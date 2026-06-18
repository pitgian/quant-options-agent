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


def get_market_bias(ticker, model, tokenizer, device):
    print(f"\n--- Fetching historical data for {ticker} ---")
    
    # Use futures (ES=F / NQ=F) to support 24/5 continuous session (including London session)
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
    
    # Download last 5 days of 15m data for the mapped ticker
    df = yf.download(fetch_ticker, period="5d", interval="15m")
    
    if df.empty:
        raise ValueError(f"No data returned for ticker {fetch_ticker}")

    # Keep only columns of interest and convert to lowercase
    # If columns are MultiIndex (can happen with newer yfinance versions), flatten/select
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
        
    df = df.rename(columns=lambda x: x.lower())
    df = df[['open', 'high', 'low', 'close', 'volume']]
    df = df.dropna()

    # Scale futures prices to match ETF (SPY/QQQ) price levels
    if ratio != 1.0:
        print(f"Scaling futures prices for {ticker} by dividing by {ratio}...")
        for col in ['open', 'high', 'low', 'close']:
            df[col] = df[col] / ratio

    # KronosTokenizer needs a context history. We will feed the last 128 candles (approx 2 days of 15m K-lines)
    # the mini model supports up to 2048 context, but 128 is plenty for immediate trends and faster on CPU.
    context_df = df.tail(128).copy()
    
    # yfinance volume is integer, convert to float
    context_df['volume'] = context_df['volume'].astype(float)
    
    # Convert timestamps to Series to ensure .dt accessor works in KronosPredictor
    x_timestamp = pd.Series(context_df.index)
    
    # Calculate future timestamps (next 78 candles, representing 3 trading days of 6.5h each)
    pred_len = 78
    freq_delta = pd.Timedelta(minutes=15)
    y_timestamp = pd.Series(pd.date_range(start=context_df.index[-1] + freq_delta, periods=pred_len, freq='15min'))

    print(f"Running Kronos prediction for {ticker} (Predicting next {pred_len} candles)...")
    
    predictor = KronosPredictor(model, tokenizer, device=device, max_context=2048)
    
    # Run prediction (using default sampling settings)
    pred_df = predictor.predict(
        df=context_df, 
        x_timestamp=x_timestamp, 
        y_timestamp=y_timestamp, 
        pred_len=pred_len, 
        T=0.7,           # Temperature balanced for realistic volatility without too much noise
        top_k=5, 
        top_p=0.9, 
        sample_count=1,  # Single pure sample for realistic candle swings and expected range
        verbose=False
    )
    
    last_price = float(context_df['close'].iloc[-1])
    
    # Calculate stats for the first 4 candles (1 hour) for default fields
    pred_df_1h = pred_df.head(4)
    predicted_price_1h = float(pred_df_1h['close'].iloc[-1])
    delta_pct = ((predicted_price_1h - last_price) / last_price) * 100
    expected_high_1h = float(pred_df_1h['high'].max())
    expected_low_1h = float(pred_df_1h['low'].min())
    predicted_volatility_pct_1h = ((expected_high_1h - expected_low_1h) / last_price) * 100
    
    # Classify trend bias for 1h
    if delta_pct > 0.05:
        trend_bias = "BULLISH"
    elif delta_pct < -0.05:
        trend_bias = "BEARISH"
    else:
        trend_bias = "NEUTRAL"
        
    print(f"Result for {ticker} (1h): Last={last_price:.2f}, Predicted={predicted_price_1h:.2f}, Bias={trend_bias} ({delta_pct:+.2f}%)")
    
    # Parse intermediate candles
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
        "ticker": ticker,
        "last_price": round(last_price, 2),
        "predicted_price_1h": round(predicted_price_1h, 2),
        "expected_high": round(expected_high_1h, 2),
        "expected_low": round(expected_low_1h, 2),
        "predicted_volatility_pct": round(predicted_volatility_pct_1h, 3),
        "trend_bias": trend_bias,
        "strength_pct": round(delta_pct, 2),
        "candles": predicted_candles
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
                "last_price": 540.0,
                "predicted_price_1h": 540.0,
                "expected_high": 540.0,
                "expected_low": 540.0,
                "predicted_volatility_pct": 0.0,
                "trend_bias": "NEUTRAL",
                "strength_pct": 0.0,
                "candles": [],
                "error": str(e)
            },
            "NASDAQ_bias": {
                "ticker": "QQQ",
                "last_price": 450.0,
                "predicted_price_1h": 450.0,
                "expected_high": 450.0,
                "expected_low": 450.0,
                "predicted_volatility_pct": 0.0,
                "trend_bias": "NEUTRAL",
                "strength_pct": 0.0,
                "candles": [],
                "error": str(e)
            }
        }
        with open(OUTPUT_PATH, "w") as f:
            json.dump(fallback_data, f, indent=2)

if __name__ == "__main__":
    main()
