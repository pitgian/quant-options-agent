"""Unit tests for alpha_lab — the walk-forward champion arena.

Covers (all synthetic, no network):
  1. dedup_targets keeps the LAST-issued snapshot per target.
  2. build_rows signed-move math.
  3. fit_recal recovers a known linear law from noisy synthetic data.
  4. fit_feats + predict_feats round-trip a feature-driven signal.
  5. _apply_move_to_block: amplitude rescaled, shape preserved, band width
     preserved, ramp fallback when the issued move is ~zero.
  6. pick_champion gate hierarchy (feats > recal > issued > dampen > observe).
  7. paired_sign_p sanity.

Run: .venv/bin/python tests/test_alpha_lab.py
"""
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import alpha_lab as al  # noqa: E402

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


# ---------------------------------------------------------------------------
# 1. dedup_targets keeps the last-issued snapshot per target
# ---------------------------------------------------------------------------
print("\n[1] dedup_targets")
history = [
    {"symbol": "SPY", "horizon": "4h", "target_at": "2026-09-01T00:00:00+00:00",
     "issued_at": "2026-08-31T10:00:00+00:00", "anchor_price": 100.0,
     "predicted_target": 101.0, "realized_price": 100.5},
    {"symbol": "SPY", "horizon": "4h", "target_at": "2026-09-01T00:00:00+00:00",
     "issued_at": "2026-08-31T14:00:00+00:00", "anchor_price": 100.0,
     "predicted_target": 102.0, "realized_price": 100.5},
    {"symbol": "SPY", "horizon": "4h", "target_at": "2026-09-02T00:00:00+00:00",
     "issued_at": "2026-09-01T10:00:00+00:00", "anchor_price": 100.5,
     "predicted_target": 99.0, "realized_price": 101.0},
]
scored = al.load_scored(history)
rows = al.dedup_targets(scored)
check("one row per target", len(rows) == 2, f"got {len(rows)}")
check("keeps LAST issued", rows[0]["predicted_target"] == 102.0,
      f"got {rows[0]['predicted_target']}")

# ---------------------------------------------------------------------------
# 2. build_rows signed moves
# ---------------------------------------------------------------------------
print("\n[2] build_rows")
lab_rows = al.build_rows(scored)
r0 = lab_rows[0]
check("pred move %", abs(r0["pred_move_pct"] - 2.0) < 1e-9, f"{r0['pred_move_pct']}")
check("real move %", abs(r0["real_move_pct"] - 0.5) < 1e-9, f"{r0['real_move_pct']}")

# ---------------------------------------------------------------------------
# 3. fit_recal recovers a linear law
# ---------------------------------------------------------------------------
print("\n[3] fit_recal")
rng = random.Random(7)
xs = [rng.uniform(-1.5, 1.5) for _ in range(300)]
ys = [0.05 + 0.12 * x + rng.gauss(0, 0.02) for x in xs]
coef = al.fit_recal(xs, ys, [1.0] * len(xs))
check("coef recovered", coef is not None and abs(coef[1] - 0.12) < 0.02 and abs(coef[0] - 0.05) < 0.02,
      f"got {coef}")

# ---------------------------------------------------------------------------
# 4. fit_feats round-trip
# ---------------------------------------------------------------------------
print("\n[4] fit_feats")
rows_f = []
for i in range(200):
    f = {"rsi_14": rng.uniform(20, 80), "pcr": rng.uniform(0.6, 1.6)}
    x = rng.uniform(-1.0, 1.0)
    rows_f.append({
        "pred_move_pct": x,
        "real_move_pct": 0.3 * (f["rsi_14"] - 50.0) / 50.0 + 0.05 * x,
        "features": f,
    })
model = al.fit_feats(rows_f, ["rsi_14", "pcr"], [1.0] * len(rows_f))
check("model fitted", model is not None and "rsi_14" in model["features"], f"{model and model['features']}")
if model:
    # Low RSI row should predict below-average move, high RSI above.
    lo = al.predict_feats(model, {"pred_move_pct": 0.0, "features": {"rsi_14": 25.0}})
    hi = al.predict_feats(model, {"pred_move_pct": 0.0, "features": {"rsi_14": 75.0}})
    check("rsi signal direction", hi > lo, f"lo={lo:.4f} hi={hi:.4f}")

# ---------------------------------------------------------------------------
# 5. _apply_move_to_block
# ---------------------------------------------------------------------------
print("\n[5] _apply_move_to_block")
anchor = 500.0
candles = []
moves = [0.0, 0.1, 0.25, 0.5]  # % moves per candle (shape)
for i, mv in enumerate(moves):
    close = anchor * (1 + mv / 100.0)
    candles.append({
        "timestamp": f"2026-09-0{i+1}T00:00:00+00:00",
        "open": round(close, 2), "high": round(close + 1, 2),
        "low": round(close - 1, 2), "close": round(close, 2),
        "close_p10": round(close - 2, 2), "close_p90": round(close + 2, 2),
    })
block = {"last_price": anchor, "candles": candles}
al._apply_move_to_block(block, 0.1, {"mode": "model"})  # scale = 0.1/0.5 = 0.2
got_last = block["candles"][-1]["close"]
exp_last = anchor * (1 + 0.1 / 100.0)
check("last candle retargeted", abs(got_last - exp_last) < 0.02, f"{got_last} vs {exp_last}")
width_before = candles[3]["close_p90"] - candles[3]["close_p10"]
width_after = block["candles"][3]["close_p90"] - block["candles"][3]["close_p10"]
check("band width preserved", abs(width_before - width_after) < 0.03,
      f"{width_before} vs {width_after}")
first_delta = abs(block["candles"][0]["close"] - anchor)
check("first candle ~ anchor", first_delta < 0.01, f"delta {first_delta}")

# Ramp fallback when issued move ~ 0.
candles2 = []
for i in range(3):
    candles2.append({"close": anchor, "high": anchor, "low": anchor,
                     "close_p10": anchor, "close_p90": anchor})
block2 = {"last_price": anchor, "candles": candles2}
al._apply_move_to_block(block2, 1.0, {"mode": "model"})
check("ramp fallback end move", abs(block2["candles"][-1]["close"] - anchor * 1.01) < 0.02,
      f"{block2['candles'][-1]['close']}")

# ---------------------------------------------------------------------------
# 6. pick_champion gate hierarchy
# ---------------------------------------------------------------------------
print("\n[6] pick_champion")
def arena(issued_skill, recal_skill=None, feats_skill=None, n=50, p_ok=0.01):
    base = {"n_test": n, "beats_naive_p": p_ok}
    out = {"naive_zero": {"n_test": n, "mae_pct": 1.0},
           "issued": dict(base, skill_vs_naive_pct=issued_skill)}
    if recal_skill is not None:
        out["recal"] = dict(base, skill_vs_naive_pct=recal_skill)
    if feats_skill is not None:
        out["feats"] = dict(base, skill_vs_naive_pct=feats_skill)
    return out

c = al.pick_champion(arena(10.0, feats_skill=8.0, recal_skill=6.0))
check("feats wins when significant", c["champion"] == "feats", f"{c}")
c = al.pick_champion(arena(10.0, recal_skill=6.0))
check("recal when no feats", c["champion"] == "recal", f"{c}")
c = al.pick_champion(arena(6.0, recal_skill=1.0))  # recal not significant enough
check("issued passthrough", c["champion"] == "issued" and c["mode"] == "passthrough", f"{c}")
c = al.pick_champion(arena(-20.0))
check("dampen when issued bad", c["champion"] == "naive_zero" and c["mode"] == "dampen", f"{c}")
c = al.pick_champion(arena(1.0))
check("observe when nothing significant", c["mode"] == "observe", f"{c}")
c = al.pick_champion(arena(-30.0, n=10))  # too few test points -> observe
check("gate on n_test", c["mode"] == "observe", f"{c}")

# ---------------------------------------------------------------------------
# 7. paired_sign_p
# ---------------------------------------------------------------------------
print("\n[7] paired_sign_p")
e_a = [1.0] * 50
e_b = [2.0] * 50
check("A beats B clearly", al.paired_sign_p(e_a, e_b) < 1e-6, "")
check("all ties -> no evidence (p=1)", al.paired_sign_p(e_a, list(e_a)) == 1.0,
      f"{al.paired_sign_p(e_a, list(e_a))}")
# 60/100 wins: mildly better, one-sided p should be smallish but not tiny.
check("60% wins is weak evidence", 0.01 < al.paired_sign_p([1.0] * 60 + [2.0] * 40, [2.0] * 100) < 0.2, "")

print(f"\n{'='*50}\nalpha_lab tests: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
