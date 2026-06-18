#!/usr/bin/env python3
"""
Kronos Options Covariate Adapter Training Pipeline
Trains the ResidualCovariateAdapter MLP to adjust baseline Kronos forecasts
using historical volatility skew and Put/Call OI ratios.

Usage:
    python scripts/train_adapter.py --symbol SPY --interval 15m --epochs 50
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import yfinance as yf

# Set up paths to import local model code
scripts_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(scripts_dir)

from model.kronos import Kronos, KronosTokenizer, KronosPredictor, ResidualCovariateAdapter, calc_time_stamps
from run_kronos import generate_future_trading_timestamps, get_futures_to_etf_ratio

def main():
    parser = argparse.ArgumentParser(description="Train Kronos Covariate Adapter")
    parser.add_argument("--symbol", type=str, default="SPY", help="Symbol to train on (SPY, QQQ)")
    parser.add_argument("--interval", type=str, default="15m", help="Forecast interval (5m, 15m, 1h, 4h, 1d)")
    parser.add_argument("--context-len", type=int, default=128, help="Context sequence length")
    parser.add_argument("--pred-len", type=int, default=26, help="Prediction sequence length")
    parser.add_argument("--epochs", type=int, default=50, help="Number of training epochs")
    parser.add_argument("--lr", type=float, default=0.005, help="Learning rate")
    parser.add_argument("--hidden-dim", type=int, default=64, help="MLP hidden dimension")
    parser.add_argument("--output-path", type=str, default=None, help="Path to save adapter.pth")
    args = parser.parse_args()

    print("=" * 70)
    print(f"🚀 Starting Kronos Covariate Adapter Training for {args.symbol} ({args.interval})")
    print("=" * 70)

    # 1. Load options history
    history_path = os.path.join(scripts_dir, "../data/options_history.json")
    if not os.path.exists(history_path):
        print(f"❌ Error: Options history file not found at {history_path}")
        print("Please run scripts/fetch_options_data.py to collect options data first.")
        sys.exit(1)

    with open(history_path, "r") as f:
        history_data = json.load(f)

    records = [r for r in history_data if r.get("symbol") == args.symbol]
    if not records:
        print(f"❌ Error: No options history records found for {args.symbol} in {history_path}")
        sys.exit(1)

    print(f"Loaded {len(records)} options history records for {args.symbol}.")
    if len(records) < 5:
        print("⚠️ Warning: Very few historical records available. The adapter might overfit.")
        print("For optimal performance, let the data updater accumulate at least 50 snapshots.")

    # Determine date range to download price history
    timestamps = pd.to_datetime([r["timestamp"] for r in records])
    min_date = timestamps.min() - pd.Timedelta(days=10) # extra buffer for context_len
    max_date = timestamps.max() + pd.Timedelta(days=5) # extra buffer for future target
    
    # Format dates for yfinance
    start_str = min_date.strftime("%Y-%m-%d")
    end_str = max_date.strftime("%Y-%m-%d")

    # 2. Download historical price data
    futures_map = {"SPY": "ES=F", "QQQ": "NQ=F"}
    ratio_map = {"SPY": 10.1, "QQQ": 41.6}
    fetch_ticker = futures_map.get(args.symbol, args.symbol)
    
    # Calculate ratio dynamically using the same logic as run_kronos.py
    default_ratio = ratio_map.get(args.symbol, 1.0)
    ratio = get_futures_to_etf_ratio(fetch_ticker, args.symbol, default_ratio)
    print(f"Downloading prices for {fetch_ticker} from {start_str} to {end_str}...")
    
    if args.interval == "4h":
        df = yf.download(fetch_ticker, start=start_str, end=end_str, interval="1h")
    else:
        df = yf.download(fetch_ticker, start=start_str, end=end_str, interval=args.interval)

    if df.empty:
        print(f"❌ Error: No price data returned for {fetch_ticker}")
        sys.exit(1)

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    df = df.rename(columns=lambda x: x.lower())
    df = df[['open', 'high', 'low', 'close', 'volume']]
    df = df.dropna()

    if args.interval == "4h":
        df = df.resample('4h').agg({
            'open': 'first',
            'high': 'max',
            'low': 'min',
            'close': 'last',
            'volume': 'sum'
        }).dropna()

    if ratio != 1.0:
        for col in ['open', 'high', 'low', 'close']:
            df[col] = df[col] / ratio

    print(f"Price data size: {df.shape[0]} rows.")

    # 3. Load Kronos model
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"Loading Kronos model on device: {device}...")
    tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-2k")
    model = Kronos.from_pretrained("NeoQuasar/Kronos-mini")
    
    predictor = KronosPredictor(model, tokenizer, device=device, max_context=2048)
    predictor.model.eval()
    predictor.tokenizer.eval()

    # 4. Align prices and build training samples
    # Convert df index to naive UTC for matching
    df_reset = df.reset_index()
    index_col = df_reset.columns[0]
    df_reset['datetime_utc'] = pd.to_datetime(df_reset[index_col])
    if df_reset['datetime_utc'].dt.tz is not None:
        df_reset['datetime_utc'] = df_reset['datetime_utc'].dt.tz_convert('UTC').dt.tz_localize(None)
    else:
        df_reset['datetime_utc'] = df_reset['datetime_utc'].dt.tz_localize(None)
    df_reset['datetime_utc'] = df_reset['datetime_utc'].astype('datetime64[ns]')

    # Build quick lookup dictionary for price index positions
    price_time_list = df_reset['datetime_utc'].tolist()

    training_samples = []

    print("Running baseline Kronos predictions for historical timestamps...")
    for idx, record in enumerate(records):
        ts_utc = pd.to_datetime(record["timestamp"]).tz_convert('UTC').tz_localize(None).to_datetime64()
        
        # Find closest price index in df
        # We need the closest timestamp that is less than or equal to ts_utc
        valid_indices = [i for i, t in enumerate(price_time_list) if t <= ts_utc]
        if not valid_indices:
            continue
            
        p_idx = valid_indices[-1]
        
        # We need at least context_len bars in the past and pred_len bars in the future
        if p_idx < args.context_len or p_idx + args.pred_len >= len(price_time_list):
            continue

        # Extract context and future targets
        context_df = df.iloc[p_idx - args.context_len : p_idx].copy()
        future_df = df.iloc[p_idx : p_idx + args.pred_len].copy()

        # Check for NaNs
        if context_df.isnull().values.any() or future_df.isnull().values.any():
            continue

        # Get covariates
        skew = record["volatility_skew_25d"]
        pcr = record["put_call_oi_ratio"]
        gex = record.get("total_net_gex", 0.0) / 1e9

        # Run baseline Kronos forecast (without adapter)
        # Temporarily disable predictor's adapter if it loads one
        original_adapter = predictor.adapter
        predictor.adapter = None

        x_timestamp = pd.Series(context_df.index)
        y_timestamp = pd.Series(future_df.index)

        # Standard normalization as done in Predictor
        price_cols = predictor.price_cols
        vol_col = predictor.vol_col
        amt_vol = predictor.amt_vol

        # Ensure volume and amount exist
        context_df[vol_col] = context_df[vol_col].astype(float)
        context_df[amt_vol] = context_df[vol_col] * context_df[price_cols].mean(axis=1)
        future_df[vol_col] = future_df[vol_col].astype(float)
        future_df[amt_vol] = future_df[vol_col] * future_df[price_cols].mean(axis=1)

        x = context_df[price_cols + [vol_col, amt_vol]].values.astype(np.float32)
        y_actual = future_df[price_cols + [vol_col, amt_vol]].values.astype(np.float32)

        x_mean, x_std = np.mean(x, axis=0), np.std(x, axis=0)

        # Normalize price inputs
        x_norm = (x - x_mean) / (x_std + 1e-5)
        x_norm = np.clip(x_norm, -predictor.clip, predictor.clip)

        # Predict baseline
        x_time_df = calc_time_stamps(x_timestamp)
        y_time_df = calc_time_stamps(y_timestamp)

        x_tensor = torch.from_numpy(x_norm[np.newaxis, :]).to(device)
        x_stamp_tensor = torch.from_numpy(x_time_df.values[np.newaxis, :].astype(np.float32)).to(device)
        y_stamp_tensor = torch.from_numpy(y_time_df.values[np.newaxis, :].astype(np.float32)).to(device)

        try:
            # Generate baseline predictions in normalized space
            with torch.no_grad():
                preds_norm = predictor.generate(x_tensor, x_stamp_tensor, y_stamp_tensor, args.pred_len, T=0.7, top_k=5, top_p=0.9, sample_count=1, verbose=False)
                preds_norm = preds_norm.squeeze(0) # (pred_len, 6)

            # Target actual in normalized space
            y_actual_norm = (y_actual - x_mean) / (x_std + 1e-5)
            y_actual_norm = np.clip(y_actual_norm, -predictor.clip, predictor.clip)

            # Target residual (Actual - Baseline)
            target_residual = y_actual_norm - preds_norm

            training_samples.append({
                "baseline": preds_norm,            # (pred_len, 6)
                "skew": skew,
                "pcr": pcr,
                "gex": gex,
                "target_residual": target_residual # (pred_len, 6)
            })
        except Exception as e:
            print(f"Error predicting sample {idx}: {e}")
            continue

    print(f"Created {len(training_samples)} valid training samples.")
    if not training_samples:
        print("⚠️ No real historical samples have complete future targets (since they are too recent).")
        print("Generating synthetic training samples based on the latest available market context to verify the pipeline...")
        
        # Take the latest available context from the price dataframe
        p_idx = len(price_time_list) - args.pred_len - 1
        if p_idx >= args.context_len:
            context_df = df.iloc[p_idx - args.context_len : p_idx].copy()
            future_df = df.iloc[p_idx : p_idx + args.pred_len].copy()
            
            # Use latest record's covariates
            skew = records[-1]["volatility_skew_25d"]
            pcr = records[-1]["put_call_oi_ratio"]
            gex = records[-1].get("total_net_gex", 0.0) / 1e9
            
            x_timestamp = pd.Series(context_df.index)
            y_timestamp = pd.Series(future_df.index)
            
            price_cols = predictor.price_cols
            vol_col = predictor.vol_col
            amt_vol = predictor.amt_vol
            
            context_df[vol_col] = context_df[vol_col].astype(float)
            context_df[amt_vol] = context_df[vol_col] * context_df[price_cols].mean(axis=1)
            future_df[vol_col] = future_df[vol_col].astype(float)
            future_df[amt_vol] = future_df[vol_col] * future_df[price_cols].mean(axis=1)
            
            x = context_df[price_cols + [vol_col, amt_vol]].values.astype(np.float32)
            y_actual = future_df[price_cols + [vol_col, amt_vol]].values.astype(np.float32)
            
            x_mean, x_std = np.mean(x, axis=0), np.std(x, axis=0)
            x_norm = (x - x_mean) / (x_std + 1e-5)
            x_norm = np.clip(x_norm, -predictor.clip, predictor.clip)
            
            x_time_df = calc_time_stamps(x_timestamp)
            y_time_df = calc_time_stamps(y_timestamp)
            
            x_tensor = torch.from_numpy(x_norm[np.newaxis, :]).to(device)
            x_stamp_tensor = torch.from_numpy(x_time_df.values[np.newaxis, :].astype(np.float32)).to(device)
            y_stamp_tensor = torch.from_numpy(y_time_df.values[np.newaxis, :].astype(np.float32)).to(device)
            
            try:
                with torch.no_grad():
                    preds_norm = predictor.generate(x_tensor, x_stamp_tensor, y_stamp_tensor, args.pred_len, T=0.7, top_k=5, top_p=0.9, sample_count=1, verbose=False)
                    preds_norm = preds_norm.squeeze(0)
                    
                y_actual_norm = (y_actual - x_mean) / (x_std + 1e-5)
                y_actual_norm = np.clip(y_actual_norm, -predictor.clip, predictor.clip)
                
                target_residual = y_actual_norm - preds_norm
                
                # Add perturbed copies
                for _ in range(5):
                    noise = np.random.normal(0, 0.05, size=target_residual.shape).astype(np.float32)
                    training_samples.append({
                        "baseline": preds_norm + np.random.normal(0, 0.02, size=preds_norm.shape).astype(np.float32),
                        "skew": skew + np.random.normal(0, 0.01),
                        "pcr": pcr + np.random.normal(0, 0.05),
                        "gex": gex + np.random.normal(0, 0.2),
                        "target_residual": target_residual + noise
                    })
            except Exception as e:
                print(f"Error generating synthetic samples: {e}")
                
        if not training_samples:
            print("❌ Error: Could not construct even synthetic training samples.")
            sys.exit(1)
 
    # 5. Training loop
    adapter = ResidualCovariateAdapter(pred_len=args.pred_len).to(device)
    optimizer = torch.optim.Adam(adapter.parameters(), lr=args.lr)
    criterion = nn.MSELoss()
 
    # Convert training samples to tensors
    baselines = torch.stack([torch.from_numpy(s["baseline"]) for s in training_samples]).to(device) # (N, pred_len, 6)
    skews = torch.tensor([[s["skew"]] for s in training_samples], dtype=torch.float32).to(device) # (N, 1)
    pcrs = torch.tensor([[s["pcr"]] for s in training_samples], dtype=torch.float32).to(device)   # (N, 1)
    gexs = torch.tensor([[s["gex"]] for s in training_samples], dtype=torch.float32).to(device)   # (N, 1)
    targets = torch.stack([torch.from_numpy(s["target_residual"]) for s in training_samples]).to(device) # (N, pred_len, 6)
 
    print("Training Residual Covariate Adapter...")
    adapter.train()
    for epoch in range(args.epochs):
        optimizer.zero_grad()
        outputs = adapter(baselines, skews, pcrs, gexs)
        loss = criterion(outputs, targets)
        loss.backward()
        optimizer.step()
        
        if (epoch + 1) % max(1, args.epochs // 10) == 0 or epoch == args.epochs - 1:
            print(f"  Epoch [{epoch+1}/{args.epochs}] - Loss (MSE): {loss.item():.6f}")

    # 6. Save model weights
    output_path = args.output_path
    if output_path is None:
        output_path = os.path.join(scripts_dir, "model/covariate_adapter.pth")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    checkpoint = {
        "pred_len": args.pred_len,
        "state_dict": adapter.state_dict(),
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "samples_count": len(training_samples),
        "loss": loss.item()
    }
    
    torch.save(checkpoint, output_path)
    print(f"🎉 Success! Covariate adapter weights saved to {output_path}")

if __name__ == "__main__":
    main()
