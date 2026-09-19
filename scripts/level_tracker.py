#!/usr/bin/env python3
"""Level track record — closes the self-improvement loop for key levels.

Mirrors forecast_tracker.py, but for the DAY-TRADING LEVELS (put/call walls,
gamma-classified pin/trigger) shown in the Mercato tab:

    levels issued → matured (24h) → scored against realized price bars
        → per-kind bounce/break stats → data/level_report.json → UI

WHY: the Sep-2026 one-shot validation (scratch/validate_levels.py) showed raw
OI walls hold ~42% of touches vs 63% for RANDOM levels, while long-gamma
(pin) strikes rejected ~80%. One snapshot is not statistics: this tracker
accumulates the same measurement continuously, per level kind, so the UI can
show which level families actually repel price — and the ranking can be
re-tuned on evidence instead of theory.

Pipeline (all modes run in the default `all`):
  snapshot  compute the day-trading levels for SPY/QQQ from the fresh
            options_data.json (parity port of wallService + keyLevelService:
            own-side walls, <=5% distance, 0.4% spacing, top-5 per side,
            pin/trigger from netGEX sign) and append ONE record per
            (symbol, strike, type, UTC date) — re-issuing the same level on
            the same day adds no information (same underlying OI).
  score     pending records whose 24h window has passed are scored on 5m
            bars (yfinance, one download per symbol): TOUCH = price entered
            the +-band; then within H bars BOUNCE (adverse move >= rejection
            without breaking) or BREAK (crossed beyond buffer first).
            Untouched levels are recorded as untouched — never as failures.
  report    aggregate scored records per (symbol, type, gamma_sign):
            bounce rate with Wilson CI + exact binomial verdict vs the 50%
            no-edge null, gated on n_touched >= MIN_TOUCHED.

Usage:
    python scripts/level_tracker.py                 # all modes
    python scripts/level_tracker.py --mode score    # just score pending
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

HISTORY_PATH = os.path.join(SCRIPTS_DIR, "../data/level_history.json")
REPORT_PATH = os.path.join(SCRIPTS_DIR, "../data/level_report.json")
OPTIONS_PATH = os.path.join(SCRIPTS_DIR, "../data/options_data.json")

SCHEMA_VERSION = 1
RETENTION_DAYS = 120
PER_GROUP_CAP = 4000

# Level construction (parity with services/wallService.ts + keyLevelService.ts)
LAMBDA = 2.0            # Laplacian distance decay, % scale
MAX_DIST_PCT = 5.0      # day-trading radius around spot
SPACING_PCT = 0.4       # min gap between levels on the same side
LEVELS_PER_SIDE = 5
WALL_CAP_RATIO = (0.3, 3.0)

# Scoring
WINDOW_HOURS = 24       # observation window per level
BAND_PCT = 0.10         # touch band, % of spot at issue
BREAK_BUF_PCT = 0.15    # beyond-level cross that counts as break
REJECT_PCT = 0.20       # adverse move that counts as bounce
H_BARS = 24             # 5m bars after touch (2h) to resolve bounce/break
MAX_PENDING_AGE_DAYS = 7  # older unscored levels are dropped (data gaps)

# Verdicts
MIN_TOUCHED = 20
ALPHA = 0.05

SYMBOLS = ("SPY", "QQQ")


# ---------------------------------------------------------------------------
# Level construction (parity port)
# ---------------------------------------------------------------------------

def _dte_weights(dte: int):
    if dte == 0:
        return (0.25, 0.75)
    if dte <= 3:
        return (0.50, 0.50)
    return (0.70, 0.30)


def compute_levels(snap: dict, symbol: str) -> list:
    """Day-trading levels for one symbol from an options_data.json snapshot."""
    sd = snap.get("symbols", {}).get(symbol)
    if not sd:
        return []
    spot = float(sd["spot"])
    gen = snap.get("generated")
    gen_dt = datetime.fromisoformat(gen) if gen else datetime.now(timezone.utc)
    if gen_dt.tzinfo is None:
        gen_dt = gen_dt.replace(tzinfo=timezone.utc)

    put_map: dict = {}
    call_map: dict = {}
    for exp in sd.get("expiries", []):
        edate = datetime.fromisoformat(exp["date"])
        if edate.tzinfo is None:
            edate = edate.replace(tzinfo=timezone.utc)
        dte = max(0, math.ceil((edate - gen_dt).total_seconds() / 86400))
        tw = 1.0 / (1.0 + dte / 7.0)
        for o in exp.get("options", []):
            m = put_map if o["side"] == "PUT" else call_map
            rec = m.setdefault(o["strike"], {"oi": 0.0, "vol": 0.0, "dte": dte})
            rec["oi"] += o["oi"] * tw
            rec["vol"] += o["vol"] * tw
            rec["dte"] = min(rec["dte"], dte)

    def score_strike(strike, rec):
        wo, wv = _dte_weights(rec["dte"])
        dist_pct = abs(strike - spot) / spot * 100.0
        activity = rec["oi"] * wo + rec["vol"] * wv
        return activity * math.exp(-dist_pct / LAMBDA)

    def top_levels(m, side):
        rows = []
        for strike, rec in m.items():
            if rec["oi"] <= 0 and rec["vol"] <= 0:
                continue
            ratio = strike / spot if spot else 0
            if ratio < WALL_CAP_RATIO[0] or ratio > WALL_CAP_RATIO[1]:
                continue
            if side == "put" and strike > spot:
                continue
            if side == "call" and strike < spot:
                continue
            dist_pct = abs(strike - spot) / spot * 100.0
            if dist_pct > MAX_DIST_PCT:
                continue
            rows.append((strike, score_strike(strike, rec)))
        rows.sort(key=lambda x: -x[1])
        picked = []
        min_gap = spot * SPACING_PCT / 100.0
        for strike, score in rows:
            if all(abs(strike - p) >= min_gap for p, _ in picked):
                picked.append((strike, score))
            if len(picked) == LEVELS_PER_SIDE:
                break
        return sorted(picked)

    levels = []
    for side, m, ltype in (("put", put_map, "support"), ("call", call_map, "resistance")):
        for strike, score in top_levels(m, side):
            rec = m[strike]
            dist_pct = abs(strike - spot) / spot * 100.0
            # netGEX per strike (mirror wallService): sum oi*gamma*100*spot^2*sign
            levels.append({
                "symbol": symbol,
                "strike": float(strike),
                "type": ltype,
                "strength": round(min(100.0, score), 2),
                "net_gex": None,  # filled by caller if gamma data available
                "distance_pct": round(dist_pct, 3),
                "spot_at_issue": spot,
            })
    return levels


def annotate_gamma_sign(levels: list, snap: dict, symbol: str) -> None:
    """Fill net_gex + gamma_sign per level from the per-strike GEX aggregate.

    Mirrors wallService: gex = sum(oi * gamma * 100 * spot^2 * sign * tw) with
    sign +1 for calls, -1 for puts; netGEX = callGEX - putGEX at the strike.
    Falls back to 'trigger' classification when gamma data is unavailable
    (put-dominated strikes below spot are the common case there).
    """
    sd = snap.get("symbols", {}).get(symbol)
    if not sd:
        return
    spot = float(sd["spot"])
    gen = snap.get("generated")
    gen_dt = datetime.fromisoformat(gen) if gen else datetime.now(timezone.utc)
    if gen_dt.tzinfo is None:
        gen_dt = gen_dt.replace(tzinfo=timezone.utc)

    net: dict = {}
    have_gamma = False
    for exp in sd.get("expiries", []):
        edate = datetime.fromisoformat(exp["date"])
        if edate.tzinfo is None:
            edate = edate.replace(tzinfo=timezone.utc)
        dte = max(0, math.ceil((edate - gen_dt).total_seconds() / 86400))
        tw = 1.0 / (1.0 + dte / 7.0)
        for o in exp.get("options", []):
            gamma = o.get("gamma")
            if not gamma:
                continue
            have_gamma = True
            sign = 1.0 if o["side"] == "CALL" else -1.0
            v = o["oi"] * gamma * 100.0 * spot * spot * sign * tw
            net[o["strike"]] = net.get(o["strike"], 0.0) + v

    for lv in levels:
        if have_gamma:
            g = net.get(lv["strike"], 0.0)
            lv["net_gex"] = round(g, 2)
            lv["gamma_sign"] = "pin" if g >= 0 else "trigger"
        else:
            lv["net_gex"] = None
            lv["gamma_sign"] = "trigger"


# ---------------------------------------------------------------------------
# Snapshot mode
# ---------------------------------------------------------------------------

def snapshot_levels(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    if not os.path.exists(OPTIONS_PATH):
        print(f"level_tracker: options_data.json not found; nothing to snapshot.")
        return 0
    with open(OPTIONS_PATH) as f:
        snap = json.load(f)

    history = _load_history()
    # Dedupe index: same (symbol, strike, type, UTC date) already recorded.
    day = now.date().isoformat()
    seen = {
        (r["symbol"], r["strike"], r["type"])
        for r in history
        if r.get("issued_at", "")[:10] == day
    }

    added = 0
    for symbol in SYMBOLS:
        levels = compute_levels(snap, symbol)
        annotate_gamma_sign(levels, snap, symbol)
        for lv in levels:
            key = (symbol, lv["strike"], lv["type"])
            if key in seen:
                continue
            seen.add(key)
            history.append({
                "v": SCHEMA_VERSION,
                "issued_at": now.isoformat(),
                "symbol": symbol,
                "strike": lv["strike"],
                "type": lv["type"],
                "gamma_sign": lv["gamma_sign"],
                "net_gex": lv["net_gex"],
                "strength": lv["strength"],
                "distance_pct": lv["distance_pct"],
                "spot_at_issue": lv["spot_at_issue"],
                # scored fields
                "touched": None,
                "outcome": None,          # 'bounce' | 'break' | 'untouched'
                "n_touch_sessions": None,
                "scored_at": None,
            })
            added += 1

    if added:
        history = _prune(history)
        _save_history(history)
    print(f"level_tracker: snapshot — {added} nuovi livelli (storico: {len(history)}).")
    return added


# ---------------------------------------------------------------------------
# Scoring mode
# ---------------------------------------------------------------------------

def score_pending_levels(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    history = _load_history()
    pending = [r for r in history if r.get("outcome") is None]
    to_score = []
    for r in pending:
        issued = _parse(r.get("issued_at"))
        if issued is None:
            continue
        age = now - issued
        if age >= timedelta(hours=WINDOW_HOURS):
            to_score.append((r, issued))
        elif age > timedelta(days=MAX_PENDING_AGE_DAYS):
            r["outcome"] = "expired_unscored"
            r["scored_at"] = now.isoformat()

    if not to_score:
        print("level_tracker: nessun livello da valutare.")
        _save_history(history)
        return 0

    try:
        import yfinance as yf
    except ImportError:
        print("level_tracker: yfinance non disponibile; scoring rimandato.")
        return 0

    by_symbol: dict = defaultdict(list)
    for r, issued in to_score:
        by_symbol[r["symbol"]].append((r, issued))

    scored = 0
    for symbol, entries in by_symbol.items():
        start = min(i for _, i in entries).astimezone(timezone.utc) - timedelta(hours=1)
        try:
            df = yf.Ticker(symbol).history(
                start=start, end=now,
                interval="5m", prepost=False,
            )
        except Exception as e:
            print(f"level_tracker: download barre {symbol} fallito ({e}); riprovo al prossimo run.")
            continue
        if df.empty:
            print(f"level_tracker: nessuna barra {symbol}; riprovo al prossimo run.")
            continue
        idx = df.index.tz_convert("UTC") if df.index.tz is not None else df.index.tz_localize("UTC")
        highs = df["High"].values
        lows = df["Low"].values
        utcs = [t.to_pydatetime() for t in idx]

        for r, issued in entries:
            res = _score_one(r, issued, now, utcs, highs, lows)
            if res == "scored":
                scored += 1
            elif res == "wait":
                pass  # bars not covering the window yet → stay pending

    _save_history(history)
    print(f"level_tracker: score — {scored} livelli valutati.")
    return scored


def _score_one(rec, issued: datetime, now: datetime, utcs, highs, lows) -> str:
    """Score one record on the provided bars. Returns 'scored'|'wait'|'skip'."""
    window_end = issued + timedelta(hours=WINDOW_HOURS)
    if window_end > now:
        return "skip"

    spot = rec["spot_at_issue"]
    L = rec["strike"]
    band = max(L * BAND_PCT / 100.0, 0.01)
    brk = max(L * BREAK_BUF_PCT / 100.0, 0.015)
    rej = max(L * REJECT_PCT / 100.0, 0.02)

    in_window = [k for k, t in enumerate(utcs) if issued <= t <= window_end]
    if not in_window:
        return "wait"  # no bars yet (e.g. weekend right after issue) → retry

    support = rec["type"] == "support"
    touches = 0
    bounces = 0
    breaks = 0
    seen_days = set()
    for i in in_window:
        day = utcs[i].astimezone(_ET).date()
        if day in seen_days:
            continue
        if not (lows[i] <= L + band and highs[i] >= L - band):
            continue
        seen_days.add(day)
        touches += 1
        resolved = False
        for j in range(i + 1, min(i + 1 + H_BARS, len(utcs))):
            if support:
                if lows[j] <= L - brk:
                    breaks += 1; resolved = True; break
                if highs[j] >= L + rej:
                    bounces += 1; resolved = True; break
            else:
                if highs[j] >= L + brk:
                    breaks += 1; resolved = True; break
                if lows[j] <= L - rej:
                    bounces += 1; resolved = True; break
        if not resolved:
            # window ended mid-resolution: count only if decisively beyond
            pass

    rec["touched"] = touches > 0
    rec["n_touch_sessions"] = touches
    if bounces > breaks:
        rec["outcome"] = "bounce"
    elif breaks > bounces:
        rec["outcome"] = "break"
    elif bounces == breaks == 0:
        rec["outcome"] = "untouched"
    else:
        # equal bounces/breaks across sessions: net zero edge, call it a wash
        rec["outcome"] = "untouched"
    rec["scored_at"] = now.isoformat()
    return "scored"


_ET = ZoneInfo("America/New_York")  # session-day bucketing (1 touch per session)


# ---------------------------------------------------------------------------
# Report mode
# ---------------------------------------------------------------------------

def _wilson_ci(successes: int, n: int):
    if n <= 0:
        return None
    z = 1.96
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denom
    return [round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)]


def _binom_two_sided_p(k: int, n: int, p: float = 0.5) -> float:
    if n <= 0:
        return 1.0
    def pmf(i):
        return math.comb(n, i) * (p ** i) * ((1 - p) ** (n - i))
    pk = pmf(k)
    total = sum(pm for pm in (pmf(i) for i in range(n + 1)) if pm <= pk + 1e-15)
    return min(1.0, total)


def build_report(now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    history = _load_history()
    scored = [r for r in history if r.get("outcome") in ("bounce", "break", "untouched")]

    groups: dict = defaultdict(list)
    for r in scored:
        groups[(r["symbol"], r["type"], r.get("gamma_sign") or "unknown")].append(r)

    out = {}
    for (symbol, ltype, sign), rows in sorted(groups.items()):
        touched_rows = [r for r in rows if r.get("touched")]
        n_touched = len(touched_rows)
        decisive = [r for r in touched_rows if r["outcome"] in ("bounce", "break")]
        bounces = sum(1 for r in decisive if r["outcome"] == "bounce")
        breaks = sum(1 for r in decisive if r["outcome"] == "break")
        n_dec = bounces + breaks
        rate = bounces / n_dec if n_dec else None
        p = _binom_two_sided_p(bounces, n_dec) if n_dec else None
        if n_touched < MIN_TOUCHED or p is None or p >= ALPHA:
            verdict = "NO_DATA"
        elif rate > 0.5:
            verdict = "BOUNCE_EDGE"   # the family repels price
        else:
            verdict = "BREAK_EDGE"    # the family gets violated
        out[f"{symbol}|{ltype}|{sign}"] = {
            "n_issued": len(rows),
            "n_scored": len(rows),
            "n_touched": n_touched,
            "bounces": bounces,
            "breaks": breaks,
            "bounce_rate": round(rate, 4) if rate is not None else None,
            "ci95": _wilson_ci(bounces, n_dec),
            "p_value": round(p, 5) if p is not None else None,
            "verdict": verdict,
        }

    return {
        "version": SCHEMA_VERSION,
        "generated_at": now.isoformat(),
        "min_touched_for_verdict": MIN_TOUCHED,
        "total_issued": len(history),
        "total_scored": len([r for r in history if r.get("outcome") not in (None, "expired_unscored")]),
        "note": ("bounce_rate = frazione di touch in cui il prezzo ha respinto il livello "
                 "senza romperlo (finestra 24h, touch 1/sessione). Verdetto vs ipotesi "
                 "nulla 50% (nessun effetto), binomiale esatta p<0.05, n>=20 touch."),
        "kinds": out,
    }


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

def _parse(value):
    if not value:
        return None
    d = datetime.fromisoformat(value)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d


def _load_history(path: str | None = None) -> list:
    path = path or HISTORY_PATH
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            history = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(history, list):
        return []
    return [r for r in history if isinstance(r, dict) and r.get("v", SCHEMA_VERSION) >= 1]


def _prune(history: list) -> list:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)).isoformat()
    kept = [r for r in history if (r.get("issued_at") or "") >= cutoff]
    groups: dict = defaultdict(list)
    for r in kept:
        groups[(r.get("symbol"), r.get("type"))].append(r)
    out = []
    for recs in groups.values():
        recs.sort(key=lambda r: r.get("issued_at") or "", reverse=True)
        out.extend(recs[:PER_GROUP_CAP])
    return out


def _save_history(history: list, path: str | None = None) -> None:
    path = path or HISTORY_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(history, f, indent=1)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="Level track record: snapshot/score/report")
    ap.add_argument("--mode", choices=["all", "snapshot", "score", "report"], default="all")
    args = ap.parse_args()
    now = datetime.now(timezone.utc)

    if args.mode in ("all", "snapshot"):
        snapshot_levels(now)
    if args.mode in ("all", "score"):
        score_pending_levels(now)
    if args.mode in ("all", "report"):
        rep = build_report(now)
        os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
        with open(REPORT_PATH, "w") as f:
            json.dump(rep, f, indent=2)
        n_kinds = len(rep["kinds"])
        print(f"level_tracker: report scritto ({n_kinds} famiglie) -> {REPORT_PATH}")


if __name__ == "__main__":
    main()
