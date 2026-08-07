"""Diagnose the systematic under-coverage of Kronos prediction bands.

The Track Record shows range/band coverage around 18% — far below the ~80% a
well-calibrated 80% Monte Carlo band should hit. This script reads the
(ideally re-scored) history and quantifies WHY, so we can decide the fix:

For every scored snapshot it measures, against the realized price:
  - band miss magnitude: how far outside [band_p10, band_p90] the realized
    landed, as a fraction of the band half-width (p90-p50).
  - range miss magnitude: same against [predicted_low, predicted_high].
  - miss direction: did the realized blow through the TOP (UP miss, model
    under-predicted upside) or the BOTTOM (DOWN miss)?

Then per (symbol, horizon) it reports:
  - coverage % (matches the frontend).
  - median miss magnitude among MISSES → the scale factor that would bring
    coverage toward target (if every band were widened by ~that factor, most
    misses would land inside).
  - UP-miss vs DOWN-miss imbalance → tells us whether the band is symmetric-tight
    (model too confident overall) or one-sided (model biased in direction).

This is a DIAGNOSTIC, not a fix: it prints a recommendation. What to do with it
(allargare le bande ×k? più campioni MC? un bias-correction?) is a separate
decision on the model side.

Usage:
    python scripts/diagnose_band_calibration.py
    python scripts/diagnose_band_calibration.py --history PATH
"""

import os
import sys
import json
import argparse
import statistics
from collections import defaultdict

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)

import forecast_tracker as ft  # noqa: E402

HISTORY_PATH = ft.HISTORY_PATH


def _safe(x):
    return x if isinstance(x, (int, float)) else None


def analyze(records):
    """Group by (symbol, horizon) and compute miss statistics."""
    groups = defaultdict(list)
    for r in records:
        if r.get("realized_price") is None:
            continue
        groups[(r.get("symbol"), r.get("horizon"))].append(r)

    report = {}
    for key, recs in sorted(groups.items()):
        band_miss_factors = []   # |realized - nearest band edge| / band half-width
        band_dirs = []           # "UP" if realized > p90, "DOWN" if < p10
        range_miss_factors = []
        band_hits = band_total = 0
        range_hits = range_total = 0

        for r in recs:
            realized = _safe(r.get("realized_price"))
            if realized is None:
                continue

            # --- Monte Carlo band [band_p10, band_p90], centered on p50 ≈ predicted_target ---
            p10 = _safe(r.get("band_p10"))
            p90 = _safe(r.get("band_p90"))
            p50 = _safe(r.get("predicted_target"))
            if p10 is not None and p90 is not None and p50 is not None:
                band_total += 1
                if p10 <= realized <= p90:
                    band_hits += 1
                else:
                    half = (p90 - p10) / 2.0
                    # Miss magnitude: how many half-widths outside the band.
                    # realized well beyond p90 → factor = (realized - p90)/half.
                    if realized > p90:
                        miss = (realized - p90) / half if half > 0 else float("inf")
                        band_dirs.append("UP")
                    else:
                        miss = (p10 - realized) / half if half > 0 else float("inf")
                        band_dirs.append("DOWN")
                    band_miss_factors.append(miss)

            # --- Outer range [predicted_low, predicted_high] ---
            lo = _safe(r.get("predicted_low"))
            hi = _safe(r.get("predicted_high"))
            if lo is not None and hi is not None:
                range_total += 1
                if lo <= realized <= hi:
                    range_hits += 1
                else:
                    half = (hi - lo) / 2.0
                    if realized > hi:
                        miss = (realized - hi) / half if half > 0 else float("inf")
                    else:
                        miss = (lo - realized) / half if half > 0 else float("inf")
                    range_miss_factors.append(miss)

        def coverage(hits, total):
            return round(hits / total, 4) if total else None

        def med(xs):
            return round(statistics.median(xs), 3) if xs else None

        up = band_dirs.count("UP")
        dn = band_dirs.count("DOWN")
        report[key] = {
            "n": len(recs),
            "band_coverage": coverage(band_hits, band_total),
            "band_n": band_total,
            "band_miss_count": len(band_miss_factors),
            "band_miss_median_halves": med(band_miss_factors),
            "band_up_misses": up,
            "band_down_misses": dn,
            "range_coverage": coverage(range_hits, range_total),
            "range_n": range_total,
            "range_miss_median_halves": med(range_miss_factors),
        }
    return report


def recommend(stats):
    """Plain-text recommendation from the per-group stats."""
    cov = stats["band_coverage"]
    if cov is None:
        return "no band data"
    if cov >= 0.75:
        return "band well-calibrated (~80% target met) — no action"
    miss_med = stats["band_miss_median_halves"]
    # If misses sit a median of K half-widths outside, widening each band by
    # ~(1 + K) half-widths each side would absorb the typical miss. K here is
    # in units of (p90-p50), so the multiplicative widen factor ≈ 1 + K.
    factor = round(1 + (miss_med or 0), 2)
    up, dn = stats["band_up_misses"], stats["band_down_misses"]
    total_miss = up + dn
    if total_miss == 0:
        asym = "n/a"
    else:
        # Fraction of misses on the UP side. ~0.5 = symmetric, >0.65 one-sided UP.
        up_frac = up / total_miss
        if up_frac >= 0.65:
            asym = f"sbilanciato UP ({up}/{total_miss} = {up_frac:.0%}): il modello sottostima i rialzi"
        elif up_frac <= 0.35:
            asym = f"sbilanciato DOWN ({dn}/{total_miss} = {1-up_frac:.0%}): il modello sottostima i ribassi"
        else:
            asym = f"simmetrico ({up}U/{dn}D): banda uniformemente troppo stretta"
    return f"allargare band ×~{factor} | {asym}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--history", default=HISTORY_PATH)
    args = parser.parse_args()

    if not os.path.exists(args.history):
        print(f"diagnose_band_calibration: history not found at {args.history}", file=sys.stderr)
        return 1

    with open(args.history) as f:
        history = json.load(f)
    if not isinstance(history, list):
        print("diagnose_band_calibration: history root is not a list.", file=sys.stderr)
        return 1

    scored = [r for r in history if r.get("realized_price") is not None]
    print(f"diagnose_band_calibration: {len(scored)} scored records / {len(history)} total.\n")

    report = analyze(history)

    print("=" * 110)
    print("BAND / RANGE CALIBRATION DIAGNOSIS")
    print("=" * 110)
    print(f"{'group':10s} | {'n':>4s} | {'band cov':>9s} | {'miss med':>9s} | {'UP/DN miss':>11s} | "
          f"{'range cov':>9s} | recommendation")
    print("-" * 110)
    for key, s in report.items():
        cov = f"{s['band_coverage']*100:.0f}%" if s['band_coverage'] is not None else "—"
        rcov = f"{s['range_coverage']*100:.0f}%" if s['range_coverage'] is not None else "—"
        missmed = f"{s['band_miss_median_halves']}×" if s['band_miss_median_halves'] is not None else "—"
        updn = f"{s['band_up_misses']}/{s['band_down_misses']}"
        rec = recommend(s)
        print(f"{key[0]+'/'+key[1]:10s} | {s['n']:4d} | {cov:>9s} | {missmed:>9s} | {updn:>11s} | "
              f"{rcov:>9s} | {rec}")

    print("\n" + "=" * 110)
    print("LEGEND")
    print("-" * 110)
    print("  band cov     — frazione di realized dentro [p10,p90] (target ~80%)")
    print("  miss med     — mediana di quanto il realized eccede la band, in mezze-larghezze")
    print("                 (1.5× = il realized tipico è 1.5 half-width oltre il bordo)")
    print("  UP/DN miss   — quanti miss sopra la banda (UP) vs sotto (DN). Sbilanciamento = bias direzionale")
    print("  range cov    — frazione dentro [predicted_low, predicted_high] (range outer p90/p10)")
    print("=" * 110)
    return 0


if __name__ == "__main__":
    sys.exit(main())
