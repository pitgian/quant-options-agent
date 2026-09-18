#!/usr/bin/env python3
"""Central skill evaluation for the Kronos forecast pipeline.

Answers the ONLY question that matters for a forecasting system that feeds
options decisions: does the pipeline beat the trivial baselines, or not?

Design principles (learned from the 2026-08 track-record audit, where 6020
"scored" records turned out to be 160 distinct targets x ~38 duplicate
snapshots, with negative skill everywhere):

  1. DEDUP FIRST. One evaluation row per (symbol, horizon, target_at) — the
     LAST snapshot issued before maturity (the most informed one). Scoring
     every 15-min snapshot against the same realized close inflates n by ~38x
     and makes every metric statistically meaningless.

  2. ALWAYS COMPARE AGAINST NAIVE. The baseline to beat is "price does not
     move" (predicted target = anchor). A model with MAE > naive MAE has
     NEGATIVE skill: it destroys information. Skill score is reported per
     group and gates everything downstream.

  3. VERDICTS, NOT VIBES. Each (symbol, horizon) group gets an explicit
     verdict:
       ALPHA     — beats naive meaningfully AND direction is significant
       NO_ALPHA  — indistinguishable from naive (yet)
       ANTI      — significantly WORSE than naive / anti-correlated
                   (report-only; the alpha lab damps these, never inverts)

  4. SIGNIFICANCE, NOT POINT ESTIMATES. Direction accuracy comes with an
     exact two-sided binomial p-value; correlation with a normal-approx
     p-value. With few targets everything stays NO_ALPHA — by design.

Outputs data/skill_report.json (committed to the data branch by CI so the UI
can surface the verdicts) and prints a console table.

Usage:
    python scripts/skill_evaluator.py                       # default paths
    python scripts/skill_evaluator.py --window-days 30      # limit window
"""

import argparse
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)

from forecast_tracker import HISTORY_PATH  # noqa: E402

REPORT_OUTPUT_PATH = os.path.join(SCRIPTS_DIR, "../data/skill_report.json")

REPORT_VERSION = 1

# A forecast whose |predicted move| is below this (in % of anchor) is FLAT and
# excluded from directional accuracy (mirrors forecast_tracker's threshold).
FLAT_MOVE_THRESHOLD_PCT = 0.05

# Minimum distinct targets before ANY significance statement is made.
MIN_TARGETS = 20


# ---------------------------------------------------------------------------
# Statistics helpers (no scipy — stdlib only)
# ---------------------------------------------------------------------------

def binom_two_sided_p(k: int, n: int, p: float = 0.5) -> float:
    """Exact two-sided binomial test p-value (stdlib only, fine for n <= 5000)."""
    if n <= 0:
        return 1.0
    def pmf(k):
        if k < 0 or k > n:
            return 0.0
        return math.comb(n, k) * (p ** k) * ((1 - p) ** (n - k))
    pk = pmf(k)
    # Sum all outcomes at most as likely as the observed one.
    total = sum(pm for pm in (pmf(i) for i in range(n + 1)) if pm <= pk + 1e-15)
    return min(1.0, total)


def normal_cdf(x: float) -> float:
    """CDF of the standard normal (Abramowitz-Stegun 7.1.26)."""
    t = 1.0 / (1.0 + 0.2316419 * abs(x))
    poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
               t * (-1.821255978 + t * 1.330274429))))
    cdf = 1.0 - (math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)) * poly
    return cdf if x >= 0 else 1.0 - cdf


def corr_p_value(r: float, n: int) -> float:
    """Two-sided p-value for Pearson r != 0 under the t approximation (normal)."""
    if n < 3 or not (-1.0 < r < 1.0):
        return 1.0
    t = abs(r) * math.sqrt((n - 2) / max(1e-12, 1.0 - r * r))
    return min(1.0, 2.0 * (1.0 - normal_cdf(t)))


def pearson(xs, ys) -> float:
    n = len(xs)
    if n < 3:
        return float("nan")
    mx = sum(xs) / n
    my = sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx <= 0 or sy <= 0:
        return float("nan")
    return sxy / (sx * sy)


# ---------------------------------------------------------------------------
# Dataset construction
# ---------------------------------------------------------------------------

def load_scored(history: list) -> list:
    return [r for r in history if r.get("realized_price") is not None
            and r.get("anchor_price") and r.get("predicted_target")]


def dedup_targets(scored: list) -> list:
    """One row per (symbol, horizon, target_at): the LAST-issued snapshot.

    The last-issued snapshot before maturity is the most informed forecast of
    that target — it is what a user following the system would actually have
    acted on at decision time.
    """
    best = {}
    for r in scored:
        key = (r.get("symbol"), r.get("horizon"), r.get("target_at"))
        cur = best.get(key)
        if cur is None or (r.get("issued_at") or "") >= (cur.get("issued_at") or ""):
            best[key] = r
    rows = list(best.values())

    def sort_key(r):
        return (r.get("target_at") or "", r.get("issued_at") or "")
    rows.sort(key=sort_key)
    return rows


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def _signed_move(rec: dict, price_key: str) -> float:
    return (rec[price_key] - rec["anchor_price"]) / rec["anchor_price"] * 100.0


def group_metrics(rows: list) -> dict:
    """Compute the full metric set for one (symbol, horizon) group."""
    n = len(rows)
    pred_moves = [_signed_move(r, "predicted_target") for r in rows]
    real_moves = [_signed_move(r, "realized_price") for r in rows]
    errs_model = [abs(pm - rm) for pm, rm in zip(pred_moves, real_moves)]
    errs_naive = [abs(rm) for rm in real_moves]

    mae_model = sum(errs_model) / n
    mae_naive = sum(errs_naive) / n
    skill_pct = (mae_naive - mae_model) / mae_naive * 100.0 if mae_naive > 0 else 0.0

    # Direction: exclude FLAT predictions from accuracy (consistent with the
    # live NEUTRAL label) but report how many were flat.
    n_flat = 0
    dir_ok = 0
    dir_n = 0
    real_up = 0
    for pm, rm in zip(pred_moves, real_moves):
        if rm > 0:
            real_up += 1
        if abs(pm) <= FLAT_MOVE_THRESHOLD_PCT:
            n_flat += 1
            continue
        dir_n += 1
        if (pm > 0) == (rm > 0):
            dir_ok += 1
    dir_acc = dir_ok / dir_n * 100.0 if dir_n else None
    dir_p = binom_two_sided_p(dir_ok, dir_n) if dir_n else None

    r = pearson(pred_moves, real_moves)
    r_p = corr_p_value(r, n) if r == r else None

    # Band coverage on the final-close band.
    band_rows = [x for x in rows if x.get("band_p10") is not None and x.get("band_p90") is not None]
    band_cov = None
    if band_rows:
        hits = sum(1 for x in band_rows if x["band_p10"] <= x["realized_price"] <= x["band_p90"])
        band_cov = hits / len(band_rows) * 100.0

    mean_abs_move = sum(errs_naive) / n

    return {
        "n_targets": n,
        "mae_model_pct": round(mae_model, 4),
        "mae_naive_pct": round(mae_naive, 4),
        "skill_vs_naive_pct": round(skill_pct, 2),
        "mean_abs_move_pct": round(mean_abs_move, 4),
        "mean_pred_move_pct": round(sum(pred_moves) / n, 4),
        "direction": {
            "n_directional": dir_n,
            "n_flat": n_flat,
            "accuracy_pct": round(dir_acc, 2) if dir_acc is not None else None,
            "p_value": round(dir_p, 5) if dir_p is not None else None,
            "realized_up_pct": round(real_up / n * 100.0, 2),
        },
        "correlation": {
            "pred_vs_real": round(r, 4) if r == r else None,
            "p_value": round(r_p, 5) if r_p is not None else None,
        },
        "band_coverage_pct": round(band_cov, 2) if band_cov is not None else None,
        "window": {
            "first_target": rows[0].get("target_at"),
            "last_target": rows[-1].get("target_at"),
        },
    }


def verdict_of(m: dict) -> str:
    """ALPHA / NO_ALPHA / ANTI — conservative by design."""
    if m["n_targets"] < MIN_TARGETS:
        return "NO_ALPHA"
    skill = m["skill_vs_naive_pct"]
    d = m["direction"] or {}
    c = m["correlation"] or {}
    dir_acc = d.get("accuracy_pct")
    dir_p = d.get("p_value")
    r = c.get("pred_vs_real")
    r_p = c.get("p_value")

    dir_sig_good = dir_acc is not None and dir_acc > 50 and dir_p is not None and dir_p < 0.05
    dir_sig_bad = dir_acc is not None and dir_acc < 50 and dir_p is not None and dir_p < 0.05
    corr_sig_good = r is not None and r > 0.15 and r_p is not None and r_p < 0.05
    corr_sig_bad = r is not None and r < -0.15 and r_p is not None and r_p < 0.05

    if skill >= 5.0 and (dir_sig_good or corr_sig_good):
        return "ALPHA"
    if (skill <= -5.0 and (dir_sig_bad or corr_sig_bad)) or (corr_sig_bad and skill < 0):
        return "ANTI"
    return "NO_ALPHA"


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def build_report(history: list, window_days: int | None = None) -> dict:
    scored = load_scored(history)
    rows = dedup_targets(scored)

    if window_days:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=window_days)).isoformat()
        rows = [r for r in rows if (r.get("target_at") or "") >= cutoff]

    groups: dict = defaultdict(list)
    for r in rows:
        groups[f"{r.get('symbol')}|{r.get('horizon')}"].append(r)

    out_groups = {}
    for key in sorted(groups):
        m = group_metrics(groups[key])
        m["verdict"] = verdict_of(m)
        out_groups[key] = m

    return {
        "version": REPORT_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days": window_days,
        "min_targets_for_verdict": MIN_TARGETS,
        "total_scored_snapshots": len(scored),
        "total_distinct_targets": len(rows),
        "duplication_factor": round(len(scored) / max(1, len(rows)), 1),
        "groups": out_groups,
    }


def print_report(rep: dict) -> None:
    print(f"\n=== Skill report ({rep['generated_at'][:16]}) ===")
    print(f"scored snapshots: {rep['total_scored_snapshots']}  "
          f"distinct targets: {rep['total_distinct_targets']}  "
          f"(x{rep['duplication_factor']} duplication)")
    hdr = (f"{'group':10s} {'n':>4s} {'MAE mod':>8s} {'MAE nav':>8s} "
           f"{'skill':>7s} {'dirAcc':>7s} {'p(dir)':>8s} {'corr':>6s} "
           f"{'band%':>6s}  verdict")
    print(hdr)
    print("-" * len(hdr))
    for key, m in rep["groups"].items():
        d = m["direction"] or {}
        c = m["correlation"] or {}
        da = f"{d['accuracy_pct']:.1f}%" if d.get("accuracy_pct") is not None else "—"
        dp = f"{d['p_value']:.4f}" if d.get("p_value") is not None else "—"
        co = f"{c['pred_vs_real']:+.2f}" if c.get("pred_vs_real") is not None else "—"
        bc = f"{m['band_coverage_pct']:.0f}%" if m.get("band_coverage_pct") is not None else "—"
        print(f"{key:10s} {m['n_targets']:4d} {m['mae_model_pct']:7.3f}% "
              f"{m['mae_naive_pct']:7.3f}% {m['skill_vs_naive_pct']:+6.1f}% "
              f"{da:>7s} {dp:>8s} {co:>6s} {bc:>6s}  {m['verdict']}")
    print()


def main() -> None:
    ap = argparse.ArgumentParser(description="Skill evaluation vs naive baseline")
    ap.add_argument("--history", default=HISTORY_PATH)
    ap.add_argument("--out", default=REPORT_OUTPUT_PATH)
    ap.add_argument("--window-days", type=int, default=None,
                    help="Only evaluate targets whose target_at is within N days.")
    args = ap.parse_args()

    with open(args.history) as f:
        history = json.load(f)
    rep = build_report(history, window_days=args.window_days)
    print_report(rep)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(rep, f, indent=2)
    print(f"skill report written → {args.out}")


if __name__ == "__main__":
    main()
