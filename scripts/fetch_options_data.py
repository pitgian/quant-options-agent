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
MAX_EXPIRATIONS = 12
TOP_N_WALLS = 12
MIN_COMBINED_OI_VOL = 100  # filter out strikes with very low activity
SCORE_OI_WEIGHT = 0.6
SCORE_VOL_WEIGHT = 0.4
INTER_SYMBOL_DELAY = 2  # seconds between symbols to avoid rate limiting

# Symbols processed when --symbol ALL is used
ALL_SYMBOLS = ["SPY", "QQQ", "SPX", "NDX"]

# ---------------------------------------------------------------------------
# Symbol mapping
# ---------------------------------------------------------------------------
# Maps our canonical symbol name to the yfinance ticker used for options chains.
# For indices (SPX, NDX) the spot price is fetched from futures instead.
SYMBOL_YFINANCE_MAP = {
    "SPY": "SPY",
    "QQQ": "QQQ",
    "SPX": "^SPX",
    "NDX": "^NDX",
}

# Spot price fallback: indices don't trade directly, use futures
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
# Data fetching
# ---------------------------------------------------------------------------

def get_spot_price(symbol: str, ticker: yf.Ticker) -> Optional[float]:
    """
    Return the last traded price for *symbol*.

    For SPX and NDX, fetch from futures (ES=F, NQ=F) since the index
    ticker itself may not return reliable pricing.
    """
    # For indices, try futures first
    futures_ticker = SPOT_FUTURES_MAP.get(symbol)
    if futures_ticker:
        try:
            fut = yf.Ticker(futures_ticker)
            hist = fut.history(period="1d")
            if hist is not None and not hist.empty:
                price = float(hist["Close"].iloc[-1])
                logger.info(f"💰 {symbol} spot from {futures_ticker}: ${price:.2f}")
                return price
        except Exception as e:
            logger.warning(f"Could not fetch spot from {futures_ticker}: {e}")

    # Standard approach: history from the ticker itself
    try:
        hist = ticker.history(period="1d")
        if hist is not None and not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception as e:
        logger.warning(f"Could not fetch spot price from history: {e}")

    # Fallback: fast_info
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


def parse_chain_side(df: pd.DataFrame, side: str) -> List[Dict[str, Any]]:
    """Extract strike, oi, volume from a single side (calls/puts) DataFrame."""
    rows = []
    for _, row in df.iterrows():
        oi = int(row["openInterest"]) if pd.notna(row["openInterest"]) else 0
        vol = int(row["volume"]) if pd.notna(row["volume"]) else 0
        rows.append(
            {
                "strike": round(float(row["strike"]), 2),
                "side": side,
                "oi": oi,
                "vol": vol,
            }
        )
    return rows


# ---------------------------------------------------------------------------
# Wall calculation
# ---------------------------------------------------------------------------

def calculate_walls(
    all_options_by_expiry: List[Dict[str, Any]],
    spot: float,
    top_n: int = TOP_N_WALLS,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Aggregate OI and Volume per strike across all expirations, compute a
    combined score, and return the top put walls and call walls.

    Each expiry dict: {"date": str, "options": [{"strike", "side", "oi", "vol"}, ...]}

    Returns:
        (put_walls, call_walls) – each a list of wall dicts sorted by score desc.
    """
    # Accumulate per-strike, per-side data with per-expiry breakdown
    strike_data: Dict[float, Dict[str, Dict[str, Dict[str, int]]]] = {}

    for expiry_info in all_options_by_expiry:
        expiry_date = expiry_info["date"]
        for opt in expiry_info["options"]:
            strike = opt["strike"]
            side_key = "put" if opt["side"] == "PUT" else "call"
            oi = opt.get("oi", 0)
            vol = opt.get("vol", 0)

            if strike not in strike_data:
                strike_data[strike] = {"put": {}, "call": {}}
            strike_data[strike][side_key][expiry_date] = {
                "oi": oi,
                "vol": vol,
            }

    # Build candidate lists for puts and calls
    put_candidates = []
    call_candidates = []

    for strike, sides in strike_data.items():
        # --- PUT side ---
        put_total_oi = sum(e["oi"] for e in sides["put"].values())
        put_total_vol = sum(e["vol"] for e in sides["put"].values())
        if put_total_oi + put_total_vol >= MIN_COMBINED_OI_VOL and strike < spot:
            put_candidates.append(
                {
                    "strike": strike,
                    "total_oi": put_total_oi,
                    "total_vol": put_total_vol,
                    "expiry_breakdown": sides["put"],
                    "type": "put",
                }
            )

        # --- CALL side ---
        call_total_oi = sum(e["oi"] for e in sides["call"].values())
        call_total_vol = sum(e["vol"] for e in sides["call"].values())
        if call_total_oi + call_total_vol >= MIN_COMBINED_OI_VOL and strike > spot:
            call_candidates.append(
                {
                    "strike": strike,
                    "total_oi": call_total_oi,
                    "total_vol": call_total_vol,
                    "expiry_breakdown": sides["call"],
                    "type": "call",
                }
            )

    # Score and rank
    put_walls = _score_and_rank(put_candidates, spot, top_n)
    call_walls = _score_and_rank(call_candidates, spot, top_n)

    return put_walls, call_walls


def _score_and_rank(
    candidates: List[Dict[str, Any]], spot: float, top_n: int
) -> List[Dict[str, Any]]:
    """Apply min-max normalization + weighted score, return top *top_n*."""
    if not candidates:
        return []

    oi_values = [c["total_oi"] for c in candidates]
    vol_values = [c["total_vol"] for c in candidates]

    oi_norm = min_max_normalize(oi_values)
    vol_norm = min_max_normalize(vol_values)

    for i, c in enumerate(candidates):
        c["score"] = round(
            oi_norm[i] * SCORE_OI_WEIGHT + vol_norm[i] * SCORE_VOL_WEIGHT, 6
        )
        # Distance from spot as percentage
        c["distance_pct"] = round((c["strike"] - spot) / spot * 100, 2)
        # List of expiry dates that contribute to this wall
        c["contributing_expiries"] = sorted(c["expiry_breakdown"].keys())

    candidates.sort(key=lambda x: x["score"], reverse=True)
    return candidates[:top_n]


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def fetch_symbol_data(symbol: str) -> Optional[Dict[str, Any]]:
    """
    Full pipeline for a single symbol:
      1. Resolve yfinance ticker symbol
      2. Fetch spot price
      3. Fetch option chains for all available expirations (up to MAX_EXPIRATIONS)
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

    selected_expirations = list(expirations[:MAX_EXPIRATIONS])
    logger.info(
        f"📅 Using {len(selected_expirations)} of {len(expirations)} available expirations"
    )

    # 3. Fetch each chain and build both raw expiry data and aggregated options
    raw_expiries: List[Dict[str, Any]] = []
    all_options_by_expiry: List[Dict[str, Any]] = []

    for exp_date in selected_expirations:
        chain = fetch_options_chain(ticker, exp_date)
        if chain is None:
            logger.warning(f"⚠️ Skipping {exp_date} (fetch failed)")
            continue

        calls = parse_chain_side(chain["calls"], "CALL")
        puts = parse_chain_side(chain["puts"], "PUT")
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
        logger.info(f"  ✅ {exp_date}: {len(all_options)} contracts")

    if not all_options_by_expiry:
        logger.error(f"❌ No option data fetched for {symbol}")
        return None

    # 4. Calculate walls
    put_walls_raw, call_walls_raw = calculate_walls(all_options_by_expiry, spot)

    # 5. Build wall structures (snake_case to match RawWall interface in vercelDataService.ts)
    put_walls = [
        {
            "strike": w["strike"],
            "type": w["type"],
            "total_oi": w["total_oi"],
            "total_vol": w["total_vol"],
            "score": round(w["score"] * 100, 1),
            "contributing_expiries": w["contributing_expiries"],
            "distance_pct": w["distance_pct"],
        }
        for w in put_walls_raw
    ]

    call_walls = [
        {
            "strike": w["strike"],
            "type": w["type"],
            "total_oi": w["total_oi"],
            "total_vol": w["total_vol"],
            "score": round(w["score"] * 100, 1),
            "contributing_expiries": w["contributing_expiries"],
            "distance_pct": w["distance_pct"],
        }
        for w in call_walls_raw
    ]

    # 6. Assemble per-symbol output (matches RawSymbolData interface)
    now_iso = datetime.now(timezone.utc).isoformat()

    result = {
        "spot": spot,
        "generated": now_iso,
        "expiries": raw_expiries,
        "walls": {
            "put_walls": put_walls,
            "call_walls": call_walls,
        },
    }

    logger.info(
        f"✅ {symbol}: {len(put_walls)} put walls, {len(call_walls)} call walls identified"
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
    args = parser.parse_args()

    symbols = resolve_symbols(args.symbol)
    output_path = Path(args.output)

    logger.info(f"🚀 Starting Options Wall Analyzer for: {', '.join(symbols)}")

    # Process each symbol
    symbols_data: Dict[str, Any] = {}
    failed_symbols: List[str] = []

    for i, symbol in enumerate(symbols):
        try:
            data = fetch_symbol_data(symbol)
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
    logger.info(f"💾 Data saved to {output_path}")
    logger.info(
        f"📊 Summary: {len(symbols_data)} symbols, "
        f"{total_put} total put walls, {total_call} total call walls"
    )


if __name__ == "__main__":
    main()
