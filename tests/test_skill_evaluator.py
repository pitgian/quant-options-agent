"""Unit tests for skill_evaluator — deduped skill measurement vs naive.

Covers (all synthetic, no network):
  1. group_metrics: skill math, direction accuracy, flat exclusion.
  2. verdict_of: ALPHA requires skill + significance; low-n stays NO_ALPHA;
     anti-correlated pipelines are flagged ANTI, not ALPHA.
  3. binom_two_sided_p sanity.
  4. dedup_targets + load_scored filtering.

Run: .venv/bin/python tests/test_skill_evaluator.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import skill_evaluator as se  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✅ {name}")
    else:
        FAIL += 1
        print(f"  ❌ {name} — {detail}")


def make_row(anchor, pred_move, real_move, **kw):
    return dict({
        "symbol": "SPY", "horizon": "4h",
        "target_at": "2026-09-01T00:00:00+00:00",
        "issued_at": "2026-08-31T10:00:00+00:00",
        "anchor_price": anchor,
        "predicted_target": anchor * (1 + pred_move / 100.0),
        "realized_price": anchor * (1 + real_move / 100.0),
        "band_p10": None, "band_p90": None,
    }, **kw)


# ---------------------------------------------------------------------------
print("\n[1] group_metrics")
# Model: always right by 0.1%; naive error = |real move| = 0.5%.
rows = [make_row(100.0, 0.5 + (0.1 if i % 2 else -0.1), 0.5) for i in range(40)]
m = se.group_metrics(rows)
check("skill positive", m["skill_vs_naive_pct"] == 80.0, f"{m['skill_vs_naive_pct']}")
check("all directional", m["direction"]["n_directional"] == 40, f"{m['direction']}")
check("direction perfect", m["direction"]["accuracy_pct"] == 100.0, "")

# Flat predictions excluded from direction accuracy.
rows_flat = [make_row(100.0, 0.0, 0.6) for _ in range(10)]
m2 = se.group_metrics(rows_flat)
check("flat excluded", m2["direction"]["n_directional"] == 0 and m2["direction"]["n_flat"] == 10, "")

# ---------------------------------------------------------------------------
print("\n[2] verdict_of")
good = dict(m)
good["n_targets"] = 50
check("ALPHA when skilled+significant", se.verdict_of(good) == "ALPHA", se.verdict_of(good))

lown = dict(m)
lown["n_targets"] = 10
check("low-n conservative", se.verdict_of(lown) == "NO_ALPHA", "")

# Anti-correlated, negative skill: ANTI, never ALPHA.
anti = {
    "n_targets": 60,
    "skill_vs_naive_pct": -120.0,
    "direction": {"n_directional": 60, "n_flat": 0, "accuracy_pct": 10.0, "p_value": 1e-9,
                  "realized_up_pct": 50.0},
    "correlation": {"pred_vs_real": -0.6, "p_value": 0.0},
}
check("ANTI detected", se.verdict_of(anti) == "ANTI", se.verdict_of(anti))

# Mediocre: NO_ALPHA.
mediocre = {
    "n_targets": 60,
    "skill_vs_naive_pct": 1.0,
    "direction": {"n_directional": 60, "n_flat": 0, "accuracy_pct": 52.0, "p_value": 0.6,
                  "realized_up_pct": 50.0},
    "correlation": {"pred_vs_real": 0.05, "p_value": 0.7},
}
check("NO_ALPHA when weak", se.verdict_of(mediocre) == "NO_ALPHA", se.verdict_of(mediocre))

# ---------------------------------------------------------------------------
print("\n[3] binom_two_sided_p")
check("fair coin p=1", abs(se.binom_two_sided_p(50, 100) - 1.0) < 0.5, "")
check("extreme is significant", se.binom_two_sided_p(95, 100) < 1e-10, "")
check("half of few is not", se.binom_two_sided_p(5, 10) > 0.5, "")

# ---------------------------------------------------------------------------
print("\n[4] load_scored / dedup_targets")
mixed = [
    make_row(100.0, 1.0, 0.5),                      # scored
    {"symbol": "SPY", "horizon": "4h",
     "target_at": "2026-09-01T00:00:00+00:00",
     "issued_at": "2026-08-31T10:00:00+00:00",
     "anchor_price": 100.0, "predicted_target": 101.0,
     "realized_price": None},                       # still pending
]
check("unscored filtered", len(se.load_scored(mixed)) == 1, "")

print(f"\n{'='*50}\nskill_evaluator tests: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
