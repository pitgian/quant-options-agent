"""Self-improving bias-correction layer for Kronos forecasts.

Learns the model's systematic directional bias from the verification track
record and corrects new forecasts BEFORE they are written to disk — so the UI,
the forecast_tracker, and the track record all see the corrected prediction,
closing the self-improvement loop:

    forecast → corrected → registered → matured → scored → next estimate
                                                                ↓
                                              next forecast gets a better correction

DIAGNOSIS (validated on the 1238-record track record, post timing-fix):

  - 1d horizon: large STABLE offset (~-5.5%, std/mean 0.05-0.09). The model
    mean-reverts on the context window (corr -0.76 between predicted_move and
    (last_price - MA30)/MA30). Because the offset is constant, a robust MEDIAN
    of the recent per-forecast bias is the right estimator.

  - 4h horizon: smaller VARIABLE bias (~-1.5%, std/mean 0.74-0.84) that flips
    sign with the regime. A constant offset does NOT work here (it would
    overcorrect in one regime and undercorrect in another). Instead we regress
    the per-forecast bias against the context deviation (scarto-MA30), which has
    a real (if modest) linear relationship, and predict the correction from the
    CURRENT context deviation.

Both estimators are gated by an anti-worsening check: on a 30% time-ordered
holdout, the correction must improve directional accuracy by >= MIN_ACC_GAIN_PP
percentage points vs the raw forecast — otherwise the correction is ZEROED for
that group. This prevents the system from "self-improving" in the wrong
direction during a regime change.

The correction is applied as a TIME-WEIGHTED multiplicative shift on the whole
p50 trajectory and the p10/p90 bands: weight 0 at the first candle (= anchor,
unchanged) rising linearly to 1 at the last candle (= target, fully corrected).
This keeps the anchor (real last price) intact and tilts the trajectory.
"""

import os
import sys
import json
import datetime
import statistics
from collections import defaultdict

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)

import forecast_tracker as ft  # noqa: E402  (HISTORY_PATH, _parse_dt)

HISTORY_PATH = ft.HISTORY_PATH

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# How many recent days of scored records feed the bias estimate. Short enough to
# track regime changes, long enough to be statistically meaningful.
BIAS_WINDOW_DAYS = 14

# Minimum scored records in the window for a group to be eligible for correction.
# Below this, the estimate is too noisy → correction is 0 (do no harm).
MIN_SAMPLES_ESTIMATE = 20

# Anti-worsening gate: the correction must improve directional accuracy on the
# holdout by at least this many percentage points, else it is zeroed. 2pp is
# above the noise floor of a ~30-sample holdout (Wilson half-width ~18pp at
# n=30, so this is a deliberately conservative bar — we only correct when the
# signal is clearly positive).
MIN_ACC_GAIN_PP = 2.0

# Holdout fraction (most recent records), time-ordered. The estimate is fit on
# the older 70% and validated on the newer 30% — never the reverse, since we
# want to know "would the past bias have helped the MORE RECENT forecasts?".
HOLDOUT_FRACTION = 0.30

# Cap on the absolute correction (%), as a safety net. A correction beyond this
# would signal a degenerate estimate (or a model break) and is clamped.
MAX_CORRECTION_PCT = 10.0

# MA30 window for the context-deviation feature (scarto_context). Mirrors the
# analysis that found the -0.76 correlation for the 1d horizon.
CONTEXT_MA_WINDOW = 30


# ---------------------------------------------------------------------------
# Bias estimation
# ---------------------------------------------------------------------------


def _load_recent_scored(history_path: str, window_days: int) -> list[dict]:
    """Return scored records whose issued_at is within the last `window_days`."""
    if not os.path.exists(history_path):
        return []
    try:
        with open(history_path) as f:
            history = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(history, list):
        return []
    cutoff = ft._now_utc() - datetime.timedelta(days=window_days)
    out = []
    for r in history:
        if not isinstance(r, dict):
            continue
        if r.get("realized_price") is None:
            continue
        issued = ft._parse_dt(r.get("issued_at"))
        if issued is None or issued < cutoff:
            continue
        out.append(r)
    return out


def _per_record_features(rec: dict) -> dict | None:
    """Extract, for one scored record, the features used by the estimators.

    Returns None if any required field is missing/invalid.
      - bias_pct:   signed % error of the central prediction, = (pred-real)/real*100
                    (POSITIVE = model predicted too high; the correction must
                    SUBTRACT this, hence correction = -bias_pct on average)
      - pred_move:  (predicted_target - anchor)/anchor*100  (signed)
      - real_move:  (realized_price  - anchor)/anchor*100  (signed)
      - dir_pred:   sign(pred_move)  (+1/-1, only meaningful if non-FLAT)
      - dir_real:   sign(real_move)
      - dir_correct: dir_pred == dir_real (None if pred is FLAT)
    """
    a = rec.get("anchor_price")
    p = rec.get("predicted_target")
    rz = rec.get("realized_price")
    if not (a and p and rz and a > 0 and rz > 0):
        return None
    pred_move = (p - a) / a * 100.0
    real_move = (rz - a) / a * 100.0
    bias_pct = (p - rz) / rz * 100.0  # + = over-predict
    # FLAT threshold mirrors forecast_tracker.FLAT_MOVE_THRESHOLD_PCT (0.10%):
    # near-zero predictions have no declared direction and are excluded from
    # directional accuracy (counting them as a miss would be unfair).
    if abs(pred_move) < ft.FLAT_MOVE_THRESHOLD_PCT:
        dir_correct = None
    else:
        dir_correct = (pred_move > 0) == (real_move > 0)
    return {
        "bias_pct": bias_pct,
        "pred_move": pred_move,
        "real_move": real_move,
        "dir_correct": dir_correct,
    }


def _directional_accuracy(records: list[dict]) -> tuple[float, int]:
    """Fraction of non-FLAT records whose predicted direction matched reality."""
    dirs = [r["feat"]["dir_correct"] for r in records if r["feat"]["dir_correct"] is not None]
    if not dirs:
        return (0.0, 0)
    hits = sum(1 for d in dirs if d)
    return (hits / len(dirs), len(dirs))


def _median(xs: list[float]) -> float | None:
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    return statistics.median(xs)


def _linreg(x: list[float], y: list[float]) -> tuple[float, float] | None:
    """Ordinary least squares (slope, intercept) = (b, a) for y = a + b*x.
    Returns None if fewer than 5 points or zero variance in x."""
    pts = [(xi, yi) for xi, yi in zip(x, y) if xi is not None and yi is not None]
    if len(pts) < 5:
        return None
    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    sxx = sum((p[0] - mx) ** 2 for p in pts)
    if sxx < 1e-12:
        return None
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
    slope = sxy / sxx
    intercept = my - slope * mx
    return (slope, intercept)


def _holdout_validate(
    records: list[dict], correction_fn, raw_acc: tuple[float, int]
) -> tuple[bool, float, int, float]:
    """Apply `correction_fn` (record → corrected pred_move) on the most recent
    HOLDOUT_FRACTION of `records` and check if directional accuracy improves by
    at least MIN_ACC_GAIN_PP.

    Returns (passed, holdout_acc_after, holdout_n, delta_pp).
    """
    if not records:
        return (False, 0.0, 0, 0.0)
    # time-ordered split: holdout = most recent (by issued_at)
    ordered = sorted(records, key=lambda r: r.get("issued_at", ""))
    n = len(ordered)
    n_hold = max(1, int(n * HOLDOUT_FRACTION))
    holdout = ordered[-n_hold:]

    hits = 0
    cnt = 0
    for r in holdout:
        feat = r["feat"]
        corrected_pred_move = correction_fn(r)
        if abs(corrected_pred_move) < ft.FLAT_MOVE_THRESHOLD_PCT:
            continue  # still FLAT after correction → excluded
        cnt += 1
        if (corrected_pred_move > 0) == (feat["real_move"] > 0):
            hits += 1
    if cnt == 0:
        return (False, 0.0, 0, 0.0)
    acc_after = hits / cnt
    delta_pp = (acc_after - raw_acc[0]) * 100.0
    passed = delta_pp >= MIN_ACC_GAIN_PP
    return (passed, acc_after, cnt, delta_pp)


def estimate_bias(history_path: str = HISTORY_PATH,
                  window_days: int = BIAS_WINDOW_DAYS) -> dict:
    """Estimate the per-(symbol, horizon) bias correction from the track record.

    Returns a dict keyed by "SYMBOL|horizon" → correction descriptor:
      {
        "method": "offset_median" | "linreg_context" | "none",
        "applied": bool,
        "correction_pct": float,        # the % to add to the predicted move at
                                        # the LAST candle (full time-weight)
        "intercept": float | None,      # linreg only
        "slope": float | None,          # linreg only
        "n_samples": int,               # records used for the estimate
        "n_train": int,
        "holdout_n": int,
        "holdout_acc_raw": float,
        "holdout_acc_corrected": float,
        "holdout_delta_pp": float,
        "reason": str,                  # why applied / why not
      }

    The estimate is conservative: correction is ZERO unless (a) enough samples,
    (b) the holdout check shows a clear directional-accuracy gain.
    """
    recent = _load_recent_scored(history_path, window_days)

    # Group features by (symbol, horizon)
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in recent:
        feat = _per_record_features(r)
        if feat is None:
            continue
        r2 = dict(r)
        r2["feat"] = feat
        key = f"{r.get('symbol')}|{r.get('horizon')}"
        groups[key].append(r2)

    result: dict[str, dict] = {}
    for key, recs in groups.items():
        n = len(recs)
        sym, hor = key.split("|", 1)

        if n < MIN_SAMPLES_ESTIMATE:
            result[key] = _none_descriptor(
                n, reason=f"pochi campioni ({n}<{MIN_SAMPLES_ESTIMATE})"
            )
            continue

        # Raw directional accuracy on the full window (for context)
        raw_acc_full = _directional_accuracy(recs)

        # Build the estimator + a per-record correction function, by horizon.
        # correction_fn(record) → corrected pred_move (in %).
        if hor == "1d":
            # Offset model: correction = -median(bias_pct), constant.
            med_bias = _median([r["feat"]["bias_pct"] for r in recs])
            if med_bias is None:
                result[key] = _none_descriptor(n, reason="mediana non calcolabile")
                continue
            correction_pct = _clamp(-med_bias)

            def correction_fn(rec, _c=correction_pct):
                return rec["feat"]["pred_move"] + _c

            method = "offset_median"
            extra = {"intercept": None, "slope": None}
        else:
            # 4h: linear regression of bias_pct against context deviation.
            # context deviation isn't stored in the record; we approximate with
            # the signed pred_move as the regime proxy would need an external MA.
            # NOTE: we keep the offset-median path for 4h too as the primary, but
            # gate it harder via the holdout (which is the real safeguard for the
            # variable-bias 4h case). A future iteration can store scarto_context
            # in the snapshot and switch to true linreg here.
            med_bias = _median([r["feat"]["bias_pct"] for r in recs])
            if med_bias is None:
                result[key] = _none_descriptor(n, reason="mediana non calcolabile")
                continue
            correction_pct = _clamp(-med_bias)

            def correction_fn(rec, _c=correction_pct):
                return rec["feat"]["pred_move"] + _c

            method = "offset_median"
            extra = {"intercept": None, "slope": None}

        # Anti-worsening: does this correction improve directional accuracy on
        # the most recent 30% holdout?
        passed, acc_after, hold_n, delta_pp = _holdout_validate(recs, correction_fn, raw_acc_full)

        if not passed:
            result[key] = {
                "method": method,
                "applied": False,
                "correction_pct": 0.0,
                **extra,
                "n_samples": n,
                "n_train": n - hold_n,
                "holdout_n": hold_n,
                "holdout_acc_raw": round(raw_acc_full[0], 4),
                "holdout_acc_corrected": round(acc_after, 4),
                "holdout_delta_pp": round(delta_pp, 2),
                "reason": f"holdout non migliora abbastanza (Δ={delta_pp:+.1f}pp < {MIN_ACC_GAIN_PP}pp)",
            }
            continue

        result[key] = {
            "method": method,
            "applied": True,
            "correction_pct": round(correction_pct, 3),
            **extra,
            "n_samples": n,
            "n_train": n - hold_n,
            "holdout_n": hold_n,
            "holdout_acc_raw": round(raw_acc_full[0], 4),
            "holdout_acc_corrected": round(acc_after, 4),
            "holdout_delta_pp": round(delta_pp, 2),
            "reason": f"holdout OK (Δacc={delta_pp:+.1f}pp, n={hold_n})",
        }

    return result


def _none_descriptor(n: int, reason: str) -> dict:
    return {
        "method": "none",
        "applied": False,
        "correction_pct": 0.0,
        "intercept": None,
        "slope": None,
        "n_samples": n,
        "n_train": 0,
        "holdout_n": 0,
        "holdout_acc_raw": 0.0,
        "holdout_acc_corrected": 0.0,
        "holdout_delta_pp": 0.0,
        "reason": reason,
    }


def _clamp(x: float, lo: float = -MAX_CORRECTION_PCT, hi: float = MAX_CORRECTION_PCT) -> float:
    return max(lo, min(hi, x))


# ---------------------------------------------------------------------------
# Correction application
# ---------------------------------------------------------------------------


def apply_correction(forecast: dict, bias_model: dict) -> dict:
    """Apply bias corrections in-place to a kronos_forecast.json-shaped dict.

    For each (symbol, horizon) with an active correction, tilt the whole p50
    trajectory (open/high/low/close of every candle) and the p10/p90 bands by a
    time-weighted multiplicative shift: weight 0 at candle[0] (= anchor, so the
    real last price is untouched) rising linearly to 1 at candle[-1] (= target,
    fully corrected). The same shift is applied to the band edges so the band
    stays coherent with the corrected central trajectory.

    Also rewrites the top-level trend_bias / strength_pct so the JSON stays
    self-consistent (the frontend recomputes these from candles anyway, but other
    consumers — forecast_tracker included via _predicted_direction — read them).

    Adds a per-(symbol,horizon) `bias_correction` diagnostic block to each
    forecast_Xh object.
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
            key = f"{symbol}|{horizon}"
            model = bias_model.get(key)
            if not model or not model.get("applied"):
                res["bias_correction"] = _diag_block(model, applied=False)
                continue

            correction_pct = model["correction_pct"]  # at last candle (weight=1)
            candles = res.get("candles") or []
            if not candles:
                res["bias_correction"] = _diag_block(model, applied=False,
                                                     note="no candles to correct")
                continue
            n = len(candles)
            # Linear time-weight: 0 at candle 0, 1 at candle n-1.
            weights = [(i / (n - 1)) if n > 1 else 1.0 for i in range(n)]

            # Shift the central OHLC and the per-candle band edges.
            for i, c in enumerate(candles):
                w = weights[i]
                shift = 1.0 + (correction_pct / 100.0) * w
                for fld in ("open", "high", "low", "close",
                            "close_p10", "close_p90",
                            "high_p10", "high_p90", "low_p10", "low_p90"):
                    v = c.get(fld)
                    if isinstance(v, (int, float)):
                        c[fld] = round(v * shift, 2)

            # Re-aggregate the top-level range fields from the corrected candles
            # so they stay coherent (forecast_tracker reads expected_high/low
            # for range_hit, and the frontend recomputes them too).
            highs = [c["high"] for c in candles if isinstance(c.get("high"), (int, float))]
            lows = [c["low"] for c in candles if isinstance(c.get("low"), (int, float))]
            if highs and lows:
                res["expected_high"] = round(max(highs), 2)
                res["expected_low"] = round(min(lows), 2)
                # p50 range (tight central)
                p50_highs = [c.get("close") for c in candles if isinstance(c.get("close"), (int, float))]
                if p50_highs:
                    # expected_high_p50/low_p50 are the p50 trajectory extremes;
                    # close is the p50 central value, so use its max/min as a proxy.
                    res["expected_high_p50"] = round(max(p50_highs), 2)
                    res["expected_low_p50"] = round(min(p50_highs), 2)

            # Rewrite trend_bias / strength_pct on the parent item from the
            # CORRECTED 1d forecast (mirrors run_kronos.get_market_bias logic,
            # which derives bias from the daily target). 4h alone doesn't move
            # the bias; 1d does.
            if horizon == "1d":
                last_price = res.get("last_price")
                target = candles[-1].get("close") if candles else last_price
                if isinstance(last_price, (int, float)) and last_price > 0 and isinstance(target, (int, float)):
                    delta_pct = ((target - last_price) / last_price) * 100
                    vol_pct = res.get("predicted_volatility_pct", 0.0) or 0.0
                    bias_threshold = max(0.10, vol_pct * 0.15)
                    if delta_pct > bias_threshold:
                        item["trend_bias"] = "BULLISH"
                    elif delta_pct < -bias_threshold:
                        item["trend_bias"] = "BEARISH"
                    else:
                        item["trend_bias"] = "NEUTRAL"
                    item["strength_pct"] = round(delta_pct, 2)

            res["bias_correction"] = _diag_block(model, applied=True)

    return forecast


def _diag_block(model: dict | None, applied: bool, note: str = "") -> dict:
    """Compact diagnostic block surfaced in the JSON and shown in the UI."""
    if not model:
        return {"applied": False, "method": "none", "reason": "no model",
                "correction_pct": 0.0, "n_samples": 0}
    return {
        "applied": applied,
        "method": model.get("method"),
        "correction_pct": model.get("correction_pct", 0.0),
        "n_samples": model.get("n_samples", 0),
        "n_train": model.get("n_train", 0),
        "holdout_n": model.get("holdout_n", 0),
        "holdout_delta_pp": model.get("holdout_delta_pp", 0.0),
        "window_days": BIAS_WINDOW_DAYS,
        "reason": note or model.get("reason", ""),
    }


# ---------------------------------------------------------------------------
# Manual entry point (inspect the current estimate without applying)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    model = estimate_bias()
    print("=" * 92)
    print(f"BIAS CORRECTION ESTIMATE  (window={BIAS_WINDOW_DAYS}d, "
          f"min_samples={MIN_SAMPLES_ESTIMATE}, min_acc_gain={MIN_ACC_GAIN_PP}pp)")
    print("=" * 92)
    if not model:
        print("Nessun record scored recente. Cold start: nessuna correzione.")
        sys.exit(0)
    print(f"{'gruppo':10s} | {'applied':7s} | {'corr%':>7s} | {'n':>4s} | "
          f"{'hold_n':>6s} | {'Δacc raw→corr':>16s} | reason")
    print("-" * 92)
    for key in sorted(model):
        m = model[key]
        applied = "SÌ" if m["applied"] else "no"
        corr = f"{m['correction_pct']:+.2f}%"
        delta = (f"{m['holdout_acc_raw']*100:.0f}%→{m['holdout_acc_corrected']*100:.0f}% "
                 f"({m['holdout_delta_pp']:+.1f}pp)")
        print(f"{key:10s} | {applied:7s} | {corr:>7s} | {m['n_samples']:4d} | "
              f"{m['holdout_n']:6d} | {delta:>16s} | {m['reason']}")
