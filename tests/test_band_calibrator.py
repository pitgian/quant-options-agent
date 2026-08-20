"""Unit tests for the band_calibrator self-improvement layer.

Exercises:
  1. estimate_band_calibration recovers a known widening factor (synthetic
     history where realized prices sit ~3 half-widths outside a 1%-wide band).
  2. Anti-worsening: when the native band already covers ~everything (factor
     would be ≈1), no widening is applied.
  3. With too few records (< MIN_SAMPLES), calibration is 0.
  4. apply_band_calibration: central trajectory and anchor untouched; band
     edges widened symmetrically by the factor; expected_high/low and
     predicted_volatility_pct re-aggregated; diagnostic block attached.
  5. apply_band_calibration leaves a group untouched when applied=False, and
     attaches the diagnostic block with the reason.

Run: venv/bin/python tests/test_band_calibrator.py
"""
import os
import sys
import json
import tempfile
import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import band_calibrator as bcal  # noqa: E402
import forecast_tracker as ft  # noqa: E402  (for _now_utc)

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


def make_record(symbol, horizon, days_ago, center, half, realized,
                issued=None):
    """Build a scored history record with band fields.

    `center` is predicted_target (the p50 close), `half` the band half-width:
    band_p10 = center - half, band_p90 = center + half. The anchor equals the
    center so the record declares no directional move (irrelevant here — only
    band fields matter to the calibrator).
    """
    if issued is None:
        issued = (ft._now_utc() - datetime.timedelta(days=days_ago)).isoformat()
    return {
        "v": 2,
        "issued_at": issued,
        "symbol": symbol,
        "horizon": horizon,
        "target_at": issued,
        "anchor_price": center,
        "predicted_target": center,
        "realized_price": realized,
        "predicted_high": center + half,
        "predicted_low": center - half,
        "band_p10": center - half,
        "band_p90": center + half,
        "predicted_direction": "FLAT",
        "direction_correct": None,
    }


def write_history(records):
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    json.dump(records, f)
    f.close()
    return f.name


# --- Test 1: recover a known widening factor -------------------------------
print("\n=== Test 1: estimate recovers a known widening factor (~×3) ===")
# Band half-width = 1% of price; realized always lands 3 half-widths ABOVE the
# center (the documented UP-side under-coverage). The 80th percentile of |z|
# is exactly 3.0 → factor 3.0, and the holdout must show native coverage 0%
# vs calibrated 100%.
recs = []
for i in range(60):
    center = 100.0 + i * 0.01
    half = center * 0.01
    realized = center + 3.0 * half
    recs.append(make_record("SPY", "4h", days_ago=13 - (i % 14),
                            center=center, half=half, realized=realized))
path = write_history(recs)
try:
    model = bcal.estimate_band_calibration(path, window_days=14)
    m = model.get("SPY|4h")
    check("SPY|4h present in model", m is not None, f"keys={list(model)}")
    check("calibration applied", m and m["applied"], f"model={m}")
    check("factor ≈ 3.0",
          m and abs(m["factor"] - 3.0) < 0.05,
          f"got {m['factor'] if m else None}")
    check("holdout coverage improves",
          m and m["coverage_gain_pp"] >= bcal.MIN_COV_GAIN_PP,
          f"gain={m['coverage_gain_pp'] if m else None}pp")
    check("holdout native coverage ≈ 0%",
          m and m["holdout_cov_native"] < 0.05,
          f"native={m['holdout_cov_native'] if m else None}")
finally:
    os.unlink(path)


# --- Test 2: already-calibrated band → no widening -------------------------
print("\n=== Test 2: native band well-calibrated → factor 1, NOT applied ===")
# Realized uniformly inside ±0.5 half-widths: the q80 of |z| ≈ 0.5 → clamped
# to 1.0 (widen-only). Holdout coverage gain ≈ 0pp → gated off.
import random
random.seed(7)
recs = []
for i in range(60):
    center = 100.0 + i * 0.01
    half = center * 0.01
    realized = center + random.uniform(-0.5, 0.5) * half
    recs.append(make_record("QQQ", "1d", days_ago=13 - (i % 14),
                            center=center, half=half, realized=realized))
path = write_history(recs)
try:
    model = bcal.estimate_band_calibration(path, window_days=14)
    m = model.get("QQQ|1d")
    check("QQQ|1d present", m is not None)
    check("factor clamped to 1.0 (widen-only)",
          m and m["factor"] == 1.0, f"factor={m['factor'] if m else None}")
    check("NOT applied (no gain possible)",
          m and not m["applied"], f"applied={m['applied'] if m else None}")
finally:
    os.unlink(path)


# --- Test 3: too few records → calibration 0 -------------------------------
print("\n=== Test 3: < MIN_SAMPLES records → not applied ===")
recs = [make_record("SPY", "4h", days_ago=1, center=100.0, half=1.0, realized=103.0)
        for _ in range(10)]
path = write_history(recs)
try:
    model = bcal.estimate_band_calibration(path, window_days=14)
    m = model.get("SPY|4h")
    check("few-sample group present", m is not None)
    check("calibration NOT applied (too few samples)",
          m and not m["applied"], f"applied={m['applied'] if m else None}")
    check("reason mentions sample count",
          m and "campioni" in (m.get("reason") or ""),
          f"reason={m.get('reason') if m else None}")
finally:
    os.unlink(path)


# --- Test 4: apply — center untouched, bands widened coherently ------------
print("\n=== Test 4: apply_band_calibration — center intact, bands ×3 ===")
forecast = {
    "SP500_bias": {
        "ticker": "SPY", "last_price_1d": 100.0, "trend_bias": "BEARISH",
        "strength_pct": -1.0,
        "forecast_1d": {
            "last_price": 100.0,
            "expected_high": 100.9, "expected_low": 98.1,
            "expected_high_p50": 100.5, "expected_low_p50": 99.5,
            "predicted_volatility_pct": 2.8,
            "candles": [
                {"timestamp": "t0", "open": 100.0, "high": 100.5, "low": 99.5, "close": 100.0,
                 "close_p10": 99.3, "close_p90": 100.7, "high_p10": 99.8, "high_p90": 101.2,
                 "low_p10": 98.8, "low_p90": 100.2, "volume": 1000},
                {"timestamp": "t1", "open": 99.8, "high": 100.3, "low": 99.3, "close": 99.5,
                 "close_p10": 98.8, "close_p90": 100.2, "high_p10": 99.6, "high_p90": 101.0,
                 "low_p10": 98.6, "low_p90": 100.0, "volume": 1000},
                {"timestamp": "t2", "open": 99.5, "high": 100.0, "low": 99.0, "close": 99.0,
                 "close_p10": 98.3, "close_p90": 99.7, "high_p10": 99.3, "high_p90": 100.7,
                 "low_p10": 98.3, "low_p90": 99.7, "volume": 1000},
            ],
        },
        "forecast_4h": {"last_price": 100.0, "candles": []},
    },
    "NASDAQ_bias": {"ticker": "QQQ", "forecast_4h": {"last_price": 200.0, "candles": []},
                    "forecast_1d": {"last_price": 200.0, "candles": []}},
}
model = {
    "SPY|1d": {"method": "conformal_scale", "applied": True, "factor": 3.0,
               "n_samples": 100, "n_train": 70, "holdout_n": 30,
               "holdout_cov_native": 0.05, "holdout_cov_calibrated": 0.95,
               "coverage_gain_pp": 90.0, "reason": "test"},
    # 4h deliberately absent → "no model" diag block path.
}
out = bcal.apply_band_calibration(forecast, model)
sp1d = out["SP500_bias"]["forecast_1d"]
candles = sp1d["candles"]
check("anchor last_price unchanged (100.0)", sp1d["last_price"] == 100.0)
check("candle[1] close unchanged (center untouched)", candles[1]["close"] == 99.5)
check("candle[1] close_p10 widened 98.8 → 97.4 (±0.7 → ±2.1)",
      abs(candles[1]["close_p10"] - 97.4) < 0.01, f"got {candles[1]['close_p10']}")
check("candle[1] close_p90 widened 100.2 → 101.6",
      abs(candles[1]["close_p90"] - 101.6) < 0.01, f"got {candles[1]['close_p90']}")
check("symmetry: center equidistant from widened edges",
      abs((candles[1]["close"] - candles[1]["close_p10"])
          - (candles[1]["close_p90"] - candles[1]["close"])) < 0.02)
check("band ordering preserved (p10 ≤ close ≤ p90)",
      candles[1]["close_p10"] <= candles[1]["close"] <= candles[1]["close_p90"])
# candle[1] high=100.3, high_p10=99.6, high_p90=101.0 → ±0.7 → ×3: 98.2 / 102.4
check("high band widened around its own center (99.6→98.2, 101.0→102.4)",
      abs(candles[1]["high_p10"] - 98.2) < 0.01 and abs(candles[1]["high_p90"] - 102.4) < 0.01,
      f"got {candles[1]['high_p10']}/{candles[1]['high_p90']}")
# outer range re-aggregated from widened edges: max(high_p90) = candle[0]
# 100.5+3×0.7 = 102.6; min(low_p10) = candle[2] 99.0−3×0.7 = 96.9
check("expected_high re-aggregated (100.9 → 102.6)",
      abs(sp1d["expected_high"] - 102.6) < 0.01, f"got {sp1d['expected_high']}")
check("expected_low re-aggregated (98.1 → 96.9)",
      abs(sp1d["expected_low"] - 96.9) < 0.01, f"got {sp1d['expected_low']}")
check("predicted_volatility_pct recomputed",
      abs(sp1d["predicted_volatility_pct"] - 5.7) < 0.05,
      f"got {sp1d['predicted_volatility_pct']}")
check("p50 range fields untouched", sp1d["expected_high_p50"] == 100.5)
check("diag block attached with factor",
      sp1d.get("band_calibration", {}).get("factor") == 3.0)
check("group without model gets 'no model' diag",
      out["SP500_bias"]["forecast_4h"].get("band_calibration", {}).get("reason") == "no model")


# --- Test 5: apply with applied=False leaves forecast untouched -------------
print("\n=== Test 5: applied=False → forecast untouched, diag attached ===")
forecast2 = {
    "SP500_bias": {
        "forecast_1d": {
            "last_price": 100.0, "expected_high": 101.0, "expected_low": 99.0,
            "candles": [{"close": 100.0, "close_p10": 99.0, "close_p90": 101.0}],
        },
    },
}
model2 = {"SPY|1d": {"method": "conformal_scale", "applied": False, "factor": 1.0,
                     "n_samples": 40, "reason": "gated"}}
out2 = bcal.apply_band_calibration(forecast2, model2)
c = out2["SP500_bias"]["forecast_1d"]["candles"][0]
check("candle untouched", c["close_p10"] == 99.0 and c["close_p90"] == 101.0)
check("expected range untouched",
      out2["SP500_bias"]["forecast_1d"]["expected_high"] == 101.0)
check("diag block attached with applied=false",
      out2["SP500_bias"]["forecast_1d"].get("band_calibration", {}).get("applied") is False)


# --- Summary ---------------------------------------------------------------
print()
print("=" * 60)
if FAIL:
    print(f"FAILED: {FAIL} check(s) failed ({PASS} passed)")
    sys.exit(1)
print(f"OK: all {PASS} checks passed")
