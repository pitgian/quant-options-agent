#!/usr/bin/env python3
"""
Local FastAPI server for fetching options data using yfinance.
This server is designed to be spawned automatically by the frontend
during local development.

Usage:
    python scripts/local_server.py [--port PORT]

Default port: 8765
"""

import yfinance as yf
import asyncio
import argparse
import logging
import sys
import os
import math
from datetime import datetime
from typing import Optional, Dict, List, Any, Tuple
from dataclasses import dataclass, asdict
from pathlib import Path
from scipy.stats import norm

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Symbol mapping for yfinance format
# Indices require ^ prefix in yfinance (e.g., ^SPX, ^NDX)
# ETFs are used as-is (SPY, QQQ)
SYMBOL_MAP: Dict[str, str] = {
    'SPY': 'SPY',   # ETF - no change
    'QQQ': 'QQQ',   # ETF - no change
    'SPX': '^SPX',  # S&P 500 Index - requires caret
    'NDX': '^NDX',  # Nasdaq 100 Index - requires caret
}

# Rate limiting configuration
RATE_LIMIT_DELAY = 1.5  # seconds between API calls for multiple expiries
MAX_RETRIES = 3

app = FastAPI(
    title="Local Options Data Server",
    description="FastAPI server that fetches options data using yfinance",
    version="2.0.0"
)

# Add CORS middleware to allow frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for local development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Pydantic models for response format (new multi-expiry format)
class OptionContract(BaseModel):
    strike: float
    lastPrice: float
    bid: float
    ask: float
    volume: Optional[int]
    openInterest: Optional[int]
    impliedVolatility: float
    inTheMoney: bool


class GammaWall(BaseModel):
    strike: float
    gamma: float


class GEXData(BaseModel):
    """Gamma exposure data per strike."""
    strike: float
    gex: float  # in billions
    cumulative_gex: float


class VolOIAnalysis(BaseModel):
    """Volume/Open Interest analysis for unusual activity."""
    call_vol_oi_ratio: float
    put_vol_oi_ratio: float
    call_unusual_activity: bool
    put_unusual_activity: bool


class PutCallRatios(BaseModel):
    """Multiple PCR variants."""
    oi_based: float
    volume_based: float
    weighted: float
    delta_adjusted: float


class VolatilitySkew(BaseModel):
    """Volatility skew analysis."""
    put_iv_avg: float
    call_iv_avg: float
    skew_ratio: float
    skew_type: str  # 'smirk', 'reverse_smirk', 'flat'
    sentiment: str  # 'bearish', 'bullish', 'neutral'


class QuantMetrics(BaseModel):
    """Quantitative metrics for options analysis."""
    gamma_flip: float
    total_gex: float
    max_pain: float
    put_call_ratios: PutCallRatios
    volatility_skew: VolatilitySkew
    gex_by_strike: List[GEXData] = []


class ExpiryData(BaseModel):
    """Data for a single expiry."""
    expiryDate: str
    label: str  # 0DTE, WEEKLY, MONTHLY
    calls: List[OptionContract]
    puts: List[OptionContract]
    gammaFlip: Optional[float] = None
    callWalls: List[GammaWall] = []
    putWalls: List[GammaWall] = []
    quantMetrics: Optional[QuantMetrics] = None


class MultiExpiryOptionsResponse(BaseModel):
    """Response format with multiple expiries."""
    symbol: str
    currentPrice: float
    expiries: List[ExpiryData]
    availableExpirations: List[str]
    timestamp: str


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    python_version: str


def is_friday(date_str: str) -> bool:
    """Check if date is a Friday"""
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        return dt.weekday() == 4
    except ValueError:
        return False


def is_monthly(date_str: str) -> bool:
    """Check if date is third Friday of the month (monthly expiry)"""
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        return dt.weekday() == 4 and 15 <= dt.day <= 21
    except ValueError:
        return False


def is_weekly_friday(date_str: str) -> bool:
    """Check if date is a Friday but NOT monthly (third Friday)"""
    return is_friday(date_str) and not is_monthly(date_str)


def select_expirations(expirations: List[str]) -> List[Tuple[str, str]]:
    """
    Select 3 distinct expirations following standard options expiry rules:
    1. 0DTE - First available expiration
    2. WEEKLY - Next Friday that is NOT the third Friday (monthly)
    3. MONTHLY - Third Friday of the month (day 15-21, weekday=4)
    
    Returns list of (label, date) tuples.
    """
    if not expirations:
        return []
    
    selected = []
    used_dates = set()
    
    # 1. 0DTE - always the first
    selected.append(("0DTE", expirations[0]))
    used_dates.add(expirations[0])
    
    # 2. WEEKLY - Next Friday that is NOT the monthly (third Friday)
    for exp in expirations:
        if exp not in used_dates and is_weekly_friday(exp):
            selected.append(("WEEKLY", exp))
            used_dates.add(exp)
            break
    
    # 3. MONTHLY - First third Friday not yet used
    for exp in expirations:
        if exp not in used_dates and is_monthly(exp):
            selected.append(("MONTHLY", exp))
            used_dates.add(exp)
            break
    
    # Fallback: If no weekly Friday found, use next Friday after 0DTE
    if len(selected) < 2:
        for exp in expirations:
            if exp not in used_dates and is_friday(exp):
                selected.insert(1, ("WEEKLY", exp))
                used_dates.add(exp)
                break
    
    # Fallback: If no monthly found, use any Friday after weekly
    if len(selected) < 3:
        for exp in expirations:
            if exp not in used_dates:
                selected.append(("MONTHLY", exp))
                break
    
    return selected


def get_spot_price(ticker: yf.Ticker) -> Optional[float]:
    """
    Get the current spot price with multiple fallback methods.
    """
    try:
        # Method 1: fast_info (fastest)
        return float(ticker.fast_info['last_price'])
    except (KeyError, TypeError, IndexError):
        pass
    
    try:
        # Method 2: history
        hist = ticker.history(period="1d")
        if not hist.empty:
            return float(hist['Close'].iloc[-1])
    except Exception:
        pass
    
    return None


def safe_int(value) -> Optional[int]:
    """Safely convert value to int, returning None for NaN/null values."""
    if value is None:
        return None
    try:
        if isinstance(value, float) and math.isnan(value):
            return None
        return int(value)
    except (ValueError, TypeError):
        return None


def safe_float(value, default=0.0) -> float:
    """Safely convert value to float, returning default for NaN/null values."""
    if value is None:
        return default
    try:
        result = float(value)
        if math.isnan(result):
            return default
        return result
    except (ValueError, TypeError):
        return default


# ============================================================================
# QUANTITATIVE ANALYSIS FUNCTIONS
# ============================================================================

def calculate_black_scholes_gamma(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """
    Calculate Black-Scholes gamma.
    
    Args:
        S: Spot price
        K: Strike price
        T: Time to expiration in years
        r: Risk-free rate
        sigma: Implied volatility
    
    Returns:
        Gamma value
    """
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return 0.0
    try:
        d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
        return norm.pdf(d1) / (S * sigma * math.sqrt(T))
    except (ValueError, ZeroDivisionError):
        return 0.0


def calculate_gex_per_strike(strike: float, call_oi: float, put_oi: float,
                              spot: float, T: float, r: float,
                              call_iv: float, put_iv: float) -> float:
    """
    Calculate gamma exposure for a single strike in $ billions.
    
    Dealer gamma is long calls, short puts (typically).
    """
    call_gamma = calculate_black_scholes_gamma(spot, strike, T, r, call_iv) if call_iv > 0 else 0
    put_gamma = calculate_black_scholes_gamma(spot, strike, T, r, put_iv) if put_iv > 0 else 0
    
    # Dealer gamma is long calls, short puts (typically)
    call_gex = call_gamma * call_oi * 100 * spot * spot * 0.01
    put_gex = -put_gamma * put_oi * 100 * spot * spot * 0.01  # Negative for puts
    
    return (call_gex + put_gex) / 1e9  # Convert to billions


def find_gamma_flip_strike(strikes_data: List[Dict], spot: float, T: float, r: float) -> Tuple[float, List[GEXData]]:
    """
    Find the strike where cumulative GEX flips from positive to negative.
    
    Returns:
        Tuple of (gamma_flip_strike, list of GEX data by strike)
    """
    cumulative_gex = 0
    gex_by_strike = []
    
    for strike_data in sorted(strikes_data, key=lambda x: x['strike']):
        gex = calculate_gex_per_strike(
            strike_data['strike'],
            strike_data.get('call_oi', 0),
            strike_data.get('put_oi', 0),
            spot, T, r,
            strike_data.get('call_iv', 0.3),
            strike_data.get('put_iv', 0.3)
        )
        cumulative_gex += gex
        gex_by_strike.append(GEXData(
            strike=strike_data['strike'],
            gex=round(gex, 6),
            cumulative_gex=round(cumulative_gex, 6)
        ))
    
    # Find flip point
    gamma_flip = spot  # Default to spot
    for i, gex_data in enumerate(gex_by_strike):
        if i > 0 and gex_by_strike[i-1].cumulative_gex * gex_data.cumulative_gex < 0:
            gamma_flip = gex_data.strike
            break
    
    return gamma_flip, gex_by_strike


def calculate_max_pain(strikes_data: List[Dict], spot: float) -> float:
    """
    Calculate max pain - strike where total option value is minimized.
    
    This is the price at which option holders (buyers) have the most loss,
    and option writers (sellers) have the most gain.
    """
    if not strikes_data:
        return spot
    
    min_value = float('inf')
    max_pain = spot
    
    test_strikes = [s['strike'] for s in strikes_data]
    
    for test_strike in test_strikes:
        total_value = 0
        for s in strikes_data:
            # Call value at expiration = max(0, test_strike - strike) * call_oi
            call_value = max(0, test_strike - s['strike']) * s.get('call_oi', 0)
            # Put value at expiration = max(0, strike - test_strike) * put_oi
            put_value = max(0, s['strike'] - test_strike) * s.get('put_oi', 0)
            total_value += (call_value + put_value) * 100  # Contract multiplier
        
        if total_value < min_value:
            min_value = total_value
            max_pain = test_strike
    
    return max_pain


def analyze_volume_oi_ratio(strikes_data: List[Dict]) -> List[VolOIAnalysis]:
    """
    Analyze Volume/OI ratio for unusual activity detection.
    
    A ratio > 1.5 is considered unusual (more volume than existing open interest).
    """
    analyses = []
    for strike_data in strikes_data:
        call_oi = strike_data.get('call_oi', 0)
        put_oi = strike_data.get('put_oi', 0)
        call_vol = strike_data.get('call_volume', 0)
        put_vol = strike_data.get('put_volume', 0)
        
        # Calculate ratios (handle division by zero)
        call_vol_oi_ratio = call_vol / call_oi if call_oi > 0 else 0.0
        put_vol_oi_ratio = put_vol / put_oi if put_oi > 0 else 0.0
        
        # Flag unusual activity (>1.5 is considered unusual)
        call_unusual = call_vol_oi_ratio > 1.5
        put_unusual = put_vol_oi_ratio > 1.5
        
        analyses.append(VolOIAnalysis(
            call_vol_oi_ratio=round(call_vol_oi_ratio, 2),
            put_vol_oi_ratio=round(put_vol_oi_ratio, 2),
            call_unusual_activity=call_unusual,
            put_unusual_activity=put_unusual
        ))
    
    return analyses


def calculate_weighted_pcr(strikes_data: List[Dict]) -> float:
    """Volume-weighted Put/Call Ratio."""
    weighted_put = sum(s.get('put_oi', 0) * s.get('put_volume', 1) for s in strikes_data)
    weighted_call = sum(s.get('call_oi', 0) * s.get('call_volume', 1) for s in strikes_data)
    return weighted_put / weighted_call if weighted_call > 0 else 0.0


def calculate_delta_adjusted_pcr(strikes_data: List[Dict], spot: float) -> float:
    """Delta-adjusted PCR using moneyness approximation."""
    # OTM puts have strikes below spot
    total_put_delta = sum(
        min(1, s.get('put_oi', 0) / 1000)
        for s in strikes_data
        if s.get('strike', 0) < spot
    )
    # OTM calls have strikes above spot
    total_call_delta = sum(
        min(1, s.get('call_oi', 0) / 1000)
        for s in strikes_data
        if s.get('strike', 0) > spot
    )
    return total_put_delta / total_call_delta if total_call_delta > 0 else 0.0


def calculate_put_call_ratios(strikes_data: List[Dict], spot: float) -> PutCallRatios:
    """Calculate multiple PCR variants for comprehensive analysis."""
    total_call_oi = sum(s.get('call_oi', 0) for s in strikes_data)
    total_put_oi = sum(s.get('put_oi', 0) for s in strikes_data)
    total_call_vol = sum(s.get('call_volume', 0) for s in strikes_data)
    total_put_vol = sum(s.get('put_volume', 0) for s in strikes_data)
    
    return PutCallRatios(
        oi_based=round(total_put_oi / total_call_oi, 3) if total_call_oi > 0 else 0.0,
        volume_based=round(total_put_vol / total_call_vol, 3) if total_call_vol > 0 else 0.0,
        weighted=round(calculate_weighted_pcr(strikes_data), 3),
        delta_adjusted=round(calculate_delta_adjusted_pcr(strikes_data, spot), 3)
    )


def analyze_volatility_skew(strikes_data: List[Dict], spot: float) -> VolatilitySkew:
    """
    Analyze IV skew for sentiment indication.
    
    - Smirk (put skew): Fear - puts more expensive, bearish sentiment
    - Reverse smirk (call skew): Calls more expensive, bullish sentiment
    - Flat: Balanced market
    """
    # OTM puts: strikes below 95% of spot
    otm_puts = [s for s in strikes_data if s['strike'] < spot * 0.95]
    # OTM calls: strikes above 105% of spot
    otm_calls = [s for s in strikes_data if s['strike'] > spot * 1.05]
    
    avg_put_iv = sum(s.get('put_iv', 0) for s in otm_puts) / len(otm_puts) if otm_puts else 0.0
    avg_call_iv = sum(s.get('call_iv', 0) for s in otm_calls) / len(otm_calls) if otm_calls else 0.0
    
    skew_ratio = avg_put_iv / avg_call_iv if avg_call_iv > 0 else 1.0
    
    # Classify skew
    if skew_ratio > 1.2:
        skew_type = "smirk"  # Fear - puts more expensive
        sentiment = "bearish"
    elif skew_ratio < 0.9:
        skew_type = "reverse_smirk"  # Calls more expensive
        sentiment = "bullish"
    else:
        skew_type = "flat"  # Balanced
        sentiment = "neutral"
    
    return VolatilitySkew(
        put_iv_avg=round(avg_put_iv, 4),
        call_iv_avg=round(avg_call_iv, 4),
        skew_ratio=round(skew_ratio, 3),
        skew_type=skew_type,
        sentiment=sentiment
    )


def calculate_quant_metrics(calls: List[OptionContract], puts: List[OptionContract],
                            spot: float, expiry_date: str) -> QuantMetrics:
    """
    Calculate all quantitative metrics for an expiry.
    
    Args:
        calls: List of call option contracts
        puts: List of put option contracts
        spot: Current spot price
        expiry_date: Expiration date string (YYYY-MM-DD)
    
    Returns:
        QuantMetrics object with all calculated metrics
    """
    # Calculate time to expiration in years
    try:
        expiry_dt = datetime.strptime(expiry_date, '%Y-%m-%d')
        now = datetime.now()
        T = max((expiry_dt - now).days / 365.0, 0.0001)  # Minimum 1 day for calculations
    except ValueError:
        T = 0.01  # Default to ~3.5 days
    
    r = 0.05  # Risk-free rate assumption (5%)
    
    # Build strikes data structure
    strikes_map: Dict[float, Dict] = {}
    
    for call in calls:
        if call.strike not in strikes_map:
            strikes_map[call.strike] = {'strike': call.strike}
        strikes_map[call.strike]['call_oi'] = call.openInterest or 0
        strikes_map[call.strike]['call_volume'] = call.volume or 0
        strikes_map[call.strike]['call_iv'] = call.impliedVolatility
    
    for put in puts:
        if put.strike not in strikes_map:
            strikes_map[put.strike] = {'strike': put.strike}
        strikes_map[put.strike]['put_oi'] = put.openInterest or 0
        strikes_map[put.strike]['put_volume'] = put.volume or 0
        strikes_map[put.strike]['put_iv'] = put.impliedVolatility
    
    strikes_data = list(strikes_map.values())
    
    # Calculate GEX and gamma flip
    gamma_flip, gex_by_strike = find_gamma_flip_strike(strikes_data, spot, T, r)
    
    # Calculate total GEX
    total_gex = sum(g.gex for g in gex_by_strike)
    
    # Calculate max pain
    max_pain = calculate_max_pain(strikes_data, spot)
    
    # Calculate put/call ratios
    put_call_ratios = calculate_put_call_ratios(strikes_data, spot)
    
    # Analyze volatility skew
    volatility_skew = analyze_volatility_skew(strikes_data, spot)
    
    return QuantMetrics(
        gamma_flip=round(gamma_flip, 2),
        total_gex=round(total_gex, 4),
        max_pain=round(max_pain, 2),
        put_call_ratios=put_call_ratios,
        volatility_skew=volatility_skew,
        gex_by_strike=gex_by_strike[:50]  # Limit to 50 strikes for response size
    )


# ============================================================================
# END QUANTITATIVE ANALYSIS FUNCTIONS
# ============================================================================


def process_option_chain(chain, side: str, current_price: float) -> List[OptionContract]:
    """
    Process option chain data and return list of OptionContract.
    """
    options = []
    df = chain.calls if side == "CALL" else chain.puts
    
    if df is None or df.empty:
        return options
    
    for _, row in df.iterrows():
        strike = safe_float(row.get('strike', 0))
        options.append(OptionContract(
            strike=strike,
            lastPrice=safe_float(row.get('lastPrice', 0)),
            bid=safe_float(row.get('bid', 0)),
            ask=safe_float(row.get('ask', 0)),
            volume=safe_int(row.get('volume')),
            openInterest=safe_int(row.get('openInterest')),
            impliedVolatility=safe_float(row.get('impliedVolatility', 0)),
            inTheMoney=bool(row.get('inTheMoney', False))
        ))
    
    return options


def calculate_gamma_exposure(options: List[OptionContract], side: str, current_price: float) -> Tuple[Optional[float], List[GammaWall], List[GammaWall]]:
    """
    Calculate gamma flip point and identify gamma walls.
    
    Returns: (gamma_flip, call_walls, put_walls)
    """
    if not options:
        return None, [], []
    
    # Group by strike and sum open interest
    strike_oi: Dict[float, float] = {}
    for opt in options:
        if opt.strike not in strike_oi:
            strike_oi[opt.strike] = 0
        # Weight by proximity to current price for gamma estimation
        distance = abs(opt.strike - current_price)
        weight = 1.0 / (1.0 + distance / current_price) if current_price > 0 else 1.0
        oi = opt.openInterest if opt.openInterest else 0
        strike_oi[opt.strike] += oi * weight
    
    # Find call walls (strikes with highest OI above current price)
    call_strikes = [(s, oi) for s, oi in strike_oi.items() if s >= current_price]
    call_strikes.sort(key=lambda x: x[1], reverse=True)
    call_walls = [GammaWall(strike=s, gamma=oi) for s, oi in call_strikes[:3]]
    
    # Find put walls (strikes with highest OI below current price)
    put_strikes = [(s, oi) for s, oi in strike_oi.items() if s < current_price]
    put_strikes.sort(key=lambda x: x[1], reverse=True)
    put_walls = [GammaWall(strike=s, gamma=oi) for s, oi in put_strikes[:3]]
    
    # Estimate gamma flip as the strike where call OI ≈ put OI
    total_call_oi = sum(oi for s, oi in strike_oi.items() if s >= current_price)
    total_put_oi = sum(oi for s, oi in strike_oi.items() if s < current_price)
    
    if total_call_oi + total_put_oi > 0:
        # Simple estimation: weighted average of strikes
        call_weighted = sum(s * oi for s, oi in strike_oi.items() if s >= current_price)
        put_weighted = sum(s * oi for s, oi in strike_oi.items() if s < current_price)
        
        if total_call_oi > 0 and total_put_oi > 0:
            gamma_flip = (call_weighted + put_weighted) / (total_call_oi + total_put_oi)
        elif total_call_oi > 0:
            gamma_flip = call_weighted / total_call_oi
        elif total_put_oi > 0:
            gamma_flip = put_weighted / total_put_oi
        else:
            gamma_flip = current_price
        
        return round(gamma_flip, 2), call_walls, put_walls
    
    return current_price, call_walls, put_walls


async def fetch_with_retry(fn, retries=MAX_RETRIES, delay=RATE_LIMIT_DELAY):
    """
    Retry wrapper with exponential backoff for rate limiting.
    """
    last_error = None
    for attempt in range(retries):
        try:
            return await fn() if asyncio.iscoroutinefunction(fn) else fn()
        except Exception as e:
            error_str = str(e).lower()
            is_rate_limited = '429' in error_str or 'too many requests' in error_str or 'crumb' in error_str
            
            if is_rate_limited and attempt < retries - 1:
                wait_time = delay * (2 ** attempt)
                logger.warning(f"Rate limited, retrying in {wait_time}s... ({retries - attempt - 1} retries left)")
                await asyncio.sleep(wait_time)
                last_error = e
            else:
                raise e
    
    raise last_error


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Health check endpoint to verify the server is running.
    """
    return HealthResponse(
        status="healthy",
        timestamp=datetime.now().isoformat(),
        python_version=sys.version
    )


@app.get("/options/{symbol}", response_model=MultiExpiryOptionsResponse)
async def get_options(
    symbol: str,
    expiry: Optional[str] = Query(None, description="Optional: single expiration date (YYYY-MM-DD). If not provided, fetches 0DTE, WEEKLY, MONTHLY.")
):
    """
    Fetch options data for a given symbol with multiple expiries.
    
    By default, fetches 3 expirations:
    1. 0DTE (same day if available, or nearest)
    2. First weekly expiry
    3. First monthly expiry
    
    Args:
        symbol: Stock/ETF symbol (SPY, QQQ, SPX, NDX)
        expiry: Optional single expiration date in YYYY-MM-DD format
    
    Returns:
        MultiExpiryOptionsResponse with expiries array containing calls, puts, and metadata
    """
    # Normalize symbol
    symbol = symbol.upper()
    
    # Validate symbol
    if symbol not in SYMBOL_MAP:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid symbol. Must be one of: {', '.join(SYMBOL_MAP.keys())}"
        )
    
    # Map to yfinance format
    yf_symbol = SYMBOL_MAP[symbol]
    logger.info(f"Fetching data for {symbol} -> {yf_symbol}")
    
    try:
        # Create ticker
        ticker = yf.Ticker(yf_symbol)
        
        # Get current price
        current_price = get_spot_price(ticker)
        if current_price is None:
            logger.warning(f"Could not fetch spot price for {symbol}")
            current_price = 0.0
        else:
            current_price = round(current_price, 2)
            logger.info(f"Current price for {symbol}: {current_price:.2f}")
        
        # Add delay for rate limiting
        await asyncio.sleep(RATE_LIMIT_DELAY)
        
        # Get available expiration dates
        try:
            expirations = ticker.options
            if not expirations:
                raise HTTPException(
                    status_code=404,
                    detail=f"No options data available for {symbol}"
                )
        except Exception as e:
            logger.error(f"Failed to get expirations: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to fetch options expirations: {str(e)}"
            )
        
        available_expirations = list(expirations)
        
        # Determine which expirations to fetch
        if expiry and expiry in available_expirations:
            # Single expiry mode (backwards compatible)
            expiries_to_fetch = [("SINGLE", expiry)]
        else:
            # Multi-expiry mode: 0DTE, WEEKLY, MONTHLY
            expiries_to_fetch = select_expirations(available_expirations)
        
        logger.info(f"Selected expiries to fetch: {expiries_to_fetch}")
        
        # Fetch data for each expiry
        expiry_data_list = []
        
        for label, exp_date in expiries_to_fetch:
            logger.info(f"Fetching {label} ({exp_date})...")
            
            # Add delay between requests to avoid rate limiting
            if expiry_data_list:  # Not the first request
                await asyncio.sleep(RATE_LIMIT_DELAY)
            
            try:
                option_chain = ticker.option_chain(exp_date)
            except Exception as e:
                logger.error(f"Failed to get option chain for {exp_date}: {e}")
                continue  # Skip this expiry and continue with others
            
            # Process calls and puts
            calls = process_option_chain(option_chain, "CALL", current_price)
            puts = process_option_chain(option_chain, "PUT", current_price)
            
            # Calculate gamma exposure (legacy method)
            all_options = calls + puts
            gamma_flip, call_walls, put_walls = calculate_gamma_exposure(
                all_options, "ALL", current_price
            )
            
            # Calculate advanced quantitative metrics
            try:
                quant_metrics = calculate_quant_metrics(calls, puts, current_price, exp_date)
                logger.info(f"Quant metrics for {label}: gamma_flip={quant_metrics.gamma_flip}, "
                           f"max_pain={quant_metrics.max_pain}, total_gex={quant_metrics.total_gex}")
            except Exception as e:
                logger.warning(f"Failed to calculate quant metrics for {label}: {e}")
                quant_metrics = None
            
            expiry_data = ExpiryData(
                expiryDate=exp_date,
                label=label,
                calls=calls,
                puts=puts,
                gammaFlip=gamma_flip,
                callWalls=call_walls,
                putWalls=put_walls,
                quantMetrics=quant_metrics
            )
            
            expiry_data_list.append(expiry_data)
            logger.info(f"Successfully fetched {len(calls)} calls and {len(puts)} puts for {label} ({exp_date})")
        
        if not expiry_data_list:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to fetch any options data for {symbol}"
            )
        
        logger.info(f"Successfully fetched {len(expiry_data_list)} expiries for {symbol}")
        
        return MultiExpiryOptionsResponse(
            symbol=symbol,
            currentPrice=current_price,
            expiries=expiry_data_list,
            availableExpirations=available_expirations,
            timestamp=datetime.now().isoformat()
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error fetching options data: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch options data: {str(e)}"
        )


@app.get("/")
async def root():
    """
    Root endpoint with API information.
    """
    return {
        "name": "Local Options Data Server",
        "version": "2.0.0",
        "description": "Fetches options data with multiple expiries (0DTE, WEEKLY, MONTHLY)",
        "endpoints": {
            "health": "/health",
            "options": "/options/{symbol} - Returns 0DTE, WEEKLY, MONTHLY expiries by default"
        },
        "supported_symbols": list(SYMBOL_MAP.keys())
    }


def main():
    """
    Main entry point for the server.
    """
    parser = argparse.ArgumentParser(description="Local Options Data Server")
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Port to run the server on (default: 8765)"
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)"
    )
    
    args = parser.parse_args()
    
    logger.info(f"Starting Local Options Data Server v2.0.0 on {args.host}:{args.port}")
    logger.info(f"Python version: {sys.version}")
    logger.info(f"Supported symbols: {list(SYMBOL_MAP.keys())}")
    logger.info("Fetching multiple expiries: 0DTE, WEEKLY, MONTHLY")
    
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="info"
    )


if __name__ == "__main__":
    main()
