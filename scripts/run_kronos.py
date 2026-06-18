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


def run_forecast_for_resolution(fetch_ticker, ratio, interval, period, context_len, pred_len, model, tokenizer, device):
    print(f"Downloading historical data: interval={interval}, period={period}...")
    df = yf.download(fetch_ticker, period=period, interval=interval)
    if df.empty:
        raise ValueError(f"No data returned for ticker {fetch_ticker} with interval {interval}")
        
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
        
    df = df.rename(columns=lambda x: x.lower())
    df = df[['open', 'high', 'low', 'close', 'volume']]
    df = df.dropna()

    if ratio != 1.0:
        for col in ['open', 'high', 'low', 'close']:
            df[col] = df[col] / ratio

    context_df = df.tail(context_len).copy()
    context_df['volume'] = context_df['volume'].astype(float)
    
    x_timestamp = pd.Series(context_df.index)
    freq_map = {
        "5m": "5min",
        "15m": "15min",
        "1h": "1h"
    }
    freq_str = freq_map.get(interval, interval)
    if interval == "5m":
        freq_delta = pd.Timedelta(minutes=5)
    elif interval == "15m":
        freq_delta = pd.Timedelta(minutes=15)
    else:
        freq_delta = pd.Timedelta(hours=1)
    y_timestamp = pd.Series(pd.date_range(start=context_df.index[-1] + freq_delta, periods=pred_len, freq=freq_str))

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
        "candles": predicted_candles
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
        
    # Generate 5m Forecast (up to 24 candles = 2 hours)
    print(f"\n--- Generating 5m forecast for {ticker} ---")
    forecast_5m = run_forecast_for_resolution(
        fetch_ticker=fetch_ticker,
        ratio=ratio,
        interval="5m",
        period="5d",
        context_len=128,
        pred_len=24,
        model=model,
        tokenizer=tokenizer,
        device=device
    )

    # Generate 15m Forecast (up to 26 candles)
    print(f"\n--- Generating 15m forecast for {ticker} ---")
    forecast_15m = run_forecast_for_resolution(
        fetch_ticker=fetch_ticker,
        ratio=ratio,
        interval="15m",
        period="5d",
        context_len=128,
        pred_len=26,
        model=model,
        tokenizer=tokenizer,
        device=device
    )
    
    # Generate 1h Forecast (up to 40 candles)
    print(f"\n--- Generating 1h forecast for {ticker} ---")
    forecast_1h = run_forecast_for_resolution(
        fetch_ticker=fetch_ticker,
        ratio=ratio,
        interval="1h",
        period="30d",
        context_len=128,
        pred_len=40,
        model=model,
        tokenizer=tokenizer,
        device=device
    )
    
    # Get 1h trend bias from first 4 candles of 15m forecast for backwards compatibility
    last_price = forecast_15m["last_price"]
    candles_15m = forecast_15m["candles"]
    candles_1h_out = candles_15m[:4]
    predicted_price_1h = candles_1h_out[-1]["close"] if candles_1h_out else last_price
    delta_pct = ((predicted_price_1h - last_price) / last_price) * 100
    
    if delta_pct > 0.05:
        trend_bias = "BULLISH"
    elif delta_pct < -0.05:
        trend_bias = "BEARISH"
    else:
        trend_bias = "NEUTRAL"
        
    print(f"Result for {ticker} (1h bias): Last={last_price:.2f}, Predicted={predicted_price_1h:.2f}, Bias={trend_bias} ({delta_pct:+.2f}%)")
    
    return {
        "ticker": ticker,
        "last_price_5m": forecast_5m["last_price"],
        "last_price_15m": last_price,
        "last_price_1h": forecast_1h["last_price"],
        "trend_bias": trend_bias,
        "strength_pct": round(delta_pct, 2),
        "forecast_5m": forecast_5m,
        "forecast_15m": forecast_15m,
        "forecast_1h": forecast_1h
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
                "last_price_5m": 750.0,
                "last_price_15m": 750.0,
                "last_price_1h": 750.0,
                "trend_bias": "NEUTRAL",
                "strength_pct": 0.0,
                "forecast_5m": {
                    "last_price": 750.0,
                    "expected_high": 750.0,
                    "expected_low": 750.0,
                    "predicted_volatility_pct": 0.0,
                    "candles": []
                },
                "forecast_15m": {
                    "last_price": 750.0,
                    "expected_high": 750.0,
                    "expected_low": 750.0,
                    "predicted_volatility_pct": 0.0,
                    "candles": []
                },
                "forecast_1h": {
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
                "last_price_5m": 740.0,
                "last_price_15m": 740.0,
                "last_price_1h": 740.0,
                "trend_bias": "NEUTRAL",
                "strength_pct": 0.0,
                "forecast_5m": {
                    "last_price": 740.0,
                    "expected_high": 740.0,
                    "expected_low": 740.0,
                    "predicted_volatility_pct": 0.0,
                    "candles": []
                },
                "forecast_15m": {
                    "last_price": 740.0,
                    "expected_high": 740.0,
                    "expected_low": 740.0,
                    "predicted_volatility_pct": 0.0,
                    "candles": []
                },
                "forecast_1h": {
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
