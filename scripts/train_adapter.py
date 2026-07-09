#!/usr/bin/env python3
"""
Unified Kronos Covariate Adapter Training Pipeline
===================================================

Trains a SINGLE ResidualCovariateAdapter that corrects Kronos baseline
forecasts across ALL prediction horizons (5m / 15m / 1h / 4h / 1d) and both
ETF symbols (SPY, QQQ), using historical volatility skew, Put/Call OI ratio
and Net GEX as covariates.

Key differences from the legacy single-horizon trainer:
  * One model covers every timeframe (via a learnable `pred_len` embedding),
    instead of a separate checkpoint per pred_len.
  * Ground-truth targets are REALIZED future price bars aligned to each
    historical options snapshot (not synthetic noise).
  * GUARD: if fewer than MIN_REAL_SAMPLES genuine samples with realized
    future targets exist, training is skipped and NO checkpoint is written —
    we never overwrite a good adapter with one fit to synthetic noise.
  * Emits data/adapter_training_stats.json so the UI can show whether the
    adapter is actually training on real data and how well it generalizes.

Usage:
    python scripts/train_adapter.py --epochs 40
    python scripts/train_adapter.py --symbols SPY QQQ --epochs 40
"""

import argparse
import hashlib
import time
import json
import math
import os
import sys
from datetime import datetime, timezone
from typing import List, Dict, Tuple, Optional

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import yfinance as yf

# Set up paths to import local model code
scripts_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(scripts_dir)

from model.kronos import (
    Kronos, KronosTokenizer, KronosPredictor, ResidualCovariateAdapter,
    calc_time_stamps,
)
from run_kronos import generate_future_trading_timestamps, get_futures_to_etf_ratio

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# (name, yfinance interval, prediction length) — only the horizons that
# run_kronos.py actually generates. We dropped 5m/15m/1h: their adapter val
# MSE was the worst (1.0-1.14) while the |residual| correction was the
# largest, i.e. the adapter was actively adding noise on the short horizons.
# Concentrating on 4h + 1d focuses all adapter capacity on the timeframes
# the UI actually uses and where the adapter is reliable (val MSE 0.45-0.50).
HORIZONS: List[Tuple[str, str, int]] = [
    ("4h", "4h", 6),
    ("1d", "1d", 5),
]

# Kronos context length — MUST match run_kronos.py (now 256). Training the
# adapter on baselines generated with the same context the model uses at
# inference avoids a train/serve skew that would silently degrade the
# correction quality.
CONTEXT_LEN = 256
DEFAULT_FUTURES_RATIO = {"SPY": 10.09, "QQQ": 41.57}
FUTURES_MAP = {"SPY": "ES=F", "QQQ": "NQ=F"}

# Do not save a checkpoint (and do not report "trained") unless we have at
# least this many REAL samples with realized future targets. This is the core
# anti-overfitting guard: the legacy trainer silently fit noise when only a
# day or two of history existed.
MIN_REAL_SAMPLES = 30
# Require at least this many samples for a given horizon to score it.
MIN_SAMPLES_PER_HORIZON = 5
# Cap the number of options-history snapshots we actually turn into training
# samples PER SYMBOL. With 500 records/symbol x 5 horizons the legacy loop ran
# thousands of slow autoregressive Kronos forwards and blew the 15-min CI
# budget. Subsampling to ~40 evenly-spaced snapshots per symbol keeps the
# pipeline well under budget while preserving temporal coverage. Override via
# the --max-records flag when running locally on a beefy machine.
MAX_RECORDS_PER_SYMBOL = 40
# Kronos autoregressive baseline forwards are the cost driver; batch them in
# chunks this size to bound memory + keep CI responsive.
BASELINE_BATCH_SIZE = 16
# Upper bound on the number of parallel sequences Kronos decodes concurrently
# (batch_size x sample_count). auto_regressive_inference already averages
# over sample_count internally, so a higher denoise count shrinks the batch
# to keep memory bounded on CPU.
BASELINE_PARALLEL_BUDGET = 32

STATS_OUTPUT_PATH = os.path.join(scripts_dir, "../data/adapter_training_stats.json")

# How many past-run summaries to retain inside adapter_training_stats.json
# (the longitudinal loss / sample history surfaced in the UI). The CI
# restores this file from the data branch BEFORE every training run, so
# appending one record per run accumulates a stable history across runs
# without needing a separate state file.
MAX_RUN_HISTORY = 300


def _log(msg: str) -> None:
    """Print + flush so CI shows progress immediately (no block buffering)."""
    print(msg, flush=True)


def _load_previous_runs(stats_path: str) -> List[Dict]:
    """Recover the longitudinal run history from the previously-published
    stats file. Returns [] when the file is missing or malformed (e.g. first
    ever run, or legacy file without loss_history_runs)."""
    try:
        with open(stats_path, "r") as f:
            prev = json.load(f)
        runs = prev.get("loss_history_runs") or []
        return runs if isinstance(runs, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


# ---------------------------------------------------------------------------
# Persistent baseline cache
# ---------------------------------------------------------------------------
# Kronos baseline forwards are the cost driver of training. They are also
# stochastic (T=0.7 sampling), which is WHY the per-epoch loss curve changed
# every run. Caching the (denoised) baseline for each (snapshot, horizon)
# turns the cost into a one-time-per-snapshot expense AND makes training
# reproducible: same inputs -> same target residual -> stable, comparable
# loss curves. The CI restores this file from the data branch, so the cache
# accumulates across runs.

BASELINE_CACHE_PATH = os.path.join(scripts_dir, "../data/adapter_baselines_cache.json")
# Bump when the Kronos model weights, tokenizer, sampling policy (T/top_k/top_p)
# or CONTEXT_LEN change: a mismatch invalidates every cached baseline.
BASELINE_CACHE_VERSION = 1


def _baseline_cache_key(symbol: str, horizon: str, pred_len: int,
                        x_norm: np.ndarray, sx: np.ndarray, sy: np.ndarray) -> str:
    """Deterministic key over the EXACT Kronos inputs (context + time stamps).
    Hashing the real input bytes — not just the snapshot timestamp — makes the
    key robust to price-frame resolution changes: the same snapshot aligned
    against 4h vs daily bars yields different keys, so no stale hits."""
    h = hashlib.blake2b(digest_size=16)
    h.update(f"v{BASELINE_CACHE_VERSION}|{symbol}|{horizon}|pl{pred_len}|cl{CONTEXT_LEN}".encode())
    h.update(np.ascontiguousarray(x_norm, dtype=np.float32).tobytes())
    h.update(np.ascontiguousarray(sx, dtype=np.float32).tobytes())
    h.update(np.ascontiguousarray(sy, dtype=np.float32).tobytes())
    return h.hexdigest()


def _load_baseline_cache(path: str) -> Dict[str, list]:
    try:
        with open(path, "r") as f:
            obj = json.load(f)
        if isinstance(obj, dict) and obj.get("version") == BASELINE_CACHE_VERSION:
            entries = obj.get("entries") or {}
            return entries if isinstance(entries, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return {}


def _flush_baseline_cache(cache: Dict[str, list], path: str) -> None:
    """Atomic write so a mid-run timeout never leaves a half-written cache."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"version": BASELINE_CACHE_VERSION, "entries": cache}, f)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_block(x: np.ndarray, clip: float) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = np.mean(x, axis=0)
    std = np.std(x, axis=0) + 1e-5
    x_norm = np.clip((x - mean) / std, -clip, clip)
    return x_norm, mean, std


def _build_stamps(context_df: pd.DataFrame, future_df: pd.DataFrame):
    x_time_df = calc_time_stamps(pd.Series(context_df.index))
    y_time_df = calc_time_stamps(pd.Series(future_df.index))
    return (
        x_time_df.values.astype(np.float32),
        y_time_df.values.astype(np.float32),
    )


def _prepare_block(df_block: pd.DataFrame, predictor: KronosPredictor):
    """Add volume/amount cols and return the 6-col normalized-ready ndarray."""
    price_cols = predictor.price_cols
    vol_col = predictor.vol_col
    amt_vol = predictor.amt_vol
    blk = df_block.copy()
    blk[vol_col] = blk[vol_col].astype(float)
    blk[amt_vol] = blk[vol_col] * blk[price_cols].mean(axis=1)
    return blk[price_cols + [vol_col, amt_vol]].values.astype(np.float32)


def _resolve_baselines(
    predictor: KronosPredictor,
    samples: List[Dict],
    pred_len: int,
    device: str,
    *,
    symbol: str,
    deadline_s: Optional[float] = None,
    cache: Optional[Dict[str, list]] = None,
    n_denoise: int = 1,
    touched: Optional[set] = None,
) -> List[Tuple[Dict, np.ndarray]]:
    """Resolve a denoised Kronos baseline for each aligned sample, using the
    persistent cache to skip already-computed ones.

    Denoising is native: auto_regressive_inference averages over `sample_count`
    internally, so passing sample_count=n_denoise returns the mean of n
    independent draws in ONE forward pass — a less noisy estimate of Kronos's
    systematic error, which is what the adapter should learn to correct.

    Returns (sample, baseline) pairs in original order. Samples whose baseline
    could not be resolved (deadline hit before their turn) are dropped; their
    progress is NOT lost because everything computed so far was already cached.
    """
    price_cols = predictor.price_cols
    vol_col = predictor.vol_col
    amt_vol = predictor.amt_vol

    def _prep_one(s):
        ctx = s["context_df"].copy()
        fut = s["future_df"]
        ctx[vol_col] = ctx[vol_col].astype(float)
        ctx[amt_vol] = ctx[vol_col] * ctx[price_cols].mean(axis=1)
        x = ctx[price_cols + [vol_col, amt_vol]].values.astype(np.float32)
        x_norm, _, _ = _normalize_block(x, predictor.clip)
        sx, sy = _build_stamps(ctx, fut)
        return x_norm, sx, sy

    n = len(samples)
    out: List[Optional[np.ndarray]] = [None] * n
    keys: List[Optional[str]] = [None] * n

    # Keep the number of parallel decoded sequences (batch x sample_count)
    # bounded so high denoise counts don't blow CPU memory.
    batch_size = max(1, min(BASELINE_BATCH_SIZE, BASELINE_PARALLEL_BUDGET // max(1, n_denoise)))

    # 1) Cache lookup — instant hits.
    cache_hits = 0
    for i, s in enumerate(samples):
        x_norm, sx, sy = _prep_one(s)
        if cache is not None:
            key = _baseline_cache_key(symbol, s["horizon"], pred_len, x_norm, sx, sy)
            keys[i] = key
            if touched is not None:
                touched.add(key)
            if key in cache:
                out[i] = np.asarray(cache[key], dtype=np.float32)
                cache_hits += 1

    miss_idx = [i for i in range(n) if out[i] is None]
    _log(f"      baseline cache: {cache_hits}/{n} hits, {len(miss_idx)} to compute "
         f"(denoise x{n_denoise}, batch {batch_size})")

    # 2) Batched computation for misses, with a hard wall-clock deadline.
    computed = 0
    hit_deadline = False
    for start in range(0, len(miss_idx), batch_size):
        if deadline_s is not None and time.time() > deadline_s:
            hit_deadline = True
            break
        positions = miss_idx[start:start + batch_size]
        preps = [_prep_one(samples[i]) for i in positions]
        x_batch = np.stack([p[0] for p in preps], axis=0)
        sx_batch = np.stack([p[1] for p in preps], axis=0)
        sy_batch = np.stack([p[2] for p in preps], axis=0)
        with torch.no_grad():
            preds = predictor.generate(
                x_batch, sx_batch, sy_batch, pred_len,
                T=0.7, top_k=5, top_p=0.9, sample_count=n_denoise, verbose=False,
            )  # (B, pred_len, 6) — already averaged over sample_count internally
        for j, pos in enumerate(positions):
            base = preds[j].astype(np.float32)
            out[pos] = base
            if cache is not None and keys[pos] is not None:
                cache[keys[pos]] = base.tolist()
        computed += len(positions)
        if len(miss_idx) > batch_size:
            _log(f"      baseline computed {start + len(positions)}/{len(miss_idx)}")
    if hit_deadline:
        _log(f"      ⏱  baseline deadline reached at {computed}/{len(miss_idx)} misses "
             f"— remainder deferred to next run (cached progress persists).")

    # 3) Ordered result, dropping the unresolved (deadline-truncated) tail.
    return [(samples[i], out[i]) for i in range(n) if out[i] is not None]


# ---------------------------------------------------------------------------
# Sample construction (ground-truth aligned to historical snapshots)
# ---------------------------------------------------------------------------

def build_training_samples(
    predictor: KronosPredictor,
    records: List[Dict],
    price_df: pd.DataFrame,
    price_time_list,
    symbol: str,
    device: str,
    progress_label: str,
    hname: str,
    interval: str,
    pred_len: int,
    max_records: Optional[int] = MAX_RECORDS_PER_SYMBOL,
    deadline_s: Optional[float] = None,
    cache: Optional[Dict[str, list]] = None,
    cache_path: Optional[str] = None,
    n_denoise: int = 1,
    touched: Optional[set] = None,
) -> List[Dict]:
    """Build (baseline forecast, covariates, target residual) samples for ONE
    horizon, aligned against the price frame PASSED BY THE CALLER.

    The caller (main) loops over horizons and fetches the native-resolution
    frame for each, so this function must process exactly that single
    horizon — NOT loop over all horizons. The previous implementation looped
    over every horizon internally using the single supplied frame, which
    produced ~50% of samples at the WRONG resolution (e.g. '4h' samples built
    from daily bars, with a ~6-month context instead of ~18h). That silently
    corrupted training under each pred_len label.
    """
    samples: List[Dict] = []
    n_prices = len(price_time_list)

    # Subsample snapshots (evenly spaced in time) ONLY when an explicit cap is
    # set. With baseline caching enabled the default is to use ALL snapshots:
    # the expensive Kronos forwards are computed once and reused across runs,
    # so the CI time budget is no longer the binding constraint — and a larger,
    # more diverse training set directly improves the adapter's generalization.
    if max_records is not None and len(records) > max_records:
        idx = np.linspace(0, len(records) - 1, max_records).round().astype(int)
        idx = sorted(set(idx.tolist()))
        records = [records[i] for i in idx]
        _log(f"[{progress_label}] Subsampled to {len(records)} snapshots "
             f"(cap {max_records}).")
    else:
        _log(f"[{progress_label}] Using all {len(records)} snapshots "
             f"(baseline cache active, no subsampling).")

    _log(f"[{progress_label}] Aligning {len(records)} snapshots against "
         f"{n_prices} {interval} price bars (horizon {hname}, pred_len={pred_len})...")

    per_h: List[Dict] = []
    for record in records:
        ts_utc = pd.to_datetime(record["timestamp"])
        if ts_utc.tz is not None:
            ts_utc = ts_utc.tz_convert("UTC").tz_localize(None)
        ts_np = ts_utc.to_datetime64()

        valid = [i for i, t in enumerate(price_time_list) if t <= ts_np]
        if not valid:
            continue
        p_idx = valid[-1]
        if p_idx < CONTEXT_LEN or p_idx + pred_len >= n_prices:
            continue  # not enough history or future not yet realized

        ctx = price_df.iloc[p_idx - CONTEXT_LEN: p_idx].copy()
        fut = price_df.iloc[p_idx: p_idx + pred_len].copy()
        if ctx.isnull().values.any() or fut.isnull().values.any():
            continue

        per_h.append({
            "context_df": ctx,
            "future_df": fut,
            "skew": float(record["volatility_skew_25d"]),
            "pcr": float(record["put_call_oi_ratio"]),
            "gex": float(record.get("total_net_gex", 0.0)) / 1e9,
            "horizon": hname,
            "interval": interval,
            "pred_len": pred_len,
        })

    if not per_h:
        _log(f"  [{hname}] 0 aligned samples")
        return samples

    # Baseline forecasts (cache-aware: hits are free, misses are computed
    # with N-sample averaging to denoise the target, then cached forever).
    try:
        resolved = _resolve_baselines(
            predictor, per_h, pred_len, device,
            symbol=symbol, deadline_s=deadline_s,
            cache=cache, n_denoise=n_denoise, touched=touched,
        )
    except Exception as e:
        _log(f"  [{hname}] baseline resolution failed: {e}")
        return samples
    # Persist cache after this horizon so partial progress survives a mid-run
    # deadline/timeout — the next run resumes via cache hits.
    if cache is not None and cache_path is not None:
        _flush_baseline_cache(cache, cache_path)

    for s, base_norm in resolved:
        fut = s["future_df"]
        y_actual = _prepare_block(fut, predictor)
        # Reuse the same normalization the predictor would apply at inference:
        # context mean/std. Reconstruct from context for consistency.
        ctx = s["context_df"]
        x = _prepare_block(ctx, predictor)
        _, m, sd = _normalize_block(x, predictor.clip)
        y_actual_norm = np.clip((y_actual - m) / sd, -predictor.clip, predictor.clip)
        target_residual = y_actual_norm - base_norm
        samples.append({
            "baseline": base_norm.astype(np.float32),
            "target_residual": target_residual.astype(np.float32),
            "skew": s["skew"],
            "pcr": s["pcr"],
            "gex": s["gex"],
            "pred_len": s["pred_len"],
            "horizon": s["horizon"],
            "symbol": symbol,
        })
    _log(f"  [{hname}] {len(per_h)} aligned, {len(samples)} built (pred_len={pred_len})")

    return samples


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def train(
    samples: List[Dict],
    epochs: int,
    lr: float,
    hidden_dim: int,
    device: str,
    verbose: bool = True,
) -> Tuple[ResidualCovariateAdapter, Dict]:
    # Train/val split (stratified-ish by shuffling deterministically)
    rng = np.random.default_rng(42)
    idx = np.arange(len(samples))
    rng.shuffle(idx)
    val_n = max(1, len(samples) // 5)
    val_idx = set(idx[:val_n].tolist())
    train_idx = [i for i in idx if i not in val_idx]

    train_s = [samples[i] for i in train_idx]
    val_s = [samples[i] for i in val_idx]

    # Covariate standardization stats from the TRAIN split only
    cov = np.array([[s["skew"], s["pcr"], s["gex"]] for s in train_s], dtype=np.float32)
    cov_mean = cov.mean(axis=0).tolist()
    cov_std = (cov.std(axis=0) + 1e-5).tolist()

    adapter = ResidualCovariateAdapter(
        hidden_dim=hidden_dim, cov_mean=cov_mean, cov_std=cov_std,
    ).to(device)
    optimizer = torch.optim.AdamW(adapter.parameters(), lr=lr, weight_decay=1e-4)
    criterion = nn.MSELoss()

    def to_tensors(batch):
        # Baselines/targets from different horizons have different time lengths;
        # pad them to MAX_PRED_LEN so np.stack works (matches the adapter's
        # internal padding) and build a mask to ignore padded positions in loss.
        max_pl = ResidualCovariateAdapter.MAX_PRED_LEN
        B = len(batch)
        D = ResidualCovariateAdapter.D_IN
        base = np.zeros((B, max_pl, D), dtype=np.float32)
        tgt = np.zeros((B, max_pl, D), dtype=np.float32)
        mask = np.zeros((B, max_pl), dtype=np.float32)
        sk = np.zeros((B, 1), dtype=np.float32)
        pc = np.zeros((B, 1), dtype=np.float32)
        gx = np.zeros((B, 1), dtype=np.float32)
        pl = np.zeros((B,), dtype=np.int64)
        for i, b in enumerate(batch):
            p = b["baseline"].shape[0]
            base[i, :p] = b["baseline"]
            tgt[i, :p] = b["target_residual"]
            mask[i, :p] = 1.0
            sk[i, 0] = b["skew"]
            pc[i, 0] = b["pcr"]
            gx[i, 0] = b["gex"]
            pl[i] = p
        return (
            torch.from_numpy(base).to(device),
            torch.from_numpy(tgt).to(device),
            torch.from_numpy(mask).to(device),  # (B, max_pl)
            torch.from_numpy(sk).to(device),
            torch.from_numpy(pc).to(device),
            torch.from_numpy(gx).to(device),
            torch.from_numpy(pl).to(device),
        )

    def masked_mse(out, targets, mask):
        # Mean squared error over features, averaged only across real
        # (non-padded) timesteps so short horizons aren't penalized on padding.
        se = ((out - targets) ** 2).mean(dim=-1)  # (B, max_pl)
        return (se * mask).sum() / (mask.sum() + 1e-8)

    def baseline_mse_of(targets, mask):
        # MSE of the target residual against ZERO = variance of (actual -
        # baseline) in normalized space = how wrong the Kronos baseline alone
        # is. Used as the reference to measure how much the adapter helps.
        return masked_mse(torch.zeros_like(targets), targets, mask).item()

    loss_history = []

    def evaluate(batch):
        with torch.no_grad():
            baselines, targets, mask, sk, pc, gx, pl = to_tensors(batch)
            out = adapter(baselines, sk, pc, gx, pl)
            return masked_mse(out, targets, mask).item()

    # Early stopping on validation loss. The previous fix trained a fixed
    # 40 epochs and saved the LAST checkpoint, but the val curve typically
    # bottomed out around epoch 18-24 and then drifted UP (overfit). Saving
    # the best-val state instead recovers ~4-8% of val MSE for free.
    PATIENCE = 5
    best_val_loss = float("inf")
    best_epoch = 0
    best_state = None
    epochs_no_improve = 0
    stopped_early = False

    adapter.train()
    bs = min(64, len(train_s))
    for epoch in range(epochs):
        order = np.random.default_rng(epoch).permutation(len(train_s))
        epoch_losses = []
        for start in range(0, len(train_s), bs):
            batch = [train_s[i] for i in order[start:start + bs]]
            baselines, targets, mask, sk, pc, gx, pl = to_tensors(batch)
            optimizer.zero_grad()
            out = adapter(baselines, sk, pc, gx, pl)
            loss = masked_mse(out, targets, mask)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(adapter.parameters(), 1.0)
            optimizer.step()
            epoch_losses.append(loss.item())
        train_loss = float(np.mean(epoch_losses)) if epoch_losses else float("nan")
        val_loss = evaluate(val_s) if val_s else float("nan")
        loss_history.append({"epoch": epoch + 1, "train_loss": train_loss, "val_loss": val_loss})
        if verbose and ((epoch + 1) % max(1, epochs // 10) == 0 or epoch == epochs - 1):
            _log(f"  Epoch [{epoch+1}/{epochs}] train={train_loss:.6f} val={val_loss:.6f}")

        # Early stopping bookkeeping (only meaningful when we have a val set).
        if val_s and not (math.isnan(val_loss)):
            if val_loss < best_val_loss - 1e-6:
                best_val_loss = val_loss
                best_epoch = epoch + 1
                best_state = {k: v.detach().clone() for k, v in adapter.state_dict().items()}
                epochs_no_improve = 0
            else:
                epochs_no_improve += 1
                if epochs_no_improve >= PATIENCE:
                    stopped_early = True
                    if verbose:
                        _log(f"  ⏹  Early stopping at epoch {epoch+1}: no val improvement "
                             f"for {PATIENCE} epochs (best={best_val_loss:.6f} @ epoch {best_epoch}).")
                    break

    # Restore the best-val checkpoint before computing final metrics / saving.
    # If we never had a val set (degenerate), best_state stays None and we
    # keep the last state as-is.
    if best_state is not None:
        adapter.load_state_dict(best_state)
        if verbose:
            _log(f"  ↩  Restored best-val weights (epoch {best_epoch}, val={best_val_loss:.6f}).")

    # Overall baseline-vs-adapter comparison on the FULL validation set.
    # baseline_mse = variance of the target residual = how wrong Kronos alone
    # is (normalized space). adapter_mse = residual error after correction.
    # improvement_pct = share of baseline error the adapter explains
    # (R²-like: 100% = perfect correction, 0% = no help, <0% = harmful).
    with torch.no_grad():
        baselines, targets, mask, sk, pc, gx, pl = to_tensors(val_s)
        out = adapter(baselines, sk, pc, gx, pl)
        overall_adapter_mse = masked_mse(out, targets, mask).item()
        overall_baseline_mse = baseline_mse_of(targets, mask)
    overall_improvement_pct = (
        (overall_baseline_mse - overall_adapter_mse) / (overall_baseline_mse + 1e-8)
    ) * 100.0

    # Per-horizon validation MSE (baseline vs adapter)
    horizon_metrics: Dict[str, Dict] = {}
    for hname, _, pred_len in HORIZONS:
        hv = [s for s in val_s if s["pred_len"] == pred_len]
        if len(hv) < MIN_SAMPLES_PER_HORIZON:
            continue
        with torch.no_grad():
            baselines, targets, mask, sk, pc, gx, pl = to_tensors(hv)
            out = adapter(baselines, sk, pc, gx, pl)
            adapter_mse = masked_mse(out, targets, mask).item()
            baseline_mse = baseline_mse_of(targets, mask)
        improvement_pct = (
            (baseline_mse - adapter_mse) / (baseline_mse + 1e-8)
        ) * 100.0
        horizon_metrics[hname] = {
            "pred_len": pred_len,
            "val_samples": len(hv),
            "val_mse": adapter_mse,
            "baseline_val_mse": baseline_mse,
            "improvement_pct": improvement_pct,
        }

    # A horizon is "validated" (safe to apply live) only if it had enough val
    # samples AND the adapter actually helps there (improvement_pct > 0).
    # Horizons that fail either check are excluded from validated_pred_lens,
    # and run_kronos.py will REFUSE to apply the adapter on them — applying
    # an un-validated or harmful correction silently corrupts forecasts.
    validated_pred_lens = sorted({
        m["pred_len"] for m in horizon_metrics.values() if m["improvement_pct"] > 0
    })

    final_train_loss = loss_history[-1]["train_loss"] if loss_history else None
    final_val_loss = loss_history[-1]["val_loss"] if loss_history else None

    info = {
        "cov_mean": cov_mean,
        "cov_std": cov_std,
        "loss_history": loss_history,
        "horizon_metrics": horizon_metrics,
        "validated_pred_lens": validated_pred_lens,
        "final_train_loss": final_train_loss,
        "final_val_loss": final_val_loss,
        "final_baseline_val_loss": overall_baseline_mse,
        "final_improvement_pct": overall_improvement_pct,
        "train_samples": len(train_s),
        "val_samples": len(val_s),
        "best_epoch": best_epoch or (len(loss_history) if loss_history else None),
        "best_val_loss": best_val_loss if best_state is not None else final_val_loss,
        "stopped_early": stopped_early,
    }
    return adapter, info


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Train unified Kronos Covariate Adapter")
    parser.add_argument("--symbols", type=str, nargs="+", default=["SPY", "QQQ"])
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--hidden-dim", type=int, default=128)
    parser.add_argument("--max-records", type=int, default=None,
                        help="Cap snapshots per symbol (subsampling). Default: no "
                             "cap — use ALL history, since baseline caching makes "
                             "full-history training affordable across runs.")
    parser.add_argument("--baseline-budget-min", type=float, default=15.0,
                        help="Hard wall-clock budget (minutes) for baseline Kronos "
                             "forwards in THIS run. Cache persists partial progress, "
                             "so a truncated run resumes next time via cache hits.")
    parser.add_argument("--baseline-samples", type=int, default=8,
                        help="Number of stochastic Kronos samples to average per "
                             "baseline (denoises the training target). auto_regressive_"
                             "inference averages internally, so cost is one forward.")
    parser.add_argument("--cache-path", type=str, default=None,
                        help="Path to the baseline cache JSON (default: "
                             "data/adapter_baselines_cache.json).")
    parser.add_argument("--output-path", type=str, default=None)
    parser.add_argument("--stats-path", type=str, default=None)
    parser.add_argument("--force-save", action="store_true",
                        help="Save checkpoint even with fewer than MIN_REAL_SAMPLES (for testing).")
    args = parser.parse_args()

    _log("=" * 70)
    _log(f"🚀 Unified Kronos Covariate Adapter Training")
    _log(f"   symbols={args.symbols}  horizons={[h[0] for h in HORIZONS]}  epochs={args.epochs}")
    _log("=" * 70)

    # 1. Load options history
    history_path = os.path.join(scripts_dir, "../data/options_history.json")
    if not os.path.exists(history_path):
        _log(f"❌ No options history at {history_path}. Run fetch_options_data.py first.")
        sys.exit(1)
    with open(history_path, "r") as f:
        history_data = json.load(f)
    # Keep only records produced by the current GEX formula. Records from
    # earlier versions (e.g. pre-Black-Scholes-IV-fix) carry an artefactual
    # GEX and would corrupt training; they are purged on write by
    # append_to_history, but we filter defensively on read too.
    HISTORY_GEX_VERSION = 2
    before = len(history_data)
    history_data = [r for r in history_data if r.get("gex_v") == HISTORY_GEX_VERSION]
    purged = before - len(history_data)
    if purged:
        _log(f"🧹 Dropped {purged} stale history record(s) with incompatible gex_v (≠{HISTORY_GEX_VERSION}).")

    # 2. Load Kronos model
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    _log(f"Loading Kronos model on device: {device}...")
    tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-2k")
    model = Kronos.from_pretrained("NeoQuasar/Kronos-mini")
    predictor = KronosPredictor(model, tokenizer, device=device, max_context=2048)
    predictor.model.eval()
    predictor.tokenizer.eval()
    # Make sure the adapter is OFF during baseline generation
    predictor.adapter = None

    # 3. Build samples across symbols + horizons. Compute a shared wall-clock
    # deadline for ALL baseline forwards so the run can never freeze the runner
    # regardless of how slow autoregressive Kronos is on CPU.
    baseline_deadline = time.time() + args.baseline_budget_min * 60
    # Load the persistent baseline cache. The CI restores this file from the
    # data branch, so computed baselines survive across runs — turning the
    # expensive Kronos forwards into a one-time-per-snapshot cost and making
    # full-history training both affordable and reproducible.
    baseline_cache_path = args.cache_path or BASELINE_CACHE_PATH
    baseline_cache = _load_baseline_cache(baseline_cache_path)
    touched_keys: set = set()
    _log(f"Loaded baseline cache: {len(baseline_cache)} entries "
         f"(version {BASELINE_CACHE_VERSION}, path {baseline_cache_path}).")
    all_samples: List[Dict] = []
    symbols_seen: Dict[str, int] = {}
    for symbol in args.symbols:
        records = [r for r in history_data if r.get("symbol") == symbol]
        symbols_seen[symbol] = len(records)
        if not records:
            _log(f"[{symbol}] no history records, skipping.")
            continue

        timestamps = pd.to_datetime([r["timestamp"] for r in records])
        min_date = timestamps.min() - pd.Timedelta(days=10)
        max_date = timestamps.max() + pd.Timedelta(days=5)
        start_str = min_date.strftime("%Y-%m-%d")
        end_str = max_date.strftime("%Y-%m-%d")

        fetch_ticker = FUTURES_MAP.get(symbol, symbol)
        default_ratio = DEFAULT_FUTURES_RATIO.get(symbol, 1.0)
        ratio = get_futures_to_etf_ratio(fetch_ticker, symbol, default_ratio)

        # Per-horizon price download. We used to download only 5m and resample
        # every horizon from it, but yfinance exposes only ~60 days of intraday
        # 5m history — not enough for CONTEXT_LEN=256 on 4h (needs ~42 trading
        # days of 4h bars) and useless for 1d (needs ~1 year). So each horizon
        # now downloads its NATIVE resolution with a period large enough to
        # cover the context window (mirrors run_kronos.py).
        HORIZON_PERIOD = {
            "5m": "5d",   # (legacy, kept for completeness)
            "15m": "5d",
            "1h": "30d",
            # yfinance exposes up to ~2y of 1h history (the ~60d limit only
            # applies to sub-hourly intervals). Downloading 2y and resampling
            # to 4h yields ~3000 4h bars so ALL historical snapshots in the
            # 2-year window can form 4h training samples — previously the
            # 90d cap starved the 4h training set to only the last ~108 days.
            "4h": "2y",   # downloaded as 1h then resampled to 4h (yfinance)
            "1d": "2y",
        }

        def utc_indexed(frame: pd.DataFrame) -> Tuple[pd.DataFrame, list]:
            fr = frame.copy()
            fr.index.name = "dt"
            dt = pd.to_datetime(fr.index)
            if getattr(dt, "tz", None) is not None:
                dt = dt.tz_convert("UTC").tz_localize(None)
            else:
                dt = dt.tz_localize(None)
            fr["datetime"] = dt.astype("datetime64[ns]")
            return fr, fr["datetime"].tolist()

        def fetch_native(interval: str) -> Optional[pd.DataFrame]:
            """Download native-resolution OHLCV for an interval, converted to ETF scale."""
            period = HORIZON_PERIOD.get(interval, "1y")
            # 4h is fetched as 1h and resampled (yfinance has no native 4h endpoint).
            yf_interval = "1h" if interval == "4h" else interval
            try:
                raw = yf.download(fetch_ticker, period=period, interval=yf_interval, progress=False)
            except Exception as e:
                _log(f"  [{symbol}/{interval}] yfinance download failed: {e}")
                return None
            if raw.empty:
                return None
            if isinstance(raw.columns, pd.MultiIndex):
                raw.columns = raw.columns.get_level_values(0)
            raw = raw.rename(columns=lambda c: c.lower())
            raw = raw[["open", "high", "low", "close", "volume"]].dropna()
            if interval == "4h":
                raw = raw.resample("4h").agg(
                    {"open": "first", "high": "max", "low": "min",
                     "close": "last", "volume": "sum"}).dropna()
            if ratio != 1.0:
                for c in ["open", "high", "low", "close"]:
                    raw[c] = raw[c] / ratio
            return raw

        for hname, interval, pred_len in HORIZONS:
            df = fetch_native(interval)
            if df is None or df.empty:
                _log(f"  [{symbol}/{hname}] no price data for {interval}, skipping.")
                continue
            frame, time_list = utc_indexed(df)
            if len(time_list) < CONTEXT_LEN + pred_len + 1:
                _log(f"  [{symbol}/{hname}] not enough bars yet ({len(time_list)}), skipping.")
                continue

            h_records = records  # all snapshots; alignment filters by availability
            per_h_samples = build_training_samples(
                predictor, h_records, frame, time_list, symbol, device,
                progress_label=f"{symbol}/{hname}",
                hname=hname, interval=interval, pred_len=pred_len,
                max_records=args.max_records,
                deadline_s=baseline_deadline,
                cache=baseline_cache, cache_path=baseline_cache_path,
                n_denoise=args.baseline_samples, touched=touched_keys,
            )
            # tag horizon already set inside; just collect
            all_samples.extend(per_h_samples)
            _log(f"  [{symbol}/{hname}] produced {len(per_h_samples)} real samples")

    # Prune the baseline cache to entries that are still alignable (i.e. were
    # touched this run). Snapshots that aged out of the price window or left
    # the 500/symbol history cap are evicted automatically, keeping the cache
    # tight and the committed file small. Then flush once more (per-horizon
    # flushes already happened, this catches the final prune).
    if baseline_cache:
        stale = [k for k in baseline_cache.keys() if k not in touched_keys]
        for k in stale:
            del baseline_cache[k]
        if stale:
            _log(f"\n🧹 Pruned {len(stale)} stale baseline cache entr(y) "
                 f"(no longer alignable); {len(baseline_cache)} remain.")
        _flush_baseline_cache(baseline_cache, baseline_cache_path)
        _log(f"💾 Baseline cache saved: {len(baseline_cache)} entries.")

    real_total = len(all_samples)
    _log(f"\nTotal REAL samples (all symbols × horizons): {real_total}")
    _log(f"  history records seen: {symbols_seen}")
    per_h_counts = {}
    for s in all_samples:
        per_h_counts[s["horizon"]] = per_h_counts.get(s["horizon"], 0) + 1
    _log(f"  per-horizon real samples: {per_h_counts}")

    # 4. GUARD — refuse to overwrite a good adapter with noise.
    save = real_total >= MIN_REAL_SAMPLES or args.force_save
    stats = {
        "version": 2,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "symbols": args.symbols,
        "history_records": symbols_seen,
        "real_samples_total": real_total,
        "per_horizon_real_samples": per_h_counts,
        "min_real_samples_required": MIN_REAL_SAMPLES,
        "saved": save,
        "reason": None,
        "epochs": args.epochs,
        "device": device,
    }

    if not save:
        reason = (f"Only {real_total} real samples (< {MIN_REAL_SAMPLES} required). "
                  f"Existing adapter (if any) was NOT overwritten. "
                  f"Ground-truth accumulation continues via options_history.json.")
        stats["reason"] = reason
        _log("\n⏸️  GUARD: " + reason)
        # Even when the guard blocks training, record this run in the
        # longitudinal history so the UI can show real-sample accumulation
        # over time (the curve users compare across days).
        prev_runs = _load_previous_runs(args.stats_path or STATS_OUTPUT_PATH)
        prev_runs.append({
            "ts": stats["trained_at"],
            "trained": False,
            "real_samples": real_total,
            "per_horizon_real_samples": per_h_counts,
            "epochs_run": 0,
        })
        stats["loss_history_runs"] = prev_runs[-MAX_RUN_HISTORY:]
        _write_stats(stats, args.stats_path)
        return

    # 5. Train
    adapter, info = train(all_samples, args.epochs, args.lr, args.hidden_dim, device)
    stats.update({
        "cov_stats": {
            "skew": {"mean": info["cov_mean"][0], "std": info["cov_std"][0]},
            "pcr": {"mean": info["cov_mean"][1], "std": info["cov_std"][1]},
            "gex": {"mean": info["cov_mean"][2], "std": info["cov_std"][2]},
        },
        "train_samples": info["train_samples"],
        "val_samples": info["val_samples"],
        "final_train_loss": info["final_train_loss"],
        "final_val_loss": info["final_val_loss"],
        "final_baseline_val_loss": info["final_baseline_val_loss"],
        "final_improvement_pct": info["final_improvement_pct"],
        "horizons": info["horizon_metrics"],
        "validated_pred_lens": info["validated_pred_lens"],
        "best_epoch": info["best_epoch"],
        "best_val_loss": info["best_val_loss"],
        "stopped_early": info["stopped_early"],
        "loss_history": info["loss_history"],
    })

    # Append this run to the longitudinal history (stable across runs, unlike
    # the per-epoch loss_history which is regenerated — with stochastic Kronos
    # baselines — on every execution). Capped to MAX_RUN_HISTORY entries.
    prev_runs = _load_previous_runs(args.stats_path or STATS_OUTPUT_PATH)
    prev_runs.append({
        "ts": stats["trained_at"],
        "trained": True,
        "real_samples": real_total,
        "per_horizon_real_samples": per_h_counts,
        "train_samples": info["train_samples"],
        "val_samples": info["val_samples"],
        "final_train_loss": info["final_train_loss"],
        "final_val_loss": info["final_val_loss"],
        "best_val_loss": info["best_val_loss"],
        "best_epoch": info["best_epoch"],
        "final_improvement_pct": info["final_improvement_pct"],
        "final_baseline_val_loss": info["final_baseline_val_loss"],
        "epochs_run": len(info["loss_history"]),
        "stopped_early": info["stopped_early"],
        "validated_pred_lens": info["validated_pred_lens"],
    })
    stats["loss_history_runs"] = prev_runs[-MAX_RUN_HISTORY:]

    # 6. Save checkpoint (v2 unified format)
    output_path = args.output_path or os.path.join(scripts_dir, "model/covariate_adapter.pth")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    checkpoint = {
        "version": 2,
        "state_dict": adapter.state_dict(),
        "hidden_dim": args.hidden_dim,
        "cov_mean": info["cov_mean"],
        "cov_std": info["cov_std"],
        # All horizons the model was trained on (input-space support).
        "supported_pred_lens": [h[2] for h in HORIZONS],
        # Subset of supported_pred_lens that PASSED validation: enough val
        # samples AND improvement_pct > 0. run_kronos.py refuses to apply
        # the adapter on any pred_len not in this list.
        "validated_pred_lens": info["validated_pred_lens"],
        "trained_at": stats["trained_at"],
        "real_samples_total": real_total,
        "final_train_loss": info["final_train_loss"],
        "final_val_loss": info["final_val_loss"],
        "best_epoch": info["best_epoch"],
        "best_val_loss": info["best_val_loss"],
        "stopped_early": info["stopped_early"],
    }
    torch.save(checkpoint, output_path)
    _log(f"\n🎉 Saved unified adapter → {output_path}")
    _log(f"   train_loss={info['final_train_loss']:.6f}  val_loss={info['final_val_loss']:.6f}")

    _write_stats(stats, args.stats_path)


def _write_stats(stats: Dict, stats_path: str | None) -> None:
    path = stats_path or STATS_OUTPUT_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(stats, f, indent=2)
    _log(f"📊 Wrote training stats → {path}")


if __name__ == "__main__":
    main()
