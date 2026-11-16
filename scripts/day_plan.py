#!/usr/bin/env python3
"""Day Plan — il piano dei livelli operativi del giorno, costruito come farebbe
un desk di volumi/opzioni. UNICO punto di verità per la UI.

Genera data/day_plan.json:
  { futures, last_price, read, levels[ SOLO opzioni: muri gamma (PIN/TRIGGER),
    GEX flip, max pain — con chain etf/index e strike nativo ],
    top_gamma*/gex_profile* per l'istogramma, ratio di conversione }

  NOTA 13/11: i livelli price/AMT (PDH, VWAP, POC, IB…) non esistono più: la
  scala è solo opzioni da mesi e quei livelli erano zavorra nel piano e nel
  track record. Le barre futures servono unicamente per lo spot.

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
import os
import sys
import numpy as np
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)

from fetch_options_data import calculate_walls  # parità con la UI (stessa formula)

PLAN_PATH = os.path.join(SCRIPTS_DIR, "..", "data", "day_plan.json")
PREV_PLAN_PATH = os.path.join(SCRIPTS_DIR, "..", "data", "day_plan_prev.json")
STATS_PATH = os.path.join(SCRIPTS_DIR, "..", "data", "level_stats.json")

# Griglia operativa: tutti i livelli opzioni si normalizzano a 5pt per
# garantire che ETF e INDICE che rappresentano lo stesso strike economico
# cadano nella STESSA zona — condizione necessaria per le zone di confluenza.
def _r5(x):
    """Arrotonda a 5 punti (griglia operativa ES/NQ)."""
    return round(round(x / 5) * 5, 1)


# OI aggregata minima perché la catena opzioni sia considerata sana.
# Un giorno normale SPY/QQQ ha milioni di contratti; yfinance/Yahoo a volte
# smette di fornire openInterest e la catena torna con OI≈0: sotto questa
# soglia muri/flip/max pain sono numeri a caso e NON vengono pubblicati.
MIN_CHAIN_OI = 100_000
# Soglie DIVERSE per simbolo: l'OI naturale dipende dal mercato. NDX è
# istituzionale con pochi contratti ma ~2,8M$ di nozionale ciascuno — su
# Yahoo oscilla attorno a 50-60k TOTALI (con il 99% dei contratti che
# porta OI): con la soglia assoluta 100k la catena NDX risultava sempre
# "degradata" → niente livelli indice per NQ. La soglia ridotta (~44%
# del normale) scatta solo se Yahoo perde metà dei dati.
MIN_CHAIN_OI_BY_SYMBOL = {"NDX": 10_000}
# Nota (05/11): la soglia va tenuta BASSA per NDX perché l'OI ENTRO la
# finestra ±10% varia col mercato: nei giorni di crollo la finestra
# scivola su zone a OI minore e una soglia troppo alta scarterebbe la
# catena a torto (bug del 05/11: 24,2k < 25k → catena 'degradata' durante
# un -5%, livelli indici assenti). Il vero segnale di rottura resta
# l'OI ~0 (fetch parziale/rotto), che 10k (~40% del normale ~25-35k)
# coglie comunque.


def min_chain_oi(symbol: str) -> int:
    """Soglia OI per simbolo (default: quella degli ETF)."""
    return MIN_CHAIN_OI_BY_SYMBOL.get(symbol, MIN_CHAIN_OI)


OPTIONS_PATH = os.path.join(SCRIPTS_DIR, "..", "data", "options_data.json")

ET = ZoneInfo("America/New_York")
VERSION = 1

# Finestra di rilevanza: muri, flip e max pain si cercano entro questo raggio
# dallo spot. Fuori, l'OI delle scadenze lunghe (LEAPS accumulati da anni)
# domina e produce "muri" a −19% e max pain senza senso (bug 08/10: put wall
# a 625 con spot 775 perché lì dormiva OI storica).
RELEVANCE_WINDOW_PCT = 0.10


def relevant_expiries(expiries: list, spot: float) -> list:
    """Copia delle scadenze con solo i contratti entro la finestra di rilevanza.

    Scarta anche le scadenze GIÀ PASSATE: il feed (CBOE/Yahoo) le tiene in
    lista per qualche giorno con gamma/OI stantii, e senza questo filtro
    finivano dentro GEX flip, regime gamma, top_gamma e i muri della scala.
    Misurato l'11/11 sul piano live: 3 scadenze passate = 11,4% della gamma
    totale del libro — abbastanza da spostare il flip di decine di punti.
    (max_pain e i profili per borsa già filtravano; qui mancava.)
    """
    if not spot:
        return expiries
    lo, hi = spot * (1 - RELEVANCE_WINDOW_PCT), spot * (1 + RELEVANCE_WINDOW_PCT)
    today_iso = datetime.now(ET).date().isoformat()
    out = []
    for e in expiries:
        d = e.get("date", "")
        if d and d < today_iso:
            continue
        opts = [o for o in (e.get("options") or [])
                if lo <= float(o.get("strike", 0) or 0) <= hi]
        out.append({**e, "options": opts})
    return out

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


# NOTA 13/11: session_high_low / profile_from_bars / value_area / vwap_of
# (max-min sessione, profili volumi, POC/VA, VWAP) rimossi insieme ai livelli
# price/AMT che li usavano: la scala è solo opzioni. Le barre futures restano
# nel pipeline per lo spot (last_price).


# ---------------------------------------------------------------------------
# Opzioni: muri (calculate_walls) + GEX flip dalle catene
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# IL FLIP DALLA CURVA DI ESPOSIZIONE (16/11) — come lo calcolano le piattaforme
# ---------------------------------------------------------------------------
# Fino al 15/11 il flip era lo zero-crossing della SOMMA PER STRIKE del GEX
# (la "gamma netta" barra per barra dell'istogramma). È un errore di definizione:
# quella serie è un dente di sega — misurato sul libro del 16/11: 73 cambi di
# segno entro ±10% dallo spot su NDX, 13 su SPX. Prendere il più vicino significa
# pescare rumore, e il "confine di regime" che ne esce può stare SOTTO il prezzo
# mentre il regime allo spot è short: è la contraddizione vista dall'utente
# ("gamma negativa col prezzo sopra il flip").
#
# Le piattaforme serie (SpotGamma / Sweep / InsiderFinance) non guardano le barre:
# disegnano una CURVA SOLA — "se il prezzo fosse a P, quanta gamma avrebbero in
# totale i dealer?" — rivalutando la gamma di OGNI contratto a quel prezzo con
# Black-Scholes (T, IV e OI reali della catena). Quella curva ha in pratica UN
# incrocio (cresce col prezzo: salendo le call passano ATM e le put ne escono),
# quindi sotto l'incrocio = dealer short gamma (amplificazione), sopra = long
# (pin / mean reversion) — e il regime non può mai contraddire il flip, perché i
# due sono la STESSA funzione letta in due punti.
#
# Convenzione segni invariata (call +, put −): coincide con muri e istogramma che
# l'utente guarda già, quindi il resto della scala non cambia significato.
CONTRACT_MULT = 100.0        # moltiplicatore contrattuale (convenzione del file)
GEX_R = 0.04                 # tasso privo di interesse
GEX_Q = 0.012                # rendimento da dividendi (forward del future)
GEX_CURVE_BAND = 0.12        # la curva si valuta da spot·(1−12%) a spot·(1+12%)
GEX_STRIKE_BAND = 0.20       # oltre ±20% dallo spot: gamma trascurabile
GEX_TODAY_YEARS = 0.5 / 365  # T convenzionale per le scadenze di OGGI
# IV di riserva quando il feed non la porta (stessi valori di utils/gammaEstimate.ts)
GEX_DEFAULT_IV = {"SPY": 0.15, "QQQ": 0.20, "SPX": 0.15, "NDX": 0.20}
GEX_FALLBACK_IV = 0.20
GEX_METHOD = "curve-bs-v1"   # scritto nel piano: serve per leggere il track record
_SQRT_2PI = float(np.sqrt(2 * np.pi))


def _years_to_expiry(date_str: str, today=None) -> float | None:
    """Anni residui alla scadenza; scadenze passate → None (non è esposizione).

    Le scadenze di OGGI usano un T convenzionale di mezza giornata: il feed non
    dice QUANTO resta, e usare il tempo residuo reale farebbe scivolare il flip
    durante la seduta a parità di catena (il numero cambierebbe perché sono le
    10:30 o le 15:30, non perché il libro è cambiato). Il flip deve essere
    riproducibile: stessa catena → stesso numero.
    """
    if not date_str:
        return None
    try:
        d = datetime.fromisoformat(date_str).date()
    except ValueError:
        return None
    today = today or datetime.now(ET).date()
    days = (d - today).days
    if days < 0:
        return None
    return GEX_TODAY_YEARS if days == 0 else days / 365.0


def _chain_matrix(exps: list, spot: float, symbol: str | None):
    """Catene → matrici (strike, segno, peso·OI, iv, T) pronte per la curva.

    Righe scartate: OI 0 (nessun contratto aperto = nessuna copertura da fare),
    strike fuori banda, scadenza già passata. IV assente → default per simbolo;
    IV > 300% → 300% (è spazzatura deep-OTM, ma un IV enorme peserebbe come un
    muro).
    """
    rows = []
    default_iv = GEX_DEFAULT_IV.get(symbol or "", GEX_FALLBACK_IV)
    lo, hi = spot * (1 - GEX_STRIKE_BAND), spot * (1 + GEX_STRIKE_BAND)
    for e in exps:
        T = _years_to_expiry(e.get("date", ""))
        if not T:
            continue
        for o in e.get("options") or []:
            try:
                K = float(o.get("strike", 0) or 0)
                oi = float(o.get("oi", 0) or 0)
            except (TypeError, ValueError):
                continue
            if oi <= 0 or not (lo <= K <= hi):
                continue
            iv = float(o.get("iv", 0) or 0)
            if iv <= 0:
                iv = default_iv
            elif iv > 3.0:
                iv = 3.0
            rows.append((K, 1.0 if o.get("side") == "CALL" else -1.0,
                         oi * CONTRACT_MULT, iv, T))
    if not rows:
        return None
    a = np.asarray(rows, dtype=float)
    return a[:, 0], a[:, 1], a[:, 2], a[:, 3], a[:, 4]


def gamma_exposure_curve(exps: list, spot: float, symbol: str | None = None,
                         band: float = GEX_CURVE_BAND):
    """Curva di esposizione gamma dei dealer in funzione del PREZZO.

        G(P) = Σ contratti ±OI·100·P²·Γ_BS(P, K, iv, T)      (+ call, − put)

    Restituisce (prezzi, G) oppure None se la catena non è valutabile.
    """
    m = _chain_matrix(exps, spot, symbol)
    if m is None:
        return None
    K, sgn, w, iv, T = m
    step = 0.5 if spot < 2000 else 5.0
    lo, hi = spot * (1 - band), spot * (1 + band)
    P = np.arange(lo, hi + step / 2, step)
    st = iv * np.sqrt(T)
    var_drift = (GEX_R - GEX_Q + 0.5 * iv * iv) * T
    disc_q = np.exp(GEX_Q * T)
    G = np.empty(P.shape, dtype=float)
    for i0 in range(0, P.size, 64):                 # blocchi 64×N, non M×N
        Pp = P[i0:i0 + 64][:, None]
        d1 = (np.log(Pp / K) + var_drift[None, :]) / st[None, :]
        gam = np.exp(-0.5 * d1 * d1) / (_SQRT_2PI * Pp * st[None, :] * disc_q[None, :])
        G[i0:i0 + 64] = ((sgn * w)[None, :] * gam * Pp * Pp).sum(axis=1)
    return P, G


def gamma_flip(exps: list, spot: float, symbol: str | None = None,
               band: float = GEX_CURVE_BAND) -> dict | None:
    """Regime E confini di regime dalla stessa curva di esposizione.

      regime      'long' | 'short'  ← segno di G allo spot
      flip        il confine più vicino allo spot (None se la curva non taglia)
      flip_below  ultimo confine SOTTO lo spot (None = scendendo non cambia
                  regime entro la banda)
      flip_above  primo confine SOPRA lo spot
      crossings   quanti tagli ci sono nella banda (1 = libro pulito)
      band        ±% della banda valutata

    Il regime è il segno di G allo spot e i flip sono gli zeri della STESSA
    curva: "sotto il flip = short, sopra = long" è vero per costruzione, non per
    assunzione — è esattamente ciò che la definizione per-strike rompeva.
    """
    c = gamma_exposure_curve(exps, spot, symbol, band)
    if c is None:
        return None
    P, G = c
    g_spot = float(np.interp(spot, P, G))
    s = np.sign(G)
    i = np.where(s[:-1] * s[1:] < 0)[0]
    xs = ([round(float(x), 1) for x in
           P[i] + (P[i + 1] - P[i]) * np.abs(G[i]) / (np.abs(G[i]) + np.abs(G[i + 1]))]
          if i.size else [])
    below = [x for x in xs if x < spot]
    above = [x for x in xs if x >= spot]
    flip_below = max(below) if below else None
    flip_above = min(above) if above else None
    cand = [x for x in (flip_below, flip_above) if x is not None]
    return {
        "regime": "long" if g_spot > 0 else "short",
        "flip": min(cand, key=lambda x: abs(x - spot)) if cand else None,
        "flip_below": flip_below,
        "flip_above": flip_above,
        "crossings": len(xs),
        "band": band,
    }


def bands_by_bucket(exps: list, spot: float, symbol: str | None) -> dict:
    """gamma_flip per le TRE borse di scadenza (0dte / week / all).

    Stesso partizionamento per data di top_gamma_by_bucket e gex_profile_by_bucket,
    così muro, barra dell'istogramma e flip che l'utente guarda vengono dallo
    STESSO insieme di scadenze.
    """
    today = datetime.now(ET).date()
    horizon = today + timedelta(days=7)
    out: dict = {}
    for name in ("0dte", "week", "all"):
        sel = []
        for e in exps:
            try:
                d = datetime.fromisoformat(e.get("date", "")).date()
            except ValueError:
                continue
            if d < today:
                continue
            if name == "0dte" and d != today:
                continue
            if name == "week" and d > horizon:
                continue
            sel.append(e)
        out[name] = gamma_flip(sel, spot, symbol) if sel else None
    return out


def _band_fut(band: dict | None, ratio: float) -> dict:
    """Banda di regime (scala nativa) → campi del piano (scala futures)."""
    if not band:
        return {}

    def conv(v):
        return _r5(v * ratio) if v else None

    return {
        "regime": band.get("regime"),
        "flip": conv(band.get("flip")),
        "flip_below": conv(band.get("flip_below")),
        "flip_above": conv(band.get("flip_above")),
        "flip_native": band.get("flip"),
        "flip_below_native": band.get("flip_below"),
        "flip_above_native": band.get("flip_above"),
        "crossings": band.get("crossings"),
        "band_pct": band.get("band"),
    }


def nearest_zero_crossing(profile: dict, spot: float) -> float | None:
    """DEPRECATO 16/11 — zero-crossing del GEX PER STRIKE più vicino allo spot.

    Non è più la definizione di flip del piano: vedi gamma_flip qui sopra. La
    serie per strike è la stessa dell'istogramma (che la UI continua a mostrare)
    ma è un dente di sega e il suo incrocio più vicino non è il confine del
    regime. Tenuta solo come riferimento di formula.
    """
    strikes = sorted(profile)
    best = None
    for i in range(len(strikes) - 1):
        a, b = profile[strikes[i]], profile[strikes[i + 1]]
        if a * b < 0:
            d = abs(strikes[i] - spot)
            if best is None or d < best[0]:
                best = (d, strikes[i] + (strikes[i + 1] - strikes[i]) * abs(a) / (abs(a) + abs(b)))
    return round(best[1], 1) if best else None


def regime_at_spot(net: dict, spot: float) -> str | None:
    """DEPRECATO 16/11 — segno del GEX per strike ai due strike che brackettano
    lo spot. Il regime del piano ora viene dalla curva di esposizione
    (gamma_flip): regime e flip devono essere la STESSA funzione.
    """
    st = sorted(net)
    if not st:
        return None
    # il primo strike utile per lato può valere ESATTAMENTE 0 (catene a passi
    # larghi tipo NDX: gli strike attorno allo spot possono non avere gamma
    # nelle scadenze future, solo in quelle scadute). In quel caso si cammina
    # verso l'esterno fino al primo strike con gamma ≠ 0: il regime è definito
    # dal primo livello che conta, non da uno zero di riempimento.
    below = None
    for k in reversed(st):
        if k > spot:
            continue
        if net[k]:
            below = k
            break
    above = None
    for k in st:
        if k <= spot:
            continue
        if net[k]:
            above = k
            break
    vals = [net[k] for k in (below, above) if k is not None]
    return ("long" if sum(vals) > 0 else "short") if vals else None


def top_gamma_by_bucket(expiries: list, spot: float,
                        symbol: str | None = None) -> tuple:
    """Profili GEX per strike per BORSA DI SCADENZA (0dte / week / all).

    0dte = solo le scadenze di oggi (il pin attorno allo spot);
    week = entro 7 giorni da oggi (i muri della settimana);
    all  = tutte le scadenze del libro (struttura).
    Stessi campi del top_gamma aggregato (strike, net_gex, sign, side) e
    STESSA formula dell'accumulo in compute_option_levels: i due vanno
    tenuti in parità — il selettore maturità della scala li usa per
    mostrare i muri del perimetro scelto (le scadenze lunghe hanno gamma
    minuscola: senza borse non emergerrebbero mai dal top-3 aggregato).
    """
    CONTRACT = 100.0
    today = datetime.now(ET).date()
    horizon = (today + timedelta(days=7)).isoformat()
    today_iso = today.isoformat()
    buckets: dict = {"0dte": [], "week": [], "all": []}
    for e in expiries:
        d = e.get("date", "")
        if d and d < today_iso:
            continue  # scadenza già passata: il suo OI non è più un livello
        buckets["all"].append(e)
        if d == today_iso:
            buckets["0dte"].append(e)
        if today_iso <= d <= horizon:
            buckets["week"].append(e)

    out: dict = {}
    flips: dict = {}
    regimes: dict = {}
    # FLIP E REGIME di ogni borsa dalla CURVA di esposizione (16/11): prima
    # erano lo zero-crossing della somma per strike, che è un dente di sega
    # (73 cambi di segno su NDX entro ±10%) e poteva mettere il "confine" sotto
    # il prezzo col regime short → la contraddizione vista dall'utente.
    bands: dict = {name: (gamma_flip(exps, spot, symbol) if exps else None)
                   for name, exps in buckets.items()}
    for name, exps in buckets.items():
        net: dict = {}
        call_abs: dict = {}
        put_abs: dict = {}
        for exp in exps:
            for o in exp.get("options") or []:
                g = o.get("gamma")
                if not g:
                    continue
                sign = 1.0 if o["side"] == "CALL" else -1.0
                mag = o["oi"] * g * CONTRACT * spot * spot
                net[o["strike"]] = net.get(o["strike"], 0.0) + mag * sign
                side_abs = call_abs if o["side"] == "CALL" else put_abs
                side_abs[o["strike"]] = side_abs.get(o["strike"], 0.0) + mag
        b = bands.get(name) or {}
        flips[name] = b.get("flip")
        regimes[name] = b.get("regime")
        top = sorted(net.items(), key=lambda kv: -abs(kv[1]))[:10]
        out[name] = [
            {
                "strike": round(k, 1),
                "net_gex": round(vv, 0),
                "sign": "long" if vv >= 0 else "short",
                "side": "call" if call_abs.get(k, 0) >= put_abs.get(k, 0) else "put",
            }
            for k, vv in top
        ]
    return out, flips, regimes, bands


def gex_profile_by_bucket(expiries: list, spot: float, window_pct: float = 0.10) -> dict:
    """Profilo COMPLETO per strike per borsa (0dte/week/all) — l'istogramma
    della UI. Per strike QUATTRO valori: c = GEX lato call (≥0), p = GEX
    lato put (≤0) [net = c + p], co/po = open interest call/put. Stessa
    formula di compute_option_levels (gamma × OI × 100 × spot²) ma su
    TUTTI gli strike della finestra ±window_pct e in Mld (1e9$), arrotondati
    a 3 decimali. Gli strike senza né GEX né OI scartati.
    Dall'11/11 la UI passa window_pct=0.20 per il confronto con
    InsiderFinance, che mostra l'intera catena (prima ±10%: gli strike
    lontani sparivano e l'OI non combaciava più)."""
    CONTRACT = 100.0
    today = datetime.now(ET).date()
    horizon = (today + timedelta(days=7)).isoformat()
    today_iso = today.isoformat()
    buckets: dict = {"0dte": [], "week": [], "all": []}
    for e in expiries:
        d = e.get("date", "")
        if d and d < today_iso:
            continue
        buckets["all"].append(e)
        if d == today_iso:
            buckets["0dte"].append(e)
        if today_iso <= d <= horizon:
            buckets["week"].append(e)

    lo, hi = spot * (1 - window_pct), spot * (1 + window_pct)
    out: dict = {}
    for name, exps in buckets.items():
        agg: dict = {}   # strike -> [call_gex, put_gex, call_oi, put_oi]
        for e in exps:
            for o in e.get("options") or []:
                s = float(o.get("strike", -1))
                if not (lo <= s <= hi):
                    continue
                g = o.get("gamma") or 0
                oi = int(o.get("oi") or 0)
                cell = agg.setdefault(round(s, 1), [0.0, 0.0, 0, 0])
                is_call = o["side"] == "CALL"
                if g and oi:
                    sign = 1.0 if is_call else -1.0
                    v = oi * g * CONTRACT * spot * spot * sign
                    if sign > 0:
                        cell[0] += v
                    else:
                        cell[1] += v
                if oi:
                    if is_call:
                        cell[2] += oi
                    else:
                        cell[3] += oi
        prof = []
        for s in sorted(agg):
            c, pp, co, po = agg[s]
            # scarta solo gli strike davvero vuoti: senza GEX E senza OI
            if abs(c) + abs(pp) < 1e7 and co + po == 0:
                continue
            prof.append({"s": round(s, 1), "c": round(c / 1e9, 3), "p": round(pp / 1e9, 3),
                         "co": int(co), "po": int(po)})
        out[name] = prof
    return out


def _bin_profile(entries: list, step: float) -> list:
    """Aggrega il profilo GEX su bin da `step` pt in scala futures: strike
    arrotondati al bin più vicino, valori (c/p/co/po) sommati. Serve perché
    in modalità 'Entrambi' la UI somma ETF+indice per strike IDENTICO — le
    due fonti devono quindi stare sulla stessa griglia (verifica 09/11:
    indice non-binnato → 0 strike comuni → istogramma doppio invece che
    sommato)."""
    out: dict = {}
    for e in entries:
        z = round(e["s"] / step) * step
        cur = out.setdefault(z, {"s": z, "c": 0.0, "p": 0.0, "co": 0, "po": 0})
        cur["c"] += e["c"]
        cur["p"] += e["p"]
        cur["co"] += e.get("co", 0)
        cur["po"] += e.get("po", 0)
    return sorted(out.values(), key=lambda x: x["s"])


def compute_option_levels(expiries: list, spot: float,
                          symbol: str | None = None,
                          bands: dict | None = None) -> tuple:
    """Restituisce (walls, gex_flip, gex_flip_0dte, top_gamma, gex_regime, bands).

    walls: [{strike(INDICE), type, net_gex}] — top per |net_gex|
    gex_flip / gex_flip_0dte / gex_regime: dal 16/11 vengono dalla CURVA di
              esposizione gamma (gamma_flip), non dallo zero-crossing della
              somma per strike. Borsa 'all' = strutturale, '0dte' = oggi.
    bands: i tre regimi (0dte/week/all) già calcolati dal caller (evita di
              rifare la curva due volte); None = li calcola qui.
    """
    expiries = relevant_expiries(expiries, spot)
    put_walls_raw, call_walls_raw, _ = calculate_walls(expiries, spot)
    walls = []
    for w in put_walls_raw + call_walls_raw:
        walls.append({
            "strike": float(w["strike"]),
            "type": w["type"],
            "net_gex": w.get("net_gex", 0.0) or 0.0,
            "score": w.get("score", 0) or 0,
            "oi": float(w.get("total_oi", 0) or 0),
            "vol": float(w.get("total_vol", 0) or 0),
        })

    CONTRACT = 100.0
    net: dict = {}
    call_abs: dict = {}   # |GEX| del lato call per strike (per il lato dominante)
    put_abs: dict = {}
    for exp in expiries:
        for o in exp.get("options", []):
            g = o.get("gamma")
            if not g:
                continue
            sign = 1.0 if o["side"] == "CALL" else -1.0
            mag = o["oi"] * g * CONTRACT * spot * spot
            net[o["strike"]] = net.get(o["strike"], 0.0) + mag * sign
            (call_abs if o["side"] == "CALL" else put_abs)[o["strike"]] = \
                (call_abs if o["side"] == "CALL" else put_abs).get(o["strike"], 0.0) + mag

    if bands is None:
        bands = bands_by_bucket(expiries, spot, symbol)
    flip = (bands.get("all") or {}).get("flip")
    flip0 = (bands.get("0dte") or {}).get("flip")
    gex_regime = (bands.get("all") or {}).get("regime")

    top = sorted(net.items(), key=lambda kv: -abs(kv[1]))[:10]
    top_strikes = []
    for k, vv in top:
        # lato dominante: quale lato contribuisce di più al GEX dello strike
        # (serve a etichettare 'call wall' / 'put wall' come InsiderFinance)
        c_abs = call_abs.get(k, 0.0)
        p_abs = put_abs.get(k, 0.0)
        top_strikes.append({
            "strike": round(k, 1),
            "net_gex": round(vv, 0),
            "sign": "long" if vv >= 0 else "short",
            "side": "call" if c_abs >= p_abs else "put",
        })

    # regime: segno della curva di esposizione allo spot (borsa 'all'). Definito
    # anche quando la curva non taglia entro la banda: lì il flip non esiste ma
    # il regime sì, e il badge non deve sfarfallare.

    return walls, flip, flip0, top_strikes, gex_regime, bands


def max_pain(expiries: list, spot: float) -> dict:
    """Max Pain: lo strike dove il payout TOTALE agli acquirenti di opzioni
    è MINIMO (dolore massimo per chi le ha comprate). Vicino alla scadenza il
    prezzo tende a gravitare lì. Calcolato (a) sull'ultima scadenza — il pin
    di oggi — e (b) aggregato su tutte le scadenze."""
    expiries = relevant_expiries(expiries, spot)
    if not expiries:
        return {}
    # aggrega OI call/put per strike per scadenza
    today_d = datetime.now(ET).date()
    per_exp: dict = defaultdict(lambda: defaultdict(lambda: {"c": 0.0, "p": 0.0}))
    for e in expiries:
        try:
            if datetime.fromisoformat(e["date"]).date() < today_d:
                continue  # scadenza già passata: il suo OI non è più un livello
        except Exception:
            pass
        for o in e.get("options", []):
            cell = per_exp[e["date"]][o["strike"]]
            if o["side"] == "CALL":
                cell["c"] += o["oi"]
            else:
                cell["p"] += o["oi"]

    def pain_of(strikes_set, oi_by_strike, S):
        tot = 0.0
        for K, d in oi_by_strike.items():
            tot += d["c"] * max(0.0, S - K)
            tot += d["p"] * max(0.0, K - S)
        return tot

    def max_pain_of(oi_by_strike):
        strikes = sorted(oi_by_strike)
        if len(strikes) < 2:
            return None
        pains = [(pain_of(strikes, oi_by_strike, S), S) for S in strikes]
        return min(pains)[1]

    out = {}
    if per_exp:
        nearest_date = min(per_exp)
        nearest_oi = per_exp[nearest_date]
        mp_n = max_pain_of(nearest_oi)
        if mp_n:
            out["nearest"] = {"strike": round(mp_n, 1), "expiry": nearest_date}
        all_oi: dict = defaultdict(lambda: {"c": 0.0, "p": 0.0})
        for d in per_exp:
            for K, dd in per_exp[d].items():
                all_oi[K]["c"] += dd["c"]
                all_oi[K]["p"] += dd["p"]
        mp_a = max_pain_of(all_oi)
        if mp_a:
            out["all"] = {"strike": round(mp_a, 1)}
    return out


# ---------------------------------------------------------------------------
# Costruzione del piano
# ---------------------------------------------------------------------------

def dedupe_levels(levels: list) -> list:
    """Dedup a 3 pt: livelli quasi-coincidenti = la stessa zona, tiene il
    primo (ordine di inserimento = priorità: AMT/magneti prima dei pivot).

    I livelli da catena INDICE (chain='index') NON vengono soppressi dai
    livelli opzioni ETF: le due fonti sono visualizzabili separatamente e
    la loro coincidenza è informazione (confluenza). Un livello indice è
    assorbito solo da un livello prezzo/AMT (zona già occupata da altra
    lettura) o da un altro livello indice.
    """
    base = [lv for lv in levels if lv.get("chain") != "index"]
    idx_lvs = [lv for lv in levels if lv.get("chain") == "index"]
    # I FLIP si escludono a vicenda solo se sono lo STESSO perimetro: i tre
    # perimetri (Tutte / ≤7gg / 0DTE) sono tre confini di regime diversi e la UI
    # ne mostra uno per volta secondo la borsa scelta dal trader. Il dedup a 3 pt
    # che si mangiava GEX-FLIP-WEEK perché coincideva col strutturale è il motivo
    # per cui l'indicatore NT8 (che legge SOLO i livelli) mostrava un flip diverso
    # dal sito (che invece ha il fallback sui campi numerici) — bug 16/11.
    keep = [lv for lv in levels if str(lv.get("name", "")).startswith("GEX-FLIP")]
    base = [lv for lv in base if not str(lv.get("name", "")).startswith("GEX-FLIP")]
    idx_lvs = [lv for lv in idx_lvs if not str(lv.get("name", "")).startswith("GEX-FLIP")]
    deduped: list = list(keep)
    for lv in base:
        if any(abs(lv["price"] - d["price"]) < 3.0 for d in deduped):
            continue
        deduped.append(lv)
    for lv in idx_lvs:
        # solo price/amt (non-opzioni) o altri livelli indice lo assorbono
        if any(abs(lv["price"] - d["price"]) < 3.0
               for d in deduped if d.get("source") != "options"):
            continue
        if any(abs(lv["price"] - d["price"]) < 3.0
               for d in deduped
               if d.get("chain") == "index"
               and not str(d.get("name", "")).startswith("GEX-FLIP")):
            continue
        deduped.append(lv)
    return sorted(deduped, key=lambda x: -x["price"])


def build_plan(idx_et, o, h, l, c, v, futures: str, walls_etf: list, spot_etf: float,
               gex_flip_etf: float | None, spot_fut_ratio: float,
               index_to_fut: float | None = None,
               gex_flip0_etf: float | None = None,
               gex_flipw_etf: float | None = None,
               index_opts: dict | None = None,
               bands_etf: dict | None = None) -> dict:
    """
    walls_etf: i muri già calcolati dal pipeline opzioni, in scala ETF/strike
               [{"strike":..., "type": "put_wall|call_wall", "net_gex":...,
                 "score":...}, ...]
    spot_fut_ratio: fattore ETF→futures (ES spot / SPY spot, live).
    index_opts: SECONDA FONTE (catena SPX/NDX), in scala indice/strike nativa:
                {"walls": [...], "flip": ..., "flip0": ..., "ratio": indice→fut,
                 "bands": {0dte/week/all}}. None/assente = indice degradata.
    bands_etf: {"0dte"/"week"/"all" → banda di regime nativa} — porta nel livello
                flip il confine SOTTO e SOPRA lo spot e il regime, così il sito
                e NT8 disegnano lo stesso numero e non possono contraddirsi.
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

    # NOTA 13/11: i livelli price/AMT (PDH, PDL, ONH/ONL, OPEN, IB, VWAP±σ,
    # GVWAP, POC, naked POC, W-HIGH/LOW, PWH/PWL) NON vengono più pubblicati:
    # la scala è SOLO opzioni (muri gamma, flip, max pain) da mesi e quei
    # livelli restavano nel piano come zavorra — e finivano pure nel track
    # record. Le barre futures servono ancora per lo spot (last_price).

    # --- GEX flip (opzioni ETF): un livello per perimetro di scadenza ---------
    # Valori dalla CURVA di esposizione (16/11): sotto il flip i dealer sono
    # short gamma (movimenti che si amplificano), sopra long (pin). Il livello
    # si porta dietro anche il confine dall'altra parte dello spot (zone_low /
    # zone_high) e il regime: chi legge (sito o NT8) non deve indovinare niente.
    def flip_extras(bucket: str) -> dict:
        b = (bands_etf or {}).get(bucket) or {}
        return {
            "chain": "etf",
            "regime": b.get("regime"),
            "zone_low": _r5(b["flip_below"] * spot_fut_ratio) if b.get("flip_below") else None,
            "zone_high": _r5(b["flip_above"] * spot_fut_ratio) if b.get("flip_above") else None,
            "crossings": b.get("crossings"),
            "method": GEX_METHOD,
        }

    if gex_flip_etf:
        add("GEX-FLIP", "GEX flip (cambio regime gamma)",
            _r5(gex_flip_etf * spot_fut_ratio), "pivot", "options",
            **flip_extras("all"))
    # Flip 0DTE: solo le scadenze di oggi (daily + weekly + mensile che
    # cadono oggi). Regime intraday: è il libro che i dealer coprono entro
    # la chiusura. Può divergere dall'aggregato → info, non rumore.
    if gex_flip0_etf:
        add("GEX-FLIP-0DTE", "GEX flip 0DTE (scade oggi)",
            _r5(gex_flip0_etf * spot_fut_ratio), "pivot", "options",
            **flip_extras("0dte"))
    if gex_flipw_etf:
        add("GEX-FLIP-WEEK", "GEX flip ≤7gg (cambio regime gamma)",
            _r5(gex_flipw_etf * spot_fut_ratio), "pivot", "options",
            **flip_extras("week"))

    # --- muri da catena INDICE (SPX/NDX): stessa logica, fonte separata ---
    # Strike in scala indice, convertiti col fattore indice→futures (ES/SPX).
    # Normalizzati a griglia 5pt per confluenza con ETF.
    # Nomi con suffisso -IDX: il track record li accumula separatamente
    # (ES:PIN vs ES:PIN-IDX) — è la misura che dice nel tempo quale fonte
    # produce livelli più affidabili.
    if index_opts and index_opts.get("ratio"):
        i_ratio = float(index_opts["ratio"])
        i_src = "SPX" if futures == "ES" else "NDX"
        def flip_extras_idx(bucket: str) -> dict:
            b = (index_opts.get("bands") or {}).get(bucket) or {}
            return {
                "chain": "index",
                "regime": b.get("regime"),
                "zone_low": _r5(b["flip_below"] * i_ratio) if b.get("flip_below") else None,
                "zone_high": _r5(b["flip_above"] * i_ratio) if b.get("flip_above") else None,
                "crossings": b.get("crossings"),
                "method": GEX_METHOD,
            }

        if index_opts.get("flip"):
            add("GEX-FLIP-IDX", f"GEX flip da {i_src} (cambio regime gamma)",
                _r5(index_opts["flip"] * i_ratio), "pivot", "options",
                **flip_extras_idx("all"))
        if index_opts.get("flip0"):
            add("GEX-FLIP-0DTE-IDX", f"GEX flip 0DTE da {i_src} (scade oggi)",
                _r5(index_opts["flip0"] * i_ratio), "pivot", "options",
                **flip_extras_idx("0dte"))
        if index_opts.get("flipw"):
            add("GEX-FLIP-WEEK-IDX", f"GEX flip ≤7gg da {i_src} (cambio regime gamma)",
                _r5(index_opts["flipw"] * i_ratio), "pivot", "options",
                **flip_extras_idx("week"))
        pin_wi, trg_wi = [], []
        for w in index_opts.get("walls") or []:
            strike = w.get("strike")
            if not strike:
                continue
            price_fut = _r5(strike * i_ratio)
            net = w.get("net_gex", 0.0) or 0.0
            (pin_wi if net >= 0 else trg_wi).append((price_fut, w))
        for price_fut, w in sorted(pin_wi, key=lambda x: -abs(x[1].get("net_gex", 0)))[:3]:
            side_pos = "sopra" if price_fut > last else "sotto"
            wall_side = w["type"].replace("_wall", "")
            add("PIN-IDX", f"Muro {wall_side} in pin ({side_pos}, {i_src})",
                price_fut, "barrier", "options", chain="index", gamma="pin",
                side=wall_side, oi=round(float(w.get("oi", 0) or 0)),
                native=round(float(w.get('strike') or 0), 2), nativeSource=i_src)
        for price_fut, w in sorted(trg_wi, key=lambda x: -abs(x[1].get("net_gex", 0)))[:2]:
            wall_side = w["type"].replace("_wall", "")
            add("TRIGGER-IDX", f"Trigger {wall_side} ({i_src})",
                price_fut, "trigger", "options", chain="index", gamma="trigger",
                side=wall_side, oi=round(float(w.get("oi", 0) or 0)),
                native=round(float(w.get('strike') or 0), 2), nativeSource=i_src)

    # --- muri da opzioni ETF: pin (gamma lunga) = barriera; trigger = accelerano ---
    # Le walls sono in scala ETF (SPY/QQQ): stesso fattore di tutti gli altri
    # livelli non-opzioni. Normalizzate a griglia 5pt per confluenza con IDX.
    # (calculate_walls lavora sulle catene ETF.)
    pin_walls, trigger_walls = [], []
    for w in walls_etf:
        strike = w.get("strike")
        if not strike or not spot_etf:
            continue
        price_fut = _r5(strike * spot_fut_ratio)
        net = w.get("net_gex", 0.0) or 0.0
        if net >= 0:
            pin_walls.append((price_fut, w))
        else:
            trigger_walls.append((price_fut, w))

    # pin più significativi: top 3 per |net_gex|
    for price_fut, w in sorted(pin_walls, key=lambda x: -abs(x[1].get("net_gex", 0)))[:3]:
        side_pos = "sopra" if price_fut > last else "sotto"
        wall_side = w["type"].replace("_wall", "")
        add("PIN", f"Muro {wall_side} in pin ({side_pos})",
            price_fut, "barrier", "options", chain="etf", gamma="pin", side=wall_side,
            oi=round(float(w.get("oi", 0) or 0)),
            native=round(float(w.get("strike") or 0), 2), nativeSource="SPY" if futures == "ES" else "QQQ")
    for price_fut, w in sorted(trigger_walls, key=lambda x: -abs(x[1].get("net_gex", 0)))[:2]:
        wall_side = w["type"].replace("_wall", "")
        add("TRIGGER", f"Trigger {wall_side}",
            price_fut, "trigger", "options", chain="etf", gamma="trigger", side=wall_side,
            oi=round(float(w.get("oi", 0) or 0)),
            native=round(float(w.get("strike") or 0), 2), nativeSource="SPY" if futures == "ES" else "QQQ")

    # NOTA scala: price/amt derivano da barre futures (già in scala ES/NQ);
    # le opzioni sono convertite al momento dell'add() — nessuna doppia conversione.

    last_fut = last  # la scala delle barre È futures
    for lv in levels:
        lv["dist_pts"] = round(lv["price"] - last_fut, 1)

    levels.sort(key=lambda x: -x["price"])
    levels = dedupe_levels(levels)
    levels.sort(key=lambda x: -x["price"])

    # --- lettura del giorno: solo gamma (i livelli price/AMT non esistono più) ---
    read = []
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
    }


# ---------------------------------------------------------------------------
# Scoring: affidabilità storica per nome livello
# ---------------------------------------------------------------------------

def score_plan_against(plan: dict, idx_et, highs, lows, closes=None, only_date=None) -> list:
    """Giudica un piano: ogni livello ha successo se fa IL SUO MESTIERE.

    only_date: se fornito, giudica SOLO le barre di quel giorno ET (giudizio
    della giornata completata). Altrimenti conta le barre DAL giorno di
    pubblicazione del piano in poi.

    Verdetto per meccanismo (kind), sulla finestra di 2h dal primo touch:
      barrier/pivot  non cede il buffer di 4 pt, oppure respinge ≥6 pt
      trigger        rottura CON follow-through ≥6 pt nella direzione di moto
                     (lo stallo dopo il tocco è fallimento)
      magnet         convergenza: a fine finestra il prezzo chiude sul livello
    """
    gen = str(plan.get("generated_at") or "")[:10]
    if only_date is not None:
        keep = [k for k in range(len(idx_et)) if idx_et[k].date() == only_date]
        if not keep:
            return []
    elif gen:
        keep = [k for k in range(len(idx_et))
                if idx_et[k].strftime("%Y-%m-%d") >= gen]
    else:
        keep = None
    if keep is not None:
        idx_et = [idx_et[k] for k in keep]
        highs = [highs[k] for k in keep]
        lows = [lows[k] for k in keep]
        if closes is not None:
            # le chiusure vanno filtrate COME le barre: senza questo, con
            # only_date il magnete confrontava la chiusura dell'ULTIMO giorno
            # della finestra (o l'overnight) invece della giornata giudicata
            closes = [closes[k] for k in keep]
    out = []
    for lv in plan.get("levels", []):
        P = lv["price"]
        kind = lv.get("kind", "pivot")
        band = max(TOUCH_BAND_PTS, P * 0.0004)
        brk = max(BREAK_BUF_PTS, P * 0.0005)
        rej = max(REJECT_PTS, P * 0.0007)
        touched = False
        held = False
        first = None
        for k in range(len(idx_et)):
            if lows[k] <= P + band and highs[k] >= P - band:
                touched = True
                first = k
                break
        # magnete (max pain): il mestiere è la CHIUSURA DI GIORNATA sul
        # livello — il pinning dei dealer avviene in chiusura, non a 2h dal
        # tocco (lezione 24/10). Non richiede il tocco: la giornata chiude
        # sul livello o no. Il close è quello dell'ULTIMA barra del giorno.
        # len() e non verità: closes è un array numpy — `if closes:` su più
        # di un elemento solleva ValueError e abbatte TUTTO lo scoring
        if kind == "magnet" and closes is not None and len(closes):
            held = abs(closes[-1] - P) <= band
            touched = True
        elif touched:
            after_hi = max(highs[first:first + 24], default=P)
            after_lo = min(lows[first:first + 24], default=P)
            mid = (highs[first] + lows[first]) / 2
            from_above = mid > P
            if kind == "trigger":
                # successo = rottura CON follow-through (≥ rej) nella direzione
                # di moto entro la finestra; stallo o rimbalzo = fallimento
                held = after_lo <= P - rej if from_above else after_hi >= P + rej
            else:
                # barriera/pin/pivot: successo = stallo sul lato di arrivo
                # (mai il buffer di 4 pt) OPPURE respinta ≥6 pt in direzione
                # opposta. La rottura continua nel senso di arrivo = fallimento.
                if from_above:
                    held = after_lo > P - brk or after_hi >= P + rej
                else:
                    held = after_hi < P + brk or after_lo <= P - rej
        out.append({
            "name": lv.get("name"), "nome_it": lv.get("nome_it"),
            "price": P, "source": lv.get("source"), "kind": kind,
            "touched": touched, "held": held,
        })
    return out


def update_stats(prev_plan: dict, idx_et, highs, lows, closes, stats: dict, prefix: str = "", only_date=None) -> dict:
    """Accumula i verdetti nel dizionario stats, con chiave per strumento
    ("ES:PDH"): nomi identici su strumenti diversi restano statistiche separate."""
    results = score_plan_against(prev_plan, idx_et, highs, lows, closes=closes, only_date=only_date)
    for r in results:
        if not r["touched"]:
            continue
        key = f"{prefix}:{r['name']}" if prefix else r["name"]
        s = stats.setdefault(key, {"name": key, "n": 0, "held": 0, "nome_it": r["nome_it"]})
        s["n"] += 1
        if r["held"]:
            s["held"] += 1
        s["rate"] = round(s["held"] / s["n"], 3)
    return results


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


def load_last_scored():
    """Ultima giornata ET già inclusa nel track record (None se mai scalato)."""
    if not os.path.exists(STATS_PATH):
        return None
    try:
        with open(STATS_PATH) as f:
            v = json.load(f).get("last_scored")
        return datetime.fromisoformat(v).date() if v else None
    except (json.JSONDecodeError, OSError, ValueError, TypeError):
        return None


def save_stats(stats: dict, last_scored=None) -> None:
    os.makedirs(os.path.dirname(STATS_PATH), exist_ok=True)
    with open(STATS_PATH, "w") as f:
        json.dump({"version": 1, "generated_at": datetime.now(timezone.utc).isoformat(),
                   "last_scored": last_scored.isoformat() if last_scored else None,
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
    stats = load_stats()   # caricata UNA volta: ES e NQ si accumulano insieme
    last_scored = load_last_scored()   # ultima giornata ET già giudicata
    bars_data = {}
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
        h = hist["High"].to_numpy(float)
        l = hist["Low"].to_numpy(float)
        cl = hist["Close"].to_numpy(float)
        es_spot = float(cl[-1])
        # Nei giro NOTTURNI (02:45 ET) i futures quotano live ma lo spot
        # indice è CONGELATO alla chiusura: il rapporto futures/indice
        # calcolato così è distorto (sta mattina dava 0,9944 → la strike
        # 28000 NDX mappata a NQ 27843 invece di ~28128). La coppia
        # coerente è chiusura RTH futures / spot indice alla STESSA chiusura:
        # uso l'ultima barra RTH. Di giorno è identica all'ultima barra.
        mask_rth = ((idx_et.hour > 9) | ((idx_et.hour == 9) & (idx_et.minute >= 30))) & (idx_et.hour < 16)
        rth_closes = cl[mask_rth]
        # Ratio di conversione strike → scala futures = PREMIO dei futures
        # CONGELATO PER SEDUTA: chiusure RTH dell'ultima seduta COMPLETATA
        # (futures ÷ indice ÷ ETF, tutte alla stessa ora di chiusura). Gli
        # input non cambiano durante il giorno → stesso ratio a ogni giro
        # della pipeline: muri, flip e istogramma indice restano FERMI (un
        # muro è un livello, non una media mobile). Costo noto e accettato:
        # il premio reale deriva ~0.05%/giorno → il mapping può essere stanco
        # di 3-5 punti a fine seduta; il tooltip mostra comunque lo strike
        # nativo esatto. NON fare il pairing live: barra futures 5m LIVE ÷
        # close 1d Yahoo RITARDATO 10-15' abbinava momenti diversi e l'11/11
        # lo strike 28000 NDX è scivolato +37 NQ in 40 minuti di rally.
        def close_on(tkr: str, want) -> float | None:
            """Close giornaliero dell'ultima seduta con data ≤ `want`.
            Durante RTH l'ultima barra 1d è il close di OGGI in corso:
            scartarla è esattamente ciò che evita il ratio che scivola."""
            try:
                hh = yf.Ticker(tkr).history(period="7d", interval="1d")["Close"].dropna()
                if hh.empty or want is None:
                    return None
                ix_et = hh.index.tz_convert(ET) if hh.index.tz is not None else hh.index.tz_localize(ET)
                ok = [i for i in range(len(hh)) if ix_et[i].date() <= want]
                if ok:
                    return float(hh.iloc[ok[-1]])
            except Exception:
                pass
            return None

        # Data dell'ultima seduta RTH completata: oggi dopo le 16:00 ET
        # (chiusure fresche per la sessione Globex), altrimenti il precedente
        # giorno con barre. Una sola variazione al giorno, alla chiusura.
        now_et = datetime.now(ET)
        today_et = now_et.date()
        bar_dates = sorted({ts.date() for ts in idx_et})
        prev_dates = [d for d in bar_dates if d < today_et]
        basis_date = (today_et if (now_et.hour >= 16 and today_et in bar_dates)
                      else (prev_dates[-1] if prev_dates else None))
        fut_basis_close = None
        if basis_date is not None:
            m_basis = np.array([ts.date() == basis_date for ts in idx_et]) & mask_rth
            if m_basis.any():
                fut_basis_close = float(cl[m_basis][-1])

        idx_hist_tkr = "^SPX" if fut == "ES" else "^NDX"
        idx_sym = "SPX" if fut == "ES" else "NDX"
        spx = options_data.get("symbols", {}).get(idx_sym, {})
        spx_spot = float(spx.get("spot", 0) or 0)
        idx_close = close_on(idx_hist_tkr, basis_date)
        etf_close = close_on(sym, basis_date)
        if fut_basis_close and idx_close and etf_close:
            ratio = fut_basis_close / etf_close
            index_to_fut = fut_basis_close / idx_close
        else:
            # fallback (storia quotidiana mancante): abbinamento live — meglio
            # di niente, ma i livelli indice possono scivolare di qualche
            # punto fra i giri finché le chiusure non tornano disponibili.
            ratio = es_spot / spot_etf if spot_etf else 10.0
            index_to_fut = (es_spot / spx_spot) if spx_spot else None

        # Catena sana? OI aggregata oltre la soglia e nessun flag degraded:
        # con la catena rotta il flip esce a +17% dallo spot e il max pain a
        # −60% (min() su pareggio totale di OI zero) — meglio nessun livello.
        oi_tot = sum(int(o.get("oi", 0) or 0)
                     for e in sd.get("expiries", [])
                     for o in (e.get("options") or []))
        degraded = (sd.get("data_quality") == "degraded" or oi_tot < min_chain_oi(sym))
        if degraded:
            print(f"day_plan: catena {sym} degradata (OI tot {oi_tot:,}) → "
                  f"livelli opzioni saltati")
            walls, flip, flip0, top_gamma, gex_regime = [], None, [], [], None
            tg_b = {"0dte": [], "week": [], "all": []}
            flips_b, regs_b, bands_b = {}, {}, {}
            prof_b = {"0dte": [], "week": [], "all": []}
            mp = {"nearest": {}, "all": {}}
        else:
            tg_b, flips_b, regs_b, bands_b = top_gamma_by_bucket(
                sd.get("expiries", []), spot_etf, sym)
            walls, flip, flip0, top_gamma, gex_regime = compute_option_levels(
                sd.get("expiries", []), spot_etf, sym, bands=bands_b)[:5]
            mp = max_pain(sd.get("expiries", []), spot_etf)
            prof_b = gex_profile_by_bucket(sd.get("expiries", []), spot_etf, window_pct=0.20)
        # GEX flip ricalcolato qui dai per-strike già presenti nel JSON walls
        # (spx/spx_spot definiti nel blocco ratio, prima della catena indice)

        # --- catena INDICE (SPX/NDX): seconda fonte di livelli opzioni ---
        # Opzioni europee a regolamento in contanti: i dealer coprono la gamma
        # direttamente sui futures ES/NQ. Stessa soglia OI e stesso scarto
        # della catena ETF: se degradata, la fonte indice resta assente e la
        # UI continua a mostrare gli ETF.
        index_opts = None
        index_aggr: dict = {}
        idx_sym = "SPX" if fut == "ES" else "NDX"
        if index_to_fut and spx.get("expiries"):
            oi_idx = sum(int(o.get("oi", 0) or 0)
                         for e in spx.get("expiries", [])
                         for o in (e.get("options") or []))
            deg_idx = (spx.get("data_quality") == "degraded" or oi_idx < min_chain_oi(idx_sym))
            if deg_idx:
                print(f"day_plan: catena {idx_sym} degradata "
                      f"(OI tot {oi_idx:,}) → livelli da indici saltati")
            else:
                tg_bi, flips_bi, regs_bi, bands_bi = top_gamma_by_bucket(
                    spx.get("expiries", []), spx_spot, idx_sym)
                walls_i, flip_i, flip0_i, tg_i, reg_i = compute_option_levels(
                    spx.get("expiries", []), spx_spot, idx_sym, bands=bands_bi)[:5]
                mp_i = max_pain(spx.get("expiries", []), spx_spot)
                i_ratio = index_to_fut
                # PRIMA di index_opts: index_opts usa flips_bi (flip ≤7gg della
                # catena indice). Invertire l'ordine = UnboundLocalError, lo
                # script muore prima di scrivere il piano e il workflow lo
                # nasconde con `|| true` (piano fermo, options_data fresco).
                index_opts = {"walls": walls_i, "flip": flip_i, "flip0": flip0_i,
                              "flipw": flips_bi.get("week"), "ratio": i_ratio,
                              "bands": bands_bi}
                prof_bi = gex_profile_by_bucket(spx.get("expiries", []), spx_spot, window_pct=0.20)
                index_aggr = {
                    "gamma_regime_index": reg_i,
                    # Normalizzati a 5pt per confluenza con ETF
                    "top_gamma_index": [
                        {**t, "strike_fut": _r5(t["strike"] * i_ratio)} for t in tg_i
                    ],
                    "gex_profile_index": [
                        {**e, "s": round(e["s"] * i_ratio, 1)} for e in prof_bi["all"]
                    ],
                    "gex_profile_0dte_index": [
                        {**e, "s": round(e["s"] * i_ratio, 1)} for e in prof_bi["0dte"]
                    ],
                    "gex_profile_week_index": [
                        {**e, "s": round(e["s"] * i_ratio, 1)} for e in prof_bi["week"]
                    ],
                    # Variante binnata su griglia 25pt (stessa del profilo ETF):
                    # usata SOLO dalla modalità 'Entrambi' della UI, che somma
                    # ETF+indice per strike identico (con strike raw 5-pt la
                    # merge non troverebbe mai corrispondenze). La vista
                    # 'indice' usa i profili raw qui sopra, confrontabili
                    # per-strike con InsiderFinance.
                    "gex_profile_index_binned": _bin_profile(
                        [{**e, "s": round(e["s"] * i_ratio, 1)} for e in prof_bi["all"]], 25),
                    "gex_profile_0dte_index_binned": _bin_profile(
                        [{**e, "s": round(e["s"] * i_ratio, 1)} for e in prof_bi["0dte"]], 25),
                    "gex_profile_week_index_binned": _bin_profile(
                        [{**e, "s": round(e["s"] * i_ratio, 1)} for e in prof_bi["week"]], 25),
                    # Normalizzati a 5pt per confluenza con ETF
                    "top_gamma_0dte_index": [
                        {**t, "strike_fut": _r5(t["strike"] * i_ratio)} for t in tg_bi["0dte"]
                    ],
                    "top_gamma_week_index": [
                        {**t, "strike_fut": _r5(t["strike"] * i_ratio)} for t in tg_bi["week"]
                    ],
                    "gex_flip_0dte_index": (_r5(flip0_i * i_ratio) if flip0_i else None),
                    # flip e regime della borsa ≤7gg (scala futures, come gli altri)
                    "gex_flip_week_index": (
                        _r5(flips_bi["week"] * i_ratio) if flips_bi.get("week") else None),
                    "gamma_regime_week_index": regs_bi.get("week"),
                    "gamma_regime_0dte_index": regs_bi.get("0dte"),
                    "idx_to_fut_ratio": (round(index_to_fut, 6) if index_to_fut else None),
                    "max_pain_nearest_index": (
                        _r5(mp_i["nearest"]["strike"] * i_ratio)
                        if mp_i.get("nearest", {}).get("strike") else None),
                    "max_pain_all_index": (
                        _r5(mp_i["all"]["strike"] * i_ratio)
                        if mp_i.get("all", {}).get("strike") else None),
                }

        plan = build_plan(idx_et, hist["Open"].values, h, l,
                          hist["Close"].values,
                          hist["Volume"].values.astype(float),
                          futures=fut, walls_etf=walls, spot_etf=spot_etf,
                          gex_flip_etf=flip, spot_fut_ratio=ratio,
                          index_to_fut=index_to_fut, gex_flip0_etf=flip0,
                          gex_flipw_etf=flips_b.get("week"),
                          index_opts=index_opts, bands_etf=bands_b)
        plan.update(index_aggr)
        plan["spot_etf"] = spot_etf
        plan["gamma_regime"] = gex_regime
        # --- flip e regime PER BORSA (0dte / week / all) -------------------
        # Il flip è il confine di regime: se la UI è su 0DTE deve essere lo
        # zero-crossing delle scadenze di oggi, non quello strutturale (e così
        # per ≤7gg). Prima esistevano solo 'all' (livello GEX-FLIP) e 0dte: la
        # borsa ≤7gg mostrava il flip sbagliato.
        plan["gamma_regime_0dte"] = regs_b.get("0dte")
        plan["gamma_regime_week"] = regs_b.get("week")
        # --- il quaderno del regime (16/11): curva di esposizione per le TRE
        # borse di entrambe le catene. È LA fonte di regime e flip: i due numeri
        # vengono dalla stessa curva, quindi il badge non può più dire "short"
        # col prezzo sopra il confine. `flip_below`/`flip_above` = i confini della
        # ZONA di regime in cui sta il prezzo (None = la zona esce dalla banda).
        plan["gamma"] = {
            "method": GEX_METHOD,
            "note": ("G(P) = Σ ±OI·100·P²·Γ_BS(P) rivalutata a ogni prezzo; "
                     f"banda ±{int(GEX_CURVE_BAND * 100)}%, r={GEX_R}, q={GEX_Q}"),
            "etf": {"symbol": sym,
                    **{b: _band_fut((bands_b or {}).get(b), ratio)
                       for b in ("all", "week", "0dte")}},
            "index": ({"symbol": idx_sym,
                       **{b: _band_fut((bands_bi or {}).get(b), i_ratio)
                          for b in ("all", "week", "0dte")}}
                      if index_opts and index_opts.get("bands") else None),
        }
        if flips_b.get("week"):
            plan["gex_flip_week"] = _r5(flips_b["week"] * ratio)
            plan["gex_flip_week_native"] = round(flips_b["week"], 4)
        # Il ratio ETF→futures va SEMPRE pubblicato: la UI lo usa per il doppio
        # prezzo (tooltip dell'istogramma e righe della scala in vista ETF) e per
        # ricavare gli strike nativi. Prima stava dentro `if flip0:` → nei giorni
        # senza scadenze 0DTE (weekend, festivi, catena corta) il campo spariva e
        # la vista ETF restava senza traduzione in futures, mentre la vista
        # indici continuava a funzionare (bug scoperto 14/11).
        plan["etf_to_fut_ratio"] = round(ratio, 6)
        if flip0:
            plan["gex_flip_0dte"] = _r5(flip0 * ratio)
        if flip0 is not None:
            plan["gex_flip_0dte_native"] = round(flip0, 4)
        if flip is not None:
            plan["gex_flip_native"] = round(flip, 4)
        if degraded:
            plan["read"].insert(0, "⚠️ Catena opzioni non disponibile in questo "
                                 "snapshot (OI assente): la scala mostra solo "
                                 "i livelli prezzo/AMT. I muri gamma torneranno "
                                 "appena la sorgente OI torna disponibile.")
        # max pain + top gamma in scala futures (+ borse 0dte/week per il
        # selettore maturità della scala) + profilo GEX completo per l'istogramma.
        # I profili ETF (griglia a $1 di SPY/QQQ) vengono AGGREGATI in bin da
        # 25 pt ES: senza aggregazione l'istogramma è rado (centinaia di
        # barrette da pochi contratti). La catena indici ha strike nativi da
        # 5/25/100 pt: resta a griglia nativa.
        # Profili ETF in scala NATIVA (SPY/QQQ): confronto 1:1 con
        # InsiderFinance (che lista gli strike in scala ETF). La variante
        # _binned (convertita in scala futures + bin 25) serve SOLO alla
        # modalità 'Entrambi', che somma ETF+indici per strike identico.
        plan["gex_profile"] = prof_b["all"]
        plan["gex_profile_0dte"] = prof_b["0dte"]
        plan["gex_profile_week"] = prof_b["week"]
        plan["gex_profile_binned"] = _bin_profile([
            {**e, "s": round(e["s"] * ratio, 1)} for e in prof_b["all"]
        ], 25)
        plan["gex_profile_0dte_binned"] = _bin_profile([
            {**e, "s": round(e["s"] * ratio, 1)} for e in prof_b["0dte"]
        ], 25)
        plan["gex_profile_week_binned"] = _bin_profile([
            {**e, "s": round(e["s"] * ratio, 1)} for e in prof_b["week"]
        ], 25)
        # Normalizzati a 5pt per confluenza ETF↔IDX nella scala
        plan["top_gamma_0dte"] = [
            {**t, "strike_fut": _r5(t["strike"] * ratio)} for t in tg_b["0dte"]
        ]
        plan["top_gamma_week"] = [
            {**t, "strike_fut": _r5(t["strike"] * ratio)} for t in tg_b["week"]
        ]
        if mp.get("nearest", {}).get("strike"):
            plan["max_pain_nearest"] = _r5(mp["nearest"]["strike"] * ratio)
            plan["max_pain_nearest_native"] = round(mp["nearest"]["strike"], 2)
        if mp.get("all", {}).get("strike"):
            plan["max_pain_all"] = _r5(mp["all"]["strike"] * ratio)
            plan["max_pain_all_native"] = round(mp["all"]["strike"], 2)
        plan["top_gamma"] = [
            {**t, "strike_fut": _r5(t["strike"] * ratio)} for t in top_gamma
        ]
        plans[fut] = plan
        bars_data[fut] = (idx_et, h, l, cl)
        if args.show:
            print(f"\n=== {fut} — spot {plan['last_price']} ===")
            for lv in plan["levels"]:
                print(f"  {lv['price']:9.1f}  {lv['nome_it']:32s} [{lv['kind']}/{lv['source']}]")
        if args.show:
            print(f"\n=== {fut} — spot {plan['last_price']} ===")
            for lv in plan["levels"]:
                print(f"  {lv['price']:9.1f}  {lv['nome_it']:32s} [{lv['kind']}/{lv['source']}]")

    # --- TRACK RECORD: al cambio di giornata ET si giudica il piano
    # ripristinato (quello con cui si apre la giornata) sulle barre
    # COMPLETE dell'ultimo giorno non ancora giudicato. Il marcatore
    # last_scored è indispensabile: i run 24/7 rigenerano il piano anche
    # di notte, quindi il confronto "data generazione < oggi" (che è un
    # confronto UTC vs ET) non sarebbe MAI vero al momento giusto.
    # Regola STRICT (> last_scored): il giorno giudicato non si ri-giudica
    # la sera stessa, e i weekend senza barre non bloccano il ciclo.
    # Ogni verdetto porta con sé lo SNAPSHOT dello stato (regime, scenario,
    # divergenza SPY/QQQ): è il dataset per i futuri decision model.
    scored_target = None
    try:
        if plans and os.path.exists(PLAN_PATH):
            with open(PLAN_PATH) as pf:
                old_all = json.load(pf)
            for fut, (idx_et, h, l, cl) in bars_data.items():
                today = max(idx_et).date()
                old_plan = (old_all.get("plans") or {}).get(fut)
                bar_dates = sorted({d.date() for d in idx_et})
                target = max((d for d in bar_dates
                              if d < today and (last_scored is None or d > last_scored)),
                             default=None)
                if not (old_plan and target):
                    continue
                # SOLO i livelli che la scala mostra davvero: fonti opzioni
                # + max pain + muri gamma top-3 per lato (le sintesi che fa
                # la UI). VWAP/VAH/overnight non sono più nella scala e non
                # devono accumulare fiducia.
                old_levels = [lv for lv in old_plan.get("levels", [])
                              if lv.get("source") == "options"]
                if old_plan.get("max_pain_nearest"):
                    old_levels.append({"name": "MAXPAIN-0DTE",
                                       "nome_it": "Max Pain scadenza vicina",
                                       "price": float(old_plan["max_pain_nearest"]),
                                       "kind": "magnet"})
                if old_plan.get("max_pain_all"):
                    old_levels.append({"name": "MAXPAIN-ALL",
                                       "nome_it": "Max Pain (tutte le scadenze)",
                                       "price": float(old_plan["max_pain_all"]),
                                       "kind": "magnet"})
                # sintetici da catena INDICE: track record separato per fonte
                if old_plan.get("max_pain_nearest_index"):
                    old_levels.append({"name": "MAXPAIN-0DTE-IDX",
                                       "nome_it": "Max Pain scadenza vicina (indici)",
                                       "price": float(old_plan["max_pain_nearest_index"]),
                                       "kind": "magnet"})
                if old_plan.get("max_pain_all_index"):
                    old_levels.append({"name": "MAXPAIN-ALL-IDX",
                                       "nome_it": "Max Pain (tutte le scadenze, indici)",
                                       "price": float(old_plan["max_pain_all_index"]),
                                       "kind": "magnet"})
                spot_ref = float(old_plan.get("last_price") or 0)
                for tname, tsrc in (("MURO-GAMMA", old_plan.get("top_gamma")),
                                    ("MURO-GAMMA-IDX", old_plan.get("top_gamma_index"))):
                    # STESSA selezione della scala (addGammaWalls): migliore
                    # sopra + migliore sotto SEMPRE, riempimento fino a 4 —
                    # il track record misura ciò che la UI mostra davvero.
                    tg = [x for x in (tsrc or []) if x.get("strike_fut")]
                    above = sorted([x for x in tg if x.get("strike_fut", 0) >= spot_ref],
                                   key=lambda t: -abs(t.get("net_gex", 0) or 0))
                    below = sorted([x for x in tg if x.get("strike_fut", 0) < spot_ref],
                                   key=lambda t: -abs(t.get("net_gex", 0) or 0))
                    picked: list = []
                    if above:
                        picked.append(above[0])
                    if below:
                        picked.append(below[0])
                    for x in sorted(above[1:] + below[1:],
                                    key=lambda t: -abs(t.get("net_gex", 0) or 0)):
                        if len(picked) >= 4:
                            break
                        picked.append(x)
                    for t in picked:
                        zone = round(t["strike_fut"] / 5) * 5
                        old_levels.append({"name": tname,
                                           "nome_it": f"Muro gamma a {zone:.0f}",
                                           "price": float(zone),
                                           "kind": ("barrier" if t.get("sign") == "long"
                                                    else "trigger")})

                # snapshot dello stato MISURATO SUL PIANO GIUDICATO
                o_other = (old_all.get("plans") or {}).get("NQ" if fut == "ES" else "ES") or {}
                my_flip = next((lv["price"] for lv in old_plan.get("levels", [])
                                if lv.get("name") == "GEX-FLIP"), None)
                o_flip = next((lv["price"] for lv in o_other.get("levels", [])
                               if lv.get("name") == "GEX-FLIP"), None)
                regime = other_regime = None
                if my_flip and spot_ref:
                    regime = "long" if spot_ref > my_flip else "short"
                if o_flip and o_other.get("last_price"):
                    other_regime = "long" if o_other["last_price"] > o_flip else "short"
                mp = old_plan.get("max_pain_nearest")
                near_mp = bool(mp is not None and spot_ref
                               and abs(mp - spot_ref) / spot_ref < 0.004)
                divergence = bool(regime and other_regime and regime != other_regime) or None
                if regime == "long" and near_mp:
                    scenario = "compressione"
                elif regime == "short" and not near_mp:
                    scenario = "trend"
                elif regime:
                    scenario = "ibrido"
                else:
                    scenario = None
                snap = {"date": target.isoformat(), "spot": spot_ref,
                        "regime": regime, "divergence": divergence,
                        "near_mp": near_mp if mp is not None else None,
                        "scenario": scenario,
                        "expiry_day": bool(old_plan.get("gex_flip_0dte"))}

                results = update_stats({**old_plan, "levels": old_levels},
                                       idx_et, h, l, cl, stats, prefix=fut,
                                       only_date=target)
                n_new = 0
                for r in results:
                    if not r.get("touched"):
                        continue
                    n_new += 1
                    s = stats.get(f"{fut}:{r['name']}")
                    if s is None:
                        continue
                    hist = s.setdefault("history", [])
                    hist.append({**snap, "kind": r.get("kind"),
                                 "dist_pts": (round(r["price"] - spot_ref)
                                              if spot_ref else None),
                                 "held": bool(r["held"])})
                    del hist[:-400]   # cap per livello
                print(f"day_plan: track record +{n_new} verdetti (giornata {target})")
                scored_target = target
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"day_plan: scoring saltato ({e})")

    os.makedirs(os.path.dirname(PLAN_PATH), exist_ok=True)
    with open(PLAN_PATH, "w") as f:
        json.dump({"version": VERSION, "generated_at": datetime.now(timezone.utc).isoformat(),
                   "plans": plans}, f, indent=1)
    save_stats(stats, last_scored=(scored_target or last_scored))
    print(f"day_plan scritto → {PLAN_PATH} (stats: {sum(v['n'] for v in stats.values())} occorrenze)")


if __name__ == "__main__":
    main()
