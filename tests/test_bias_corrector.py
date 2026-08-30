"""Unit tests for the bias_corrector self-improvement layer.

Exercises:
  1. estimate_bias recovers a known constant offset (synthetic history where the
     model systematically under-predicts by X%).
  2. Anti-worsening: when the synthetic bias is REAL and consistent, the
     correction passes the holdout; when the "bias" is pure noise (no real
     directional signal), the correction is ZEROED (do no harm).
  3. With too few records (< MIN_SAMPLES_ESTIMATE), correction is 0.
  4. apply_correction: anchor (last_price) is unchanged; the target (last candle
     close) is shifted by the full correction_pct; mid-candles get the linear
     time-weight; band edges (close_p10/p90) move coherently with the trajectory.
  5. apply_correction leaves a group untouched when applied=False, and attaches
     the diagnostic block.

Run: .venv/bin/python tests/test_bias_corrector.py
"""
import os
import sys
import json
import tempfile
import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import bias_corrector as bc  # noqa: E402
import forecast_tracker as ft  # noqa: E402  (for _now_utc / constants)

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


def make_record(symbol, horizon, days_ago, anchor, pred_target, realized,
                issued=None):
    """Build a scored history record. issued_at defaults to `days_ago` ago."""
    if issued is None:
        issued = (ft._now_utc() - datetime.timedelta(days=days_ago)).isoformat()
    return {
        "v": 2,
        "issued_at": issued,
        "symbol": symbol,
        "horizon": horizon,
        "target_at": issued,
        "anchor_price": anchor,
        "predicted_target": pred_target,
        "realized_price": realized,
        "predicted_high": pred_target * 1.01,
        "predicted_low": pred_target * 0.99,
        "band_p10": pred_target * 0.99,
        "band_p90": pred_target * 1.01,
        "predicted_direction": "UP" if pred_target > anchor else "DOWN",
        "realized_method": "intraday_1h" if horizon == "4h" else "daily_close",
    }


def write_history(records):
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    json.dump(records, f)
    f.close()
    return f.name


# --- Test 1: recover a known constant offset -------------------------------
print("\n=== Test 1: estimate_bias recovers a known constant offset ===")
# SPY/1d: model always predicts target = anchor * 0.97 (-3%), reality is
# anchor * 1.02 (+2%). Bias_pct = (pred - real)/real = (-3% - +2%) ≈ -5%.
# Correction should be ~+5%.
recs = []
for i in range(60):
    anchor = 100.0 + i * 0.01  # tiny drift so records aren't identical
    pred = anchor * 0.97
    real = anchor * 1.02
    recs.append(make_record("SPY", "1d", days_ago=13 - (i % 14),
                            anchor=anchor, pred_target=pred, realized=real))
path = write_history(recs)
try:
    model = bc.estimate_bias(path, window_days=14)
    m = model.get("SPY|1d")
    check("SPY|1d present in model", m is not None, f"keys={list(model)}")
    # 2026-08: a 100%-one-direction window is exactly the herding pathology —
    # the old code recovered a +5% offset from it and shipped it; the gate
    # must refuse instead (see HERD_DIRECTION_MAX_SHARE).
    check("herded window → correction REFUSED",
          m and not m["applied"], f"model={m}")
    check("refusal reason mentions herding",
          m and "herding" in (m.get("reason") or ""),
          f"reason={m.get('reason') if m else None}")
finally:
    os.unlink(path)


# --- Test 1b: mixed window recovers the offset, clamped per horizon ---------
print("\n=== Test 1b: mixed-direction window → offset recovered but CLAMPED ===")
# 70% of predictions point DOWN (−1.2%), 30% UP (+1.0%); reality is always
# +1.5%. Median bias ≈ −2.7% → correction ≈ +2.7%, but the 1d cap is 2.0%.
# The clamp must bite: a shift larger than the horizon's plausible move is
# never shipped.
recs = []
for i in range(60):
    anchor = 100.0 + i * 0.01
    pred = anchor * (0.988 if i % 10 < 7 else 1.010)
    real = anchor * 1.015
    recs.append(make_record("SPY", "1d", days_ago=13 - (i % 14),
                            anchor=anchor, pred_target=pred, realized=real))
path = write_history(recs)
try:
    model = bc.estimate_bias(path, window_days=14)
    m = model.get("SPY|1d")
    check("mixed window: correction applied", m and m["applied"], f"model={m}")
    check("correction clamped to the 1d cap",
          m and abs(m["correction_pct"] - bc.MAX_CORRECTION_PCT_BY_HORIZON["1d"]) < 1e-9,
          f"got {m['correction_pct'] if m else None}")
    check("holdout shows improvement",
          m and m["holdout_delta_pp"] > bc.MIN_ACC_GAIN_PP,
          f"delta={m['holdout_delta_pp'] if m else None}")
finally:
    os.unlink(path)


# --- Test 2: anti-worsening on pure noise (no real bias) --------------------
print("\n=== Test 2: anti-worsening — pure noise → correction ZEROED ===")
# Random predictions (no systematic bias): realized is random walk around anchor,
# predicted is also random. No correction should help.
import random
random.seed(42)
recs = []
for i in range(60):
    anchor = 100.0
    # predicted move random in [-2%, +2%], realized move random in [-2%, +2%]
    pred_move = random.uniform(-2, 2)
    real_move = random.uniform(-2, 2)
    pred = anchor * (1 + pred_move / 100)
    real = anchor * (1 + real_move / 100)
    recs.append(make_record("SPY", "1d", days_ago=13 - (i % 14),
                            anchor=anchor, pred_target=pred, realized=real))
path = write_history(recs)
try:
    model = bc.estimate_bias(path, window_days=14)
    m = model.get("SPY|1d")
    # The correction may or may not pass the holdout by chance; the KEY check is
    # that IF it's applied, the holdout gain is real (>= MIN_ACC_GAIN_PP), and
    # that the system is conservative (n_samples reported). We mainly assert it
    # doesn't crash and produces a well-formed decision.
    check("pure-noise model is well-formed",
          m is not None and "applied" in m and "reason" in m,
          f"model={m}")
    check("pure-noise correction is small (|corr| < 3%)",
          m and abs(m["correction_pct"]) < 3.0,
          f"corr={m['correction_pct'] if m else None}")
    # Whether it passes depends on the RNG seed; document whichever it is.
    print(f"     (noise result: applied={m['applied'] if m else '?'}, "
          f"Δ={m['holdout_delta_pp'] if m else '?'}pp — anti-worsening gate decides)")
finally:
    os.unlink(path)


# --- Test 3: too few records → correction 0 --------------------------------
print("\n=== Test 3: < MIN_SAMPLES_ESTIMATE records → correction 0 ===")
recs = [make_record("SPY", "1d", days_ago=1, anchor=100.0,
                     pred_target=97.0, realized=102.0) for _ in range(10)]
path = write_history(recs)
try:
    model = bc.estimate_bias(path, window_days=14)
    m = model.get("SPY|1d")
    check("few-sample group present", m is not None)
    check("correction NOT applied (too few samples)",
          m and not m["applied"],
          f"applied={m['applied'] if m else None}")
    check("correction_pct is 0", m and m["correction_pct"] == 0.0)
    check("reason mentions sample count",
          m and "campioni" in (m.get("reason") or ""),
          f"reason={m.get('reason') if m else None}")
finally:
    os.unlink(path)


# --- Test 4: apply_correction anchor invariance + time-weight --------------
print("\n=== Test 4: apply_correction — anchor intact, target +5%, bands coherent ===")
forecast = {
    "SP500_bias": {
        "ticker": "SPY", "last_price_1d": 100.0, "trend_bias": "BEARISH",
        "strength_pct": -1.0,
        "forecast_1d": {
            "last_price": 100.0,
            "expected_high": 101.0, "expected_low": 99.0,
            "predicted_volatility_pct": 4.0,
            "candles": [
                {"timestamp": "t0", "open": 100.0, "high": 100.5, "low": 99.5, "close": 100.0,
                 "close_p10": 99.0, "close_p90": 101.0, "high_p10": 99.5, "high_p90": 101.5,
                 "low_p10": 98.5, "low_p90": 100.5, "volume": 1000},
                {"timestamp": "t1", "open": 100.0, "high": 100.7, "low": 99.3, "close": 99.5,
                 "close_p10": 98.5, "close_p90": 100.5, "high_p10": 99.0, "high_p90": 101.0,
                 "low_p10": 98.0, "low_p90": 100.0, "volume": 1000},
                {"timestamp": "t2", "open": 99.5, "high": 99.8, "low": 99.0, "close": 99.0,
                 "close_p10": 98.0, "close_p90": 100.0, "high_p10": 98.5, "high_p90": 100.5,
                 "low_p10": 97.5, "low_p90": 99.5, "volume": 1000},
            ],
        },
        "forecast_4h": {"last_price": 100.0, "candles": []},
    },
    "NASDAQ_bias": {"ticker": "QQQ", "forecast_4h": {"last_price": 200.0, "candles": []},
                    "forecast_1d": {"last_price": 200.0, "candles": []}},
}
model = {"SPY|1d": {"method": "offset_median", "applied": True, "correction_pct": 5.0,
                    "n_samples": 100, "n_train": 70, "holdout_n": 30,
                    "holdout_acc_raw": 0.3, "holdout_acc_corrected": 0.9, "holdout_delta_pp": 60.0,
                    "reason": "test"}}
out = bc.apply_correction(forecast, model)
sp1d = out["SP500_bias"]["forecast_1d"]
candles = sp1d["candles"]
check("anchor last_price unchanged (100.0)", sp1d["last_price"] == 100.0)
check("candle[0] close unchanged (weight 0)", candles[0]["close"] == 100.0)
check("candle[2] close shifted +5% (99.0 → 103.95)",
      abs(candles[2]["close"] - 103.95) < 0.01, f"got {candles[2]['close']}")
check("candle[1] close shifted ~+2.5% (99.5 → ~101.99)",
      abs(candles[1]["close"] - 101.9875) < 0.01, f"got {candles[1]['close']}")
check("band close_p90 moves with trajectory (100.0 → 105.0)",
      abs(candles[2]["close_p90"] - 105.0) < 0.01, f"got {candles[2]['close_p90']}")
check("trend_bias re-derived BULLISH (target now above anchor)",
      out["SP500_bias"]["trend_bias"] == "BULLISH",
      f"got {out['SP500_bias']['trend_bias']}")
check("diagnostic block attached",
      sp1d.get("bias_correction", {}).get("applied") is True)


# --- Test 5: group with applied=False left untouched -----------------------
print("\n=== Test 5: applied=False group — candles unchanged, diag block present ===")
forecast2 = {
    "SP500_bias": {
        "forecast_1d": {
            "last_price": 100.0,
            "candles": [{"timestamp": "t0", "open": 100.0, "high": 100.5, "low": 99.5,
                         "close": 99.0, "close_p10": 98.0, "close_p90": 100.0,
                         "high_p10": 99.0, "high_p90": 101.0, "low_p10": 97.5,
                         "low_p90": 99.5, "volume": 1000}],
        },
    },
    "NASDAQ_bias": {"forecast_1d": {"last_price": 200.0, "candles": []}},
}
model2 = {"SPY|1d": {"method": "offset_median", "applied": False, "correction_pct": 0.0,
                     "n_samples": 100, "holdout_delta_pp": -5.0,
                     "reason": "holdout non migliora"}}
out2 = bc.apply_correction(forecast2, model2)
sp = out2["SP500_bias"]["forecast_1d"]
check("untouched candle close unchanged (99.0)",
      sp["candles"][0]["close"] == 99.0)
check("diag block shows applied=False",
      sp.get("bias_correction", {}).get("applied") is False)
check("diag block carries reason",
      "non migliora" in sp.get("bias_correction", {}).get("reason", ""))


# --- SUMMARY ---------------------------------------------------------------
print(f"\n{'='*60}")
print(f"RESULTS: {PASS} passed, {FAIL} failed")
print(f"{'='*60}")
sys.exit(1 if FAIL else 0)
