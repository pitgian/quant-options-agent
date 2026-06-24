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
import json
import math
import os
import sys
from datetime import datetime, timezone
from typing import List, Dict, Tuple

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

# (name, yfinance interval, prediction length) — must match run_kronos.py
HORIZONS: List[Tuple[str, str, int]] = [
    ("5m", "5m", 24),
    ("15m", "15m", 26),
    ("1h", "1h", 20),
    ("4h", "4h", 6),
    ("1d", "1d", 5),
]

CONTEXT_LEN = 128
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

STATS_OUTPUT_PATH = os.path.join(scripts_dir, "../data/adapter_training_stats.json")


def _log(msg: str) -> None:
    """Print + flush so CI shows progress immediately (no block buffering)."""
    print(msg, flush=True)


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


def _run_baseline_batch(
    predictor: KronosPredictor,
    samples: List[Dict],
    pred_len: int,
    device: str,
) -> List[np.ndarray]:
    """Run Kronos baseline (adapter disabled) for a batch of aligned samples,
    processed in chunks of BASELINE_BATCH_SIZE to bound memory and surface
    progress. `samples` share the same pred_len; each has context_df/future_df
    already validated. Returns a list of normalized-space baseline forecasts.
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
        x_norm, m, sd = _normalize_block(x, predictor.clip)
        sx, sy = _build_stamps(ctx, fut)
        return x_norm, sx, sy, (m, sd)

    prepared = [_prep_one(s) for s in samples]

    results: List[Optional[np.ndarray]] = [None] * len(samples)
    total = len(prepared)
    for start in range(0, total, BASELINE_BATCH_SIZE):
        chunk = prepared[start:start + BASELINE_BATCH_SIZE]
        x_batch = np.stack([p[0] for p in chunk], axis=0)
        sx_batch = np.stack([p[1] for p in chunk], axis=0)
        sy_batch = np.stack([p[2] for p in chunk], axis=0)
        with torch.no_grad():
            preds = predictor.generate(
                x_batch, sx_batch, sy_batch, pred_len,
                T=0.7, top_k=5, top_p=0.9, sample_count=1, verbose=False,
            )  # (B, pred_len, 6)
        for j in range(preds.shape[0]):
            results[start + j] = preds[j]
        if total > BASELINE_BATCH_SIZE:
            _log(f"      baseline {min(start + BASELINE_BATCH_SIZE, total)}/{total}")
    return [r for r in results if r is not None]


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
    max_records: int = MAX_RECORDS_PER_SYMBOL,
) -> List[Dict]:
    """For each historical options snapshot with a realized future, build a
    (baseline forecast, covariates, target residual) sample for every horizon
    whose future window is fully contained in the price history."""
    samples: List[Dict] = []
    # Pre-compute valid price-index positions
    n_prices = len(price_time_list)

    # Subsample snapshots (evenly spaced in time) so the number of slow
    # autoregressive Kronos forwards stays bounded — otherwise 500 records x
    # 5 horizons blows the CI time budget.
    if max_records is not None and len(records) > max_records:
        idx = np.linspace(0, len(records) - 1, max_records).round().astype(int)
        idx = sorted(set(idx.tolist()))
        records = [records[i] for i in idx]
        _log(f"[{progress_label}] Subsampled to {len(records)} snapshots "
             f"(cap {max_records}).")

    _log(f"[{progress_label}] Aligning {len(records)} snapshots against "
         f"{n_prices} price bars...")

    # Group candidate (record, horizon) alignments first, then run baseline in
    # batches per horizon to keep Kronos forward passes efficient.
    for hname, interval, pred_len in HORIZONS:
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
            continue

        # Baseline forecasts (batched)
        try:
            baselines = _run_baseline_batch(predictor, per_h, pred_len, device)
        except Exception as e:
            _log(f"  [{hname}] baseline batch failed: {e}")
            continue

        for s, base_norm in zip(per_h, baselines):
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
        _log(f"  [{hname}] {len(per_h)} aligned samples (pred_len={pred_len})")

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
        baselines = torch.from_numpy(np.stack([b["baseline"] for b in batch])).to(device)
        targets = torch.from_numpy(np.stack([b["target_residual"] for b in batch])).to(device)
        sk = torch.tensor([[b["skew"]] for b in batch], dtype=torch.float32, device=device)
        pc = torch.tensor([[b["pcr"]] for b in batch], dtype=torch.float32, device=device)
        gx = torch.tensor([[b["gex"]] for b in batch], dtype=torch.float32, device=device)
        pl = torch.tensor([b["pred_len"] for b in batch], dtype=torch.long, device=device)
        return baselines, targets, sk, pc, gx, pl

    loss_history = []

    def evaluate(batch):
        with torch.no_grad():
            baselines, targets, sk, pc, gx, pl = to_tensors(batch)
            out = adapter(baselines, sk, pc, gx, pl)
            return criterion(out, targets).item()

    adapter.train()
    bs = min(64, len(train_s))
    for epoch in range(epochs):
        order = np.random.default_rng(epoch).permutation(len(train_s))
        epoch_losses = []
        for start in range(0, len(train_s), bs):
            batch = [train_s[i] for i in order[start:start + bs]]
            baselines, targets, sk, pc, gx, pl = to_tensors(batch)
            optimizer.zero_grad()
            out = adapter(baselines, sk, pc, gx, pl)
            loss = criterion(out, targets)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(adapter.parameters(), 1.0)
            optimizer.step()
            epoch_losses.append(loss.item())
        train_loss = float(np.mean(epoch_losses)) if epoch_losses else float("nan")
        val_loss = evaluate(val_s) if val_s else float("nan")
        loss_history.append({"epoch": epoch + 1, "train_loss": train_loss, "val_loss": val_loss})
        if verbose and ((epoch + 1) % max(1, epochs // 10) == 0 or epoch == epochs - 1):
            _log(f"  Epoch [{epoch+1}/{epochs}] train={train_loss:.6f} val={val_loss:.6f}")

    # Per-horizon validation MSE
    horizon_metrics: Dict[str, Dict] = {}
    for hname, _, pred_len in HORIZONS:
        hv = [s for s in val_s if s["pred_len"] == pred_len]
        if len(hv) < MIN_SAMPLES_PER_HORIZON:
            continue
        with torch.no_grad():
            baselines, targets, sk, pc, gx, pl = to_tensors(hv)
            out = adapter(baselines, sk, pc, gx, pl)
            mse = criterion(out, targets).item()
        horizon_metrics[hname] = {
            "pred_len": pred_len,
            "val_samples": len(hv),
            "val_mse": mse,
        }

    final_train_loss = loss_history[-1]["train_loss"] if loss_history else None
    final_val_loss = loss_history[-1]["val_loss"] if loss_history else None

    info = {
        "cov_mean": cov_mean,
        "cov_std": cov_std,
        "loss_history": loss_history,
        "horizon_metrics": horizon_metrics,
        "final_train_loss": final_train_loss,
        "final_val_loss": final_val_loss,
        "train_samples": len(train_s),
        "val_samples": len(val_s),
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
    parser.add_argument("--max-records", type=int, default=MAX_RECORDS_PER_SYMBOL,
                        help="Cap snapshots per symbol (subsampling) to bound runtime.")
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

    # 3. Build samples across symbols + horizons
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

        # Download the FINEST resolution (5m) over the window; coarser horizons
        # are resampled from it so we only hit yfinance once per symbol.
        _log(f"[{symbol}] downloading 5m prices {start_str} → {end_str} ({fetch_ticker}, ratio={ratio:.4f})...")
        try:
            df = yf.download(fetch_ticker, start=start_str, end=end_str, interval="5m")
        except Exception as e:
            _log(f"[{symbol}] yfinance download failed: {e}")
            continue
        if df.empty:
            _log(f"[{symbol}] empty price data, skipping.")
            continue
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df = df.rename(columns=lambda c: c.lower())
        df = df[["open", "high", "low", "close", "volume"]].dropna()
        if ratio != 1.0:
            for c in ["open", "high", "low", "close"]:
                df[c] = df[c] / ratio

        # Build a per-horizon resampled frame and generate samples for each.
        # We construct one canonical UTC-indexed price series per resolution.
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

        for hname, interval, pred_len in HORIZONS:
            # Resample from 5m to the horizon's resolution
            if interval == "5m":
                frame = df.copy()
            elif interval == "15m":
                frame = df.resample("15min").agg(
                    {"open": "first", "high": "max", "low": "min",
                     "close": "last", "volume": "sum"}).dropna()
            elif interval == "1h":
                frame = df.resample("1h").agg(
                    {"open": "first", "high": "max", "low": "min",
                     "close": "last", "volume": "sum"}).dropna()
            elif interval == "4h":
                frame = df.resample("4h").agg(
                    {"open": "first", "high": "max", "low": "min",
                     "close": "last", "volume": "sum"}).dropna()
            elif interval == "1d":
                frame = df.resample("1D").agg(
                    {"open": "first", "high": "max", "low": "min",
                     "close": "last", "volume": "sum"}).dropna()
            else:
                continue

            frame, time_list = utc_indexed(frame)
            if len(time_list) < CONTEXT_LEN + pred_len + 1:
                _log(f"  [{symbol}/{hname}] not enough bars yet ({len(time_list)}), skipping.")
                continue

            h_records = records  # all snapshots; alignment filters by availability
            per_h_samples = build_training_samples(
                predictor, h_records, frame, time_list, symbol, device,
                f"{symbol}/{hname}", max_records=args.max_records,
            )
            # tag horizon already set inside; just collect
            all_samples.extend(per_h_samples)
            _log(f"  [{symbol}/{hname}] produced {len(per_h_samples)} real samples")

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
        "horizons": info["horizon_metrics"],
        "loss_history": info["loss_history"],
    })

    # 6. Save checkpoint (v2 unified format)
    output_path = args.output_path or os.path.join(scripts_dir, "model/covariate_adapter.pth")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    checkpoint = {
        "version": 2,
        "state_dict": adapter.state_dict(),
        "hidden_dim": args.hidden_dim,
        "cov_mean": info["cov_mean"],
        "cov_std": info["cov_std"],
        "supported_pred_lens": [h[2] for h in HORIZONS],
        "trained_at": stats["trained_at"],
        "real_samples_total": real_total,
        "final_train_loss": info["final_train_loss"],
        "final_val_loss": info["final_val_loss"],
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
