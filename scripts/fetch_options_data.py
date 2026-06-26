#!/usr/bin/env python3
"""
Options Wall Analyzer - Multi-Symbol Edition
Fetches options chain data from Yahoo Finance, aggregates OI and Volume
across all expirations, and identifies the top Put Walls (supports) and
Call Walls (resistances).

Supports multiple symbols via --symbol ALL or a single symbol.

Usage:
    python scripts/fetch_options_data.py --symbol ALL --output data/options_data.json
    python scripts/fetch_options_data.py --symbol SPY
    python scripts/fetch_options_data.py --symbol SPX --output data/spx_data.json
"""

import argparse
import json
import logging
import math
import os
import sys
import time
from datetime import datetime, timezone, timedelta
try:
    from zoneinfo import ZoneInfo
    _ET = ZoneInfo("America/New_York")
except Exception:
    _ET = timezone.utc  # fallback se zoneinfo non disponibile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
import requests
import yfinance as yf

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_SYMBOL = "SPY"
DEFAULT_OUTPUT = "data/options_data.json"
DATA_VERSION = "3.0"
# History schema version for the GEX covariate. Bumped when the GEX formula
# changes; append_to_history discards records produced by older versions so
# the adapter never trains on stale/incompatible GEX values.
#   v2 = Black-Scholes IV inversion + per-expiry smile fit (replaces the
#        Yahoo-IV-floor artefact that had corrupted ~99% of the old GEX).
HISTORY_GEX_VERSION = 2
MAX_EXPIRATIONS_TO_PROCESS = 25  # Max expirations to process, selected by highest contract count
CHAIN_FETCH_DELAY = 0.3  # seconds between individual chain fetches to avoid rate limiting
TOP_N_WALLS = 999  # Show all walls, no artificial limit
MIN_COMBINED_OI_VOL = 1  # Include all strikes with any activity
SCORE_OI_WEIGHT = 0.8
SCORE_VOL_WEIGHT = 0.2
INTER_SYMBOL_DELAY = 2  # seconds between symbols to avoid rate limiting

# Confluence level settings
CONFLUENCE_MIN_INTEREST = 50  # Minimum combined put+call activity to qualify
CONFLUENCE_MIN_RATIO = 0.15  # Minimum balance ratio min(put,call)/max(put,call)
CONFLUENCE_INTEREST_WEIGHT = 0.5  # Weight for total interest in confluence score
CONFLUENCE_RATIO_WEIGHT = 0.3  # Weight for balance ratio in confluence score
CONFLUENCE_DISTANCE_WEIGHT = 0.2  # Weight for proximity to spot in confluence score

# Cross-symbol confluence settings
CROSS_SYMBOL_TOLERANCE_PCT = 0.3    # % tolerance for matching levels
CROSS_SYMBOL_MIN_ACTIVITY = 100     # minimum combined activity to qualify
CROSS_SYMBOL_MAX_LEVELS = 5         # max cross-symbol levels per pair
CROSS_SYMBOL_MIN_SCORE = 35.0       # Minimum individual wall score to qualify
CROSS_SYMBOL_MIN_BALANCE = 0.20     # Minimum balance ratio between ETF/Index
CROSS_SYMBOL_MIN_COMBINED_OI = 5000 # Minimum combined OI
CROSS_SYMBOL_MIN_CROSS_SCORE = 30   # Minimum cross_score for a confluence level
CROSS_SYMBOL_INTEREST_WEIGHT = 0.40 # Weight for combined interest
CROSS_SYMBOL_BALANCE_WEIGHT = 0.20  # Weight for cross balance
CROSS_SYMBOL_PROXIMITY_WEIGHT = 0.15# Weight for proximity to spot
CROSS_SYMBOL_STRENGTH_WEIGHT = 0.25 # Weight for individual strength

# Symbols processed when --symbol ALL is used
ALL_SYMBOLS = ["SPY", "QQQ", "SPX", "NDX"]

# ---------------------------------------------------------------------------
# Symbol mapping
# ---------------------------------------------------------------------------
# Maps our canonical symbol name to the yfinance ticker used for options chains.
SYMBOL_YFINANCE_MAP = {
    "SPY": "SPY",
    "QQQ": "QQQ",
    "SPX": "^SPX",
    "NDX": "^NDX",
}

# ETF-based spot price derivation for indices.
# ETFs (SPY, QQQ) trade with real-time prices on exchanges, while index tickers
# (^SPX, ^NDX) may return 15-minute delayed data during market hours.
# We derive the index spot from the real-time ETF price using a ratio computed
# from recent historical closes of both the ETF and the index.
SPOT_ETF_MAP = {
    "SPX": "SPY",    # SPY × ratio ≈ SPX
    "NDX": "QQQ",    # QQQ × ratio ≈ NDX
}

# Index tickers used to compute the ETF→index ratio and as a direct fallback.
SPOT_INDEX_MAP = {
    "SPY": "SPY",
    "QQQ": "QQQ",
    "SPX": "^SPX",
    "NDX": "^NDX",
}

# Hardcoded fallback ratios (index/ETF).  Used when the dynamic ratio
# computation fails (e.g. yfinance history gaps, rate limiting).
# These are approximate and should be updated periodically.
#   SPX / SPY ≈ 10   (S&P 500 index / SPDR S&P 500 ETF)
#   NDX / QQQ ≈ 41   (Nasdaq 100 index / Invesco QQQ ETF)
HARDCODED_RATIOS: Dict[str, float] = {
    "SPX": 10.0,
    "NDX": 41.0,
}

# Fallback spot price source: only used when both ETF-derivation and index fail.
# Futures trade at a premium/discount to the spot index, so these are a
# last resort — the resulting gamma flip and distance metrics will be off.
SPOT_FUTURES_MAP = {
    "SPX": "ES=F",   # S&P 500 E-mini futures
    "NDX": "NQ=F",   # Nasdaq 100 E-mini futures
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def min_max_normalize(values: List[float]) -> List[float]:
    """Min-max normalize a list of values to [0, 1]."""
    if not values:
        return []
    mn, mx = min(values), max(values)
    if mx == mn:
        return [0.0] * len(values)
    return [(v - mn) / (mx - mn) for v in values]


def days_to_expiry(expiry_str: str) -> int:
    """Return the number of calendar days from now to *expiry_str* (YYYY-MM-DD)."""
    try:
        expiry_dt = datetime.strptime(expiry_str, "%Y-%m-%d").replace(
            tzinfo=timezone.utc
        )
        now = datetime.now(timezone.utc)
        return max((expiry_dt - now).days, 0)
    except ValueError:
        return 0


def format_expiry_label(date_str: str) -> str:
    """Convert '2026-05-08' to 'May 8' for display."""
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        return dt.strftime("%b %-d") if sys.platform != "win32" else dt.strftime("%b %#d")
    except ValueError:
        return date_str


# ---------------------------------------------------------------------------
# OI Fallback from previous data
# ---------------------------------------------------------------------------

def load_previous_oi_lookup(
    file_path: str = DEFAULT_OUTPUT,
) -> Dict[Tuple[str, float, str, str], int]:
    """
    Load the previous options_data.json and build a lookup dictionary
    keyed by (symbol, strike, side, expiry_date) → oi value.
    Only includes entries where oi > 0.
    Returns an empty dict if the file doesn't exist or is invalid.
    """
    path = Path(file_path)
    if not path.exists():
        logger.info("📄 No previous options_data.json found — OI fallback disabled")
        return {}

    try:
        with open(path, "r") as f:
            prev_data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"⚠️ Could not load previous data for OI fallback: {e}")
        return {}

    lookup: Dict[Tuple[str, float, str, str], int] = {}
    symbols = prev_data.get("symbols", {})
    for symbol, sym_data in symbols.items():
        for expiry in sym_data.get("expiries", []):
            expiry_date = expiry.get("date", "")
            for opt in expiry.get("options", []):
                oi = opt.get("oi", 0)
                if oi > 0:
                    key = (symbol, opt["strike"], opt["side"], expiry_date)
                    lookup[key] = oi

    logger.info(
        f"📄 Loaded previous OI lookup: {len(lookup)} non-zero OI entries "
        f"from {len(symbols)} symbols"
    )
    return lookup


# ---------------------------------------------------------------------------
# Data fetching
# ---------------------------------------------------------------------------

def _compute_etf_index_ratio(etf_ticker: str, index_ticker: str) -> Optional[float]:
    """
    Compute the index/ETF price ratio from recent **completed** daily closes.

    Returns the ratio such that:  index_spot ≈ etf_price × ratio

    Key design choices:
      • Uses only completed (historical) daily closes — the current
        incomplete trading day is excluded because index data (^SPX, ^NDX)
        may be 15-minute delayed during market hours while ETF data is
        real-time, which would produce a stale ratio.
      • Takes the **median** ratio across all available common dates to
        filter out any single-day outliers.
    """
    try:
        etf_hist = yf.Ticker(etf_ticker).history(period="5d")
        idx_hist = yf.Ticker(index_ticker).history(period="5d")
        if etf_hist.empty or idx_hist.empty:
            return None

        # Build list of (etf_close, idx_close) tuples for every common date
        pairs: List[Tuple[float, float]] = []

        # --- Try exact-index intersection first ---
        common = etf_hist.index.intersection(idx_hist.index)
        if len(common) >= 1:
            # Exclude the last (most recent) row — it may be an incomplete
            # bar during market hours with stale index data.
            completed = common[:-1] if len(common) > 1 else common
            for dt in completed:
                ec = float(etf_hist.loc[dt, "Close"])
                ic = float(idx_hist.loc[dt, "Close"])
                if ec > 0:
                    pairs.append((ec, ic))

        # --- Fallback: normalize to date-only and match ---
        if not pairs:
            etf_dates = etf_hist.index.normalize()
            idx_dates = idx_hist.index.normalize()
            common_dates = sorted(set(etf_dates) & set(idx_dates))
            # Exclude the most recent date (may be incomplete)
            completed_dates = common_dates[:-1] if len(common_dates) > 1 else common_dates
            for dt in completed_dates:
                etf_row = etf_hist.loc[etf_hist.index.normalize() == dt, "Close"]
                idx_row = idx_hist.loc[idx_hist.index.normalize() == dt, "Close"]
                if len(etf_row) > 0 and len(idx_row) > 0:
                    ec = float(etf_row.iloc[-1])
                    ic = float(idx_row.iloc[-1])
                    if ec > 0:
                        pairs.append((ec, ic))

        if not pairs:
            logger.warning(
                f"⚠️ No completed common dates for {index_ticker}/{etf_ticker} ratio"
            )
            return None

        # Compute per-day ratios and take the median
        ratios = sorted([ic / ec for ec, ic in pairs])
        median_ratio = ratios[len(ratios) // 2]

        logger.info(
            f"📐 Ratio {index_ticker}/{etf_ticker} = {median_ratio:.4f} "
            f"(median of {len(ratios)} days: "
            f"{[f'{r:.4f}' for r in ratios]})"
        )
        return median_ratio
    except Exception as e:
        logger.warning(f"⚠️ Could not compute {index_ticker}/{etf_ticker} ratio: {e}")
        return None


def _get_premarket_chart_price(symbol: str) -> Optional[float]:
    """Fetch active pre-market/after-hours price directly from Yahoo Finance chart API."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1m&range=1d&includePrePost=true"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
    try:
        response = requests.get(url, headers=headers, timeout=10)
        if response.status_code == 200:
            data = response.json()
            result = data.get('chart', {}).get('result', [{}])[0]
            meta = result.get('meta', {})
            closes = result.get('indicators', {}).get('quote', [{}])[0].get('close', [])
            
            for price in reversed(closes):
                if price is not None:
                    logger.info(f"💰 Chart pre-market price for {symbol}: ${price:.2f}")
                    return float(price)
            reg_price = meta.get('regularMarketPrice')
            if reg_price is not None:
                logger.info(f"💰 Chart regular price for {symbol}: ${reg_price:.2f}")
                return float(reg_price)
    except Exception as e:
        logger.warning(f"Error fetching chart price for {symbol}: {e}")
    return None


def _get_realtime_etf_price(etf_ticker: str) -> Optional[float]:
    """Return the most current price for an ETF using pre-market chart, falling back to fast_info."""
    price = _get_premarket_chart_price(etf_ticker)
    if price is not None and price > 0:
        return price

    try:
        price = float(yf.Ticker(etf_ticker).fast_info.last_price)
        if price > 0:
            return price
    except Exception:
        pass
    # Fallback to 1-day history
    try:
        hist = yf.Ticker(etf_ticker).history(period="1d")
        if hist is not None and not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception:
        pass
    return None


# Futures-based spot price configuration.
# Futures (ES=F, NQ=F) trade nearly 24/5 and closely track their respective
# indices, making them an excellent primary source for real-time spot prices.
FUTURES_CONFIG = {
    'SPX': {'futures_symbol': 'ES=F', 'adjustment_factor': 1.0},    # ES ≈ SPX
    'SPY': {'futures_symbol': 'ES=F', 'adjustment_factor': 0.1},    # SPY ≈ ES / 10
    'NDX': {'futures_symbol': 'NQ=F', 'adjustment_factor': 1.0},    # NQ ≈ NDX
    'QQQ': {'futures_symbol': 'NQ=F', 'adjustment_factor': 1/41},   # QQQ ≈ NQ / 41
}


def get_spot_from_futures(symbol: str) -> Optional[float]:
    """Get spot price from futures (primary source — trades nearly 24/5).

    For each symbol, fetches the corresponding futures price via yfinance
    and applies an adjustment factor to derive the spot price.
    """
    config = FUTURES_CONFIG.get(symbol)
    if not config:
        return None

    try:
        ft = yf.Ticker(config['futures_symbol'])
        price = None
        # Try fast_info first
        try:
            price = ft.fast_info['last_price']
        except Exception:
            pass
        # Fallback to history
        if not price or price <= 0:
            hist = ft.history(period="1d")
            if not hist.empty:
                price = hist['Close'].iloc[-1]

        if price and price > 0:
            spot = price * config['adjustment_factor']
            logger.info(
                f"🔥 Futures spot for {symbol} (via {config['futures_symbol']}): "
                f"${spot:.2f} (raw={price:.2f}, factor={config['adjustment_factor']})"
            )
            return spot
    except Exception as e:
        logger.warning(f"Futures error for {symbol}: {e}")

    return None


def get_spot_twelve_data(symbol: str) -> Optional[float]:
    """Get real-time spot price from Twelve Data API.

    For ETFs (SPY, QQQ): fetch directly (real-time).
    For indices (SPX, NDX): derive from ETF price × ratio.
    """
    api_key = os.environ.get('TWELVEDATA_API_KEY')
    if not api_key:
        logger.warning("TWELVEDATA_API_KEY not set, skipping Twelve Data")
        return None

    # Index derivation from ETF: ratio of previous closes
    INDEX_ETF_MAP = {
        'SPX': {'etf': 'SPY', 'ratio': 10.0},   # SPX ≈ SPY × 10
        'NDX': {'etf': 'QQQ', 'ratio': 41.0},    # NDX ≈ QQQ × 41
    }

    # Determine what to fetch from Twelve Data
    if symbol in INDEX_ETF_MAP:
        # For indices, fetch the corresponding ETF and derive
        etf_symbol = INDEX_ETF_MAP[symbol]['etf']
        ratio = INDEX_ETF_MAP[symbol]['ratio']
        td_symbol = etf_symbol
    else:
        # For ETFs, fetch directly
        td_symbol = symbol
        ratio = None

    try:
        url = f"https://api.twelvedata.com/price?symbol={td_symbol}&apikey={api_key}"
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        data = response.json()

        if 'price' in data:
            etf_price = float(data['price'])

            if ratio:
                # Derive index price from ETF
                derived_price = etf_price * ratio
                logger.info(
                    f"Twelve Data: {symbol} derived from {td_symbol} "
                    f"({etf_price}) × {ratio} = {derived_price:.2f}"
                )
                return derived_price
            else:
                logger.info(f"Twelve Data spot for {symbol}: {etf_price}")
                return etf_price
        elif 'message' in data:
            logger.warning(f"Twelve Data error for {td_symbol}: {data['message']}")
            return None
        else:
            logger.warning(f"Unexpected Twelve Data response for {td_symbol}: {data}")
            return None
    except Exception as e:
        logger.warning(f"Twelve Data fetch failed for {td_symbol}: {e}")
        return None


def get_spot_price(symbol: str, ticker: yf.Ticker) -> Optional[float]:
    """
    Return the last traded price for *symbol*.

    Priority order (spot must match the strike price universe of the options):
    1. For ETFs (SPY, QQQ): direct pre-market/real-time ETF price (most accurate, 0 delay).
    2. For Indices (SPX, NDX): derive from real-time ETF price (SPY, QQQ) first (avoids 15-min index delay).
    3. Direct Index quotes (fast_info, history).
    4. Twelve Data API.
    5. Adjusted Futures fallback (ES=F / NQ=F scaled by recent futures-to-cash ratio to eliminate rollover premium).
    """
    ETF_SYMBOLS = {'SPY', 'QQQ'}
    
    # ── 1. For ETFs: direct real-time/pre-market price ──
    if symbol in ETF_SYMBOLS:
        direct_price = _get_realtime_etf_price(symbol)
        if direct_price and direct_price > 0:
            logger.info(f"💰 {symbol} spot from direct ETF price: ${direct_price:.2f}")
            return direct_price

    # ── 2. For Indices: derive from real-time ETF (avoids 15m delay of ^SPX/^NDX) ──
    etf_ticker = SPOT_ETF_MAP.get(symbol)
    index_ticker = SPOT_INDEX_MAP.get(symbol)
    
    if etf_ticker and index_ticker and symbol not in ETF_SYMBOLS:
        etf_price = _get_realtime_etf_price(etf_ticker)
        if etf_price and etf_price > 0:
            ratio = _compute_etf_index_ratio(etf_ticker, index_ticker)
            if ratio is None:
                ratio = HARDCODED_RATIOS.get(symbol)
            if ratio:
                spot = etf_price * ratio
                logger.info(f"💰 {symbol} derived from ETF {etf_ticker} (${etf_price:.2f}) × ratio {ratio:.4f} = ${spot:.2f}")
                return spot

    # ── 3. Direct Index Quote ──
    if index_ticker and symbol not in ETF_SYMBOLS:
        try:
            price = float(yf.Ticker(index_ticker).fast_info.last_price)
            if price > 0:
                logger.info(f"💰 {symbol} spot from index {index_ticker} (fast_info): ${price:.2f}")
                return price
        except Exception:
            pass

        try:
            hist = yf.Ticker(index_ticker).history(period="1d")
            if not hist.empty:
                price = float(hist["Close"].iloc[-1])
                logger.info(f"💰 {symbol} spot from index {index_ticker} (history): ${price:.2f}")
                return price
        except Exception:
            pass

    # ── 4. Twelve Data (Backup) ──
    td_price = get_spot_twelve_data(symbol)
    if td_price and td_price > 0:
        return td_price

    # ── 5. Adjusted Futures fallback (absolute last resort for indices/ETFs, removes rollover premium) ──
    try:
        futures_symbol = SPOT_FUTURES_MAP.get(symbol)
        if futures_symbol:
            ft = yf.Ticker(futures_symbol)
            fut_price = None
            try:
                fut_price = ft.fast_info['last_price']
            except Exception:
                pass
            if not fut_price or fut_price <= 0:
                hist = ft.history(period="1d")
                if not hist.empty:
                    fut_price = hist['Close'].iloc[-1]
            
            if fut_price and fut_price > 0:
                # Adjust futures price by dynamic futures-to-cash (or futures-to-ETF) ratio from last completed close
                factor = FUTURES_CONFIG.get(symbol, {}).get('adjustment_factor', 1.0)
                
                # Try to compute dynamic factor
                try:
                    f_hist = ft.history(period="5d")
                    c_ticker_symbol = index_ticker if index_ticker else symbol
                    c_ticker = yf.Ticker(c_ticker_symbol)
                    c_hist = c_ticker.history(period="5d")
                    if not f_hist.empty and not c_hist.empty:
                        common = f_hist.index.intersection(c_hist.index)
                        if not common.empty:
                            last_date = common[-1]
                            f_close = float(f_hist.loc[last_date, 'Close'])
                            c_close = float(c_hist.loc[last_date, 'Close'])
                            if f_close > 0 and c_close > 0:
                                factor = c_close / f_close
                                logger.info(f"📐 Dynamic adjustment factor for {symbol} via {futures_symbol}: {factor:.6f}")
                except Exception as ex:
                    logger.warning(f"Failed to compute dynamic futures adjustment: {ex}")
                
                spot = fut_price * factor
                logger.info(f"💰 {symbol} spot from adjusted futures {futures_symbol}: ${spot:.2f} (raw={fut_price:.2f}, factor={factor:.6f})")
                return spot
    except Exception as e:
        logger.warning(f"Adjusted futures fallback failed for {symbol}: {e}")

    # ── 6. Ultimate Last Resort (ticker history) ──
    try:
        hist = ticker.history(period="1d")
        if not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception:
        pass

    try:
        return float(ticker.fast_info.last_price)
    except Exception:
        pass

    return None


def fetch_options_chain(
    ticker: yf.Ticker, expiry_date: str
) -> Optional[Dict[str, pd.DataFrame]]:
    """Fetch the calls and puts DataFrames for a single expiration."""
    try:
        chain = ticker.option_chain(expiry_date)
        return {"calls": chain.calls, "puts": chain.puts}
    except Exception as e:
        logger.error(f"Error fetching chain for {expiry_date}: {e}")
        return None


def parse_chain_side(
    df: pd.DataFrame,
    side: str,
    symbol: str = "",
    expiry_date: str = "",
    spot: float = 0.0,
    oi_lookup: Optional[Dict[Tuple[str, float, str, str], int]] = None,
) -> Tuple[List[Dict[str, Any]], int, int]:
    """
    Extract strike, oi, volume, gamma, and implied volatility from a single side (calls/puts) DataFrame.

    If *oi_lookup* is provided and a row has oi == 0, attempts to fall back
    to the last known non-zero OI from the lookup using the key
    (symbol, strike, side, expiry_date).

    Returns:
        (rows, zero_oi_count, fallback_count)
        - zero_oi_count: how many rows originally had OI == 0
        - fallback_count: how many of those were replaced with fallback data
    """
    lookup = oi_lookup or {}
    fallback_count = 0
    zero_oi_count = 0
    rows = []
    
    dte = days_to_expiry(expiry_date) if expiry_date else 0

    for _, row in df.iterrows():
        oi = int(row["openInterest"]) if pd.notna(row["openInterest"]) else 0
        vol = int(row["volume"]) if pd.notna(row["volume"]) else 0
        strike = round(float(row["strike"]), 2)
        iv = float(row["impliedVolatility"]) if pd.notna(row.get("impliedVolatility")) else 0.0
        bid = float(row["bid"]) if pd.notna(row.get("bid")) else 0.0
        ask = float(row["ask"]) if pd.notna(row.get("ask")) else 0.0
        
        gamma = float(row["gamma"]) if pd.notna(row.get("gamma")) else 0.0
        if gamma == 0.0 and spot > 0:
            gamma = estimate_gamma(spot, strike, dte, symbol, iv)

        if oi == 0:
            zero_oi_count += 1
            if lookup:
                key = (symbol, strike, side, expiry_date)
                fallback_oi = lookup.get(key)
                if fallback_oi is not None:
                    oi = fallback_oi
                    fallback_count += 1

        rows.append(
            {
                "strike": strike,
                "side": side,
                "oi": oi,
                "vol": vol,
                "gamma": gamma,
                "iv": iv,
                "bid": bid,
                "ask": ask,
            }
        )
    return rows, zero_oi_count, fallback_count



# ---------------------------------------------------------------------------
# Wall calculation
# ---------------------------------------------------------------------------

def calculate_walls(
    all_options_by_expiry: List[Dict[str, Any]],
    spot: float,
    top_n: int = TOP_N_WALLS,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Aggregate OI and Volume per strike across all expirations, compute a
    cross-side penalty score (own_activity - α × cross_activity), and return
    the top put walls, call walls, and confluence levels.

    Each expiry dict: {"date": str, "options": [{"strike", "side", "oi", "vol"}, ...]}

    Returns:
        (put_walls, call_walls, confluence_levels) – each a list of wall dicts sorted by score desc.
    """
    # Accumulate per-strike, per-side data with per-expiry breakdown
    strike_data: Dict[float, Dict[str, Dict[str, Dict[str, Any]]]] = {}

    for expiry_info in all_options_by_expiry:
        expiry_date = expiry_info["date"]
        for opt in expiry_info["options"]:
            strike = opt["strike"]
            side_key = "put" if opt["side"] == "PUT" else "call"
            oi = opt.get("oi", 0)
            vol = opt.get("vol", 0)
            gamma = opt.get("gamma", 0.0)

            if strike not in strike_data:
                strike_data[strike] = {"put": {}, "call": {}}
            strike_data[strike][side_key][expiry_date] = {
                "oi": oi,
                "vol": vol,
                "gamma": gamma,
            }

    # ── Expiration weighting by contract count (per side) ──
    # Calculate total OI per expiration, per side
    expiry_totals_put: Dict[str, int] = {}
    expiry_totals_call: Dict[str, int] = {}
    for strike, sides in strike_data.items():
        for exp_date, data in sides.get("put", {}).items():
            expiry_totals_put[exp_date] = expiry_totals_put.get(exp_date, 0) + data["oi"]
        for exp_date, data in sides.get("call", {}).items():
            expiry_totals_call[exp_date] = expiry_totals_call.get(exp_date, 0) + data["oi"]

    # Weight = expiry_total / max_expiry_total (per side)
    max_put = max(expiry_totals_put.values()) if expiry_totals_put and max(expiry_totals_put.values()) > 0 else 1
    max_call = max(expiry_totals_call.values()) if expiry_totals_call and max(expiry_totals_call.values()) > 0 else 1

    expiry_weights_put = {exp: tot / max_put for exp, tot in expiry_totals_put.items()}
    expiry_weights_call = {exp: tot / max_call for exp, tot in expiry_totals_call.items()}

    # ── Time-decay weighting: near-term expirations weighted higher ──
    # Formula: time_weight = 1 / (1 + DTE / 7)
    all_expiry_dates = set(list(expiry_weights_put.keys()) + list(expiry_weights_call.keys()))
    time_weights: Dict[str, float] = {}
    for exp_date in all_expiry_dates:
        dte = days_to_expiry(exp_date)
        time_weights[exp_date] = 1.0 / (1.0 + dte / 7.0)

    # Combine contract-count weights with time-decay weights
    for exp in list(expiry_weights_put.keys()):
        expiry_weights_put[exp] *= time_weights.get(exp, 1.0)
    for exp in list(expiry_weights_call.keys()):
        expiry_weights_call[exp] *= time_weights.get(exp, 1.0)

    # Build candidate lists for puts and calls
    put_candidates = []
    call_candidates = []

    # Contract size for GEX calculation
    CONTRACT_SIZE = 100

    for strike, sides in strike_data.items():
        # --- PUT side (weighted) ---
        put_total_oi = sum(e["oi"] * expiry_weights_put.get(exp, 1.0) for exp, e in sides["put"].items())
        put_total_vol = sum(e["vol"] * expiry_weights_put.get(exp, 1.0) for exp, e in sides["put"].items())
        # Opposite side (call) data at this strike
        opp_call_oi = sum(e["oi"] * expiry_weights_call.get(exp, 1.0) for exp, e in sides.get("call", {}).items())
        opp_call_vol = sum(e["vol"] * expiry_weights_call.get(exp, 1.0) for exp, e in sides.get("call", {}).items())

        # GEX computation: GEX = OI × Gamma × ContractSize × Spot² × sign
        # sign = +1 for calls, -1 for puts
        put_gex = sum(
            e["oi"] * e.get("gamma", 0.0) * CONTRACT_SIZE * spot * spot * (-1) * expiry_weights_put.get(exp, 1.0)
            for exp, e in sides["put"].items()
        )
        call_gex_at_strike = sum(
            e["oi"] * e.get("gamma", 0.0) * CONTRACT_SIZE * spot * spot * (+1) * expiry_weights_call.get(exp, 1.0)
            for exp, e in sides.get("call", {}).items()
        )

        if put_total_oi + put_total_vol >= MIN_COMBINED_OI_VOL and strike <= spot:
            put_expiry_breakdown = {
                exp: {**data, "weight": round(expiry_weights_put.get(exp, 1.0), 3)}
                for exp, data in sides["put"].items()
            }
            # Find nearest DTE for put
            nearest_dte_put = 999
            for exp in sides["put"].keys():
                dte = days_to_expiry(exp)
                if dte < nearest_dte_put:
                    nearest_dte_put = dte

            put_candidates.append(
                {
                    "strike": strike,
                    "total_oi": put_total_oi,
                    "total_vol": put_total_vol,
                    "opp_oi": opp_call_oi,
                    "opp_vol": opp_call_vol,
                    "put_gex": put_gex,
                    "call_gex": call_gex_at_strike,
                    "net_gex": put_gex + call_gex_at_strike,
                    "expiry_breakdown": put_expiry_breakdown,
                    "type": "put",
                    "nearest_dte": nearest_dte_put,
                }
            )

        # --- Call side (weighted) ---
        call_total_oi = sum(e["oi"] * expiry_weights_call.get(exp, 1.0) for exp, e in sides["call"].items())
        call_total_vol = sum(e["vol"] * expiry_weights_call.get(exp, 1.0) for exp, e in sides["call"].items())
        # Opposite side (put) data at this strike
        opp_put_oi = sum(e["oi"] * expiry_weights_put.get(exp, 1.0) for exp, e in sides.get("put", {}).items())
        opp_put_vol = sum(e["vol"] * expiry_weights_put.get(exp, 1.0) for exp, e in sides.get("put", {}).items())

        # GEX for call candidates (reuse same values computed above)
        call_gex = call_gex_at_strike if call_gex_at_strike != 0 else sum(
            e["oi"] * e.get("gamma", 0.0) * CONTRACT_SIZE * spot * spot * (+1) * expiry_weights_call.get(exp, 1.0)
            for exp, e in sides["call"].items()
        )
        put_gex_at_strike = put_gex if put_gex != 0 else sum(
            e["oi"] * e.get("gamma", 0.0) * CONTRACT_SIZE * spot * spot * (-1) * expiry_weights_put.get(exp, 1.0)
            for exp, e in sides.get("put", {}).items()
        )

        if call_total_oi + call_total_vol >= MIN_COMBINED_OI_VOL and strike >= spot:
            call_expiry_breakdown = {
                exp: {**data, "weight": round(expiry_weights_call.get(exp, 1.0), 3)}
                for exp, data in sides["call"].items()
            }
            # Find nearest DTE for call
            nearest_dte_call = 999
            for exp in sides["call"].keys():
                dte = days_to_expiry(exp)
                if dte < nearest_dte_call:
                    nearest_dte_call = dte

            call_candidates.append(
                {
                    "strike": strike,
                    "total_oi": call_total_oi,
                    "total_vol": call_total_vol,
                    "opp_oi": opp_put_oi,
                    "opp_vol": opp_put_vol,
                    "put_gex": put_gex_at_strike,
                    "call_gex": call_gex,
                    "net_gex": put_gex_at_strike + call_gex,
                    "expiry_breakdown": call_expiry_breakdown,
                    "type": "call",
                    "nearest_dte": nearest_dte_call,
                }
            )

    # Score and rank with cross-side penalty
    put_walls = _score_and_rank(put_candidates, spot, top_n)
    call_walls = _score_and_rank(call_candidates, spot, top_n)

    # Compute confluence levels from the same strike_data
    confluence_levels = calculate_confluence_levels(
        strike_data, spot, expiry_weights_put, expiry_weights_call, time_weights
    )

    return put_walls, call_walls, confluence_levels


# ---------------------------------------------------------------------------
# Unified wall scoring (Python <-> TypeScript parity)
# ---------------------------------------------------------------------------
#
# Wall "importance" = own-side activity × distance weight, where:
#
#   own_activity   = OI·w_oi + Vol·w_vol     (DTE-dependent bucket; see below)
#   distance_weight = exp(-|dist%| / 2.0)     (Laplacian, lambda = 2%)
#
# Design rationale (see docs/python-ts-parity.md):
#   - Laplacian decay gives a sharp intraday focus (ATM = 1.0, ±2% ≈ 0.37)
#     WITHOUT zeroing out far structural levels (±5% ≈ 0.08, ±8% ≈ 0.02):
#     a giant wall at -4% still surfaces if its OI justifies it.
#   - The old Gaussian exp(-(d/1.5)^2) was too peaked (≈0 at ±3%) and
#     silently discarded real support/resistance levels.
#   - The old cross-side penalty (alpha=0.35) was conceptually wrong for
#     walls: a strike with high put AND call OI is a high-gamma NODE, not
#     a weak wall. Bilaterality is rewarded separately by the confluence
#     scorer (calculate_confluence_levels).
#
# DTE-dependent OI/Vol weighting (applied ONCE here, not also during
# aggregation): at 0DTE the OI is noisy (forms and dissolves intraday), so
# volume is the trustworthy signal; at long DTE the OI is structural and
# dominates.
WALL_DISTANCE_LAMBDA = 2.0   # % distance scale for the Laplacian decay


def wall_dte_weights(nearest_dte: int) -> Tuple[float, float]:
    """Return (oi_weight, vol_weight) for the given nearest DTE bucket."""
    if nearest_dte == 0:
        return 0.25, 0.75
    if nearest_dte <= 3:
        return 0.50, 0.50
    return 0.70, 0.30


def compute_wall_score(
    own_oi: float,
    own_vol: float,
    nearest_dte: int,
    strike: float,
    spot: float,
) -> float:
    """
    Unified wall importance score (must match TS wallService.computeWallScore).

        score = (own_oi·w_oi + own_vol·w_vol) · exp(-|dist%| / lambda)

    Returns the RAW score (pre-normalization). Callers normalize to 0-100.
    """
    oi_w, vol_w = wall_dte_weights(nearest_dte)
    own_activity = own_oi * oi_w + own_vol * vol_w
    dist_pct = abs(strike - spot) / spot * 100.0 if spot > 0 else 0.0
    distance_weight = math.exp(-dist_pct / WALL_DISTANCE_LAMBDA)
    return own_activity * distance_weight


def _score_and_rank(
    candidates: List[Dict[str, Any]], spot: float, top_n: int
) -> List[Dict[str, Any]]:
    """
    Score wall candidates with the unified formula and normalize to 0-100.

    See compute_wall_score above for the formula and rationale.
    """
    if not candidates:
        return []

    for c in candidates:
        c["score"] = round(
            compute_wall_score(
                own_oi=c["total_oi"],
                own_vol=c["total_vol"],
                nearest_dte=c.get("nearest_dte", 999),
                strike=c["strike"],
                spot=spot,
            ),
            2,
        )

    # Distance from spot as percentage
        c["distance_pct"] = round((c["strike"] - spot) / spot * 100, 2)
        # List of expiry dates that contribute to this wall
        c["contributing_expiries"] = sorted(c["expiry_breakdown"].keys())

    # Filter out zero-score walls
    valid = [c for c in candidates if c["score"] > 0]
    if not valid:
        return []

    # Normalize scores to 0-100 (aligned with TS frontend)
    max_score = max(c["score"] for c in valid)
    for c in valid:
        c["score"] = round((c["score"] / max_score) * 100, 1) if max_score > 0 else 0.0

    valid.sort(key=lambda x: x["score"], reverse=True)
    return valid


def calculate_confluence_levels(
    strike_data: Dict[float, Dict[str, Dict[str, Dict[str, Any]]]],
    spot: float,
    expiry_weights_put: Dict[str, float],
    expiry_weights_call: Dict[str, float],
    time_weights: Dict[str, float],
) -> List[Dict[str, Any]]:
    """
    Identify strikes with significant bilateral (put+call) interest.

    Scoring formula:
        total_interest = weighted_put_activity + weighted_call_activity
        balance_ratio = min(put_side, call_side) / max(put_side, call_side)
        proximity = 1 / (1 + |strike - spot| / spot * 20)
        confluence_score = total_interest × 0.5 + balance_ratio × 0.3 + proximity × 0.2

    All components are min-max normalized before weighting.
    """
    candidates: List[Dict[str, Any]] = []

    for strike, sides in strike_data.items():
        # Compute weighted put activity
        put_oi_weighted = 0.0
        put_vol_weighted = 0.0
        put_expiry_breakdown: Dict[str, Dict[str, Any]] = {}

        for exp_date, data in sides.get("put", {}).items():
            w = expiry_weights_put.get(exp_date, 1.0) * time_weights.get(exp_date, 1.0)
            oi_w = data["oi"] * w
            vol_w = data["vol"] * w
            put_oi_weighted += oi_w
            put_vol_weighted += vol_w
            put_expiry_breakdown[exp_date] = {
                "oi": data["oi"],
                "vol": data["vol"],
                "weight": w,
                "side": "put",
            }

        # Compute weighted call activity
        call_oi_weighted = 0.0
        call_vol_weighted = 0.0
        call_expiry_breakdown: Dict[str, Dict[str, Any]] = {}

        for exp_date, data in sides.get("call", {}).items():
            w = expiry_weights_call.get(exp_date, 1.0) * time_weights.get(exp_date, 1.0)
            oi_w = data["oi"] * w
            vol_w = data["vol"] * w
            call_oi_weighted += oi_w
            call_vol_weighted += vol_w
            call_expiry_breakdown[exp_date] = {
                "oi": data["oi"],
                "vol": data["vol"],
                "weight": w,
                "side": "call",
            }

        put_activity = put_oi_weighted * SCORE_OI_WEIGHT + put_vol_weighted * SCORE_VOL_WEIGHT
        call_activity = call_oi_weighted * SCORE_OI_WEIGHT + call_vol_weighted * SCORE_VOL_WEIGHT
        total_interest = put_activity + call_activity

        # Skip strikes with insufficient bilateral interest
        if total_interest < CONFLUENCE_MIN_INTEREST:
            continue

        # Balance ratio: 1.0 = perfectly balanced, 0.0 = one-sided
        max_side = max(put_activity, call_activity)
        min_side = min(put_activity, call_activity)
        balance_ratio = min_side / max_side if max_side > 0 else 0

        # Skip if too one-sided
        if balance_ratio < CONFLUENCE_MIN_RATIO:
            continue

        # Merge expiry breakdowns (both put and call)
        merged_breakdown = {**put_expiry_breakdown, **call_expiry_breakdown}

        candidates.append({
            "strike": strike,
            "type": "confluence",
            "put_oi_weighted": put_oi_weighted,
            "put_vol_weighted": put_vol_weighted,
            "call_oi_weighted": call_oi_weighted,
            "call_vol_weighted": call_vol_weighted,
            "put_activity": put_activity,
            "call_activity": call_activity,
            "total_interest": total_interest,
            "balance_ratio": balance_ratio,
            "distance_pct": round((strike - spot) / spot * 100, 2),
            "expiry_breakdown": merged_breakdown,
        })

    if not candidates:
        return []

    # Min-max normalize each scoring component
    def min_max_normalize(values: List[float]) -> List[float]:
        mn, mx = min(values), max(values)
        if mx == mn:
            return [1.0 if mx > 0 else 0.0] * len(values)
        return [(v - mn) / (mx - mn) for v in values]

    interests = [c["total_interest"] for c in candidates]
    ratios = [c["balance_ratio"] for c in candidates]
    proximities = [1.0 / (1.0 + abs(c["strike"] - spot) / spot * 20) for c in candidates]

    norm_interests = min_max_normalize(interests)
    norm_ratios = min_max_normalize(ratios)
    norm_proximities = min_max_normalize(proximities)

    for i, c in enumerate(candidates):
        c["score"] = round(
            (norm_interests[i] * CONFLUENCE_INTEREST_WEIGHT
             + norm_ratios[i] * CONFLUENCE_RATIO_WEIGHT
             + norm_proximities[i] * CONFLUENCE_DISTANCE_WEIGHT) * 100,
            1,
        )
        c["contributing_expiries"] = sorted(c["expiry_breakdown"].keys())

    # Sort by score descending
    candidates.sort(key=lambda x: x["score"], reverse=True)
    return candidates


def _session_start(kind: str, tz=_ET) -> datetime:
    """
    Returns the timezone-aware start datetime for a calendar-aligned window.
      'daily'    → today 00:00 (intraday session from midnight)
      'weekly'   → Monday 00:00 of the current week
      'monthly'  → 1st of the current month 00:00
      'quarterly'→ 1st of the current quarter 00:00
    All in America/New_York (futures trade on US session boundaries).
    """
    now = datetime.now(tz)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if kind == "daily":
        return midnight
    if kind == "weekly":
        # Monday=0 ... Sunday=6
        return midnight - timedelta(days=midnight.weekday())
    if kind == "monthly":
        return midnight.replace(day=1)
    if kind == "quarterly":
        q_month = ((midnight.month - 1) // 3) * 3 + 1
        return midnight.replace(month=q_month, day=1)
    return midnight


def fetch_futures_volume_profile(
    symbol: str,
    spot_price: float,
    strikes: List[float],
    period: str = "30d",
    interval: str = "1h",
    start: Optional[datetime] = None,
    row_size: float = 1.0,
) -> Dict[str, float]:
    """
    Fetches futures candles and builds a volume profile on a uniform 1-point
    price grid in NATIVE FUTURES (ES/NQ) terms — matching what TradingView
    displays for the ES volume profile.

    Previously this scaled futures prices down to the symbol's spot/strike grid
    (5-point for SPX), which (a) put VAH/VAL in the wrong price scale (~100pt
    off vs ES) and (b) bucketed too coarsely to ever land on 7427/7464.

    Two modes for the time window:
      - ``start=None``  → Yahoo rolling ``period`` (legacy)
      - ``start=<dt>``  → session-based window (calendar-aligned)

    ``row_size`` defaults to 1.0 point (ES/NQ native). Wider rows reduce JSON
    size for long histories (90d/max) at the cost of precision.
    """
    # Map index/ETF symbols to correct futures contract
    futures_symbol = "ES=F" if symbol in ["SPY", "SPX"] else "NQ=F"
    logger.info(f"📈 Fetching futures volume profile for {symbol} using {futures_symbol} ({period}/{interval})...")

    try:
        futures_ticker = yf.Ticker(futures_symbol)
        # Fetch futures candles based on period and interval
        if start is not None:
            end_dt = datetime.now(start.tzinfo) if start.tzinfo else datetime.now(timezone.utc)
            hist = futures_ticker.history(start=start, end=end_dt, interval=interval, prepost=True)
        else:
            hist = futures_ticker.history(period=period, interval=interval, prepost=True)
        if hist.empty:
            logger.warning(f"⚠️ No futures data returned for {futures_symbol}")
            return {}

        # Determine the native futures price range, then bucket on a uniform
        # row_size grid. Prices stay in futures (ES/NQ) terms — NO spot scaling.
        all_highs = hist["High"].dropna()
        all_lows  = hist["Low"].dropna()
        if all_highs.empty:
            return {}
        price_min = float(all_lows.min())  // row_size * row_size
        price_max = float(all_highs.max()) // row_size * row_size + row_size
        rows = int(round((price_max - price_min) / row_size)) + 1
        grid = [price_min + i * row_size for i in range(rows)]
        profile = {round(p, 1): 0.0 for p in grid}

        futures_last_close = float(hist["Close"].iloc[-1])
        logger.info(f"   futures range [{price_min:.0f}..{price_max:.0f}], last={futures_last_close:.0f}, {rows} rows of {row_size}pt")

        for _, row in hist.iterrows():
            high = float(row["High"])
            low  = float(row["Low"])
            volume = float(row["Volume"])
            if pd.isna(high) or pd.isna(low) or pd.isna(volume) or volume <= 0:
                continue
            R = high - low
            if R < 1e-5:
                # Zero-range candle: assign to nearest row
                mid = (high + low) / 2
                nearest = round(mid / row_size) * row_size
                if nearest in profile:
                    profile[nearest] += volume
                continue
            # Distribute volume uniformly across the rows the candle spans
            lo_row = math.floor(low / row_size) * row_size
            hi_row = math.ceil(high / row_size) * row_size
            r = lo_row
            while r <= hi_row:
                cell_lo = r
                cell_hi = r + row_size
                overlap = max(0.0, min(high, cell_hi) - max(low, cell_lo))
                if overlap > 0:
                    rk = round(r, 1)
                    if rk in profile:
                        profile[rk] += (volume / R) * overlap
                r += row_size

        # Serialize with string keys, drop zero-volume rows
        return {str(k): round(v, 1) for k, v in profile.items() if v > 0}

    except Exception as e:
        logger.error(f"❌ Error computing futures volume profile for {symbol}: {e}")
        return {}


def calculate_volatility_skew_25d(all_options_by_expiry: List[Dict[str, Any]], spot: float) -> float:
    """
    Calculate the 25-Delta volatility skew: IV(Put 25D) - IV(Call 25D)
    averaged across liquid expirations (1 <= DTE <= 60).
    """
    import math

    def normal_cdf(x):
        return (1.0 + math.erf(x / math.sqrt(2.0))) / 2.0

    def get_delta(spot, strike, dte, iv, side):
        t = max(1, dte) / 365.0
        r = 0.05
        if iv <= 0 or t <= 0:
            if side == "CALL":
                return 1.0 if spot > strike else 0.0
            else:
                return -1.0 if spot < strike else 0.0
        try:
            d1 = (math.log(spot / strike) + (r + (iv ** 2) / 2.0) * t) / (iv * math.sqrt(t))
            if side == "CALL":
                return normal_cdf(d1)
            else:
                return normal_cdf(d1) - 1.0
        except Exception:
            if side == "CALL":
                return 1.0 if spot > strike else 0.0
            else:
                return -1.0 if spot < strike else 0.0

    exp_skews = []
    exp_weights = []

    for exp_info in all_options_by_expiry:
        exp_date = exp_info["date"]
        dte = days_to_expiry(exp_date)
        # Focus on liquid near-term expirations (e.g., 1 to 60 days)
        if dte < 1 or dte > 60:
            continue

        options = exp_info["options"]
        puts = [o for o in options if o["side"] == "PUT"]
        calls = [o for o in options if o["side"] == "CALL"]

        if not puts or not calls:
            continue

        # Find put closest to -0.25 delta
        best_put = None
        min_put_diff = float("inf")
        for p in puts:
            p_iv = p.get("iv", 0.0)
            if p_iv <= 0:
                continue
            delta = get_delta(spot, p["strike"], dte, p_iv, "PUT")
            diff = abs(delta - (-0.25))
            if diff < min_put_diff:
                min_put_diff = diff
                best_put = p

        # Find call closest to 0.25 delta
        best_call = None
        min_call_diff = float("inf")
        for c in calls:
            c_iv = c.get("iv", 0.0)
            if c_iv <= 0:
                continue
            delta = get_delta(spot, c["strike"], dte, c_iv, "CALL")
            diff = abs(delta - 0.25)
            if diff < min_call_diff:
                min_call_diff = diff
                best_call = c

        if best_put and best_call and min_put_diff < 0.15 and min_call_diff < 0.15:
            put_iv = best_put.get("iv", 0.0)
            call_iv = best_call.get("iv", 0.0)
            skew = put_iv - call_iv
            total_oi = sum(o.get("oi", 0) for o in options)
            exp_skews.append(skew)
            exp_weights.append(total_oi if total_oi > 0 else 1)

    if not exp_skews:
        # Fallback: try first available expiration
        for exp_info in all_options_by_expiry:
            exp_date = exp_info["date"]
            dte = days_to_expiry(exp_date)
            options = exp_info["options"]
            puts = [o for o in options if o["side"] == "PUT"]
            calls = [o for o in options if o["side"] == "CALL"]

            best_put = None
            min_put_diff = float("inf")
            for p in puts:
                p_iv = p.get("iv", 0.0)
                if p_iv <= 0:
                    continue
                delta = get_delta(spot, p["strike"], dte, p_iv, "PUT")
                diff = abs(delta - (-0.25))
                if diff < min_put_diff:
                    min_put_diff = diff
                    best_put = p

            best_call = None
            min_call_diff = float("inf")
            for c in calls:
                c_iv = c.get("iv", 0.0)
                if c_iv <= 0:
                    continue
                delta = get_delta(spot, c["strike"], dte, c_iv, "CALL")
                diff = abs(delta - 0.25)
                if diff < min_call_diff:
                    min_call_diff = diff
                    best_call = c

            if best_put and best_call:
                put_iv = best_put.get("iv", 0.0)
                call_iv = best_call.get("iv", 0.0)
                return put_iv - call_iv

        return 0.0

    # Weighted average of skews
    total_w = sum(exp_weights)
    weighted_skew = sum(s * w for s, w in zip(exp_skews, exp_weights)) / total_w
    return weighted_skew


def calculate_put_call_oi_ratio(all_options_by_expiry: List[Dict[str, Any]]) -> float:
    """
    Calculate the total Put Open Interest divided by total Call Open Interest.
    """
    total_put_oi = 0
    total_call_oi = 0

    for exp_info in all_options_by_expiry:
        for opt in exp_info["options"]:
            oi = opt.get("oi", 0)
            if opt["side"] == "PUT":
                total_put_oi += oi
            elif opt["side"] == "CALL":
                total_call_oi += oi

    if total_call_oi <= 0:
        return 1.0 if total_put_oi > 0 else 0.0

    return total_put_oi / total_call_oi


def estimate_gamma(spot: float, strike: float, dte: int, symbol: str, implied_vol: float = None) -> float:
    """
    Estimate option Gamma using Black-Scholes formula.
    Matches the frontend estimateGamma utility in utils/gammaEstimate.ts
    """
    import math
    DEFAULT_IV = {
        'SPY': 0.15,
        'QQQ': 0.20,
        'SPX': 0.15,
        'NDX': 0.20,
    }
    FALLBACK_IV = 0.20
    risk_free_rate = 0.05

    symbol_upper = symbol.upper() if symbol else ""
    default_iv = DEFAULT_IV.get(symbol_upper, FALLBACK_IV)
    sigma_input = implied_vol if implied_vol is not None else default_iv

    T = max(dte / 365.0, 1.0 / 365.0)
    sigma = max(sigma_input, 0.05)
    sqrt_T = math.sqrt(T)

    try:
        d1 = (math.log(spot / strike) + (risk_free_rate + 0.5 * sigma * sigma) * T) / (sigma * sqrt_T)
        pdf = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
        gamma = pdf / (spot * sigma * sqrt_T)
        return gamma
    except Exception:
        return 0.0


# ===========================================================================
# Professional IV estimation: Black-Scholes inversion + smile fit.
#
# Yahoo Finance returns impliedVolatility = ~1e-5 (effectively 0) for a large
# share of the chain (observed ~40% on SPY, dominant on the high-OI
# near-the-money options). The previous pipeline floored this to a flat 0.05,
# which produced absurdly inflated gammas on exactly the strikes that drive
# GEX — i.e. the GEX signal fed to the adapter was ~99% artefact.
#
# This module replicates what professional option platforms do:
#   1. For every option with a usable bid/ask, INVERT Black-Scholes from the
#      mid price (Newton-Raphson) to recover the true implied vol.
#   2. For each expiry, FIT a volatility smile (weighted quadratic in
#      log-moneyness, weights = OI) from the reliably-inverted IVs and
#      interpolate/extrapolate to the options Yahoo couldn't price.
#   3. Recompute gamma from the cleaned IV via the standard BS formula.
#
# The result is a GEX that reflects actual dealer positioning rather than a
# floor artefact, which makes the covariate informative for the adapter.
# ============================================================================

_RISK_FREE_RATE = 0.05
# Threshold below which a Yahoo IV is treated as broken and replaced.
_YAHOO_IV_BROKEN = 0.03
# Max acceptable bid/ask spread as a fraction of mid, to reject stale/wide quotes.
_MAX_SPREAD_FRAC = 0.25


def _bs_d1_d2(spot: float, strike: float, T: float, sigma: float, r: float = _RISK_FREE_RATE):
    import math
    sqrt_T = math.sqrt(T)
    d1 = (math.log(spot / strike) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrt_T)
    d2 = d1 - sigma * sqrt_T
    return d1, d2


def bs_price(spot: float, strike: float, T: float, sigma: float, is_call: bool, r: float = _RISK_FREE_RATE) -> float:
    """Black-Scholes option price (no dividends; index/ETF assumption)."""
    import math
    if T <= 0 or sigma <= 0:
        intrinsic = max(spot - strike, 0.0) if is_call else max(strike - spot, 0.0)
        return intrinsic
    try:
        d1, d2 = _bs_d1_d2(spot, strike, T, sigma, r)
        if is_call:
            return spot * _norm_cdf(d1) - strike * math.exp(-r * T) * _norm_cdf(d2)
        else:
            return strike * math.exp(-r * T) * _norm_cdf(-d2) - spot * _norm_cdf(-d1)
    except Exception:
        return 0.0


def _norm_cdf(x: float) -> float:
    import math
    return (1.0 + math.erf(x / math.sqrt(2.0))) / 2.0


def bs_vega(spot: float, strike: float, T: float, sigma: float, r: float = _RISK_FREE_RATE) -> float:
    import math
    if T <= 0 or sigma <= 0:
        return 0.0
    try:
        d1, _ = _bs_d1_d2(spot, strike, T, sigma, r)
        pdf = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
        return spot * math.sqrt(T) * pdf
    except Exception:
        return 0.0


def implied_vol_newton(
    price: float, spot: float, strike: float, T: float, is_call: bool,
    r: float = _RISK_FREE_RATE, max_iter: int = 50, tol: float = 1e-5,
) -> float:
    """
    Solve for implied volatility via Newton-Raphson on the BS price.
    Returns 0.0 if no convergence (caller will fall back to the smile fit).
    Bounded to [0.01, 5.0].
    """
    if price <= 0 or T <= 0:
        return 0.0
    intrinsic = max(spot - strike, 0.0) if is_call else max(strike - spot, 0.0)
    if price < intrinsic * 0.95:  # below intrinsic → unreliable quote
        return 0.0
    sigma = 0.20  # initial guess
    for _ in range(max_iter):
        try:
            p = bs_price(spot, strike, T, sigma, is_call, r)
        except Exception:
            return 0.0
        diff = p - price
        if abs(diff) < tol:
            return sigma
        v = bs_vega(spot, strike, T, sigma, r)
        if v < 1e-8:
            break
        sigma -= diff / v
        if sigma <= 0.005:
            sigma = 0.005
        if sigma > 5.0:
            return 0.0
    return 0.0


def fit_iv_smile(points: List[Dict[str, Any]], spot: float, T: float):
    """
    Fit a quadratic smile IV(m) = a + b*m + c*m² where m = log(K/F)/sqrt(T)
    (standard parametric volatility-smile form). Returns a callable
    iv(strike) or None if too few valid points.

    `points` is a list of {"strike":, "iv":, "weight":} with iv > 0.
    Fit is weighted (by OI) and robust: requires >=4 points; otherwise returns
    None and the caller falls back to a flat mean IV.
    """
    import math
    valid = [(p["strike"], p["iv"], p.get("weight", 1.0)) for p in points if p.get("iv", 0) > 0]
    if len(valid) < 4:
        return None
    sqrt_T = math.sqrt(T) if T > 0 else 1.0
    # Build weighted linear system for [a, b, c] with m = log(K/spot)/sqrt_T.
    # (Using spot as F proxy; r-discount correction is second-order for the smile shape.)
    Sxx = [0.0] * 6  # sum w * x^k for k=0..4
    Sxy = [0.0] * 3  # sum w * x^k * y for k=0..2
    for strike, iv, w in valid:
        try:
            m = math.log(strike / spot) / sqrt_T
        except Exception:
            continue
        y = iv
        # Clamp absurd IVs out of the fit (robustness against residual bad quotes)
        if y > 3.0 or y < 0.01:
            continue
        xk = 1.0
        for k in range(5):
            Sxx[k] += w * xk
            if k < 3:
                Sxy[k] += w * xk * y
            xk *= m
    # Solve 3x3 normal equations: [S0 S1 S2; S1 S2 S3; S2 S3 S4] x = [Sy0 Sy1 Sy2]
    M = [[Sxx[0], Sxx[1], Sxx[2]], [Sxx[1], Sxx[2], Sxx[3]], [Sxx[2], Sxx[3], Sxx[4]]]
    rhs = [Sxy[0], Sxy[1], Sxy[2]]
    coeff = _solve3(M, rhs)
    if coeff is None:
        return None
    a, b, c = coeff

    def iv_at(strike: float) -> float:
        try:
            m = math.log(strike / spot) / sqrt_T
        except Exception:
            return 0.0
        val = a + b * m + c * m * m
        # Clamp to a sane range to avoid runaway extrapolation on the wings
        return max(0.03, min(5.0, val))

    return iv_at


def _solve3(M, rhs):
    """Solve a 3x3 linear system via Cramer's rule. Returns None if singular."""
    def det3(a):
        return (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
                - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
                + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))
    D = det3(M)
    if abs(D) < 1e-12:
        return None
    res = []
    for col in range(3):
        Mc = [row[:] for row in M]
        for r in range(3):
            Mc[r][col] = rhs[r]
        res.append(det3(Mc) / D)
    return res


def clean_expiry_iv(options: List[Dict[str, Any]], spot: float, dte: int, symbol: str) -> int:
    """
    Recompute implied volatility and gamma for every option in ONE expiry using
    Black-Scholes inversion from bid/ask + per-expiry smile fit. Mutates the
    option dicts in place (sets 'iv' and 'gamma').

    Pipeline:
      * Step A — invert: options with usable bid/ask get IV via Newton-Raphson
        on the mid price. These anchor the smile.
      * Step B — fit smile: weighted quadratic in log-moneyness from anchored IVs.
      * Step C — fill: options without a usable mid (or whose Yahoo IV was
        broken) take IV from the smile; if no smile, fall back to the expiry's
        median anchored IV; if nothing, keep the symbol default.
      * Step D — recompute gamma from the cleaned IV via BS.

    Returns the count of IVs that were replaced (diagnostics).
    """
    import math
    if not options or spot <= 0:
        return 0
    T = max(dte / 365.0, 1.0 / 365.0)
    replaced = 0

    # Step A: invert IV from mid for options with usable bid/ask.
    anchor_points = []  # [{strike, iv, weight}]
    inverted_iv = {}  # id(opt) -> iv
    for opt in options:
        yahoo_iv = opt.get("iv", 0.0)
        bid = opt.get("bid", 0.0)
        ask = opt.get("ask", 0.0)
        is_call = opt["side"] == "CALL"
        mid = 0.0
        if bid > 0 and ask > 0:
            mid = 0.5 * (bid + ask)
            if mid > 0 and (ask - bid) / mid <= _MAX_SPREAD_FRAC:
                iv = implied_vol_newton(mid, spot, opt["strike"], T, is_call)
                if iv > 0:
                    inverted_iv[id(opt)] = iv
                    anchor_points.append({
                        "strike": opt["strike"],
                        "iv": iv,
                        "weight": max(opt.get("oi", 0), 1),
                    })
                    continue
        # If inversion failed but Yahoo IV is credible, still use it as anchor.
        if yahoo_iv >= 0.05 <= 3.0:
            anchor_points.append({
                "strike": opt["strike"],
                "iv": yahoo_iv,
                "weight": max(opt.get("oi", 0), 1),
            })

    # Step B: fit the smile from anchors.
    smile = fit_iv_smile(anchor_points, spot, T)
    # Fallback flat IV = median of anchors (or symbol default).
    valid_anchor_ivs = [p["iv"] for p in anchor_points]
    median_anchor = sorted(valid_anchor_ivs)[len(valid_anchor_ivs) // 2] if valid_anchor_ivs else None

    # Step C/D: assign final IV to every option and recompute gamma.
    for opt in options:
        is_call = opt["side"] == "CALL"
        yahoo_iv = opt.get("iv", 0.0)
        final_iv = inverted_iv.get(id(opt))
        if final_iv is None or final_iv <= 0:
            if yahoo_iv >= 0.05:
                final_iv = yahoo_iv  # Yahoo value was credible
            elif smile is not None:
                final_iv = smile(opt["strike"])  # interpolate
            elif median_anchor is not None:
                final_iv = median_anchor
            else:
                # Last-resort symbol default.
                DEFAULT_IV = {'SPY': 0.15, 'QQQ': 0.20, 'SPX': 0.15, 'NDX': 0.20}
                final_iv = DEFAULT_IV.get((symbol or "").upper(), 0.20)
        if abs(final_iv - yahoo_iv) > 1e-6 and yahoo_iv < _YAHOO_IV_BROKEN:
            replaced += 1
        opt["iv"] = float(final_iv)
        # Recompute gamma from the cleaned IV (BS formula; matches estimate_gamma).
        opt["gamma"] = estimate_gamma(spot, opt["strike"], dte, symbol, final_iv)
    return replaced


def append_to_history(symbol: str, skew: float, pcr: float, net_gex: float, file_path: str = "data/options_history.json") -> None:
    """
    Append skew, PCR and Net GEX metrics to history log, keeping the last 500 records per symbol.

    Schema versioning (gex_v): records are tagged with the GEX computation
    version they were produced by. When loading, any record whose version does
    not match HISTORY_GEX_VERSION is DROPPED — this self-heals the log when the
    GEX formula changes. In particular, all records produced before the
    Black-Scholes IV fix (gex_v missing / =1) carried an artefactual GEX (the
    Yahoo-IV-floor bug inflated GEX by ~99%), so they are discarded here on
    the next append and accumulation restarts clean.
    """
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    history = []
    if os.path.exists(file_path):
        try:
            with open(file_path, "r") as f:
                history = json.load(f)
        except Exception as e:
            logger.warning(f"Could not load history file: {e}")

    # Drop records produced by an incompatible (e.g. pre-BS-fix) GEX formula.
    before = len(history)
    history = [r for r in history if r.get("gex_v") == HISTORY_GEX_VERSION]
    purged = before - len(history)
    if purged:
        logger.info(f"🧹 Purged {purged} stale history record(s) with incompatible gex_v (≠{HISTORY_GEX_VERSION})")

    new_record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "symbol": symbol,
        "gex_v": HISTORY_GEX_VERSION,
        "volatility_skew_25d": round(skew, 5),
        "put_call_oi_ratio": round(pcr, 5),
        "total_net_gex": round(net_gex, 5)
    }
    history.append(new_record)

    # Filter to keep only last 500 records per symbol
    spy_records = [r for r in history if r.get("symbol") == "SPY"][-500:]
    qqq_records = [r for r in history if r.get("symbol") == "QQQ"][-500:]
    other_records = [r for r in history if r.get("symbol") not in ["SPY", "QQQ"]][-500:]
    history = spy_records + qqq_records + other_records

    try:
        with open(file_path, "w") as f:
            json.dump(history, f, indent=2)
        logger.info(f"💾 Saved real-time covariates for {symbol} to history ({file_path})")
    except Exception as e:
        logger.error(f"❌ Failed to write to history file: {e}")


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def fetch_symbol_data(
    symbol: str,
    max_expirations: int = MAX_EXPIRATIONS_TO_PROCESS,
    oi_lookup: Optional[Dict[Tuple[str, float, str, str], int]] = None,
) -> Optional[Dict[str, Any]]:
    """
    Full pipeline for a single symbol:
      1. Resolve yfinance ticker symbol
      2. Fetch spot price
      3. Scan ALL expirations for contract count, select top-N by volume
      4. Aggregate and score walls
      5. Return RawSymbolData-compatible dict
    """
    yf_symbol = SYMBOL_YFINANCE_MAP.get(symbol, symbol)
    logger.info(f"📊 Fetching data for {symbol} (yfinance: {yf_symbol})...")

    ticker = yf.Ticker(yf_symbol)

    # 1. Spot price
    spot = get_spot_price(symbol, ticker)
    if spot is None:
        logger.error(f"❌ Could not determine spot price for {symbol}")
        return None
    logger.info(f"💰 {symbol} spot price: ${spot:.2f}")

    # 2. Available expirations
    try:
        expirations = ticker.options
    except Exception as e:
        logger.error(f"❌ Could not fetch expirations for {symbol}: {e}")
        return None

    if not expirations:
        logger.error(f"❌ No expirations available for {symbol}")
        return None

    # 3. Scan ALL expirations: fetch chains, count contracts, cache data
    logger.info(
        f"🔍 Scanning all {len(expirations)} expirations to rank by contract count..."
    )

    # Stores: expiry_date -> {"calls": DataFrame, "puts": DataFrame, "contract_count": int}
    fetched_chains: Dict[str, Dict[str, Any]] = {}
    expiry_contract_counts: List[Tuple[str, int]] = []
    failed_expirations: List[str] = []

    for idx, exp_date in enumerate(expirations):
        try:
            chain = fetch_options_chain(ticker, exp_date)
            if chain is None:
                failed_expirations.append(exp_date)
                continue

            contract_count = len(chain["calls"]) + len(chain["puts"])
            fetched_chains[exp_date] = chain
            expiry_contract_counts.append((exp_date, contract_count))
            logger.info(
                f"  📋 [{idx + 1}/{len(expirations)}] {exp_date}: "
                f"{contract_count} contracts"
            )
        except Exception as e:
            logger.warning(f"⚠️ Skipping {exp_date} (unexpected error: {e})")
            failed_expirations.append(exp_date)

        # Small delay between chain fetches to avoid rate limiting
        if CHAIN_FETCH_DELAY > 0 and idx < len(expirations) - 1:
            time.sleep(CHAIN_FETCH_DELAY)

    if failed_expirations:
        logger.warning(
            f"⚠️ {len(failed_expirations)} expirations failed: "
            f"{', '.join(failed_expirations[:5])}"
            f"{'...' if len(failed_expirations) > 5 else ''}"
        )

    if not expiry_contract_counts:
        logger.error(f"❌ No option chains could be fetched for {symbol}")
        return None

    # Sort chronologically (nearest dates first) to prioritize near-term DTEs
    expiry_contract_counts.sort(key=lambda x: x[0])

    # Select top N nearest expirations
    selected_counts = expiry_contract_counts[:max_expirations]

    logger.info(
        f"📅 Selected top {len(selected_counts)} of {len(expirations)} expirations "
        f"by contract count (max_expirations={max_expirations}):"
    )
    for rank, (exp_date, count) in enumerate(selected_counts, 1):
        logger.info(f"  #{rank:2d}  {exp_date}: {count} contracts")

    # 4. Build raw expiry data and aggregated options from cached chains
    raw_expiries: List[Dict[str, Any]] = []
    all_options_by_expiry: List[Dict[str, Any]] = []
    total_zero_oi = 0
    total_fallbacks = 0

    for exp_date, contract_count in selected_counts:
        chain = fetched_chains[exp_date]
        calls, call_zeros, call_fbs = parse_chain_side(
            chain["calls"], "CALL", symbol, exp_date, spot, oi_lookup
        )
        puts, put_zeros, put_fbs = parse_chain_side(
            chain["puts"], "PUT", symbol, exp_date, spot, oi_lookup
        )
        total_zero_oi += call_zeros + put_zeros
        total_fallbacks += call_fbs + put_fbs
        all_options = calls + puts

        # Recompute IV (Black-Scholes inversion from bid/ask + per-expiry smile
        # fit) and recompute gamma from the cleaned IV. This replaces the
        # broken Yahoo IV (~1e-5 on ~40% of the chain) that previously inflated
        # GEX by ~99%. Done per-expiry because the smile is per-expiry.
        dte = days_to_expiry(exp_date)
        replaced_iv = clean_expiry_iv(all_options, spot, dte, symbol)
        if replaced_iv:
            logger.info(f"     ↻ {exp_date}: replaced {replaced_iv} broken Yahoo IV(s) via BS inversion + smile fit")
        # Drop bid/ask from the output dicts — only needed for the IV inversion,
        # keeping them would bloat the JSON (~2x) and the frontend doesn't use them.
        for _o in all_options:
            _o.pop("bid", None)
            _o.pop("ask", None)

        # Raw expiry for the JSON (consumed by vercelDataService.ts)
        raw_expiries.append(
            {
                "label": format_expiry_label(exp_date),
                "date": exp_date,
                "options": all_options,
            }
        )

        # Aggregated for wall calculation
        all_options_by_expiry.append({"date": exp_date, "options": all_options})
        logger.info(f"  ✅ {exp_date}: {len(all_options)} contracts (cached)")

    if not all_options_by_expiry:
        logger.error(f"❌ No option data fetched for {symbol}")
        return None

    # 5. Calculate walls (with cross-side penalty scoring)
    put_walls_raw, call_walls_raw, confluence_raw = calculate_walls(all_options_by_expiry, spot)

    # 5b. Compute totalNetGEX and gexFlipPoint across ALL strikes
    CONTRACT_SIZE = 100
    total_net_gex = 0.0
    gex_by_strike: Dict[float, float] = {}

    for expiry_info in all_options_by_expiry:
        dte = days_to_expiry(expiry_info["date"])
        time_weight = 1.0 / (1.0 + dte / 7.0)
        for opt in expiry_info["options"]:
            gamma = opt.get("gamma", 0.0)
            if gamma == 0.0:
                continue
            oi = opt.get("oi", 0)
            sign = 1 if opt["side"] == "CALL" else -1
            gex = oi * gamma * CONTRACT_SIZE * spot * spot * sign * time_weight
            total_net_gex += gex
            strike = opt["strike"]
            gex_by_strike[strike] = gex_by_strike.get(strike, 0.0) + gex

    # NOTE: GEX flip point is never computed server-side. The frontend derives
    # it with 5-strike smoothing bounded to ±5% of spot
    # (see gexService.computeGexFlipPoint), which is more robust on dense
    # 0DTE chains than a raw first-zero-crossing would be.

    # 6. Build wall structures (snake_case to match RawWall interface in vercelDataService.ts)
    put_walls = [
        {
            "strike": w["strike"],
            "type": w["type"],
            "total_oi": w["total_oi"],
            "total_vol": w["total_vol"],
            "put_oi": w["total_oi"],
            "put_vol": w["total_vol"],
            "call_oi": w.get("opp_oi", 0),
            "call_vol": w.get("opp_vol", 0),
            "call_gex": round(w.get("call_gex", 0.0), 2),
            "put_gex": round(w.get("put_gex", 0.0), 2),
            "net_gex": round(w.get("net_gex", 0.0), 2),
            "score": round(w["score"], 2),
            "contributing_expiries": w["contributing_expiries"],
            "distance_pct": w["distance_pct"],
            "expirations": [
                {
                    "expiration_date": exp_date,
                    "days_to_expiry": days_to_expiry(exp_date),
                    "oi": data["oi"],
                    "volume": data["vol"],
                    "weight": data.get("weight", 1.0),
                }
                for exp_date, data in w["expiry_breakdown"].items()
            ],
        }
        for w in put_walls_raw
    ]

    call_walls = [
        {
            "strike": w["strike"],
            "type": w["type"],
            "total_oi": w["total_oi"],
            "total_vol": w["total_vol"],
            "put_oi": w.get("opp_oi", 0),
            "put_vol": w.get("opp_vol", 0),
            "call_oi": w["total_oi"],
            "call_vol": w["total_vol"],
            "call_gex": round(w.get("call_gex", 0.0), 2),
            "put_gex": round(w.get("put_gex", 0.0), 2),
            "net_gex": round(w.get("net_gex", 0.0), 2),
            "score": round(w["score"], 2),
            "contributing_expiries": w["contributing_expiries"],
            "distance_pct": w["distance_pct"],
            "expirations": [
                {
                    "expiration_date": exp_date,
                    "days_to_expiry": days_to_expiry(exp_date),
                    "oi": data["oi"],
                    "volume": data["vol"],
                    "weight": data.get("weight", 1.0),
                }
                for exp_date, data in w["expiry_breakdown"].items()
            ],
        }
        for w in call_walls_raw
    ]

    # 6b. Build confluence wall structures
    confluence_levels = [
        {
            "strike": c["strike"],
            "type": "confluence",
            "total_oi": c["total_interest"],
            "total_vol": 0,
            "put_oi": round(c["put_activity"], 2),
            "put_vol": 0,
            "call_oi": round(c["call_activity"], 2),
            "call_vol": 0,
            "call_gex": round(c.get("call_gex", 0.0), 2),
            "put_gex": round(c.get("put_gex", 0.0), 2),
            "net_gex": round(c.get("net_gex", 0.0), 2),
            "score": round(c["score"], 2),
            "contributing_expiries": c["contributing_expiries"],
            "distance_pct": c["distance_pct"],
            "total_interest": round(c["total_interest"], 2),
            "confluence_ratio": round(c["balance_ratio"], 4),
            "expirations": [
                {
                    "expiration_date": exp_date,
                    "days_to_expiry": days_to_expiry(exp_date),
                    "oi": data["oi"],
                    "volume": data["vol"],
                    "weight": data.get("weight", 1.0),
                }
                for exp_date, data in c["expiry_breakdown"].items()
            ],
        }
        for c in confluence_raw
    ]

    # 7. OI fallback logging
    oi_fallback_used = total_fallbacks > 0
    if total_zero_oi > 0:
        logger.info(
            f"🔄 [{symbol}] OI fallback: replaced {total_fallbacks} of "
            f"{total_zero_oi} zero-OI values with last known data"
        )
    else:
        logger.info(f"🔄 [{symbol}] OI fallback: no zero-OI values detected")

    # 8. Assemble per-symbol output (matches RawSymbolData interface)
    now_iso = datetime.now(timezone.utc).isoformat()

    # Extract unique strikes from option chains
    strikes = list({
        opt["strike"]
        for exp_info in all_options_by_expiry
        for opt in exp_info["options"]
    })
    
    # Pre-calculate multiple timeframes. Calendar-aligned (session-based) for the
    # primary windows the trader uses: daily from midnight, weekly from Monday,
    # monthly from the 1st, quarterly from quarter start. The legacy 2d/5d stay
    # rolling (they're intermediate options, not requested as session windows).
    # All profiles are now in NATIVE FUTURES (ES/NQ) terms on a 1-point grid
    # (5-point for 90d/max to keep JSON size reasonable) — matches TradingView.
    futures_volume_profile_1d  = fetch_futures_volume_profile(symbol, spot, strikes, interval="5m",  start=_session_start("daily"),     row_size=1.0)
    futures_volume_profile_2d  = fetch_futures_volume_profile(symbol, spot, strikes, period="2d",   interval="15m",                      row_size=1.0)
    futures_volume_profile_5d  = fetch_futures_volume_profile(symbol, spot, strikes, period="5d",   interval="15m",                      row_size=2.0)
    futures_volume_profile_7d  = fetch_futures_volume_profile(symbol, spot, strikes, interval="30m", start=_session_start("weekly"),    row_size=2.0)
    futures_volume_profile_30d = fetch_futures_volume_profile(symbol, spot, strikes, interval="1h",  start=_session_start("monthly"),   row_size=5.0)
    futures_volume_profile_90d = fetch_futures_volume_profile(symbol, spot, strikes, interval="1d",  start=_session_start("quarterly"), row_size=5.0)
    futures_volume_profile_max = fetch_futures_volume_profile(symbol, spot, strikes, period="max",  interval="1d",                      row_size=5.0)

    # Calculate covariates
    skew_value = calculate_volatility_skew_25d(all_options_by_expiry, spot)
    pcr_value = calculate_put_call_oi_ratio(all_options_by_expiry)
    logger.info(f"📈 [{symbol}] Calculated 25-Delta Skew: {skew_value:.4f}, Put/Call OI Ratio: {pcr_value:.4f}")
    
    # Append to history database
    append_to_history(symbol, skew_value, pcr_value, total_net_gex)

    result = {
        "spot": spot,
        "generated": now_iso,
        "oi_fallback_used": oi_fallback_used,
        "total_net_gex": round(total_net_gex, 2),
        "volatility_skew_25d": round(skew_value, 4),
        "put_call_oi_ratio": round(pcr_value, 4),
        "futures_volume_profile": futures_volume_profile_30d, # Keep legacy 30d profile as default
        "futures_volume_profiles": {
            "1d": futures_volume_profile_1d,
            "2d": futures_volume_profile_2d,
            "5d": futures_volume_profile_5d,
            "7d": futures_volume_profile_7d,
            "30d": futures_volume_profile_30d,
            "90d": futures_volume_profile_90d,
            "max": futures_volume_profile_max,
        },
        "expiries": raw_expiries,
        "walls": {
            "put_walls": put_walls,
            "call_walls": call_walls,
            "confluence_levels": confluence_levels,
        },
    }

    logger.info(
        f"✅ {symbol}: {len(put_walls)} put walls, {len(call_walls)} call walls, "
        f"{len(confluence_levels)} confluence levels identified"
    )
    return result


def resolve_symbols(symbol_arg: str) -> List[str]:
    """Resolve the --symbol argument to a list of symbols to process."""
    if symbol_arg.upper() == "ALL":
        return list(ALL_SYMBOLS)
    return [symbol_arg.upper()]


# ---------------------------------------------------------------------------
# Cross-symbol confluence
# ---------------------------------------------------------------------------

def _collect_walls_for_cross(
    walls_data: Dict[str, Any], symbol: str
) -> List[Dict[str, Any]]:
    """
    Collect all walls (put, call, confluence) into a flat list for
    cross-symbol matching.  Each entry carries both the original wall_type
    and an *effective_type* used for contradiction checking (confluence
    levels resolve to their dominant side).
    """
    result: List[Dict[str, Any]] = []

    for wall in walls_data.get("put_walls", []):
        result.append({
            "symbol": symbol,
            "strike": wall["strike"],
            "distance_pct": wall["distance_pct"],
            "total_oi": wall["total_oi"],
            "total_vol": wall["total_vol"],
            "score": wall["score"],
            "wall_type": "put",
            "effective_type": "put",
        })

    for wall in walls_data.get("call_walls", []):
        result.append({
            "symbol": symbol,
            "strike": wall["strike"],
            "distance_pct": wall["distance_pct"],
            "total_oi": wall["total_oi"],
            "total_vol": wall["total_vol"],
            "score": wall["score"],
            "wall_type": "call",
            "effective_type": "call",
        })

    for wall in walls_data.get("confluence_levels", []):
        put_oi = wall.get("put_oi", 0)
        call_oi = wall.get("call_oi", 0)
        dominant = "put" if put_oi >= call_oi else "call"
        result.append({
            "symbol": symbol,
            "strike": wall["strike"],
            "distance_pct": wall["distance_pct"],
            "total_oi": wall.get("total_oi", 0),
            "total_vol": wall.get("total_vol", 0),
            "score": wall["score"],
            "wall_type": "confluence",
            "effective_type": dominant,
        })

    return result


def _is_contradictory(etf_wall: Dict[str, Any], idx_wall: Dict[str, Any]) -> bool:
    """Return True if the two walls give contradictory signals (put vs call)."""
    return {etf_wall["effective_type"], idx_wall["effective_type"]} == {"put", "call"}


def _determine_cross_type(
    etf_wall: Dict[str, Any], idx_wall: Dict[str, Any]
) -> str:
    """
    Determine the cross-symbol level type.
    Both put  → 'support',  both call → 'resistance'.
    Contradictory pairs should already have been filtered out.
    """
    etf_eff = etf_wall["effective_type"]
    idx_eff = idx_wall["effective_type"]
    if etf_eff == "put" or idx_eff == "put":
        return "support"
    return "resistance"


def _normalize_cross_values(values: List[float]) -> List[float]:
    """Min-max normalize to [0, 1].  Returns 1.0 for all-equal non-zero values."""
    if not values:
        return []
    mn, mx = min(values), max(values)
    if mx == mn:
        return [1.0 if mx > 0 else 0.0] * len(values)
    return [(v - mn) / (mx - mn) for v in values]


def _deduplicate_cross_matches(matches: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Deduplicate cross-symbol matches.

    If multiple ETF levels match the same Index level (or vice versa),
    keep only the pair with the highest cross_score.  Uses a greedy
    approach: sort by score descending, then skip any match whose ETF
    or Index strike has already been claimed.
    """
    sorted_matches = sorted(matches, key=lambda x: x["cross_score"], reverse=True)
    used_etf_strikes: set = set()
    used_idx_strikes: set = set()
    result: List[Dict[str, Any]] = []

    for m in sorted_matches:
        etf_key = m["etf"]["strike"]
        idx_key = m["idx"]["strike"]
        if etf_key in used_etf_strikes or idx_key in used_idx_strikes:
            continue
        used_etf_strikes.add(etf_key)
        used_idx_strikes.add(idx_key)
        result.append(m)

    return result


def calculate_cross_symbol_confluence(
    all_data: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Find cross-symbol confluence levels for each ETF/Index pair.

    For each pair (SPY↔SPX, QQQ↔NDX):
      1. Extract walls from both symbols
      2. Normalize to percentage-from-spot (already computed as distance_pct)
      3. Match walls within tolerance
      4. Score and rank matches
      5. Return top N cross-symbol levels

    Args:
        all_data: Dict mapping symbol name to its data (must contain
                  ``"walls"`` and ``"spot"`` keys for each symbol).

    Returns:
        Dict keyed by pair name (``"SPY_SPX"``, ``"QQQ_NDX"``) containing
        matched levels and metadata.
    """
    pairs = [("SPY", "SPX"), ("QQQ", "NDX")]
    result: Dict[str, Any] = {}

    for etf_sym, idx_sym in pairs:
        etf_data = all_data.get(etf_sym)
        idx_data = all_data.get(idx_sym)

        if not etf_data or not idx_data:
            logger.warning(
                f"⚠️ Cross-symbol: skipping {etf_sym}/{idx_sym} — "
                f"missing data (ETF: {'✓' if etf_data else '✗'}, "
                f"Index: {'✓' if idx_data else '✗'})"
            )
            continue

        etf_walls_data = etf_data.get("walls", {})
        idx_walls_data = idx_data.get("walls", {})
        etf_spot = etf_data.get("spot", 0)
        idx_spot = idx_data.get("spot", 0)

        if etf_spot <= 0 or idx_spot <= 0:
            logger.warning(
                f"⚠️ Cross-symbol: skipping {etf_sym}/{idx_sym} — "
                f"invalid spot prices (ETF: {etf_spot}, Index: {idx_spot})"
            )
            continue

        # Collect all walls into flat lists
        etf_all = _collect_walls_for_cross(etf_walls_data, etf_sym)
        idx_all = _collect_walls_for_cross(idx_walls_data, idx_sym)

        if not etf_all or not idx_all:
            logger.info(
                f"ℹ️ Cross-symbol: no walls for {etf_sym}/{idx_sym} "
                f"(ETF: {len(etf_all)}, Index: {len(idx_all)})"
            )
            pair_key = f"{etf_sym}_{idx_sym}"
            result[pair_key] = {
                "pair": pair_key,
                "etf_symbol": etf_sym,
                "index_symbol": idx_sym,
                "ratio": round(idx_spot / etf_spot, 4),
                "levels": [],
            }
            continue

        # ── Find all potential matches within tolerance ──
        matches: List[Dict[str, Any]] = []

        for ew in etf_all:
            for iw in idx_all:
                # Skip contradictory types (put vs call)
                if _is_contradictory(ew, iw):
                    continue

                # Check percentage-distance tolerance
                dist_diff = abs(ew["distance_pct"] - iw["distance_pct"])
                if dist_diff > CROSS_SYMBOL_TOLERANCE_PCT:
                    continue

                # Compute activity for each side
                etf_activity = (
                    ew["total_oi"] * SCORE_OI_WEIGHT
                    + ew["total_vol"] * SCORE_VOL_WEIGHT
                )
                idx_activity = (
                    iw["total_oi"] * SCORE_OI_WEIGHT
                    + iw["total_vol"] * SCORE_VOL_WEIGHT
                )
                combined_activity = etf_activity + idx_activity

                # Check minimum combined activity
                if combined_activity < CROSS_SYMBOL_MIN_ACTIVITY:
                    continue

                # Check minimum individual scores
                if ew["score"] < CROSS_SYMBOL_MIN_SCORE or iw["score"] < CROSS_SYMBOL_MIN_SCORE:
                    continue

                # Determine cross-symbol type
                cross_type = _determine_cross_type(ew, iw)

                matches.append({
                    "etf": ew,
                    "idx": iw,
                    "etf_activity": etf_activity,
                    "idx_activity": idx_activity,
                    "combined_activity": combined_activity,
                    "cross_type": cross_type,
                    "avg_distance_pct": (
                        abs(ew["distance_pct"]) + abs(iw["distance_pct"])
                    ) / 2,
                    "match_distance_pct": dist_diff,
                })

        if not matches:
            logger.info(
                f"ℹ️ Cross-symbol: no matching levels for {etf_sym}/{idx_sym}"
            )
            pair_key = f"{etf_sym}_{idx_sym}"
            result[pair_key] = {
                "pair": pair_key,
                "etf_symbol": etf_sym,
                "index_symbol": idx_sym,
                "ratio": round(idx_spot / etf_spot, 4),
                "levels": [],
            }
            continue

        # ── Compute cross-symbol scores ──
        for i, m in enumerate(matches):
            es = m["etf"]["score"]  # 0-100 score
            is_ = m["idx"]["score"]  # 0-100 score

            # Combined Interest: geometric mean of scores (scaled 0-1)
            combined_interest = ((es * is_) ** 0.5) / 100.0

            # Cross Balance: ratio of weaker to stronger score
            max_score = max(es, is_)
            cross_balance = min(es, is_) / max_score if max_score > 0 else 0.0

            # Proximity: inverse distance from spot
            proximity = 1.0 / (1.0 + m["avg_distance_pct"] / 2.0)

            # Individual Strength: weakest link (min of scores scaled 0-1)
            individual_strength = min(es, is_) / 100.0

            # Weighted final score (scaled to 0-100)
            raw_score = (
                CROSS_SYMBOL_INTEREST_WEIGHT * combined_interest
                + CROSS_SYMBOL_BALANCE_WEIGHT * cross_balance
                + CROSS_SYMBOL_PROXIMITY_WEIGHT * proximity
                + CROSS_SYMBOL_STRENGTH_WEIGHT * individual_strength
            )

            m["cross_score"] = round(raw_score * 100, 1)
            m["cross_balance"] = cross_balance

        # ── Filter by minimum balance ratio ──
        matches = [m for m in matches if m["cross_balance"] >= CROSS_SYMBOL_MIN_BALANCE]

        # ── Filter by minimum combined OI ──
        matches = [
            m for m in matches
            if m["etf"]["total_oi"] + m["idx"]["total_oi"] >= CROSS_SYMBOL_MIN_COMBINED_OI
        ]

        # ── Deduplicate: keep best match per unique ETF/Index strike ──
        matches = _deduplicate_cross_matches(matches)

        # Sort by cross_score descending
        matches.sort(key=lambda x: x["cross_score"], reverse=True)

        # Filter by minimum cross_score
        matches = [m for m in matches if m['cross_score'] >= CROSS_SYMBOL_MIN_CROSS_SCORE]

        # Cap at max levels per pair
        matches = matches[:CROSS_SYMBOL_MAX_LEVELS]

        # ── Build output levels ──
        levels: List[Dict[str, Any]] = []
        for m in matches:
            levels.append({
                "type": m["cross_type"],
                "cross_score": m["cross_score"],
                "etf": {
                    "symbol": m["etf"]["symbol"],
                    "strike": m["etf"]["strike"],
                    "distance_pct": m["etf"]["distance_pct"],
                    "total_oi": m["etf"]["total_oi"],
                    "total_vol": m["etf"]["total_vol"],
                    "score": m["etf"]["score"],
                    "wall_type": m["etf"]["wall_type"],
                },
                "index": {
                    "symbol": m["idx"]["symbol"],
                    "strike": m["idx"]["strike"],
                    "distance_pct": m["idx"]["distance_pct"],
                    "total_oi": m["idx"]["total_oi"],
                    "total_vol": m["idx"]["total_vol"],
                    "score": m["idx"]["score"],
                    "wall_type": m["idx"]["wall_type"],
                },
                "combined_oi": m["etf"]["total_oi"] + m["idx"]["total_oi"],
                "combined_vol": m["etf"]["total_vol"] + m["idx"]["total_vol"],
                "combined_activity": round(m["combined_activity"], 1),
            })

        pair_key = f"{etf_sym}_{idx_sym}"
        ratio = round(idx_spot / etf_spot, 4)
        result[pair_key] = {
            "pair": pair_key,
            "etf_symbol": etf_sym,
            "index_symbol": idx_sym,
            "ratio": ratio,
            "levels": levels,
        }

        logger.info(
            f"🔗 Cross-symbol {pair_key}: {len(levels)} confluence levels found "
            f"(ratio: {ratio:.2f})"
        )

    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Options Wall Analyzer – fetch & rank Put/Call walls (multi-symbol)"
    )
    parser.add_argument(
        "--symbol",
        default=DEFAULT_SYMBOL,
        help=(
            f"Ticker symbol or 'ALL' for multi-symbol processing. "
            f"ALL processes: {', '.join(ALL_SYMBOLS)}. "
            f"(default: {DEFAULT_SYMBOL})"
        ),
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help=f"Output JSON path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--max-expirations",
        type=int,
        default=MAX_EXPIRATIONS_TO_PROCESS,
        help=(
            f"Maximum number of expirations to process per symbol, "
            f"selected by highest contract count (default: {MAX_EXPIRATIONS_TO_PROCESS})"
        ),
    )
    args = parser.parse_args()

    symbols = resolve_symbols(args.symbol)
    output_path = Path(args.output)

    logger.info(f"🚀 Starting Options Wall Analyzer for: {', '.join(symbols)}")

    # Process each symbol
    symbols_data: Dict[str, Any] = {}
    failed_symbols: List[str] = []

    # Load previous data for OI fallback
    oi_lookup = load_previous_oi_lookup(args.output)

    for i, symbol in enumerate(symbols):
        try:
            data = fetch_symbol_data(
                symbol, max_expirations=args.max_expirations, oi_lookup=oi_lookup
            )
            if data is None:
                logger.error(f"❌ Failed to fetch data for {symbol}")
                failed_symbols.append(symbol)
            else:
                symbols_data[symbol] = data
        except Exception as e:
            logger.error(f"❌ Unexpected error processing {symbol}: {e}")
            failed_symbols.append(symbol)

        # Rate limiting: delay between symbols (skip after last one)
        if i < len(symbols) - 1:
            logger.info(f"⏳ Waiting {INTER_SYMBOL_DELAY}s before next symbol...")
            time.sleep(INTER_SYMBOL_DELAY)

    if not symbols_data:
        logger.error("❌ No data fetched for any symbol — aborting")
        sys.exit(1)

    if failed_symbols:
        logger.warning(
            f"⚠️ Failed symbols: {', '.join(failed_symbols)} "
            f"(continuing with {len(symbols_data)} successful)"
        )

    # Calculate cross-symbol confluence levels (SPY↔SPX, QQQ↔NDX)
    # NOTE: this reads the per-symbol 'walls' dict, so it MUST run before we
    # strip those internal fields from the serialized output below.
    cross_symbol_confluence = calculate_cross_symbol_confluence(symbols_data)

    # Build a slim copy of symbols for serialization.
    # The 'walls' block is computed by Python only to feed cross-symbol
    # matching above — the frontend re-derives walls and GEX directly from
    # the 'expiries' array (see services/index.ts), so shipping 'walls'
    # would be ~30% dead payload (1.3 MB on a typical run).
    # 'total_net_gex' is KEPT because run_kronos.py consumes it as a covariate.
    INTERNAL_FIELDS_TO_STRIP = ("walls",)
    output_symbols = {
        sym: {k: v for k, v in sd.items() if k not in INTERNAL_FIELDS_TO_STRIP}
        for sym, sd in symbols_data.items()
    }

    # Assemble top-level output (matches RawJson interface in fetchService.ts)
    now_iso = datetime.now(timezone.utc).isoformat()
    output = {
        "version": DATA_VERSION,
        "generated": now_iso,
        "symbols": output_symbols,
        "cross_symbol_confluence": cross_symbol_confluence,
    }

    # Ensure output directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write JSON
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    # Summary
    total_put = sum(
        len(symbols_data[s].get("walls", {}).get("put_walls", []))
        for s in symbols_data
    )
    total_call = sum(
        len(symbols_data[s].get("walls", {}).get("call_walls", []))
        for s in symbols_data
    )
    total_confluence = sum(
        len(symbols_data[s].get("walls", {}).get("confluence_levels", []))
        for s in symbols_data
    )
    total_cross = sum(
        len(cross_symbol_confluence.get(pair, {}).get("levels", []))
        for pair in cross_symbol_confluence
    )
    logger.info(f"💾 Data saved to {output_path}")
    logger.info(
        f"📊 Summary: {len(symbols_data)} symbols, "
        f"{total_put} total put walls, {total_call} total call walls, "
        f"{total_confluence} total confluence levels, "
        f"{total_cross} cross-symbol confluence levels"
    )


if __name__ == "__main__":
    main()
