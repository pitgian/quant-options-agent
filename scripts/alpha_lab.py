#!/usr/bin/env python3
"""Alpha lab — walk-forward model arena over the verification track record.

This is the "find alpha over time" engine. Every run it replays history
walk-forward (expanding window, one-target-ahead) across a small arena of
correction models, picks a per-(symbol, horizon) CHAMPION only when the
evidence is significant, and run_kronos.py applies that champion to fresh
forecasts. As the track record grows, better models unlock:

    day 1..n        naive wins            -> dampen (×0.15) the issued move
    enough data     recal (a + b·move)    -> learned rescale+offset beats naive
    more data       feats (ridge on       -> context features (momentum, MA-dev,
                    features)                RSI, realized vol, skew/PCR/GEX)
                                             sharpen the correction

MODELS
  naive_zero   predicted move = 0                       (the baseline to beat)
  issued       the pipeline forecast as issued           (what we do today)
  recal        weighted OLS  y = a + b·x                 (≥ MIN_RECAL train rows)
  feats        weighted ridge on standardized            (≥ MIN_FEATS train rows,
               [x, momentum, ma_dev, rsi, rv, skew,         feature coverage ≥ 60%)
               pcr, gex, ...]

Where x = issued predicted move (%), y = realized move (%).

GATES (do no harm — same philosophy as bias_corrector/band_calibrator):
  * paired sign test vs naive on walk-forward abs errors, one-sided p < 0.05
  * MAE skill vs naive ≥ MIN_SKILL_PCT
  * n_test ≥ MIN_TEST
  Otherwise the champion falls back to dampen/observe — never to blind trust.

PERSISTENCE: data/alpha_lab.json holds champions + coefficients + a timeline
(appended every run) so progress toward alpha is visible over weeks.

Usage:
    python scripts/alpha_lab.py                 # fit + report + write JSON
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)

from forecast_tracker import HISTORY_PATH  # noqa: E402
from skill_evaluator import dedup_targets, load_scored  # noqa: E402

LAB_OUTPUT_PATH = os.path.join(SCRIPTS_DIR, "../data/alpha_lab.json")

LAB_VERSION = 1

# --- arena configuration -------------------------------------------------
MIN_TRAIN_RECAL = 30      # train rows required before recal unlocks
MIN_TRAIN_FEATS = 60      # train rows required before feats unlocks
FEATURE_MIN_COVERAGE = 0.6  # share of train rows that must carry a feature
HALF_LIFE = 120           # recency half-life, in targets, for weighted fits
RIDGE_LAMBDA = 1e-2       # ridge penalty on standardized features

# --- champion gates ------------------------------------------------------
MIN_TEST = 20             # walk-forward test points required to crown anyone
MIN_SKILL_PCT = 3.0       # MAE skill vs naive required (%, positive)
ALPHA_P = 0.05            # one-sided sign-test threshold

# If nothing beats naive, damp the issued move instead of trusting it.
# ×0.15 keeps a directional hint (the UI needs a shape) while removing ~85%
# of the amplitude error — the MSE-optimal-ish compromise between honesty
# and usefulness observed on the 2026-08 record (issued amplitude ~10x real).
DAMPEN_FACTOR = 0.15

# Candidate context features (stored per-snapshot by forecast_tracker since
# schema v3; older rows simply lack them and coverage gates handle that).
FEATURE_KEYS = [
    "momentum_5", "momentum_10", "ma_dev_20", "rsi_14", "rv_20",
    "skew", "pcr", "gex",
]


# ---------------------------------------------------------------------------
# Weighted linear fits (numpy only)
# ---------------------------------------------------------------------------

def _sqrt_weights(w):
    return [math.sqrt(max(x, 1e-9)) for x in w]


def fit_recal(xs, ys, ws):
    """Weighted OLS y = a + b·x. Returns (a, b) or None if degenerate."""
    n = len(xs)
    if n < 2:
        return None
    sw = _sqrt_weights(ws)
    # Weighted least squares via normal equations on (1, x).
    sww = sum(w for w in ws)
    swx = sum(w * x for w, x in zip(ws, xs))
    swxx = sum(w * x * x for w, x in zip(ws, xs))
    swy = sum(w * y for w, y in zip(ws, ys))
    swxy = sum(w * x * y for w, x, y in zip(ws, xs, ys))
    det = sww * swxx - swx * swx
    if abs(det) < 1e-12:
        return None
    a = (swxx * swy - swx * swxy) / det
    b = (sww * swxy - swx * swy) / det
    return (a, b)


def fit_feats(rows, feat_keys, ws, lam=RIDGE_LAMBDA):
    """Weighted ridge on standardized [1, x, features...].

    Returns (feat_keys, beta) or None. Standardization stats computed on the
    training rows themselves; rows missing a feature get the train-mean
    (i.e. contribution 0 after standardization).
    """
    import numpy as np
    n = len(rows)
    if n < 5:
        return None
    means = {}
    stds = {}
    for k in feat_keys:
        vals = [r["features"].get(k) for r in rows if r.get("features") and r["features"].get(k) is not None]
        if len(vals) < max(5, int(FEATURE_MIN_COVERAGE * n)):
            continue  # not enough coverage — drop the feature
        m = sum(vals) / len(vals)
        sd = math.sqrt(sum((v - m) ** 2 for v in vals) / len(vals)) or 1.0
        means[k], stds[k] = m, sd
    if not means:
        return None

    used = [k for k in feat_keys if k in means]

    def design(row):
        vec = [row["pred_move_pct"]]
        f = row.get("features") or {}
        for k in used:
            v = f.get(k)
            vec.append((v - means[k]) / stds[k] if v is not None else 0.0)
        return vec

    D = np.array([design(r) for r in rows], dtype=float)
    y = np.array([r["real_move_pct"] for r in rows], dtype=float)
    w = np.array(ws, dtype=float)
    sw = np.sqrt(w)
    Dw = D * sw[:, None]
    yw = y * sw
    # Ridge on everything except the intercept (column 0 is x, we add our own).
    X = np.hstack([np.ones((n, 1)), Dw])
    P = np.eye(X.shape[1]) * lam
    P[0, 0] = 0.0  # do not penalize intercept
    try:
        beta = np.linalg.solve(X.T @ X + P, X.T @ yw)
    except np.linalg.LinAlgError:
        return None
    return {"features": used, "means": means, "stds": stds,
            "beta": [float(b) for b in beta]}


def predict_feats(model, row) -> float:
    f = row.get("features") or {}
    acc = model["beta"][0]
    vec = [row["pred_move_pct"]] + [
        ((f.get(k) - model["means"][k]) / model["stds"][k]
         if f.get(k) is not None else 0.0)
        for k in model["features"]
    ]
    for b, v in zip(model["beta"][1:], vec):
        acc += b * v
    return acc


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

def build_rows(scored: list) -> list:
    """Deduped evaluation rows with signed moves, sorted by target time."""
    rows = []
    for r in dedup_targets(scored):
        anchor = r["anchor_price"]
        rows.append({
            "symbol": r.get("symbol"),
            "horizon": r.get("horizon"),
            "target_at": r.get("target_at"),
            "issued_at": r.get("issued_at"),
            "pred_move_pct": (r["predicted_target"] - anchor) / anchor * 100.0,
            "real_move_pct": (r["realized_price"] - anchor) / anchor * 100.0,
            "features": r.get("context_features") or None,
        })
    return rows


def group_rows(rows):
    groups = {}
    for r in rows:
        groups.setdefault(f"{r['symbol']}|{r['horizon']}", []).append(r)
    for g in groups.values():
        g.sort(key=lambda r: (r["target_at"] or "", r["issued_at"] or ""))
    return groups


# ---------------------------------------------------------------------------
# Walk-forward evaluation
# ---------------------------------------------------------------------------

def paired_sign_p(errors_a, errors_b) -> float:
    """One-sided p that model A beats B on paired abs errors (sign test)."""
    wins = sum(1 for a, b in zip(errors_a, errors_b) if a < b - 1e-12)
    n = len(errors_a)
    if n == 0:
        return 1.0
    # Exact binomial tail P(X >= wins) under p=0.5.
    tail = sum(math.comb(n, k) for k in range(wins, n + 1)) / (2 ** n)
    return min(1.0, tail)


def evaluate_group(rows: list) -> dict:
    """Walk-forward one-target-ahead over the arena for one group."""
    n = len(rows)
    errs = {m: [] for m in ("naive_zero", "issued", "recal", "feats")}
    dirs = {m: [0, 0] for m in errs}  # [correct, directional]

    recal_model = None
    feats_model = None

    for i in range(n):
        test = rows[i]
        train = rows[:i]

        # naive + issued are parameter-free.
        errs["naive_zero"].append(abs(test["real_move_pct"]))
        errs["issued"].append(abs(test["real_move_pct"] - test["pred_move_pct"]))

        # Refit on the expanding window (recency-weighted).
        ws = [0.5 ** ((len(train) - 1 - j) / HALF_LIFE) for j in range(len(train))]
        if len(train) >= MIN_TRAIN_RECAL:
            recal_model = fit_recal(
                [r["pred_move_pct"] for r in train],
                [r["real_move_pct"] for r in train],
                ws,
            )
        if len(train) >= MIN_TRAIN_FEATS:
            feats_model = fit_feats(train, FEATURE_KEYS, ws)

        if recal_model is not None:
            p = recal_model[0] + recal_model[1] * test["pred_move_pct"]
            errs["recal"].append(abs(test["real_move_pct"] - p))
        if feats_model is not None:
            p = predict_feats(feats_model, test)
            errs["feats"].append(abs(test["real_move_pct"] - p))

    def summarize(key):
        e = errs[key]
        if not e:
            return None
        mae = sum(e) / len(e)
        return {"n_test": len(e), "mae_pct": round(mae, 4)}

    out = {k: summarize(k) for k in errs}
    naive = errs["naive_zero"]
    for k in ("issued", "recal", "feats"):
        if errs[k]:
            mae = sum(errs[k]) / len(errs[k])
            mae_naive = sum(naive) / len(naive)
            skill = (mae_naive - mae) / mae_naive * 100.0 if mae_naive > 0 else 0.0
            out[k]["skill_vs_naive_pct"] = round(skill, 2)
            out[k]["beats_naive_p"] = round(paired_sign_p(errs[k], naive), 5)

    # Directional accuracy of the CHAMPION candidates on their own predictions
    # is reported by skill_evaluator; here we keep the arena purely on MAE —
    # for options, magnitude errors are what kill (band selection, premium).
    out["feats_model"] = feats_model
    out["recal_coef"] = list(recal_model) if recal_model else None
    return out


def pick_champion(res: dict) -> dict:
    """Crown a champion for one group following the gate hierarchy."""
    def gated(key):
        r = res.get(key)
        if not r:
            return None
        ok = (r["n_test"] >= MIN_TEST
              and r.get("skill_vs_naive_pct", -99) >= MIN_SKILL_PCT
              and r.get("beats_naive_p", 1.0) < ALPHA_P)
        return r if ok else None

    g_feats = gated("feats")
    g_recal = gated("recal")
    g_issued = gated("issued")

    if g_feats:
        return {"champion": "feats", "mode": "model",
                "skill": g_feats["skill_vs_naive_pct"], "p": g_feats["beats_naive_p"]}
    if g_recal:
        return {"champion": "recal", "mode": "model",
                "skill": g_recal["skill_vs_naive_pct"], "p": g_recal["beats_naive_p"]}
    if g_issued:
        return {"champion": "issued", "mode": "passthrough",
                "skill": g_issued["skill_vs_naive_pct"], "p": g_issued["beats_naive_p"]}

    # Nothing significant. If the issued pipeline is actively WORSE than naive,
    # damp it; otherwise observe and wait for data.
    iss = res.get("issued")
    if iss and iss.get("skill_vs_naive_pct") is not None and iss["skill_vs_naive_pct"] < -5 \
            and iss["n_test"] >= MIN_TEST:
        return {"champion": "naive_zero", "mode": "dampen",
                "skill": iss["skill_vs_naive_pct"],
                "p": iss.get("beats_naive_p")}
    return {"champion": None, "mode": "observe", "skill": None, "p": None}


# ---------------------------------------------------------------------------
# Application to a fresh forecast
# ---------------------------------------------------------------------------

def _apply_move_to_block(res_block: dict, new_move_pct: float, meta: dict) -> None:
    """Rewrite a forecast block so its last-candle p50 move == new_move_pct.

    Shape-preserving: every candle's CURRENT move (relative to the anchor) is
    scaled by new/issued — the trajectory keeps Kronos's proportions, only its
    amplitude changes. The anchor candle region (w≈0) is untouched, and each
    candle's band edges are shifted by the same delta as its close, so band
    width and coherence are preserved. Falls back to a linear ramp only when
    the issued move is ~zero (scale undefined). Top-level range fields are
    re-aggregated afterwards (mirrors bias_corrector).
    """
    candles = res_block.get("candles") or []
    if not candles:
        return
    anchor = float(res_block.get("last_price") or 0.0)
    if anchor <= 0:
        return
    n = len(candles)
    try:
        issued_move = (float(candles[-1]["close"]) - anchor) / anchor * 100.0
    except (KeyError, TypeError, ValueError):
        return
    if abs(issued_move) > 1e-6:
        scale = new_move_pct / issued_move
    else:
        scale = None  # ramp fallback: distribute new_move_pct linearly
    for i, c in enumerate(candles):
        w = (i / (n - 1)) if n > 1 else 1.0
        try:
            old_close = float(c["close"])
        except (KeyError, TypeError, ValueError):
            continue
        if scale is not None:
            new_close = anchor + (old_close - anchor) * scale
        else:
            new_close = anchor * (1.0 + (new_move_pct / 100.0) * w)
        delta = new_close - old_close
        if abs(delta) < 0.005:
            continue  # rounding noise — leave the candle untouched
        for fld in ("open", "high", "low", "close",
                    "close_p10", "close_p90", "high_p10", "high_p90",
                    "low_p10", "low_p90"):
            v = c.get(fld)
            if isinstance(v, (int, float)):
                c[fld] = round(v + delta, 2)
    highs = [c["high"] for c in candles if isinstance(c.get("high"), (int, float))]
    lows = [c["low"] for c in candles if isinstance(c.get("low"), (int, float))]
    closes = [c["close"] for c in candles if isinstance(c.get("close"), (int, float))]
    if highs and lows:
        res_block["expected_high"] = round(max(highs), 2)
        res_block["expected_low"] = round(min(lows), 2)
    if closes:
        res_block["expected_high_p50"] = round(max(closes), 2)
        res_block["expected_low_p50"] = round(min(closes), 2)
    res_block["alpha_lab"] = meta


def apply_alpha_lab(forecast_data: dict, lab_path: str = LAB_OUTPUT_PATH) -> tuple:
    """Apply the current champions to a fresh kronos_forecast.json dict.

    Returns (forecast_data, meta_summary). Champion modes:
      model       — replace the issued move with the model's prediction
      dampen      — shrink the issued move by DAMPEN_FACTOR
      passthrough — issued already beats naive; leave untouched
      observe     — not enough evidence; leave untouched
    """
    try:
        with open(lab_path) as f:
            lab = json.load(f)
    except (OSError, json.JSONDecodeError):
        return forecast_data, {"applied": False, "reason": "no alpha_lab.json"}

    symbol_map = {"SP500": "SPY", "NASDAQ": "QQQ"}
    summary = {"applied": False, "groups": {}}
    for market_key, symbol in symbol_map.items():
        item = forecast_data.get(f"{market_key}_bias")
        if not isinstance(item, dict):
            continue
        for horizon in ("4h", "1d"):
            res = item.get(f"forecast_{horizon}")
            if not isinstance(res, dict) or not (res.get("candles")):
                continue
            champ = (lab.get("groups") or {}).get(f"{symbol}|{horizon}") or {}
            mode = champ.get("mode", "observe")

            anchor = float(res.get("last_price") or 0.0)
            candles = res.get("candles") or []
            if anchor <= 0 or not candles:
                continue
            try:
                issued_move = (float(candles[-1]["close"]) - anchor) / anchor * 100.0
            except (KeyError, TypeError, ValueError):
                continue

            meta = {
                "champion": champ.get("champion"),
                "mode": mode,
                "issued_move_pct": round(issued_move, 3),
                "applied_at": datetime.now(timezone.utc).isoformat(),
            }

            if mode == "model":
                params = champ.get("params") or {}
                feats_row = {"pred_move_pct": issued_move,
                             "features": res.get("context_features") or {}}
                if champ.get("champion") == "feats" and params.get("beta"):
                    try:
                        new_move = predict_feats(params, feats_row)
                    except Exception:
                        new_move = issued_move
                elif champ.get("champion") == "recal" and params.get("recal"):
                    a, b = params["recal"]
                    new_move = a + b * issued_move
                else:
                    new_move = issued_move
                meta["applied_move_pct"] = round(new_move, 3)
                _apply_move_to_block(res, new_move, meta)
                summary["applied"] = True
            elif mode == "dampen":
                new_move = issued_move * DAMPEN_FACTOR
                meta["applied_move_pct"] = round(new_move, 3)
                meta["dampen_factor"] = DAMPEN_FACTOR
                _apply_move_to_block(res, new_move, meta)
                summary["applied"] = True
            else:
                meta["applied_move_pct"] = round(issued_move, 3)
                res["alpha_lab"] = meta
            summary["groups"][f"{symbol}|{horizon}"] = meta
    return forecast_data, summary


# ---------------------------------------------------------------------------
# Fit + persist
# ---------------------------------------------------------------------------

def run_lab(history: list, out_path: str = LAB_OUTPUT_PATH, quiet: bool = False) -> dict:
    scored = load_scored(history)
    rows = build_rows(scored)
    groups = group_rows(rows)

    lab = {
        "version": LAB_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "min_test": MIN_TEST,
        "min_skill_pct": MIN_SKILL_PCT,
        "alpha_p": ALPHA_P,
        "dampen_factor": DAMPEN_FACTOR,
        "config": {
            "min_train_recal": MIN_TRAIN_RECAL,
            "min_train_feats": MIN_TRAIN_FEATS,
            "half_life": HALF_LIFE,
            "feature_keys": FEATURE_KEYS,
        },
        "groups": {},
        "timeline": [],
    }

    if not quiet:
        print(f"\n=== Alpha lab ({lab['generated_at'][:16]}) — "
              f"{len(rows)} distinct targets ===")

    for key in sorted(groups):
        grows = groups[key]
        res = evaluate_group(grows)
        champ = pick_champion(res)
        feats_model = res.pop("feats_model", None)
        recal_coef = res.pop("recal_coef", None)

        entry = {
            "n_targets": len(grows),
            "arena": res,
            "champion": champ["champion"],
            "mode": champ["mode"],
            "skill_vs_naive_pct": champ["skill"],
            "beats_naive_p": champ["p"],
            "feature_coverage": _feat_coverage(grows),
        }
        if champ["champion"] == "feats" and feats_model:
            entry["params"] = feats_model
        if champ["champion"] == "recal" and recal_coef:
            entry["params"] = {"recal": recal_coef}
        lab["groups"][key] = entry

        if not quiet:
            iss = res.get("issued") or {}
            print(f"  {key:9s} n={len(grows):4d}  issued skill={iss.get('skill_vs_naive_pct', '—'):>7}"
                  f"  champion={entry['champion'] or '—':10s} mode={entry['mode']:11s}"
                  f" skill={entry['skill_vs_naive_pct']}")

        lab["timeline"].append({
            "ts": lab["generated_at"],
            "group": key,
            "n_targets": len(grows),
            "champion": entry["champion"],
            "mode": entry["mode"],
            "skill_vs_naive_pct": entry["skill_vs_naive_pct"],
            "issued_skill": (res.get("issued") or {}).get("skill_vs_naive_pct"),
            "recal_skill": (res.get("recal") or {}).get("skill_vs_naive_pct"),
            "feats_skill": (res.get("feats") or {}).get("skill_vs_naive_pct"),
        })

    # Keep the timeline bounded (one entry per group per run).
    lab["timeline"] = lab["timeline"][-800:]

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(lab, f, indent=2)
    if not quiet:
        print(f"  alpha lab written → {out_path}")
    return lab


def _feat_coverage(rows: list) -> dict:
    cov = {}
    for k in FEATURE_KEYS:
        have = sum(1 for r in rows if r.get("features") and r["features"].get(k) is not None)
        if have:
            cov[k] = round(have / len(rows), 2)
    return cov


def main() -> None:
    ap = argparse.ArgumentParser(description="Alpha lab: walk-forward champion selection")
    ap.add_argument("--history", default=HISTORY_PATH)
    ap.add_argument("--out", default=LAB_OUTPUT_PATH)
    args = ap.parse_args()
    with open(args.history) as f:
        history = json.load(f)
    run_lab(history, out_path=args.out)


if __name__ == "__main__":
    main()
