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

    # Build candidate lists for puts and calls
    put_candidates = []
    call_candidates = []

    for strike, sides in strike_data.items():
        # --- PUT side (weighted) ---
        put_total_oi = sum(e["oi"] * expiry_weights_put.get(exp, 1.0) for exp, e in sides["put"].items())
        put_total_vol = sum(e["vol"] * expiry_weights_put.get(exp, 1.0) for exp, e in sides["put"].items())
        if put_total_oi + put_total_vol >= MIN_COMBINED_OI_VOL and strike < spot:
            put_expiry_breakdown = {
                exp: {**data, "weight": round(expiry_weights_put.get(exp, 1.0), 3)}
                for exp, data in sides["put"].items()
            }
            put_candidates.append(
                {
                    "strike": strike,
                    "total_oi": put_total_oi,
                    "total_vol": put_total_vol,
                    "expiry_breakdown": put_expiry_breakdown,
                    "type": "put",
                }
            )

        # --- Call side (weighted) ---
        call_total_oi = sum(e["oi"] * expiry_weights_call.get(exp, 1.0) for exp, e in sides["call"].items())
        call_total_vol = sum(e["vol"] * expiry_weights_call.get(exp, 1.0) for exp, e in sides["call"].items())
        if call_total_oi + call_total_vol >= MIN_COMBINED_OI_VOL and strike > spot:
            call_expiry_breakdown = {
                exp: {**data, "weight": round(expiry_weights_call.get(exp, 1.0), 3)}
                for exp, data in sides["call"].items()
            }
            call_candidates.append(
                {
                    "strike": strike,
                    "total_oi": call_total_oi,
                    "total_vol": call_total_vol,
                    "expiry_breakdown": call_expiry_breakdown,
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

    # 5. Calculate walls
    put_walls_raw, call_walls_raw = calculate_walls(all_options_by_expiry, spot)

    # 6. Build wall structures (snake_case to match RawWall interface in vercelDataService.ts)
    put_walls = [
        {
            "strike": w["strike"],
            "type": w["type"],
            "total_oi": w["total_oi"],
            "total_vol": w["total_vol"],
            "score": round(w["score"] * 100, 1),
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
            "score": round(w["score"] * 100, 1),
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
    logger.info(f"💾 Data saved to {output_path}")
    logger.info(
        f"📊 Summary: {len(symbols_data)} symbols, "
        f"{total_put} total put walls, {total_call} total call walls"
    )


if __name__ == "__main__":
    main()
