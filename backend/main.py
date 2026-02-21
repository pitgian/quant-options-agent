#!/usr/bin/env python3
"""
FastAPI Backend for QUANT Smart Sweep
Provides on-demand options data fetching via REST API.
"""

import sys
import os
import logging
from datetime import datetime
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, asdict

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import yfinance as yf
import pandas as pd

# Add parent directory to path to import from scripts
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# FastAPI app
app = FastAPI(
    title="QUANT Smart Sweep API",
    description="On-demand options data fetching for resonance analysis",
    version="1.0.0"
)

# CORS configuration for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to your domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Supported symbols
SUPPORTED_SYMBOLS = {
    "SPY": "SPDR S&P 500 ETF",
    "QQQ": "Invesco QQQ Trust",
    "SPX": "S&P 500 Index",
    "NDX": "Nasdaq 100 Index",
}

# Symbol mapping for yfinance format
# Indices require ^ prefix in yfinance (e.g., ^SPX, ^NDX)
# ETFs are used as-is (SPY, QQQ)
SYMBOL_YFINANCE_MAP = {
    "SPY": "SPY",   # ETF - no change
    "QQQ": "QQQ",   # ETF - no change
    "SPX": "^SPX",  # S&P 500 Index - requires caret
    "NDX": "^NDX",  # Nasdaq 100 Index - requires caret
}


@dataclass
class OptionRow:
    """Represents a single option."""
    strike: float
    side: str  # CALL or PUT
    iv: float
    oi: int
    vol: int


@dataclass
class ExpiryData:
    """Data for a single expiry."""
    label: str  # 0DTE, WEEKLY, MONTHLY
    date: str
    options: List[Dict[str, Any]]


@dataclass
class OptionsDataset:
    """Complete dataset for a symbol."""
    symbol: str
    spot: float
    generated: str
    expiries: List[Dict[str, Any]]


def is_monthly(date_str: str) -> bool:
    """
    Check if a date corresponds to the third Friday of the month.
    Standard monthly options expire on the third Friday.
    """
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        return dt.weekday() == 4 and 15 <= dt.day <= 21
    except ValueError:
        return False


def get_spot_price(ticker: yf.Ticker) -> Optional[float]:
    """
    Get current spot price with multiple fallback methods.
    """
    try:
        # Method 1: fast_info (fastest)
        return float(ticker.fast_info['last_price'])
    except (KeyError, TypeError):
        pass
    
    try:
        # Method 2: history
        hist = ticker.history(period="1d")
        if not hist.empty:
            return float(hist['Close'].iloc[-1])
    except Exception:
        pass
    
    return None


def select_expirations(expirations: List[str]) -> List[tuple]:
    """
    Select 3 distinct expirations following the v13.0 logic:
    1. 0DTE - First available expiration
    2. WEEKLY - First expiration that's not 0DTE
    3. MONTHLY - First standard monthly expiration
    """
    if not expirations:
        return []
    
    selected = []
    used_dates = set()
    
    # 1. 0DTE - always the first
    selected.append(("0DTE", expirations[0]))
    used_dates.add(expirations[0])
    
    # 2. WEEKLY - first available different from 0DTE
    for exp in expirations[1:]:
        if exp not in used_dates:
            selected.append(("WEEKLY", exp))
            used_dates.add(exp)
            break
    
    # 3. MONTHLY - first monthly expiration not yet used
    for exp in expirations:
        if is_monthly(exp) and exp not in used_dates:
            selected.append(("MONTHLY", exp))
            used_dates.add(exp)
            break
    
    # If no monthly found, take next available
    if len(selected) < 3:
        for exp in expirations:
            if exp not in used_dates:
                selected.append(("EXTRA_EXP", exp))
                used_dates.add(exp)
                if len(selected) == 3:
                    break
    
    return selected


def fetch_options_chain(ticker: yf.Ticker, expiry_date: str, label: str) -> Optional[ExpiryData]:
    """
    Fetch and process a single option chain.
    """
    try:
        logger.info(f"  -> Fetching {label} ({expiry_date})...")
        chain = ticker.option_chain(expiry_date)
        
        options = []
        
        # Process CALLs
        for _, row in chain.calls.iterrows():
            options.append({
                "strike": round(float(row['strike']), 2),
                "side": "CALL",
                "iv": round(float(row['impliedVolatility']), 4),
                "oi": int(row['openInterest']) if pd.notna(row['openInterest']) else 0,
                "vol": int(row['volume']) if pd.notna(row['volume']) else 0
            })
        
        # Process PUTs
        for _, row in chain.puts.iterrows():
            options.append({
                "strike": round(float(row['strike']), 2),
                "side": "PUT",
                "iv": round(float(row['impliedVolatility']), 4),
                "oi": int(row['openInterest']) if pd.notna(row['openInterest']) else 0,
                "vol": int(row['volume']) if pd.notna(row['volume']) else 0
            })
        
        return ExpiryData(
            label=label,
            date=expiry_date,
            options=options
        )
        
    except Exception as e:
        logger.error(f"  ❌ Error on {label}: {e}")
        return None


def generate_legacy_content(dataset: OptionsDataset) -> Dict[str, Any]:
    """
    Generate legacy format content for compatibility with QuantPanel.
    """
    legacy_datasets = {}
    
    for expiry in dataset.expiries:
        lines = ["STRIKE | TIPO | IV | OI | VOL"]
        for opt in expiry['options']:
            lines.append(
                f"{opt['strike']:.2f} | {opt['side']} | {opt['iv']:.4f} | {opt['oi']} | {opt['vol']}"
            )
        content = "\n".join(lines)
        
        # Key in format "TYPE (DATE)"
        key = f"{expiry['label']} ({expiry['date']})"
        legacy_datasets[key] = {
            "content": content,
            "type": expiry['label'],
            "date": expiry['date']
        }
    
    return legacy_datasets


def fetch_symbol_data(symbol: str) -> Optional[Dict[str, Any]]:
    """
    Fetch all data for a single symbol.
    Returns a dictionary compatible with the frontend.
    """
    logger.info(f"\n{'='*50}")
    logger.info(f"  Processing: {symbol}")
    logger.info(f"{'='*50}")
    
    # Map symbol to yfinance format (indices need ^ prefix)
    fetch_symbol = SYMBOL_YFINANCE_MAP.get(symbol.upper(), symbol.upper())
    if fetch_symbol != symbol.upper():
        logger.info(f"  Using yfinance symbol: {symbol} -> {fetch_symbol}")
    
    try:
        ticker = yf.Ticker(fetch_symbol)
        
        # Get spot price
        logger.info("[1/3] Fetching spot price...")
        spot = get_spot_price(ticker)
        if spot is None:
            logger.error(f"❌ Cannot get spot price for {symbol}")
            return None
        logger.info(f"  -> Spot: {spot:.2f}")
        
        # Get available expirations
        logger.info("[2/3] Fetching expirations...")
        expirations = list(ticker.options)
        if not expirations:
            logger.error(f"❌ No options found for {symbol}")
            return None
        logger.info(f"  -> Found {len(expirations)} expirations")
        
        # Select 3 expirations
        selected = select_expirations(expirations)
        logger.info(f"  -> Selected: {[f'{l}({d})' for l, d in selected]}")
        
        # Download options chains
        logger.info("[3/3] Downloading options chains...")
        expiries = []
        for label, date in selected:
            data = fetch_options_chain(ticker, date, label)
            if data:
                expiries.append(asdict(data))
        
        if not expiries:
            logger.error(f"❌ No data downloaded for {symbol}")
            return None
        
        dataset = OptionsDataset(
            symbol=symbol.upper(),
            spot=round(spot, 2),
            generated=datetime.now().isoformat(),
            expiries=expiries
        )
        
        # Generate legacy format
        legacy = generate_legacy_content(dataset)
        
        return {
            "symbol": dataset.symbol,
            "spot": dataset.spot,
            "generated": dataset.generated,
            "expiries": dataset.expiries,
            "legacy": legacy
        }
        
    except Exception as e:
        logger.error(f"❌ General error for {symbol}: {e}")
        return None


@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "service": "QUANT Smart Sweep API"
    }


@app.get("/api/symbols")
async def get_supported_symbols():
    """Get list of supported symbols."""
    return {
        "symbols": [
            {"symbol": sym, "description": desc, "yfinance_symbol": SYMBOL_YFINANCE_MAP.get(sym, sym)}
            for sym, desc in SUPPORTED_SYMBOLS.items()
        ]
    }


@app.get("/api/fetch")
async def fetch_options(
    symbol: str = Query(default="SPY", description="Symbol to fetch (SPY, QQQ, SPX, NDX)")
):
    """
    Fetch options data for a specific symbol.
    
    - **symbol**: One of SPY, QQQ, SPX, NDX
    
    Returns JSON with options data in the format expected by the frontend.
    """
    symbol = symbol.upper()
    
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported symbol: {symbol}. Supported: {list(SUPPORTED_SYMBOLS.keys())}"
        )
    
    try:
        data = fetch_symbol_data(symbol)
        
        if data is None:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to fetch data for {symbol}. Please try again later."
            )
        
        # Return in the format expected by the frontend
        return {
            "version": "2.0",
            "generated": data["generated"],
            "metadata": {
                "timestamp": data["generated"],
                "symbol": data["symbol"],
                "source": "yfinance_api"
            },
            "symbols": {
                data["symbol"]: {
                    "spot": data["spot"],
                    "generated": data["generated"],
                    "expiries": data["expiries"],
                    "legacy": data["legacy"]
                }
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {str(e)}"
        )


@app.get("/api/fetch-multiple")
async def fetch_multiple_options(
    symbols: str = Query(default="SPY,QQQ", description="Comma-separated symbols")
):
    """
    Fetch options data for multiple symbols.
    
    - **symbols**: Comma-separated list (e.g., "SPY,QQQ")
    
    Returns combined JSON with data for all requested symbols.
    """
    symbol_list = [s.strip().upper() for s in symbols.split(",")]
    
    # Validate all symbols
    invalid = [s for s in symbol_list if s not in SUPPORTED_SYMBOLS]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported symbols: {invalid}. Supported: {list(SUPPORTED_SYMBOLS.keys())}"
        )
    
    results = {}
    errors = []
    generated = datetime.now().isoformat()
    
    for symbol in symbol_list:
        data = fetch_symbol_data(symbol)
        if data:
            results[data["symbol"]] = {
                "spot": data["spot"],
                "generated": data["generated"],
                "expiries": data["expiries"],
                "legacy": data["legacy"]
            }
        else:
            errors.append(symbol)
    
    if not results:
        raise HTTPException(
            status_code=500,
            detail="Failed to fetch data for any symbol. Please try again later."
        )
    
    return {
        "version": "2.0",
        "generated": generated,
        "metadata": {
            "timestamp": generated,
            "source": "yfinance_api",
            "errors": errors if errors else None
        },
        "symbols": results
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
