import os
import sys
import json
import datetime
import numpy as np
import pandas as pd
import yfinance as yf
import torch

# Set up paths to import local model code
scripts_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.append(scripts_dir)

from model.kronos import Kronos, KronosTokenizer, KronosPredictor

# Output JSON file path
OUTPUT_PATH = os.path.join(scripts_dir, "../data/kronos_forecast.json")

def get_futures_to_etf_ratio(futures_symbol: str, etf_symbol: str, default_ratio: float) -> float:
    try:
        f_ticker = yf.Ticker(futures_symbol)
        e_ticker = yf.Ticker(etf_symbol)
        f_hist = f_ticker.history(period="5d")
        e_hist = e_ticker.history(period="5d")
        if not f_hist.empty and not e_hist.empty:
            # Align on date indices
            common_dates = f_hist.index.intersection(e_hist.index)
            if not common_dates.empty:
                last_date = common_dates[-1]
                f_close = float(f_hist.loc[last_date, 'Close'])
                e_close = float(e_hist.loc[last_date, 'Close'])
                if f_close > 0 and e_close > 0:
                    ratio = f_close / e_close
                    print(f"Dynamic futures ratio for {futures_symbol}/{etf_symbol} calculated on {last_date.date()}: {ratio:.4f}")
                    return ratio
    except Exception as e:
        print(f"Error computing dynamic futures ratio: {e}")
    return default_ratio


def generate_future_trading_timestamps(last_ts, interval, pred_len):
    timestamps = []
    curr = last_ts
    while len(timestamps) < pred_len:
        if interval == "5m":
            curr += pd.Timedelta(minutes=5)
        elif interval == "15m":
            curr += pd.Timedelta(minutes=15)
        elif interval == "1h":
            curr += pd.Timedelta(hours=1)
        elif interval == "4h":
            curr += pd.Timedelta(hours=4)
        else:
            curr += pd.Timedelta(days=1)
            
        if curr.weekday() >= 5: # 5 is Saturday, 6 is Sunday
            continue
        timestamps.append(curr)
    return pd.Series(timestamps)


def run_forecast_for_resolution(fetch_ticker, ratio, interval, period, context_len, pred_len, model, tokenizer, device):
    print(f"Downloading historical data: interval={interval}, period={period}...")
    if interval == "4h":
        df = yf.download(fetch_ticker, period=period, interval="1h")
    else:
        df = yf.download(fetch_ticker, period=period, interval=interval)
        
    if df.empty:
        raise ValueError(f"No data returned for ticker {fetch_ticker} with interval {interval}")
        
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
        
    df = df.rename(columns=lambda x: x.lower())
    df = df[['open', 'high', 'low', 'close', 'volume']]
    df = df.dropna()

    if interval == "4h":
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

    # Add Skew and PCR covariates
    symbol = "SPY"
    if "NQ" in fetch_ticker or "QQQ" in fetch_ticker:
        symbol = "QQQ"

    # Load latest real-time options data for fallback
    latest_skew = 0.0
    latest_pcr = 1.0
    latest_gex = 0.0
    try:
        options_data_path = os.path.join(scripts_dir, "../data/options_data.json")
        if os.path.exists(options_data_path):
            with open(options_data_path, "r") as f:
                opt_data = json.load(f)
                symbol_data = opt_data.get("symbols", {}).get(symbol, {})
                latest_skew = symbol_data.get("volatility_skew_25d", 0.0)
                latest_pcr = symbol_data.get("put_call_oi_ratio", 1.0)
                latest_gex = symbol_data.get("total_net_gex", 0.0)
    except Exception as e:
        print(f"Warning: Could not load latest options data for fallback: {e}")

    # Try to load options history and merge using pd.merge_asof
    history_loaded = False
    history_path = os.path.join(scripts_dir, "../data/options_history.json")
    if os.path.exists(history_path):
        try:
            with open(history_path, "r") as f:
                history = json.load(f)
            # Drop records with an incompatible (pre-BS-IV-fix) GEX formula —
            # their total_net_gex is artefactual and would mislead the adapter.
            HISTORY_GEX_VERSION = 2
            history = [r for r in history if r.get("gex_v") == HISTORY_GEX_VERSION]
            symbol_history = [r for r in history if r.get("symbol") == symbol]
            if symbol_history:
                hist_df = pd.DataFrame(symbol_history)
                hist_dt = pd.to_datetime(hist_df['timestamp'])
                if hist_dt.dt.tz is not None:
                    hist_df['datetime'] = hist_dt.dt.tz_convert('UTC').dt.tz_localize(None)
                else:
                    hist_df['datetime'] = hist_dt
                hist_df['datetime'] = hist_df['datetime'].astype('datetime64[ns]')
                hist_df = hist_df.sort_values('datetime')
                
                # Prepare price df for merge_asof
                price_df = df.reset_index()
                index_col = price_df.columns[0]
                price_dt = pd.to_datetime(price_df[index_col])
                if price_dt.dt.tz is not None:
                    price_df['datetime'] = price_dt.dt.tz_convert('UTC').dt.tz_localize(None)
                else:
                    price_df['datetime'] = price_dt
                price_df['datetime'] = price_df['datetime'].astype('datetime64[ns]')
                price_df = price_df.sort_values('datetime')
                
                # Ensure total_net_gex column exists in hist_df
                if 'total_net_gex' not in hist_df.columns:
                    hist_df['total_net_gex'] = 0.0
                
                # Merge options history (backward direction matches closest record before/at price timestamp)
                merged_df = pd.merge_asof(
                    price_df, 
                    hist_df[['datetime', 'volatility_skew_25d', 'put_call_oi_ratio', 'total_net_gex']], 
                    on='datetime', 
                    direction='backward'
                )
                df = merged_df.set_index(index_col)
                df = df.drop(columns=['datetime'])
                history_loaded = True
                print(f"Successfully merged {len(symbol_history)} options history records for {symbol} using merge_asof.")
        except Exception as e:
            print(f"Warning: Failed to merge options history: {e}")

    if not history_loaded or 'volatility_skew_25d' not in df.columns:
        df['volatility_skew_25d'] = latest_skew
    else:
        df['volatility_skew_25d'] = df['volatility_skew_25d'].fillna(latest_skew)
        
    if 'put_call_oi_ratio' not in df.columns:
        df['put_call_oi_ratio'] = latest_pcr
    else:
        df['put_call_oi_ratio'] = df['put_call_oi_ratio'].fillna(latest_pcr)

    if 'total_net_gex' not in df.columns:
        df['total_net_gex'] = latest_gex
    else:
        df['total_net_gex'] = df['total_net_gex'].fillna(latest_gex)

    context_df = df.tail(context_len).copy()
    context_df['volume'] = context_df['volume'].astype(float)
    context_df['volatility_skew_25d'] = context_df['volatility_skew_25d'].astype(float)
    context_df['put_call_oi_ratio'] = context_df['put_call_oi_ratio'].astype(float)
    context_df['total_net_gex'] = context_df['total_net_gex'].astype(float)
    
    x_timestamp = pd.Series(context_df.index)
    y_timestamp = generate_future_trading_timestamps(context_df.index[-1], interval, pred_len)

    predictor = KronosPredictor(model, tokenizer, device=device, max_context=2048)
    
    pred_df = predictor.predict(
        df=context_df, 
        x_timestamp=x_timestamp, 
        y_timestamp=y_timestamp, 
        pred_len=pred_len, 
        T=0.7, 
        top_k=5, 
        top_p=0.9, 
        sample_count=1, 
        verbose=False
    )

    # Surface adapter status so the UI can show which resolutions actually
    # received a covariate correction (and how large it was).
    adapter_status = predictor.adapter_diag or {"applied": False}
    
    last_price = float(context_df['close'].iloc[-1])
    expected_high = float(pred_df['high'].max())
    expected_low = float(pred_df['low'].min())
    predicted_volatility_pct = ((expected_high - expected_low) / last_price) * 100
    
    predicted_candles = []
    for ts, row in pred_df.iterrows():
        timestamp_str = ts.isoformat() if hasattr(ts, 'isoformat') else str(ts)
        predicted_candles.append({
            "timestamp": timestamp_str,
            "open": round(float(row['open']), 2),
            "high": round(float(row['high']), 2),
            "low": round(float(row['low']), 2),
            "close": round(float(row['close']), 2),
            "volume": round(float(row['volume']), 1)
        })
        
    return {
        "last_price": round(last_price, 2),
        "expected_high": round(expected_high, 2),
        "expected_low": round(expected_low, 2),
        "predicted_volatility_pct": round(predicted_volatility_pct, 3),
        "candles": predicted_candles,
        "adapter_status": {
            "applied": bool(adapter_status.get("applied")),
            "pred_len": adapter_status.get("pred_len", pred_len),
            "residual_norm": round(adapter_status["residual_norm"], 6) if adapter_status.get("residual_norm") is not None else None,
            "supported": bool(adapter_status.get("supported")),
            "reason": adapter_status.get("reason"),
            "covariates": adapter_status.get("covariates"),
        }
    }


def get_market_bias(ticker, model, tokenizer, device):
    print(f"\n--- Fetching historical data for {ticker} ---")
    
    futures_map = {
        "SPY": "ES=F",
        "QQQ": "NQ=F"
    }
    ratio_map = {
        "SPY": 10.09,
        "QQQ": 41.57
    }
    
    fetch_ticker = futures_map.get(ticker, ticker)
    
    # Calculate ratio dynamically using last regular session completed closes
    if ticker in futures_map:
        default_ratio = ratio_map.get(ticker, 1.0)
        ratio = get_futures_to_etf_ratio(fetch_ticker, ticker, default_ratio)
    else:
        ratio = 1.0
        
    # Generate 4h Forecast (up to 6 candles = 24h) — session + next-day bias.
    # context_len=256 (~42 trading days of 4h bars) gives Kronos more pattern
    # to condition on than the legacy 128, improving forecast coherence.
    print(f"\n--- Generating 4h forecast for {ticker} ---")
    forecast_4h = run_forecast_for_resolution(
        fetch_ticker=fetch_ticker,
        ratio=ratio,
        interval="4h",
        period="90d",
        context_len=256,
        pred_len=6,
        model=model,
        tokenizer=tokenizer,
        device=device
    )

    # Generate 1d Forecast (up to 5 candles = 1 week) — the primary daily bias.
    # context_len=256 (~1 year of daily bars) maximizes the seasonal/trend
    # context Kronos can use; pred_len kept at 5 for maximum near-term precision.
    print(f"\n--- Generating 1d forecast for {ticker} ---")
    forecast_1d = run_forecast_for_resolution(
        fetch_ticker=fetch_ticker,
        ratio=ratio,
        interval="1d",
        period="2y",
        context_len=256,
        pred_len=5,
        model=model,
        tokenizer=tokenizer,
        device=device
    )
    
    # Trend bias is derived from the daily forecast (the primary bias horizon).
    # Falls back to the 4h forecast if the daily has no candles.
    last_price = forecast_1d["last_price"]
    candles_daily = forecast_1d["candles"]
    predicted_price = candles_daily[-1]["close"] if candles_daily else (
        forecast_4h["candles"][-1]["close"] if forecast_4h["candles"] else last_price
    )
    delta_pct = ((predicted_price - last_price) / last_price) * 100
    
    if delta_pct > 0.05:
        trend_bias = "BULLISH"
    elif delta_pct < -0.05:
        trend_bias = "BEARISH"
    else:
        trend_bias = "NEUTRAL"
        
    print(f"Result for {ticker} (daily bias): Last={last_price:.2f}, Predicted={predicted_price:.2f}, Bias={trend_bias} ({delta_pct:+.2f}%)")
    
    return {
        "ticker": ticker,
        "last_price_4h": forecast_4h["last_price"],
        "last_price_1d": forecast_1d["last_price"],
        "trend_bias": trend_bias,
        "strength_pct": round(delta_pct, 2),
        "forecast_4h": forecast_4h,
        "forecast_1d": forecast_1d
    }


def main():
    print("Initializing Kronos Forecast Process...")
    
    # Auto-select CPU or GPU
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}")
    
    try:
        # Load Kronos Model and Tokenizer
        print("Loading tokenizer (NeoQuasar/Kronos-Tokenizer-2k)...")
        tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-2k")
        print("Loading model weights (NeoQuasar/Kronos-mini)...")
        model = Kronos.from_pretrained("NeoQuasar/Kronos-mini")
        
        # Run forecast for S&P500 (SPY) and Nasdaq (QQQ)
        spy_bias = get_market_bias("SPY", model, tokenizer, device)
        qqq_bias = get_market_bias("QQQ", model, tokenizer, device)
        
        forecast_data = {
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "SP500_bias": spy_bias,
            "NASDAQ_bias": qqq_bias
        }
        
        # Save output to data/kronos_forecast.json
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            json.dump(forecast_data, f, indent=2)
            
        print(f"\nSuccess! Kronos forecasts saved to {OUTPUT_PATH}")
        
    except Exception as e:
        print(f"\nERROR running Kronos forecast: {e}", file=sys.stderr)
        
        # Write dummy fallback data in case of internet/market issues
        print("Writing fallback forecast data...")
        fallback_data = {
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "SP500_bias": {
                "ticker": "SPY",
                "last_price_4h": 750.0,
                "last_price_1d": 750.0,
                "trend_bias": "NEUTRAL",
                "strength_pct": 0.0,
                "forecast_4h": {
                    "last_price": 750.0,
                    "expected_high": 750.0,
                    "expected_low": 750.0,
                    "predicted_volatility_pct": 0.0,
                    "candles": []
                },
                "forecast_1d": {
                    "last_price": 750.0,
                    "expected_high": 750.0,
                    "expected_low": 750.0,
                    "predicted_volatility_pct": 0.0,
                    "candles": []
                },
                "error": str(e)
            },
            "NASDAQ_bias": {
                "ticker": "QQQ",
                "last_price_4h": 740.0,
                "last_price_1d": 740.0,
                "trend_bias": "NEUTRAL",
                "strength_pct": 0.0,
                "forecast_4h": {
                    "last_price": 740.0,
                    "expected_high": 740.0,
                    "expected_low": 740.0,
                    "predicted_volatility_pct": 0.0,
                    "candles": []
                },
                "forecast_1d": {
                    "last_price": 740.0,
                    "expected_high": 740.0,
                    "expected_low": 740.0,
                    "predicted_volatility_pct": 0.0,
                    "candles": []
                },
                "error": str(e)
            }
        }
        with open(OUTPUT_PATH, "w") as f:
            json.dump(fallback_data, f, indent=2)

if __name__ == "__main__":
    main()
