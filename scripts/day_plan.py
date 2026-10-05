#!/usr/bin/env python3
"""Day Plan — il piano dei livelli operativi del giorno, costruito come farebbe
un desk di volumi/opzioni. UNICO punto di verità per la UI.

Genera data/day_plan.json:
  { futures, spot_fut, as_of, session{...}, read[3 frasi AMT],
    levels[ {name, nome_it, price, kind: magnet|barrier|pivot|reference,
             source: price|amt|options, dist_pts, conf?} ],
    profile_today{...histogram}, profile_prev{...}, stats del giorno }

E mantiene data/level_stats.json: l'affidabilità storica per nome livello
("PDH rispettato 8/12") — valutata ogni mattina sul piano del giorno
precedente contro le barre reali. È il track record, espresso come
confidence direttamente utilizzabile sulla scala.

Convenzioni:
  RTH = 09:30–16:00 ET   |   overnight = dalla chiusura RTH all'apertura
  tutti i prezzi in scala NATIVA futures (ES/NQ)

Uso:
    python scripts/day_plan.py                # genera piano + stats
    python scripts/day_plan.py --show         # stampa la scala
"""

import argparse
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)

from fetch_options_data import calculate_walls  # parità con la UI (stessa formula)

PLAN_PATH = os.path.join(SCRIPTS_DIR, "..", "data", "day_plan.json")
PREV_PLAN_PATH = os.path.join(SCRIPTS_DIR, "..", "data", "day_plan_prev.json")
STATS_PATH = os.path.join(SCRIPTS_DIR, "..", "data", "level_stats.json")
OPTIONS_PATH = os.path.join(SCRIPTS_DIR, "..", "data", "options_data.json")

ET = ZoneInfo("America/New_York")
VERSION = 1

# soglie di giudizio (in punti, minime per futures; % per livelli lontani)
TOUCH_BAND_PTS = 3.0     # il prezzo è "sul livello" entro ±3 pt
BREAK_BUF_PTS = 4.0      # oltre il livello di 4 pt = violato
REJECT_PTS = 6.0         # allontanamento di 6 pt = rispetto


# ---------------------------------------------------------------------------
# Sessioni RTH/overnight da barre 5m (ET)
# ---------------------------------------------------------------------------

def split_sessions(idx_et, highs, lows, opens, closes, vols):
    """Raggruppa le barre in sedute RTH per data ET + maschera overnight."""
    rth = defaultdict(list)
    on = defaultdict(list)
    for k, t in enumerate(idx_et):
        d = t.date()
        is_rth = (t.hour > 9 or (t.hour == 9 and t.minute >= 30)) and t.hour < 16
        bar = {"i": k, "h": highs[k], "l": lows[k], "o": opens[k], "c": closes[k], "v": float(vols[k])}
        if is_rth:
            rth[d].append(bar)
        else:
            on[d].append(bar)
    return rth, on


def session_high_low(bars):
    return (max(b["h"] for b in bars), min(b["l"] for b in bars))


def profile_from_bars(bars, bucket=1.0):
    """Profilo volumi: distribuzione del volume lungo il range di ogni barra."""
    grid: dict = {}
    for b in bars:
        hi, lo, vol = b["h"], b["l"], b["v"]
        if not vol or vol <= 0:
            continue
        R = hi - lo
        if R < 1e-5:
            key = round(round((hi + lo) / 2 / bucket) * bucket, 1)
            grid[key] = grid.get(key, 0.0) + vol
            continue
        r = float(math.floor(lo / bucket) * bucket)
        top = float(math.ceil(hi / bucket) * bucket)
        while r <= top:
            cell_hi = r + bucket
            overlap = max(0.0, min(hi, cell_hi) - max(lo, r))
            if overlap > 0:
                key = round(r, 1)
                grid[key] = grid.get(key, 0.0) + (vol / R) * overlap
            r += bucket
    return {k: v for k, v in grid.items() if v > 0}


def value_area(profile):
    """POC + VAH/VAL (70% dei volumi, espansione dal POC)."""
    if not profile:
        return None
    prices = sorted(profile)
    vols = [profile[p] for p in prices]
    poc_i = max(range(len(vols)), key=lambda i: vols[i])
    total = sum(vols)
    target = total * 0.7
    lo = hi = poc_i
    acc = vols[poc_i]
    while acc < target and (lo > 0 or hi < len(vols) - 1):
        up = vols[hi + 1] if hi < len(vols) - 1 else -1
        dn = vols[lo - 1] if lo > 0 else -1
        if up >= dn and up >= 0:
            hi += 1; acc += vols[hi]
        elif dn >= 0:
            lo -= 1; acc += vols[lo]
        else:
            break
    return {"poc": round(prices[poc_i], 1), "vah": round(prices[hi], 1), "val": round(prices[lo], 1)}


def vwap_of(bars):
    tp = [(b["h"] + b["l"] + b["c"]) / 3 for b in bars]
    v = [b["v"] for b in bars]
    tv = sum(v)
    if tv <= 0:
        return None, 0.0
    vwap = sum(p * w for p, w in zip(tp, v)) / tv
    variance = sum(w * (p - vwap) ** 2 for p, w in zip(tp, v)) / tv
    return vwap, math.sqrt(max(variance, 0.0))


# ---------------------------------------------------------------------------
# Opzioni: muri (calculate_walls) + GEX flip dalle catene
# ---------------------------------------------------------------------------

def compute_option_levels(expiries: list, spot: float) -> tuple[list, float | None]:
    """Restituisce (walls, gex_flip).

    walls: [{strike(INDICE), type, net_gex}] — top per |net_gex|
    gex_flip: strike a zero-crossing del GEX netto vicino allo spot
    """
    put_walls_raw, call_walls_raw, _ = calculate_walls(expiries, spot)
    walls = []
    for w in put_walls_raw + call_walls_raw:
        walls.append({
            "strike": float(w["strike"]),
            "type": w["type"],
            "net_gex": w.get("net_gex", 0.0) or 0.0,
            "score": w.get("score", 0) or 0,
        })

    # GEX per strike (gamma dal nodo; fallback stimata non disponibile qui)
    net: dict = {}
    CONTRACT = 100.0
    for exp in expiries:
        for o in exp.get("options", []):
            g = o.get("gamma")
            if not g:
                continue
            sign = 1.0 if o["side"] == "CALL" else -1.0
            v = o["oi"] * g * CONTRACT * spot * spot * sign
            net[o["strike"]] = net.get(o["strike"], 0.0) + v

    flip = None
    strikes = sorted(net)
    best = None
    for i in range(len(strikes) - 1):
        a, b = net[strikes[i]], net[strikes[i + 1]]
        if a * b < 0:  # zero-crossing
            # il crossing più vicino allo spot
            d = abs(strikes[i] - spot)
            if best is None or d < best[0]:
                best = (d, strikes[i] + (strikes[i + 1] - strikes[i]) * abs(a) / (abs(a) + abs(b)))
    if best:
        flip = round(best[1], 1)
    return walls, flip


# ---------------------------------------------------------------------------
# Costruzione del piano
# ---------------------------------------------------------------------------

def build_plan(idx_et, o, h, l, c, v, futures: str, walls_etf: list, spot_etf: float,
               gex_flip_etf: float | None, spot_fut_ratio: float,
               index_to_fut: float | None = None) -> dict:
    """
    walls_etf: i muri già calcolati dal pipeline opzioni, in scala ETF/strike
               [{"strike":..., "type": "put_wall|call_wall", "net_gex":...,
                 "score":...}, ...]
    spot_fut_ratio: fattore ETF→futures (ES spot / SPY spot, live).
    """
    rth, on = split_sessions(idx_et, list(h), list(l), list(o), list(c), v)
    for d, bars in rth.items():
        for b in bars:
            b["o"] = o[b["i"]]
            b["c"] = c[b["i"]]

    dates = sorted(rth)
    if not dates:
        return {}
    today = dates[-1]
    today_bars = rth[today]
    last = today_bars[-1]["c"]

    levels: list = []

    def add(name, nome_it, price, kind, source, **extra):
        if price is None or not (price > 0):
            return
        levels.append({
            "name": name, "nome_it": nome_it,
            "price": round(float(price), 1),
            "kind": kind, "source": source,
            **extra,
        })

    # ---value di ieri (AMT) ---
    prev_days = [d for d in dates if d < today]
    prev_va = None
    if prev_days:
        p = profile_from_bars(rth[prev_days[-1]])
        prev_va = value_area(p)
        if prev_va:
            add("POC-1d", "POC di ieri (magnete)", prev_va["poc"], "magnet", "amt")
            add("VAH-1d", "Value high di ieri", prev_va["vah"], "barrier", "amt")
            add("VAL-1d", "Value low di ieri", prev_va["val"], "barrier", "amt")

    # --- PDH/PDL ---
    if prev_s := (rth[prev_days[-1]] if prev_days else None):
        hi_p, lo_p = session_high_low(prev_s)
        add("PDH", "Max di ieri", hi_p, "pivot", "price")
        add("PDL", "Min di ieri", lo_p, "pivot", "price")

    # --- Overnight: barre non-RTH tra chiusura di ieri (16:00) e apert. oggi ---
    if prev_days:
        prev_date = prev_days[-1]
        on_bars = []
        for d, bars in on.items():
            if d > prev_date or (d == today):
                for b in bars:
                    t = idx_et[b["i"]]
                    if (d > prev_date and t.hour < 9) or (d == today and (t.hour < 9 or (t.hour == 9 and t.minute < 30))) or (d == prev_date and t.hour >= 16):
                        on_bars.append(b)
        if on_bars:
            onh, onl = session_high_low(on_bars)
            add("ONH", "Max overnight", onh, "pivot", "price")
            add("ONL", "Min overnight", onl, "pivot", "price")

    # --- Apertura RTH + Initial Balance ---
    open_rth = today_bars[0]["o"]
    add("OPEN", "Apertura RTH", open_rth, "reference", "price")
    ib = today_bars[:12]
    if ib:
        ibh, ibl = session_high_low(ib)
        add("IB-HIGH", "Initial Balance max", ibh, "pivot", "amt")
        add("IB-LOW", "Initial Balance min", ibl, "pivot", "amt")

    # --- VWAP seduta + bande ---
    vwap, sigma = vwap_of(today_bars)
    if vwap:
        add("VWAP", "VWAP seduta", vwap, "pivot", "price")
        for name, mult, nome in (("VWAP+1s", 1, "VWAP +1σ"), ("VWAP-1s", -1, "VWAP −1σ")):
            add(name, nome, vwap + mult * sigma, "reference", "price")

    # --- POC developing di oggi ---
    p_today = value_area(profile_from_bars(today_bars))
    if p_today:
        add("POC-dev", "POC di oggi", p_today["poc"], "magnet", "amt")

    # --- naked POC: POC delle ultime 5 sedute mai rivisitati ---
    for dval in dates[-6:]:
        if dval == today:
            continue
        p = value_area(profile_from_bars(rth[dval]))
        if not p:
            continue
        later_bars = [b for dd in dates for b in rth[dd] if dd >= dval]
        later_on = [b for d, bs in on.items() for b in bs if d >= dval]
        all_later = later_bars + later_on
        sliced = any(b["l"] <= p["poc"] <= b["h"] for b in all_later)
        if not sliced:
            add(f"NAKED-{dval.isoformat()}", f"POC naked {dval.strftime('%d/%m')}",
                p["poc"], "magnet", "amt")

    # --- settimanali ---
    wks = defaultdict(list)
    for d in dates:
        iso = d.isocalendar()
        wks[(iso[0], iso[1])].extend(rth[d])
    wkeys = sorted(wks)
    if len(wkeys) >= 1:
        hi_w = max(b["h"] for b in wks[wkeys[-1]])
        lo_w = min(b["l"] for b in wks[wkeys[-1]])
        add("W-HIGH", "Max settimana in corso", hi_w, "pivot", "price")
        add("W-LOW", "Min settimana in corso", lo_w, "pivot", "price")
    if len(wkeys) >= 2:
        prev_w = wkeys[-2]
        add("PWH", "Max sett. scorsa", max(b["h"] for b in wks[prev_w]), "pivot", "price")
        add("PWL", "Min sett. scorsa", min(b["l"] for b in wks[prev_w]), "pivot", "price")

    # --- GEX flip (opzioni) ---
    if gex_flip_etf:
        add("GEX-FLIP", "GEX flip (cambio regime gamma)",
            gex_flip_etf * spot_fut_ratio, "pivot", "options")

    # --- muri da opzioni: pin (gamma lunga) = barriera; trigger = accelerano ---
    # Le walls sono in scala ETF (SPY/QQQ): stesso fattore di tutti gli altri
    # livelli non-opzioni. (calculate_walls lavora sulle catene ETF.)
    pin_walls, trigger_walls = [], []
    for w in walls_etf:
        strike = w.get("strike")
        if not strike or not spot_etf:
            continue
        price_fut = strike * spot_fut_ratio
        net = w.get("net_gex", 0.0) or 0.0
        if net >= 0:
            pin_walls.append((price_fut, w))
        else:
            trigger_walls.append((price_fut, w))

    # pin più significativi: top 3 per |net_gex|
    for price_fut, w in sorted(pin_walls, key=lambda x: -abs(x[1].get("net_gex", 0)))[:3]:
        side = "sopra" if price_fut > last else "sotto"
        add("PIN", f"Muro {w['type'].replace('_wall','')} in pin ({side})",
            price_fut, "barrier", "options", gamma="pin")
    for price_fut, w in sorted(trigger_walls, key=lambda x: -abs(x[1].get("net_gex", 0)))[:2]:
        add("TRIGGER", f"Trigger {w['type'].replace('_wall','')}",
            price_fut, "trigger", "options", gamma="trigger")

    # NOTA scala: price/amt derivano da barre futures (già in scala ES/NQ);
    # le opzioni sono convertite al momento dell'add() — nessuna doppia conversione.

    last_fut = last  # la scala delle barre È futures
    for lv in levels:
        lv["dist_pts"] = round(lv["price"] - last_fut, 1)

    levels.sort(key=lambda x: -x["price"])
    # dedup: livelli a meno di 3 pt tra loro = la stessa zona; tiene il primo
    # (ordine di inserimento = priorità: AMT/magneti prima dei pivot price)
    deduped: list = []
    for lv in levels:
        if any(abs(lv["price"] - d["price"]) < 3.0 for d in deduped):
            continue
        deduped.append(lv)
    levels = deduped
    levels.sort(key=lambda x: -x["price"])

    # --- lettura del giorno (3 frasi AMT) ---
    read = []
    open_p = today_bars[0]["o"]
    if prev_va:
        ot = ("sopra la value di ieri" if open_p > prev_va["vah"]
              else "sotto la value di ieri" if open_p < prev_va["val"]
              else "dentro la value di ieri")
        if ot == "sopra la value di ieri":
            read.append(f"Apertura {ot}: giornata direzionale — accettazione sopra {prev_va['vah']:.0f} "
                        f"conferma gli acquirenti; il rientro rapido è un failed breakout verso il POC {prev_va['poc']:.0f}.")
        elif ot == "sotto la value di ieri":
            read.append(f"Apertura {ot}: si cercano acquirenti — accettazione sotto {prev_va['val']:.0f} "
                        f"conferma i venditori; il rientro è short covering verso il POC {prev_va['poc']:.0f}.")
        else:
            read.append(f"Apertura {ot}: giornata rotazionale — il prezzo dovrebbe oscillare tra "
                        f"VAL {prev_va['val']:.0f} e VAH {prev_va['vah']:.0f} fino a prova contraria.")
    if vwap:
        where = "sopra" if last >= vwap else "sotto"
        bias = "long: si comprano i pullback verso il VWAP" if where == "sopra" \
            else "short: si vendono i rimbalzi verso il VWAP"
        read.append(f"Prezzo {where} VWAP ({vwap:.0f}) → bias intraday {bias}.")
    pins_above = sorted([x["price"] for x in levels if x.get("gamma") == "pin" and x["price"] > last])
    pins_below = sorted([x["price"] for x in levels if x.get("gamma") == "pin" and x["price"] < last])
    if pins_above or pins_below:
        p = f"Pin sopra: {', '.join(f'{x:.0f}' for x in pins_above[:2])}" if pins_above else ""
        p2 = f"Pin sotto: {', '.join(f'{x:.0f}' for x in pins_below[:2])}" if pins_below else ""
        read.append("Gamma: " + " · ".join(x for x in (p, p2) if x) +
                    " — dove i dealer sono long gamma il prezzo tende a essere respinto.")

    return {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "futures": futures,
        "last_price": round(last_fut, 1),
        "read": read,
        "levels": levels,
        "developing_poc": (p_today["poc"] if p_today else None),
        "developing_va_h": (p_today["vah"] if p_today else None),
        "developing_va_l": (p_today["val"] if p_today else None),
        "profile_today": {str(k): round(vv, 1) for k, vv in profile_from_bars(today_bars).items()},
        "vwap": round(vwap, 1) if vwap else None,
        "vwap_sigma": round(sigma, 1) if sigma else None,
        "ib": {
            "high": round(session_high_low(ib)[0], 1) if today_bars[:12] else None,
            "low": round(session_high_low(ib)[1], 1) if today_bars[:12] else None,
        } if today_bars else None,
    }


# ---------------------------------------------------------------------------
# Scoring: affidabilità storica per nome livello
# ---------------------------------------------------------------------------

def score_plan_against(plan: dict, idx_et, highs, lows) -> list:
    """Giudica il piano di IERI sulle barre di oggi: rispettato o violato."""
    out = []
    for lv in plan.get("levels", []):
        P = lv["price"]
        band = max(TOUCH_BAND_PTS, P * 0.0004)
        brk = max(BREAK_BUF_PTS, P * 0.0005)
        rej = max(REJECT_PTS, P * 0.0007)
        touched = False
        held = False
        for k in range(len(idx_et)):
            if lows[k] <= P + band and highs[k] >= P - band:
                touched = True
                # direzione del rispetto: il livello "regge" se il prezzo NON
                # chiude oltre brk prima di allontanarsi di rej
                side_ref = None
                break
        if touched:
            # guarda le barre successive al primo touch
            first = next(k for k in range(len(idx_et))
                         if lows[k] <= P + band and highs[k] >= P - band)
            after_hi = max(highs[first:first + 24], default=P)
            after_lo = min(lows[first:first + 24], default=P)
            close_side = (highs[first] + lows[first]) / 2
            if close_side > P:
                held = after_lo > P - brk or after_hi >= P + rej
            else:
                held = after_hi < P + brk or after_lo <= P - rej
        out.append({
            "name": lv.get("name"), "nome_it": lv.get("nome_it"),
            "price": P, "source": lv.get("source"),
            "touched": touched, "held": held,
        })
    return out


def update_stats(prev_plan: dict, idx_et, highs, lows, stats: dict) -> dict:
    results = score_plan_against(prev_plan, idx_et, highs, lows)
    for r in results:
        if not r["touched"]:
            continue
        key = r["name"]
        s = stats.setdefault(key, {"n": 0, "held": 0, "nome_it": r["nome_it"]})
        s["n"] += 1
        if r["held"]:
            s["held"] += 1
        s["rate"] = round(s["held"] / s["n"], 3)
    return stats


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def load_stats() -> dict:
    if not os.path.exists(STATS_PATH):
        return {}
    try:
        with open(STATS_PATH) as f:
            return json.load(f).get("levels", {})
    except (json.JSONDecodeError, OSError):
        return {}


def save_stats(stats: dict) -> None:
    os.makedirs(os.path.dirname(STATS_PATH), exist_ok=True)
    with open(STATS_PATH, "w") as f:
        json.dump({"version": 1, "generated_at": datetime.now(timezone.utc).isoformat(),
                   "levels": stats}, f, indent=1)


def main() -> None:
    ap = argparse.ArgumentParser(description="Day plan — livelli operativi del giorno")
    ap.add_argument("--show", action="store_true")
    args = ap.parse_args()

    import yfinance as yf

    if not os.path.exists(OPTIONS_PATH):
        print("day_plan: options_data.json mancante — prima esegui fetch_options_data.py")
        sys.exit(1)
    with open(OPTIONS_PATH) as f:
        options_data = json.load(f)

    plans = {}
    for sym, fut in (("SPY", "ES"), ("QQQ", "NQ")):
        sd = options_data.get("symbols", {}).get(sym)
        if not sd:
            continue
        spot_etf = float(sd["spot"])
        fut_t = yf.Ticker(f"{fut}=F")
        hist = fut_t.history(period="7d", interval="5m", prepost=False)
        if hist.empty:
            print(f"day_plan: nessuna barra {fut}; salto.")
            continue
        idx = hist.index
        idx_et = idx.tz_convert(ET) if idx.tz is not None else idx.tz_localize(ET)
        es_spot = float(hist["Close"].iloc[-1])
        ratio = es_spot / spot_etf if spot_etf else 10.0

        walls, flip = compute_option_levels(sd.get("expiries", []), spot_etf)
        # GEX flip ricalcolato qui dai per-strike già presenti nel JSON walls
        spx = options_data.get("symbols", {}).get("SPX" if fut == "ES" else "NDX", {})
        spx_spot = float(spx.get("spot", 0) or 0)
        index_to_fut = (es_spot / spx_spot) if spx_spot else None
        plan = build_plan(idx_et, hist["Open"].values, hist["High"].values,
                          hist["Low"].values, hist["Close"].values,
                          hist["Volume"].values.astype(float),
                          futures=fut, walls_etf=walls, spot_etf=spot_etf,
                          gex_flip_etf=flip, spot_fut_ratio=ratio,
                          index_to_fut=index_to_fut)
        plan["spot_etf"] = spot_etf
        plans[fut] = plan

        # --- TRACK RECORD: il piano di IERI giudicato sulle barre di oggi ---
        today = max(idx_et).date()
        stats = load_stats()
        try:
            if os.path.exists(PLAN_PATH):
                with open(PLAN_PATH) as pf:
                    old_all = json.load(pf)
                old_plan = (old_all.get("plans") or {}).get(fut)
                if old_plan and (old_plan.get("generated_at") or "")[:10] < today.isoformat():
                    results = score_plan_against(old_plan, idx_et, h, l)
                    for r in results:
                        if not r["touched"]:
                            continue
                        s = stats.setdefault(r["name"], {"n": 0, "held": 0, "nome_it": r["nome_it"]})
                        s["n"] += 1
                        if r["held"]:
                            s["held"] += 1
                        s["rate"] = round(s["held"] / s["n"], 3)
        except Exception as e:
            print(f"day_plan: scoring saltato ({e})")
        if args.show:
            print(f"\n=== {fut} — spot {plan['last_price']} ===")
            for lv in plan["levels"]:
                print(f"  {lv['price']:9.1f}  {lv['nome_it']:32s} [{lv['kind']}/{lv['source']}]")

    os.makedirs(os.path.dirname(PLAN_PATH), exist_ok=True)
    with open(PLAN_PATH, "w") as f:
        json.dump({"version": VERSION, "generated_at": datetime.now(timezone.utc).isoformat(),
                   "plans": plans}, f, indent=1)
    save_stats(stats)
    print(f"day_plan scritto → {PLAN_PATH} (stats: {sum(v['n'] for v in stats.values())} occorrenze)")


if __name__ == "__main__":
    main()
