"""Empirical (conformal-style) calibration for Kronos Monte Carlo bands.

The 80% p10–p90 band is systematically UNDER-covering: on the 1238-record
track record the realized price landed inside the band only 0–6% of the time
(nominal: 80%), with 85–100% of the misses on the UP side
(scripts/diagnose_band_calibration.py quantifies this per group and suggests
widening factors ×3.5–5.6). The Kronos sampler's own dispersion is therefore
not a reliable measure of forecast uncertainty — it must be recalibrated
against realized outcomes.

This module is the self-improving layer that closes the loop, mirroring the
architecture of bias_corrector.py (estimate from the verification track record
→ anti-worsening holdout gate → apply to the fresh forecast BEFORE it is
written to disk):

    forecast → bias-corrected → band-calibrated → registered → scored
                                                                  ↓
                                              next estimate sees realized coverage

METHOD (split-conformal in spirit, per (symbol, horizon)):

  For each scored snapshot with band fields, standardize the realized error by
  the band's own half-width:

      z_i = (realized_i − predicted_target_i) / ((band_p90_i − band_p10_i) / 2)

  The empirical 80th percentile of |z_i| is the scale factor k that the band
  half-width would need for ~80% of past realizations to fall inside. Native
  k=1 means already calibrated; the measured k on the current track record is
  ~3.5–5.6.

GATES (do no harm):
  - ≥ MIN_SAMPLES records in the window, else no correction;
  - k clamped to [1.0, MAX_BAND_FACTOR] — widening only, never narrower than
    the model's native dispersion;
  - holdout check on the most recent HOLDOUT_FRACTION (time-ordered): the
    widened band must improve coverage by ≥ MIN_COV_GAIN_PP percentage points
    vs the native band, else the factor is zeroed.

APPLICATION: every candle's close/high/low p10–p90 edges are widened
symmetrically around their p50 central value (center untouched — the band
widens, the trajectory does not move), and the top-level expected_high /
expected_low / predicted_volatility_pct are re-aggregated from the widened
outer edges so range_hit scoring and the UI stay coherent.
"""

import os
import sys
import json
import datetime
import statistics
from collections import defaultdict

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)

import forecast_tracker as ft  # noqa: E402  (HISTORY_PATH)
import bias_corrector as bc    # noqa: E402  (_load_recent_scored, window conventions)

HISTORY_PATH = ft.HISTORY_PATH

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Same estimation window as the bias corrector: short enough to track regime
# changes, long enough to be statistically meaningful.
BAND_WINDOW_DAYS = bc.BIAS_WINDOW_DAYS

# Minimum scored records in the window for a group to be eligible.
MIN_SAMPLES = 30

# Minimum records in the holdout slice for its coverage comparison to mean
# anything (below this the gate is noise — treat as "cannot validate").
MIN_HOLDOUT_N = 15

# Target nominal coverage of the p10–p90 band.
TARGET_COVERAGE = 0.80

# Anti-worsening gate: the widened band must beat the native band's coverage on
# the holdout by at least this many percentage points.
MIN_COV_GAIN_PP = 5.0

# Widen-only clamp on the scale factor. A factor beyond this signals a
# degenerate estimate (or a model break) — clamp rather than extrapolate.
MAX_BAND_FACTOR = 6.0

# Holdout fraction (most recent records), time-ordered — same convention as
# bias_corrector.HOLDOUT_FRACTION.
HOLDOUT_FRACTION = 0.30


# ---------------------------------------------------------------------------
# Estimation
# ---------------------------------------------------------------------------


def _quantile(xs: list[float], q: float) -> float | None:
    """Empirical quantile with linear interpolation (numpy-free)."""
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    if len(xs) == 1:
        return xs[0]
    pos = q * (len(xs) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(xs) - 1)
    frac = pos - lo
    return xs[lo] + (xs[hi] - xs[lo]) * frac


def _band_features(rec: dict) -> dict | None:
    """Per-record standardized band error; None if fields are missing/degenerate.

      center: predicted_target (the p50 close the band was built around)
      half:   (band_p90 − band_p10) / 2 — the band's own half-width
      z:      (realized − center) / half, in half-width units
    """
    c = rec.get("predicted_target")
    lo = rec.get("band_p10")
    hi = rec.get("band_p90")
    rz = rec.get("realized_price")
    if not all(isinstance(v, (int, float)) for v in (c, lo, hi, rz)):
        return None
    if c is None or rz <= 0 or hi <= lo:
        return None
    half = (hi - lo) / 2.0
    if half <= 0:
        return None
    return {"center": float(c), "half": half, "z": (rz - c) / half}


def _coverage(records: list[dict], factor: float) -> tuple[float, int]:
    """Fraction of records whose realized price falls inside the band widened
    by `factor` (factor=1 → the native band). Returns (coverage, n)."""
    hits = total = 0
    for r in records:
        f = r["feat"]
        lo = f["center"] - factor * f["half"]
        hi = f["center"] + factor * f["half"]
        # realized price lives on the record, not on the feature dict
        rz = r.get("realized_price")
        if not isinstance(rz, (int, float)) or rz is None:
            continue
        total += 1
        if lo <= rz <= hi:
            hits += 1
    if not total:
        return (0.0, 0)
    return (hits / total, total)


def estimate_band_calibration(history_path: str = HISTORY_PATH,
                              window_days: int = BAND_WINDOW_DAYS) -> dict:
    """Estimate the per-(symbol,horizon) band widening factor from the record.

    Returns a dict keyed by "SYMBOL|horizon" → calibration descriptor:
      {
        "method": "conformal_scale" | "none",
        "applied": bool,
        "factor": float,                  # band half-width multiplier (1 = native)
        "n_samples": int,
        "n_train": int,
        "holdout_n": int,
        "holdout_cov_native": float,      # coverage at factor=1 on the holdout
        "holdout_cov_calibrated": float,  # coverage at the chosen factor
        "coverage_gain_pp": float,
        "reason": str,
      }
    """
    recent = bc._load_recent_scored(history_path, window_days)

    groups: dict[str, list[dict]] = defaultdict(list)
    for r in recent:
        feat = _band_features(r)
        if feat is None:
            continue
        r2 = dict(r)
        r2["feat"] = feat
        groups[f"{r.get('symbol')}|{r.get('horizon')}"].append(r2)

    result: dict[str, dict] = {}
    for key, recs in groups.items():
        n = len(recs)
        if n < MIN_SAMPLES:
            result[key] = _none_descriptor(n, reason=f"pochi campioni ({n}<{MIN_SAMPLES})")
            continue

        # k = empirical 80th percentile of |z| — the widening that would have
        # captured ~80% of past realizations. Widening-only clamp.
        k_raw = _quantile([abs(r["feat"]["z"]) for r in recs], TARGET_COVERAGE)
        if k_raw is None:
            result[key] = _none_descriptor(n, reason="quantile non calcolabile")
            continue
        k = min(max(k_raw, 1.0), MAX_BAND_FACTOR)

        # Time-ordered holdout (most recent), same convention as bias_corrector.
        ordered = sorted(recs, key=lambda r: r.get("issued_at", ""))
        n_hold = max(1, int(n * HOLDOUT_FRACTION))
        holdout = ordered[-n_hold:]

        cov_nat, cnt_nat = _coverage(holdout, 1.0)
        cov_cal, cnt_cal = _coverage(holdout, k)
        cnt = max(cnt_nat, cnt_cal)
        gain_pp = (cov_cal - cov_nat) * 100.0

        if cnt < MIN_HOLDOUT_N:
            result[key] = _none_descriptor(
                n, reason=f"holdout troppo piccolo ({cnt}<{MIN_HOLDOUT_N})",
            )
            continue
        if gain_pp < MIN_COV_GAIN_PP:
            result[key] = {
                "method": "conformal_scale",
                "applied": False,
                "factor": 1.0,
                "n_samples": n,
                "n_train": n - n_hold,
                "holdout_n": n_hold,
                "holdout_cov_native": round(cov_nat, 4),
                "holdout_cov_calibrated": round(cov_cal, 4),
                "coverage_gain_pp": round(gain_pp, 2),
                "reason": f"holdout non migliora abbastanza (Δcov={gain_pp:+.1f}pp < {MIN_COV_GAIN_PP}pp)",
            }
            continue

        result[key] = {
            "method": "conformal_scale",
            "applied": True,
            "factor": round(k, 3),
            "n_samples": n,
            "n_train": n - n_hold,
            "holdout_n": n_hold,
            "holdout_cov_native": round(cov_nat, 4),
            "holdout_cov_calibrated": round(cov_cal, 4),
            "coverage_gain_pp": round(gain_pp, 2),
            "reason": f"holdout OK (Δcov={gain_pp:+.1f}pp, nat={cov_nat*100:.0f}%→{cov_cal*100:.0f}%, n={n_hold})",
        }

    return result


def _none_descriptor(n: int, reason: str) -> dict:
    return {
        "method": "none",
        "applied": False,
        "factor": 1.0,
        "n_samples": n,
        "n_train": 0,
        "holdout_n": 0,
        "holdout_cov_native": 0.0,
        "holdout_cov_calibrated": 0.0,
        "coverage_gain_pp": 0.0,
        "reason": reason,
    }


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------


def apply_band_calibration(forecast: dict, calib: dict) -> dict:
    """Widen the Monte Carlo bands of a kronos_forecast.json-shaped dict in-place.

    For each (symbol, horizon) with an active calibration, every candle's
    close/high/low p10–p90 edges are rescaled symmetrically around their p50
    central value by the group's factor; the central OHLC trajectory and the
    anchor are untouched (the band widens, the path does not move). The
    top-level expected_high / expected_low / predicted_volatility_pct are
    re-aggregated from the widened outer edges so range_hit scoring and the UI
    stay coherent with the widened bands.

    Adds a per-(symbol,horizon) `band_calibration` diagnostic block to each
    forecast_Xh object (mirrors bias_correction).
    """
    symbol_map = {"SP500": "SPY", "NASDAQ": "QQQ"}
    for market_key, symbol in symbol_map.items():
        item = forecast.get(f"{market_key}_bias")
        if not isinstance(item, dict):
            continue
        for horizon in ("4h", "1d"):
            res = item.get(f"forecast_{horizon}")
            if not isinstance(res, dict):
                continue
            model = calib.get(f"{symbol}|{horizon}")
            if not model or not model.get("applied"):
                res["band_calibration"] = _diag_block(model, applied=False)
                continue

            factor = float(model["factor"])
            candles = res.get("candles") or []
            if not candles:
                res["band_calibration"] = _diag_block(model, applied=False,
                                                      note="no candles to calibrate")
                continue

            # Widen each band pair around its own central value. Ordering is
            # preserved because factor >= 1 and the widening is symmetric.
            for c in candles:
                for base in ("close", "high", "low"):
                    center = c.get(base)
                    lo = c.get(f"{base}_p10")
                    hi = c.get(f"{base}_p90")
                    if not all(isinstance(v, (int, float)) for v in (center, lo, hi)):
                        continue
                    c[f"{base}_p10"] = round(center - factor * (center - lo), 2)
                    c[f"{base}_p90"] = round(center + factor * (hi - center), 2)

            # Re-aggregate the outer range from the widened band edges — the
            # same fields run_kronos derives from p90-high-max / p10-low-min.
            last_price = res.get("last_price")
            hi_out = [c.get("high_p90") for c in candles if isinstance(c.get("high_p90"), (int, float))]
            lo_out = [c.get("low_p10") for c in candles if isinstance(c.get("low_p10"), (int, float))]
            if hi_out and lo_out:
                res["expected_high"] = round(max(hi_out), 2)
                res["expected_low"] = round(min(lo_out), 2)
                if isinstance(last_price, (int, float)) and last_price > 0:
                    res["predicted_volatility_pct"] = round(
                        (max(hi_out) - min(lo_out)) / last_price * 100.0, 3
                    )

            res["band_calibration"] = _diag_block(model, applied=True)

    return forecast


def _diag_block(model: dict | None, applied: bool, note: str = "") -> dict:
    """Compact diagnostic block surfaced in the JSON and shown in the UI."""
    if not model:
        return {"applied": False, "method": "none", "reason": "no model",
                "factor": 1.0, "n_samples": 0}
    return {
        "applied": applied,
        "method": model.get("method"),
        "factor": model.get("factor", 1.0),
        "n_samples": model.get("n_samples", 0),
        "holdout_n": model.get("holdout_n", 0),
        "holdout_cov_native": model.get("holdout_cov_native", 0.0),
        "holdout_cov_calibrated": model.get("holdout_cov_calibrated", 0.0),
        "coverage_gain_pp": model.get("coverage_gain_pp", 0.0),
        "reason": note or model.get("reason", ""),
    }


# ---------------------------------------------------------------------------
# Manual entry point (inspect the current estimate without applying)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    model = estimate_band_calibration()
    print("=" * 96)
    print(f"BAND CALIBRATION ESTIMATE  (window={BAND_WINDOW_DAYS}d, "
          f"min_samples={MIN_SAMPLES}, min_cov_gain={MIN_COV_GAIN_PP}pp, "
          f"target={TARGET_COVERAGE:.0%})")
    print("=" * 96)
    if not model:
        print("Nessun record scored recente. Cold start: nessuna calibrazione.")
        sys.exit(0)
    print(f"{'gruppo':10s} | {'applied':7s} | {'factor':>7s} | {'n':>4s} | "
          f"{'hold_n':>6s} | {'cov nat→cal':>14s} | reason")
    print("-" * 96)
    for key in sorted(model):
        m = model[key]
        applied = "SÌ" if m["applied"] else "no"
        cov = (f"{m['holdout_cov_native']*100:.0f}%→{m['holdout_cov_calibrated']*100:.0f}% "
               f"({m['coverage_gain_pp']:+.1f}pp)")
        print(f"{key:10s} | {applied:7s} | ×{m['factor']:<6.3f} | {m['n_samples']:4d} | "
              f"{m['holdout_n']:6d} | {cov:>14s} | {m['reason']}")
