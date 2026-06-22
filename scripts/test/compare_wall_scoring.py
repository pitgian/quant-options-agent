#!/usr/bin/env python3
"""
Visual comparison: OLD wall scoring vs NEW unified wall scoring.

Reads the local data/options_data.json (which still carries the 'expiries'
arrays) and recomputes put/call walls for each symbol using BOTH:

  OLD (current Python _score_and_rank):
      own_activity · max(0, 1 - α·cross_ratio) · exp(-(dist/1.5)^2)   α=0.35

  NEW (unified, this refactor):
      own_activity · exp(-|dist| / 2.0)

Both are normalized 0-100 per side per symbol, so the ranking (not the
absolute score) is what to compare.

Usage:
    .venv/bin/python scripts/test/compare_wall_scoring.py
"""
import json
import math
import importlib.util
from pathlib import Path
from collections import defaultdict

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FOD = ROOT / "scripts" / "fetch_options_data.py"
DATA = ROOT / "data" / "options_data.json"

CROSS_SIDE_ALPHA = 0.35
OLD_SIGMA = 1.5
NEW_LAMBDA = 2.0


def load_fod():
    spec = importlib.util.spec_from_file_location("fod", str(FOD))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def dte_weight(nearest_dte):
    if nearest_dte == 0:
        return 0.25, 0.75
    if nearest_dte <= 3:
        return 0.50, 0.50
    return 0.70, 0.30


def own_activity(own_oi, own_vol, opp_oi, opp_vol, nearest_dte):
    """Own-side activity (shared by both formulas)."""
    oi_w, vol_w = dte_weight(nearest_dte)
    own = own_oi * oi_w + own_vol * vol_w
    cross = opp_oi * oi_w + opp_vol * vol_w
    return own, cross


def score_old(own, cross, strike, spot):
    total = own + cross
    cross_ratio = cross / total if total > 0 else 0
    dist_pct = abs(strike - spot) / spot * 100
    decay = math.exp(-((dist_pct / OLD_SIGMA) ** 2))
    return own * max(0, 1 - CROSS_SIDE_ALPHA * cross_ratio) * decay


def score_new(own, strike, spot):
    dist_pct = abs(strike - spot) / spot * 100
    decay = math.exp(-dist_pct / NEW_LAMBDA)
    return own * decay


def build_candidates(expiries, spot, side):
    """
    Aggregate per-strike OI/Vol (with time decay) exactly like calculate_walls.
    side = 'put' (below spot) or 'call' (above spot).
    """
    mod = load_fod()
    strike_data = defaultdict(lambda: {"oi": 0.0, "vol": 0.0, "opp_oi": 0.0, "opp_vol": 0.0, "nearest_dte": 999})

    for exp in expiries:
        date = exp["date"]
        dte = mod.days_to_expiry(date)
        tw = 1.0 / (1.0 + dte / 7.0)
        for opt in exp["options"]:
            s = opt["strike"]
            opt_side = "put" if opt["side"] == "PUT" else "call"
            if opt_side == side:
                strike_data[s]["oi"] += opt["oi"] * tw
                strike_data[s]["vol"] += opt["vol"] * tw
                if dte < strike_data[s]["nearest_dte"]:
                    strike_data[s]["nearest_dte"] = dte
            else:
                strike_data[s]["opp_oi"] += opt["oi"] * tw
                strike_data[s]["opp_vol"] += opt["vol"] * tw

    # filter by side vs spot
    if side == "put":
        out = {s: d for s, d in strike_data.items() if s <= spot and (d["oi"] + d["vol"]) > 0}
    else:
        out = {s: d for s, d in strike_data.items() if s >= spot and (d["oi"] + d["vol"]) > 0}
    return out


def rank(cands, score_fn):
    scored = []
    for s, d in cands.items():
        own, _ = own_activity(d["oi"], d["vol"], d["opp_oi"], d["opp_vol"], d["nearest_dte"])
        scored.append((s, score_fn(own, d, score_fn)))
    # some score_fns need cross/spot, handle via closure
    return scored


def main():
    with open(DATA) as f:
        data = json.load(f)

    symbols = ["SPY", "QQQ", "SPX", "NDX"]
    for sym in symbols:
        sd = data["symbols"].get(sym)
        if not sd:
            continue
        spot = sd["spot"]
        expiries = sd.get("expiries", [])
        if not expiries:
            continue

        print(f"\n{'='*78}")
        print(f"  {sym}  spot={spot:.2f}")
        print(f"{'='*78}")

        for side_name, side in [("PUT WALLS (support)", "put"), ("CALL WALLS (resistance)", "call")]:
            cands = build_candidates(expiries, spot, side)
            if not cands:
                continue

            # Score with both formulas
            old_scores = {}
            new_scores = {}
            for s, d in cands.items():
                own, cross = own_activity(d["oi"], d["vol"], d["opp_oi"], d["opp_vol"], d["nearest_dte"])
                old_scores[s] = score_old(own, cross, s, spot)
                new_scores[s] = score_new(own, s, spot)

            # Normalize each to 0-100
            old_max = max(old_scores.values()) if old_scores else 1
            new_max = max(new_scores.values()) if new_scores else 1
            old_norm = {s: (v / old_max * 100) if old_max > 0 else 0 for s, v in old_scores.items()}
            new_norm = {s: (v / new_max * 100) if new_max > 0 else 0 for s, v in new_scores.items()}

            # Rank top 7 by each
            old_top = sorted(old_norm.items(), key=lambda x: -x[1])[:7]
            new_top = sorted(new_norm.items(), key=lambda x: -x[1])[:7]

            old_rank = {s: i + 1 for i, (s, _) in enumerate(old_top)}
            new_rank = {s: i + 1 for i, (s, _) in enumerate(new_top)}

            # Union of strikes shown in either top-7
            all_strikes = sorted(set([s for s, _ in old_top] + [s for s, _ in new_top]),
                                 key=lambda s: -spot if side == "put" else spot)
            # sort puts by distance below spot asc, calls by distance above spot asc
            all_strikes = sorted(all_strikes, key=lambda s: abs(s - spot))

            print(f"\n  -- {side_name} (top 7 by each formula) --")
            print(f"  {'strike':>10} {'dist%':>7} | {'OLD':>6} {'rank':>4} | {'NEW':>6} {'rank':>4} | {'Δ':>5}")
            print(f"  {'-'*10} {'-'*7} | {'-'*6} {'-'*4} | {'-'*6} {'-'*4} | {'-'*5}")
            for s in all_strikes:
                dist = (s - spot) / spot * 100
                ov = old_norm.get(s, 0)
                nv = new_norm.get(s, 0)
                orr = old_rank.get(s, "-")
                nrr = new_rank.get(s, "-")
                delta = ""
                if isinstance(orr, int) and isinstance(nrr, int):
                    d = orr - nrr
                    delta = f"{d:+d}" if d != 0 else "="
                print(f"  {s:>10.2f} {dist:>+7.2f} | {ov:>6.1f} {str(orr):>4} | {nv:>6.1f} {str(nrr):>4} | {delta:>5}")


if __name__ == "__main__":
    main()
