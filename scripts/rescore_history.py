"""One-shot rescorer for the Kronos forecast-verification history.

Re-runs `score_matured_forecasts` against the EXISTING history file using the
corrected realized-price logic (intraday-1h for 4h, daily-close for 1d). Without
this, the ~30-day window of already-scored snapshots keeps carrying realized
prices from the old daily-close-only bug — because the live tracker skips any
record with `realized_price != None` (forecast_tracker.py:299), the CI will
never fix them on its own.

Usage:
    python scripts/rescore_history.py                 # rewrite history in place
    python scripts/rescore_history.py --dry-run       # print before/after, don't save
    python scripts/rescore_history.py --history PATH  # custom history file

What it does:
    1. Load data/kronos_forecast_history.json.
    2. Snapshot the current per-group metrics (BEFORE).
    3. Null the scored fields of every MATURED record (target_at in the past),
       leaving pending (future target_at) records untouched.
    4. Run score_matured_forecasts(fetch_realized=True) with the fixed intraday
       fetch — this re-derives realized_price + the 4 flags for all matured
       records, this time at the correct timestamp.
    5. Snapshot metrics again (AFTER) and print a side-by-side per-group diff so
       the impact of the timing fix is visible immediately.

Idempotent: re-running it re-scores the same records the same way (the fetch is
deterministic for a given date window), so it's safe to run repeatedly.
"""

import os
import sys
import json
import argparse
import datetime
from collections import defaultdict

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)

import forecast_tracker as ft  # noqa: E402

HISTORY_PATH = ft.HISTORY_PATH

# Scored fields that score_matured_forecasts owns. Resetting these to None on a
# matured record makes the tracker re-evaluate it on the next pass.
SCORED_FIELDS = (
    "realized_price",
    "direction_correct",
    "abs_pct_error",
    "range_hit",
    "band_hit",
    "scored_at",
    "realized_method",
)


def _metrics(records: list[dict]) -> dict:
    """Per-(symbol,horizon) + overall aggregate metrics, mirroring the frontend.

    A compact subset of forecastScoreService.computeMetrics: directional
    accuracy (+ n + hits), MAPE, range coverage, band coverage, total scored.
    """
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in records:
        groups[(r.get("symbol"), r.get("horizon"))].append(r)

    def agg(recs):
        dirs = [r for r in recs if r.get("direction_correct") is not None]
        dir_hits = sum(1 for r in dirs if r["direction_correct"] is True)
        apes = [r["abs_pct_error"] for r in recs if isinstance(r.get("abs_pct_error"), (int, float))]
        ranges = [r for r in recs if r.get("range_hit") is not None]
        range_hits = sum(1 for r in ranges if r["range_hit"] is True)
        bands = [r for r in recs if r.get("band_hit") is not None]
        band_hits = sum(1 for r in bands if r["band_hit"] is True)
        scored = sum(1 for r in recs if r.get("realized_price") is not None)
        return {
            "scored": scored,
            "dir_n": len(dirs),
            "dir_acc": round(dir_hits / len(dirs), 4) if dirs else None,
            "mape": round(sum(apes) / len(apes), 3) if apes else None,
            "range_acc": round(range_hits / len(ranges), 4) if ranges else None,
            "range_n": len(ranges),
            "band_acc": round(band_hits / len(bands), 4) if bands else None,
            "band_n": len(bands),
        }

    return {g: agg(recs) for g, recs in sorted(groups.items())}, agg(records)


def _fmt_row(label: str, m: dict) -> str:
    def pct(x):
        return f"{x*100:5.1f}%" if isinstance(x, float) else "    —"

    return (
        f"  {label:9s} scored={m['scored']:4d} | "
        f"dir={pct(m['dir_acc'])} (n={m['dir_n']:4d}) | "
        f"MAPE={m['mape'] if m['mape'] is not None else '  —':>6}% | "
        f"range={pct(m['range_acc'])} (n={m['range_n']:4d}) | "
        f"band={pct(m['band_acc'])} (n={m['band_n']:4d})"
    )


def _print_diff(before_groups, before_overall, after_groups, after_overall):
    print("\n" + "=" * 100)
    print("REScore IMPACT (before -> after)  [timing fix: 4h now uses intraday-1h bar]")
    print("=" * 100)
    keys = sorted(set(before_groups) | set(after_groups))
    for k in keys:
        sym, hor = k
        b = before_groups.get(k, {})
        a = after_groups.get(k, {})
        print(f"\n{sym}/{hor}")
        print(_fmt_row("before", b) if b else "  before: (nessun record)")
        print(_fmt_row("after", a) if a else "  after:  (nessun record)")
    print("\nOVERALL")
    print(_fmt_row("before", before_overall))
    print(_fmt_row("after", after_overall))
    print("=" * 100)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--history", default=HISTORY_PATH, help="Path to kronos_forecast_history.json")
    parser.add_argument("--dry-run", action="store_true", help="Compute and print diff, don't save.")
    parser.add_argument("--no-fetch", action="store_true", help="Don't download realized prices (report only).")
    args = parser.parse_args()

    if not os.path.exists(args.history):
        print(f"rescore_history: history file not found at {args.history}", file=sys.stderr)
        return 1

    with open(args.history, "r") as f:
        history = json.load(f)
    if not isinstance(history, list):
        print("rescore_history: history root is not a list.", file=sys.stderr)
        return 1

    print(f"rescore_history: loaded {len(history)} records from {args.history}")

    # --- BEFORE snapshot ---
    before_groups, before_overall = _metrics(history)
    print("\nBEFORE:")
    for k, m in before_groups.items():
        print(_fmt_row(f"{k[0]}/{k[1]}", m))
    print(_fmt_row("OVERALL", before_overall))

    # --- Reset matured records so the tracker re-scores them ---
    now = ft._now_utc()
    reset = 0
    for rec in history:
        target_at = ft._parse_dt(rec.get("target_at"))
        if target_at is None or target_at > now:
            continue  # pending (future) — leave untouched
        for fld in SCORED_FIELDS:
            if fld in rec:
                rec[fld] = None
        reset += 1
    print(f"\nrescore_history: reset {reset} matured record(s) for re-scoring.")

    # Write the reset state back so score_matured_forecasts (which reloads from
    # the file) sees the nulls. In --dry-run we operate on a temp copy instead
    # so the real file is never modified.
    if args.dry_run:
        import tempfile
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tmp:
            json.dump(history, tmp)
            tmp_path = tmp.name
        try:
            ft.score_matured_forecasts(tmp_path, fetch_realized=not args.no_fetch)
            with open(tmp_path) as f:
                history_after = json.load(f)
        finally:
            os.unlink(tmp_path)
        print("rescore_history: --dry-run, original file NOT modified.")
    else:
        ft._save_history(history, args.history)
        ft.score_matured_forecasts(args.history, fetch_realized=not args.no_fetch)
        with open(args.history) as f:
            history_after = json.load(f)
        print(f"rescore_history: wrote re-scored history to {args.history}")

    # --- AFTER snapshot + diff ---
    after_groups, after_overall = _metrics(history_after)
    _print_diff(before_groups, before_overall, after_groups, after_overall)

    return 0


if __name__ == "__main__":
    sys.exit(main())
