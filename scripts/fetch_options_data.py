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
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
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
MAX_EXPIRATIONS_TO_PROCESS = 25  # Max expirations to process, selected by highest contract count
CHAIN_FETCH_DELAY = 0.3  # seconds between individual chain fetches to avoid rate limiting
TOP_N_WALLS = 999  # Show all walls, no artificial limit
MIN_COMBINED_OI_VOL = 1  # Include all strikes with any activity
SCORE_OI_WEIGHT = 0.8
SCORE_VOL_WEIGHT = 0.2
CROSS_SIDE_ALPHA = 0.35  # Cross-side penalty factor (dealer hedging impact)
INTER_SYMBOL_DELAY = 2  # seconds between symbols to avoid rate limiting

# Confluence level settings
CONFLUENCE_MIN_INTEREST = 50  # Minimum combined put+call activity to qualify
CONFLUENCE_MIN_RATIO = 0.15  # Minimum balance ratio min(put,call)/max(put,call)
CONFLUENCE_INTEREST_WEIGHT = 0.5  # Weight for total interest in confluence score
CONFLUENCE_RATIO_WEIGHT = 0.3  # Weight for balance ratio in confluence score
CONFLUENCE_DISTANCE_WEIGHT = 0.2  # Weight for proximity to spot in confluence score

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


def _get_realtime_etf_price(etf_ticker: str) -> Optional[float]:
    """Return the most current price for an ETF using fast_info (real-time)."""
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


def get_spot_price(symbol: str, ticker: yf.Ticker) -> Optional[float]:
    """
    Return the last traded price for *symbol*.

    Priority order (spot must match the strike price universe of the options):
      1. ETF derivation – real-time ETF price × dynamic ratio (primary for indices)
      1b. ETF derivation with hardcoded fallback ratio (if dynamic ratio fails)
      2. SPOT_INDEX_MAP  – index ticker directly (fallback)
      3. SPOT_FUTURES_MAP – futures ticker (fallback, may differ from index)
      4. ticker.history / fast_info – the yfinance ticker object itself
    """
    # ── 0. For ETFs (SPY, QQQ), just use the ticker directly ──
    etf_ticker = SPOT_ETF_MAP.get(symbol)

    # ── 1. Primary: derive from ETF (real-time price × ratio) ──
    # ETFs trade with real-time prices; index tickers (^SPX, ^NDX) may be
    # 15-minute delayed during market hours.  We compute the index/ETF ratio
    # from recent completed historical closes and apply it to the live ETF
    # price obtained via fast_info (which is real-time even during market
    # hours).
    if etf_ticker:
        index_ticker = SPOT_INDEX_MAP.get(symbol)
        if index_ticker:
            etf_price = _get_realtime_etf_price(etf_ticker)
            if etf_price is not None and etf_price > 0:
                # Try dynamic ratio first
                ratio = _compute_etf_index_ratio(etf_ticker, index_ticker)
                ratio_source = "dynamic"

                # Fallback to hardcoded ratio if dynamic fails
                if ratio is None:
                    ratio = HARDCODED_RATIOS.get(symbol)
                    ratio_source = "hardcoded"
                    if ratio is not None:
                        logger.warning(
                            f"⚠️ Dynamic ratio failed for {symbol}, "
                            f"using hardcoded ratio {ratio:.1f}"
                        )

                if ratio is not None:
                    spot = etf_price * ratio
                    logger.info(
                        f"💰 {symbol} spot from ETF {etf_ticker} "
                        f"(${etf_price:.2f}) × {ratio:.4f} "
                        f"({ratio_source}) = ${spot:.2f}"
                    )
                    return spot

            # If we couldn't get ETF price at all, try index directly
            logger.warning(
                f"⚠️ Could not get real-time {etf_ticker} price for {symbol} derivation"
            )

    # ── 2. Fallback: index ticker directly ──
    index_ticker = SPOT_INDEX_MAP.get(symbol)
    if index_ticker:
        try:
            price = float(yf.Ticker(index_ticker).fast_info.last_price)
            if price > 0:
                logger.info(
                    f"💰 {symbol} spot from index {index_ticker} "
                    f"(fast_info fallback): ${price:.2f}"
                )
                return price
        except Exception:
            pass

        try:
            idx = yf.Ticker(index_ticker)
            hist = idx.history(period="1d")
            if hist is not None and not hist.empty:
                price = float(hist["Close"].iloc[-1])
                logger.info(
                    f"💰 {symbol} spot from index {index_ticker} "
                    f"(history fallback): ${price:.2f}"
                )
                return price
        except Exception as e:
            logger.warning(
                f"⚠️ Could not fetch spot from index {index_ticker}: {e}"
            )

    # ── 3. Fallback: futures ticker ──
    futures_ticker = SPOT_FUTURES_MAP.get(symbol)
    if futures_ticker:
        logger.info(
            f"⚠️ {symbol} index spot unavailable, trying futures {futures_ticker}..."
        )
        try:
            fut = yf.Ticker(futures_ticker)
            hist = fut.history(period="1d")
            if hist is not None and not hist.empty:
                price = float(hist["Close"].iloc[-1])
                logger.warning(
                    f"💰 {symbol} spot from futures {futures_ticker}: ${price:.2f} "
                    f"(may not match index strike range!)"
                )
                return price
        except Exception as e:
            logger.warning(f"Could not fetch spot from {futures_ticker}: {e}")

    # ── 4. Last resort: the passed-in ticker object ──
    try:
        hist = ticker.history(period="1d")
        if hist is not None and not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception as e:
        logger.warning(f"Could not fetch spot price from history: {e}")

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
    oi_lookup: Optional[Dict[Tuple[str, float, str, str], int]] = None,
) -> Tuple[List[Dict[str, Any]], int, int]:
    """
    Extract strike, oi, volume from a single side (calls/puts) DataFrame.

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
    for _, row in df.iterrows():
        oi = int(row["openInterest"]) if pd.notna(row["openInterest"]) else 0
        vol = int(row["volume"]) if pd.notna(row["volume"]) else 0
        strike = round(float(row["strike"]), 2)
        gamma = float(row["gamma"]) if pd.notna(row.get("gamma")) else 0.0

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


def _score_and_rank(
    candidates: List[Dict[str, Any]], spot: float, top_n: int
) -> List[Dict[str, Any]]:
    """
    Apply cross-side penalty scoring using absolute values.
    
    Formula:
        own_activity = total_oi * 0.8 + total_vol * 0.2
        cross_activity = opp_oi * 0.8 + opp_vol * 0.2
        cross_ratio = cross_activity / (own_activity + cross_activity)  if total > 0
        score = own_activity * max(0, 1 - α × cross_ratio)
    
    This preserves absolute magnitude (a wall with 476K OI always scores
    much higher than one with 3 OI) while penalizing cross-side dominance.
    
    Returns candidates sorted by score descending.
    """
    if not candidates:
        return []

    for c in candidates:
        # Own side activity (absolute, weighted)
        own_activity = c["total_oi"] * SCORE_OI_WEIGHT + c["total_vol"] * SCORE_VOL_WEIGHT
        # Cross side activity (absolute, weighted)
        cross_activity = c["opp_oi"] * SCORE_OI_WEIGHT + c["opp_vol"] * SCORE_VOL_WEIGHT

        # Cross-side ratio: fraction of total activity that is cross-side
        total_activity = own_activity + cross_activity
        cross_ratio = cross_activity / total_activity if total_activity > 0 else 0

        # Score: own activity discounted by cross-side dominance
        # When cross_ratio → 0 (no cross side): score ≈ own_activity
        # When cross_ratio → 1 (cross dominates): score → own_activity × (1 - α)
        c["score"] = round(own_activity * max(0, 1 - CROSS_SIDE_ALPHA * cross_ratio), 2)

        # Distance from spot as percentage
        c["distance_pct"] = round((c["strike"] - spot) / spot * 100, 2)
        # List of expiry dates that contribute to this wall
        c["contributing_expiries"] = sorted(c["expiry_breakdown"].keys())

    # Filter out zero-score walls
    valid = [c for c in candidates if c["score"] > 0]
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
            norm_interests[i] * CONFLUENCE_INTEREST_WEIGHT
            + norm_ratios[i] * CONFLUENCE_RATIO_WEIGHT
            + norm_proximities[i] * CONFLUENCE_DISTANCE_WEIGHT,
            4,
        )
        c["contributing_expiries"] = sorted(c["expiry_breakdown"].keys())

    # Sort by score descending
    candidates.sort(key=lambda x: x["score"], reverse=True)
    return candidates


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

    # Sort by contract count descending (most contracts first)
    expiry_contract_counts.sort(key=lambda x: x[1], reverse=True)

    # Select top N by contract count
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
            chain["calls"], "CALL", symbol, exp_date, oi_lookup
        )
        puts, put_zeros, put_fbs = parse_chain_side(
            chain["puts"], "PUT", symbol, exp_date, oi_lookup
        )
        total_zero_oi += call_zeros + put_zeros
        total_fallbacks += call_fbs + put_fbs
        all_options = calls + puts

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

    # Find GEX flip point: strike where net GEX crosses from positive to negative
    gex_flip_point: Optional[float] = None
    sorted_gex_strikes = sorted(gex_by_strike.keys())
    for i in range(len(sorted_gex_strikes) - 1):
        s1, s2 = sorted_gex_strikes[i], sorted_gex_strikes[i + 1]
        g1, g2 = gex_by_strike[s1], gex_by_strike[s2]
        if g1 > 0 and g2 < 0:
            # Linear interpolation to find exact zero crossing
            gex_flip_point = round(s1 + (0 - g1) * (s2 - s1) / (g2 - g1), 2)
            break

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

    result = {
        "spot": spot,
        "generated": now_iso,
        "oi_fallback_used": oi_fallback_used,
        "total_net_gex": round(total_net_gex, 2),
        "gex_flip_point": gex_flip_point,
        "expiries": raw_expiries,
        "walls": {
            "put_walls": put_walls,
            "call_walls": call_walls,
            "confluence_levels": confluence_levels,
        },
    }

    logger.info(
        f"✅ {symbol}: {len(put_walls)} put walls, {len(call_walls)} call walls, "
        f"{len(confluence_levels)} confluence levels identified "
        f"(cross-side α={CROSS_SIDE_ALPHA})"
    )
    return result


def resolve_symbols(symbol_arg: str) -> List[str]:
    """Resolve the --symbol argument to a list of symbols to process."""
    if symbol_arg.upper() == "ALL":
        return list(ALL_SYMBOLS)
    return [symbol_arg.upper()]


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

    # Assemble top-level output (matches RawJson interface in vercelDataService.ts)
    now_iso = datetime.now(timezone.utc).isoformat()
    output = {
        "version": DATA_VERSION,
        "generated": now_iso,
        "symbols": symbols_data,
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
    logger.info(f"💾 Data saved to {output_path}")
    logger.info(
        f"📊 Summary: {len(symbols_data)} symbols, "
        f"{total_put} total put walls, {total_call} total call walls, "
        f"{total_confluence} total confluence levels"
    )


if __name__ == "__main__":
    main()
