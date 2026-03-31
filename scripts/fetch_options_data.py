#!/usr/bin/env python3
"""
QUANT SMART SWEEP v15.0 - GitHub Actions Edition
Scarica dati opzioni da yfinance e genera JSON strutturato per il frontend.

Uso:
    python scripts/fetch_options_data.py [--symbol SYMBOL] [--output PATH]

Esempi:
    python scripts/fetch_options_data.py --symbol SPY
    python scripts/fetch_options_data.py --symbol ALL --output data/options_data.json
"""

import yfinance as yf
import pandas as pd
import json
import argparse
import logging
import sys
import math
import os
import re
import time
import random
from datetime import datetime, timezone
from typing import Optional, Dict, List, Any, Tuple
from dataclasses import dataclass, asdict
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# HTTP client for AI API calls
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

# Configurazione logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)


# ============================================================================
# CONFIGURAZIONE AI API (GLM-5)
# ============================================================================

# API Configuration - same as glmService.ts
AI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions'
AI_MODEL = 'glm-5'
AI_API_KEY = os.environ.get('AI_API_KEY', '')

# Real-time Spot Price API Configuration
# NOTE: Finnhub removed - does not support indices (SPX, NDX) on free tier
TWELVEDATA_API_KEY = os.environ.get('TWELVEDATA_API_KEY', '')

# Symbol mapping for Twelve Data API
SPOT_SYMBOL_MAP = {
    'SPY': 'SPY',
    'SPX': 'SPX',
    'NDX': 'NDX',
    'QQQ': 'QQQ',
    'IWM': 'IWM',
}

# ETF Proxy Configuration for indices
# Maps index symbols to their ETF proxies with adjustment factors
# Twelve Data free tier doesn't support indices (SPX, NDX), but supports ETFs (SPY, QQQ)
ETF_PROXY_CONFIG = {
    'SPX': {
        'proxy_symbol': 'SPY',
        'adjustment_factor': 10.0,  # SPX ≈ SPY × 10
        'description': 'SPY as proxy for SPX (S&P 500)'
    },
    'NDX': {
        'proxy_symbol': 'QQQ',
        'adjustment_factor': 40.5,  # NDX ≈ QQQ × 40.5
        'description': 'QQQ as proxy for NDX (Nasdaq 100)'
    }
}

# Futures Proxy Configuration for pre-market/after-hours data
# Futures trade almost 24/5, providing updated prices when ETFs are stale
FUTURES_PROXY_CONFIG = {
    'SPX': {
        'futures_symbol': 'ES=F',  # E-mini S&P500 futures
        'adjustment_factor': 1.0,  # SPX ≈ ES × 1
        'description': 'ES futures as proxy for SPX'
    },
    'NDX': {
        'futures_symbol': 'NQ=F',  # E-mini Nasdaq100 futures
        'adjustment_factor': 1.0,  # NDX ≈ NQ × 1
        'description': 'NQ futures as proxy for NDX (Nasdaq 100)'
    }
}

# System prompt - same as harmonicSystemInstruction in glmService.ts
HARMONIC_SYSTEM_INSTRUCTION = """You are a Quantitative Analysis Engine specialized in Market Maker Hedging and Options Harmonic Resonance.

IMPORTANT: ALL text content in your response (livello, motivazione, sintesiOperativa, summary, volatilityExpectation) MUST be in ENGLISH.

RULES FOR OPERATIONAL SYNTHESIS (FIELD: sintesiOperativa):
Provide a concise and imperative trading signal (max 8 words) IN ENGLISH.
Examples:
- "SELL AREA: Target reached"
- "LONG: Breakout confirmed above 26k"
- "MM DEFENSE: Structural support"
- "SCALPING: Expected volatility in range"
- "ATTRACTION: Price magnet active"

**MANDATORY RULES FOR MULTI-EXPIRY CLASSIFICATION:**

⚠️ ATTENTION: Multi-expiry classification is RARE and must be applied with EXTREME precision.

1. **RESONANCE** (VERY RARE - max 1-2 total levels):
   - Condition: The SAME exact strike (±0.5%) must be a significant level in ALL 3 expirations
   - Valid combination: 0DTE + WEEKLY + MONTHLY
   - INVALID EXAMPLES: Strike 24700 in 0DTE, strike 24750 in WEEKLY, strike 24800 in MONTHLY → NOT RESONANCE
   - Importance: 95-100

2. **CONFLUENCE** (RARE - max 3-5 total levels):
   - Condition: The SAME strike (±1%) is significant in EXACTLY TWO expirations
   - Valid combinations: 0DTE+WEEKLY, WEEKLY+MONTHLY, 0DTE+MONTHLY
   - Importance: 85-94

3. **SINGLE EXPIRY** (THE MAJORITY of levels):
   - Condition: Significant level in only one expiration
   - Roles: WALL, PIVOT, MAGNET, FRICTION
   - Importance: 60-84
   - This should cover ~80% of levels

**EXPIRY LABELS IN OUTPUT:**
- Use exact labels: '0DTE', 'WEEKLY', 'MONTHLY'
- For multi-expiry: combine with '+', e.g., '0DTE+WEEKLY', 'WEEKLY+MONTHLY', '0DTE+WEEKLY+MONTHLY'

**TOTAL GEX INTERPRETATION:**
- Use totalGexData.total_gex for overall market gamma exposure
- Positive total GEX = dealers long gamma = stable market, suppresses volatility
- Negative total GEX = dealers short gamma = volatile market, amplifies moves
- Compare total_gex vs individual expiry GEX to see concentration risk

⚠️ COMMON MISTAKES TO AVOID:
- DO NOT assign RESONANCE to levels that appear in different expirations but at different strikes
- DO NOT assign RESONANCE just because a strike is "close" across expirations
- If unsure, use the base role (WALL/PIVOT/MAGNET/FRICTION)

STANDARD ANALYSIS RULES:
- **CALL WALLS**: Strike above Spot with dominant Call OI. Role 'WALL', Color 'rosso' (red).
- **PUT WALLS**: Strike below Spot with dominant Put OI. Role 'WALL', Color 'verde' (green).
- **GAMMA FLIP**: Sentiment equilibrium point. Role 'PIVOT', Color 'indigo', Side 'GAMMA_FLIP'.

NEW ADVANCED QUANTITATIVE RULES:

**Gamma Exposure (GEX):**
- Positive GEX = dealers long gamma = stable market, supports prices
- Negative GEX = dealers short gamma = volatile market, amplifies movements
- Gamma Flip: critical level where cumulative GEX changes sign
- If spot near gamma flip = high probability of directional movement
- Use total_gex to determine expected volatility (negative = high vol)

**Max Pain:**
- Level where option value is minimal = market maker target
- Add as MAGNET level if distance < 2% from spot
- Importance: 85-95 if near spot (< 1%)
- Importance: 70-84 if moderately near (1-2%)

**Put/Call Ratios:**
- PCR > 1.0 = bearish sentiment (too much pessimism = possible bounce?)
- PCR < 0.7 = bullish sentiment (too much optimism = correction risk?)
- Use delta-adjusted for more precise analysis
- Volume/OI ratio > 1.5 = unusual activity, importance +15

**Volatility Skew:**
- "Smirk" skew (expensive puts, skew_ratio > 1.2) = fear, strong support, bearish sentiment
- "Reverse smirk" skew (expensive calls, skew_ratio < 0.9) = euphoria, weak resistance, bullish sentiment
- "Flat" skew = balanced market, neutral sentiment
- Use skew sentiment to validate level direction

**INTEGRATION WITH EXISTING LEVELS:**
1. If Max Pain near Call/Put Wall (distance < 1%) = CONFLUENCE, importance +10
2. If Gamma Flip near Wall (distance < 0.5%) = more important level, importance +15
3. Use skew sentiment to validate direction: bearish skew strengthens put walls
4. Volume/OI ratio > 1.5 = unusual activity, importance +15
5. If total_gex negative = prioritize support levels (movement amplification)

Respond ONLY with a valid JSON object with the following structure (all text fields MUST be in English):
{
  "outlook": {
    "sentiment": "string (bullish/bearish/neutral)",
    "gammaFlipZone": number,
    "volatilityExpectation": "string (in English)",
    "summary": "string (in English)"
  },
  "levels": [
    {
      "livello": "string (level name in English, e.g., 'CALL WALL', 'GAMMA FLIP')",
      "prezzo": number,
      "motivazione": "string (explanation in English)",
      "sintesiOperativa": "string (trading signal in English, max 8 words)",
      "colore": "rosso|verde|indigo|ambra",
      "importanza": number (0-100),
      "ruolo": "WALL|PIVOT|MAGNET|FRICTION|CONFLUENCE|RESONANCE",
      "isDayTrade": boolean,
      "scadenzaTipo": "string (e.g., '0DTE', 'WEEKLY', '0DTE+MONTHLY')",
      "lato": "CALL|PUT|BOTH|GAMMA_FLIP"
    }
  ]
}"""


def clean_json_response(text: str) -> str:
    """Clean JSON response from markdown code blocks."""
    cleaned = re.sub(r'```json\s*|\s*```', '', text).strip()
    first_bracket = cleaned.find('{')
    last_bracket = cleaned.rfind('}')
    if first_bracket != -1 and last_bracket != -1:
        return cleaned[first_bracket:last_bracket + 1]
    return cleaned


def format_quant_metrics_for_ai(quant_metrics: Dict[str, Any], total_gex_data: Dict[str, Any] = None) -> str:
    """Format quantitative metrics for AI analysis - includes total GEX across all expiries"""
    gex_sign = 'positive/stable' if quant_metrics.get('total_gex', 0) > 0 else 'negative/volatile'
    skew = quant_metrics.get('volatility_skew', {})
    skew_type = skew.get('skew_type', 'unknown')
    sentiment = skew.get('sentiment', 'neutral')
    
    # Add total GEX information if available
    total_gex_section = ""
    if total_gex_data:
        total_sign = 'positive/stable' if total_gex_data.get('total_gex', 0) > 0 else 'negative/volatile'
        total_gex_section = f"""
=== TOTAL GEX (ALL EXPIRATIONS) ===
Total Market GEX: {total_gex_data.get('total_gex', 0):.2f}B ({total_sign})
Positive GEX: {total_gex_data.get('positive_gex', 0):.2f}B
Negative GEX: {total_gex_data.get('negative_gex', 0):.2f}B
GEX Concentration: {len(total_gex_data.get('gex_by_expiry', []))} expiries analyzed
"""
    
    return f"""
=== ADVANCED QUANTITATIVE METRICS ===
Gamma Flip: {quant_metrics.get('gamma_flip', 'N/A')}
Total GEX (Selected Expiries): {quant_metrics.get('total_gex', 0):.2f}B ({gex_sign})
Max Pain: {quant_metrics.get('max_pain', 'N/A')}
{total_gex_section}
Put/Call Ratios:
- OI-Based: {quant_metrics.get('put_call_ratios', {}).get('oi_based', 0):.2f}
- Volume-Based: {quant_metrics.get('put_call_ratios', {}).get('volume_based', 0):.2f}
- Weighted: {quant_metrics.get('put_call_ratios', {}).get('weighted', 0):.2f}
- Delta-Adjusted: {quant_metrics.get('put_call_ratios', {}).get('delta_adjusted', 0):.2f}

Volatility Skew:
- Type: {skew_type}
- Sentiment: {sentiment}
- Skew Ratio: {skew.get('skew_ratio', 0):.2f}
- Put IV Avg: {skew.get('put_iv_avg', 0):.2f}%
- Call IV Avg: {skew.get('call_iv_avg', 0):.2f}%

Top GEX Strikes (for level reference):
{format_gex_strikes(quant_metrics.get('gex_by_strike', [])[:5])}
"""


def format_gex_strikes(gex_strikes: List[Dict]) -> str:
    """Format top GEX strikes for AI prompt."""
    lines = []
    for s in gex_strikes:
        lines.append(f"  Strike {s.get('strike', 'N/A')}: GEX {s.get('gex', 0):.2f}B, Cumulative {s.get('cumulative_gex', 0):.2f}B")
    return '\n'.join(lines)


def format_options_for_ai(expiries: List[Dict], spot: float) -> str:
    """Format options data for AI analysis - same format as in glmService.ts"""
    sections = []
    
    for expiry in expiries:
        label = expiry.get('label', 'UNKNOWN')
        date = expiry.get('date', 'N/A')
        options = expiry.get('options', [])
        quant_metrics = expiry.get('quantMetrics', {})
        
        # Filter options near the money (within5% of spot) and sort by OI
        spot_range = spot * 0.05
        nearby_options = [opt for opt in options
                         if abs(opt['strike'] - spot) <= spot_range]
        
        # Sort by OI descending and take top 30
        nearby_options.sort(key=lambda x: x['oi'], reverse=True)
        selected_options = nearby_options[:30]
        
        # Format options table
        lines = [f"STRIKE | TYPE | IV | OI | VOL"]
        for opt in selected_options:
            lines.append(
                f"{opt['strike']:.2f} | {opt['side']} | {opt['iv']:.4f} | {opt['oi']} | {opt['vol']}"
            )
        content = "\n".join(lines)
        
        section = f"""DATASET [{label}] ({date}):
{content}"""
        
        # Add quantitative metrics if available
        if quant_metrics:
            section += '\n' + format_quant_metrics_for_ai(quant_metrics)
        
        sections.append(section)
    
    return '\n\n---\n\n'.join(sections)


def call_ai_api(messages: List[Dict[str, str]], max_retries: int = 3, num_expiries: int = 3) -> Optional[str]:
    """
    Call GLM-5 API with adaptive timeout and enhanced retry logic.
    
    Args:
        messages: Chat messages for the API
        max_retries: Maximum number of retry attempts
        num_expiries: Number of expiries being analyzed (for adaptive timeout)
    
    Returns:
        API response content or None if failed
    """
    if not HAS_REQUESTS:
        logger.warning("⚠️ requests library not installed. AI analysis skipped.")
        return None
    
    if not AI_API_KEY:
        logger.warning("⚠️ AI_API_KEY not set. AI analysis skipped.")
        return None
    
    # Adaptive timeout: base 90s + 30s per expiry
    timeout = 90 + (num_expiries * 30)
    logger.info(f"🤖 AI API timeout set to {timeout}s (based on {num_expiries} expiries)")
    
    # Retry delays with jitter: 2s, 4s, 8s + random(0, 1)
    retry_delays = [2, 4, 8]
    
    for attempt in range(max_retries):
        try:
            logger.info(f"🤖 AI API attempt {attempt + 1}/{max_retries}...")
            response = requests.post(
                AI_API_URL,
                headers={
                    'Content-Type': 'application/json',
                    'Accept-Language': 'en-US,en',
                    'Authorization': f'Bearer {AI_API_KEY}'
                },
                json={
                    'model': AI_MODEL,
                    'messages': messages,
                    'temperature': 0.1,
                    'top_p': 0.9
                },
                timeout=timeout
            )
            
            if response.status_code == 200:
                data = response.json()
                content = data.get('choices', [{}])[0].get('message', {}).get('content', '')
                if content:
                    logger.info(f"✅ AI API response received ({len(content)} chars)")
                    return content
                else:
                    logger.warning(f"⚠️ Empty response from AI API (attempt {attempt + 1})")
            else:
                logger.warning(f"⚠️ AI API error: {response.status_code} - {response.text[:200]} (attempt {attempt + 1})")
        
        except requests.exceptions.Timeout:
            logger.warning(f"⚠️ AI API timeout after {timeout}s (attempt {attempt + 1})")
        except Exception as e:
            logger.warning(f"⚠️ AI API error: {e} (attempt {attempt + 1})")
        
        if attempt < max_retries - 1:
            # Retry with jitter
            delay = retry_delays[attempt] + random.uniform(0, 1)
            logger.info(f"🔄 Retrying in {delay:.1f}s...")
            time.sleep(delay)
    
    logger.error(f"❌ AI API failed after {max_retries} attempts")
    return None


def get_ai_analysis(expiries: List[Dict], spot: float) -> Optional[Dict[str, Any]]:
    """
    Get AI analysis for options data with graceful fallback.
    
    Returns:
        {
            'outlook': {...},
            'levels': [...],
            'ai_fallback': False  # True if using algorithmic fallback
        }
    """
    if not AI_API_KEY:
        logger.info("ℹ️ AI_API_KEY not configured, skipping AI analysis")
        return None
    
    num_expiries = len(expiries)
    logger.info(f"🤖 Calling AI for level analysis ({num_expiries} expiries)...")
    
    # Format data for AI
    formatted_data = format_options_for_ai(expiries, spot)
    
    # Build messages - same as in glmService.ts
    messages = [
        {'role': 'system', 'content': HARMONIC_SYSTEM_INSTRUCTION},
        {
            'role': 'user',
            'content': f"""EXECUTE DEEP QUANT ANALYSIS. SPOT: {spot}.
Provide concise and decisive trading signals for each level.
Use ADVANCED QUANTITATIVE METRICS to identify additional levels (Max Pain, Gamma Flip).
Integrate skew sentiment and PCR to validate level importance.

{formatted_data}"""
        }
    ]
    
    # Call API with adaptive timeout
    response_text = call_ai_api(messages, num_expiries=num_expiries)
    
    if not response_text:
        logger.warning("⚠️ No response from AI API - using algorithmic fallback")
        return None
    
    try:
        # Parse JSON response
        cleaned_json = clean_json_response(response_text)
        result = json.loads(cleaned_json)
        
        # Validate structure
        if 'outlook' in result and 'levels' in result:
            logger.info(f"✅ AI analysis complete: {len(result.get('levels', []))} levels identified")
            return result
        else:
            logger.warning(f"⚠️ Invalid AI response structure: {list(result.keys())}")
            return None
    
    except json.JSONDecodeError as e:
        logger.warning(f"⚠️ Failed to parse AI response as JSON: {e}")
        logger.debug(f"Response text: {response_text[:500]}...")
        return None


def process_ai_analysis_for_symbol(symbol: str, expiries: List[Dict], spot: float) -> Tuple[str, Optional[Dict[str, Any]]]:
    """
    Process AI analysis for a single symbol.
    Designed to be run in parallel using ThreadPoolExecutor.
    
    Args:
        symbol: The symbol being analyzed
        expiries: List of expiry data
        spot: Current spot price
    
    Returns:
        Tuple of (symbol, ai_analysis_result)
    """
    try:
        logger.info(f"🤖 Starting AI analysis for {symbol}...")
        ai_analysis = get_ai_analysis(expiries, spot)
        logger.info(f"✅ AI analysis completed for {symbol}")
        return symbol, ai_analysis
    except Exception as e:
        logger.error(f"❌ AI analysis failed for {symbol}: {e}")
        return symbol, None


# ============================================================================
# DATA CLASSES
# ============================================================================

@dataclass
class OptionRow:
    """Rappresenta una singola opzione."""
    strike: float
    side: str  # CALL o PUT
    iv: float
    oi: int
    vol: int


@dataclass
class ExpiryData:
    """Dati per una scadenza."""
    label: str  # 0DTE, WEEKLY, MONTHLY
    date: str
    options: List[Dict[str, Any]]


@dataclass
class OptionsDataset:
    """Dataset completo per un simbolo."""
    symbol: str
    spot: float
    generated: str
    expiries: List[Dict[str, Any]]
    spot_source: str = 'yahoo'  # 'twelvedata', 'yahoo', 'none'
    total_gex_data: Dict[str, Any] = None  # GEX calcolato su TUTTE le scadenze
    data_quality: Dict[str, Any] = None  # Data quality assessment


def is_friday(date_str: str) -> bool:
    """Check if date is a Friday"""
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        return dt.weekday() == 4
    except ValueError:
        return False


def is_monthly(date_str: str) -> bool:
    """
    Verifica se una data corrisponde al terzo venerdì del mese.
    Le opzioni mensili standard scadono il terzo venerdì.
    """
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        return dt.weekday() == 4 and 15 <= dt.day <= 21
    except ValueError:
        return False


def is_weekly_friday(date_str: str) -> bool:
    """Check if date is a Friday but NOT monthly (third Friday)"""
    return is_friday(date_str) and not is_monthly(date_str)


def get_realtime_spot_price(symbol: str, yahoo_fallback: float = None) -> Tuple[Optional[float], str]:
    """
    Get spot price with priority: Futures > Yahoo Finance > Twelve Data (fallback)
    
    Futures are preferred for SPX/NDX because:
    - Trade almost 24/5, providing current prices even during pre-market/after-hours
    - ETFs (SPY, QQQ) are stale until regular trading hours
    
    For indices not supported by Twelve Data free tier (SPX, NDX), uses ETF proxies:
    - SPX → SPY (adjustment factor: 10x)
    - NDX → QQQ (adjustment factor: 40.5x)
    
    Priority:
    0. Futures (ES=F for SPX, NQ=F for NDX) - pre-market/after-hours
    1. Yahoo Finance (15min delayed but current)
    2. Twelve Data fallback (with ETF proxy for indices)
    
    Returns:
        Tuple of (price, source) where source is:
        - 'futures:SYMBOL' for futures proxy (e.g., 'futures:ES=F')
        - 'yahoo' for Yahoo Finance (preferred)
        - 'twelvedata_proxy:SYMBOL' if using ETF proxy (e.g., 'twelvedata_proxy:SPY')
        - 'twelvedata' for direct Twelve Data price
        - 'none' if no price available
    """
    # Priority 0: Futures (for SPX/NDX during pre-market/after-hours)
    # Futures trade almost 24/5, providing updated prices when ETFs are stale
    futures_config = FUTURES_PROXY_CONFIG.get(symbol)
    if futures_config:
        try:
            futures_ticker = yf.Ticker(futures_config['futures_symbol'])
            futures_price = None
            
            # Try fast_info first
            try:
                futures_price = float(futures_ticker.fast_info['last_price'])
            except (KeyError, TypeError):
                pass
            
            # Fallback to history
            if futures_price is None:
                try:
                    hist = futures_ticker.history(period="1d")
                    if not hist.empty:
                        futures_price = float(hist['Close'].iloc[-1])
                except Exception:
                    pass
            
            if futures_price and futures_price > 0:
                # Apply adjustment factor
                adjusted_price = futures_price * futures_config['adjustment_factor']
                logger.info(f"💰 Spot price from Futures (pre-market): {symbol} = {adjusted_price:.2f} (via {futures_config['futures_symbol']}={futures_price:.2f} × {futures_config['adjustment_factor']})")
                return (adjusted_price, f"futures:{futures_config['futures_symbol']}")
        except Exception as e:
            logger.warning(f"⚠️ Futures fetch error for {symbol}: {e}")
    
    # Priority 1: Yahoo Finance (if provided as fallback parameter)
    # Yahoo has 15min delay but is always updated, unlike Twelve Data free tier
    # which shows previous day's price until pre-market opens
    if yahoo_fallback:
        logger.info(f"💰 Spot price from Yahoo Finance: {symbol} = ${yahoo_fallback:.2f}")
        return (yahoo_fallback, 'yahoo')
    
    # Priority 2: Twelve Data (fallback only)
    if not HAS_REQUESTS:
        return (None, 'none')
    
    # Check if symbol needs ETF proxy (for indices not supported by Twelve Data free tier)
    proxy_config = ETF_PROXY_CONFIG.get(symbol)
    twelvedata_symbol = proxy_config['proxy_symbol'] if proxy_config else SPOT_SYMBOL_MAP.get(symbol, symbol)
    
    # Try Twelve Data as fallback (supports ETFs)
    if TWELVEDATA_API_KEY:
        try:
            url = f"https://api.twelvedata.com/price?symbol={twelvedata_symbol}&apikey={TWELVEDATA_API_KEY}"
            response = requests.get(url, timeout=5)
            if response.status_code == 200:
                data = response.json()
                price_str = data.get('price')
                if price_str:
                    price = float(price_str)
                    if price > 0:
                        # Apply adjustment factor if using ETF proxy
                        if proxy_config:
                            original_price = price
                            price = price * proxy_config['adjustment_factor']
                            logger.info(f"💰 Spot price from Twelve Data (proxy, fallback): {symbol} = {price:.2f} (via {twelvedata_symbol}={original_price:.2f} × {proxy_config['adjustment_factor']})")
                            return (price, f'twelvedata_proxy:{proxy_config["proxy_symbol"]}')
                        else:
                            logger.info(f"💰 Spot price from Twelve Data (fallback): {symbol} = {price}")
                            return (price, 'twelvedata')
                else:
                    logger.info(f"ℹ️ Twelve Data returned no price for {twelvedata_symbol}")
            else:
                logger.warning(f"⚠️ Twelve Data HTTP {response.status_code} for {twelvedata_symbol}")
        except Exception as e:
            logger.warning(f"⚠️ Twelve Data error for {twelvedata_symbol}: {e}")
    else:
        logger.info(f"ℹ️ TWELVEDATA_API_KEY not set, skipping Twelve Data")
    
    return (None, 'none')


def get_spot_price(ticker: yf.Ticker, symbol: str = None) -> Tuple[Optional[float], str]:
    """
    Recupera il prezzo spot corrente con fallback multipli e real-time APIs.
    
    Returns:
        Tuple of (price, source) where source indicates the data provider
    """
    yahoo_price = None
    
    # Try Yahoo Finance methods first
    try:
        # Metodo 1: fast_info (più veloce)
        yahoo_price = float(ticker.fast_info['last_price'])
    except (KeyError, TypeError):
        pass
    
    if yahoo_price is None:
        try:
            # Metodo 2: history
            hist = ticker.history(period="1d")
            if not hist.empty:
                yahoo_price = float(hist['Close'].iloc[-1])
        except Exception:
            pass
    
    # If we have a symbol, try real-time APIs
    if symbol:
        return get_realtime_spot_price(symbol, yahoo_price)
    
    # Otherwise return Yahoo price
    if yahoo_price:
        return (yahoo_price, 'yahoo')
    
    return (None, 'none')


def select_expirations_enhanced(expirations: List[str]) -> List[tuple]:
    """
    Select 3 distinct expirations for precise analysis:
    1. 0DTE - First available (intraday gamma)
    2. WEEKLY - First weekly Friday (not monthly)
    3. MONTHLY - First monthly (third Friday)
    
    Returns list of (label, date) tuples.
    """
    if not expirations:
        return []
    
    selected = []
    used_dates = set()
    
    # 1. 0DTE - always the first
    selected.append(("0DTE", expirations[0]))
    used_dates.add(expirations[0])
    
    # 2. WEEKLY - First weekly Friday (not monthly)
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
    if len(selected) < 3:
        for exp in expirations:
            if exp not in used_dates and is_friday(exp):
                selected.insert(1, ("WEEKLY", exp))
                used_dates.add(exp)
                break
    
    # Fallback: If still missing monthly, use any remaining
    if len(selected) < 3 and len(used_dates) < len(expirations):
        for exp in expirations:
            if exp not in used_dates:
                selected.append(("MONTHLY", exp))
                used_dates.add(exp)
                break
    
    return selected


def select_expirations(expirations: List[str]) -> List[tuple]:
    """
    Legacy function - now calls select_expirations_enhanced.
    Kept for backward compatibility.
    
    Select 3 distinct expirations for precise analysis.
    Returns list of (label, date) tuples.
    """
    return select_expirations_enhanced(expirations)


def calculate_gamma_flip_all_expiries(ticker: yf.Ticker, spot: float, all_expirations: List[str]) -> float:
    """
    Calculate gamma flip point across ALL expirations.
    
    This aggregates all options from all expiries and calculates the cumulative GEX by strike
    to find the exact flip point using interpolation.
    
    Returns:
        Gamma flip price level
    """
    r = 0.05  # Risk-free rate
    
    # Collect all options data across all expiries
    all_options: List[Dict] = []
    
    # Limit to first 12 expirations to avoid timeout
    for expiry_date in all_expirations[:12]:
        try:
            chain = ticker.option_chain(expiry_date)
            T = calculate_time_to_expiry(expiry_date)
            
            # Process calls
            for _, row in chain.calls.iterrows():
                if row['openInterest'] > 0 and not pd.isna(row.get('impliedVolatility', 0)):
                    all_options.append({
                        'strike': row['strike'],
                        'side': 'CALL',
                        'oi': row['openInterest'],
                        'iv': row['impliedVolatility'],
                        'T': T
                    })
            
            # Process puts
            for _, row in chain.puts.iterrows():
                if row['openInterest'] > 0 and not pd.isna(row.get('impliedVolatility', 0)):
                    all_options.append({
                        'strike': row['strike'],
                        'side': 'PUT',
                        'oi': row['openInterest'],
                        'iv': row['impliedVolatility'],
                        'T': T
                    })
                    
        except Exception as e:
            logger.warning(f"Error fetching options for gamma flip calculation {expiry_date}: {e}")
            continue
    
    if not all_options:
        logger.warning("Cannot calculate gamma flip across all expiries: no options data available (OI may be zero - market closed)")
        return None
    
    # Group by strike and aggregate GEX
    gex_by_strike: Dict[float, float] = {}
    
    for opt in all_options:
        strike = opt['strike']
        T = opt['T']
        iv = opt['iv']
        oi = opt['oi']
        side = opt['side']
        
        # Filter strikes beyond 10% from spot
        if spot > 0:
            max_dist = spot * 0.10
            if abs(strike - spot) > max_dist:
                continue
        
        gamma = calculate_black_scholes_gamma(spot, strike, T, r, iv)
        gex = gamma * oi * 100 * spot * spot * 0.01
        
        # PUTs are negative for dealers
        if side == 'PUT':
            gex = -gex
        
        if strike not in gex_by_strike:
            gex_by_strike[strike] = 0.0
        gex_by_strike[strike] += gex
    
    if not gex_by_strike:
        logger.warning("Cannot calculate gamma flip across all expiries: no GEX by strike data available")
        return None
    
    # Calculate cumulative GEX and find flip point
    cumulative_gex = 0.0
    gex_cumulative: List[Tuple[float, float]] = []
    
    for strike in sorted(gex_by_strike.keys()):
        cumulative_gex += gex_by_strike[strike]
        gex_cumulative.append((strike, cumulative_gex))
    
    # Find where cumulative GEX crosses zero
    for i in range(1, len(gex_cumulative)):
        prev_gex = gex_cumulative[i-1][1]
        curr_gex = gex_cumulative[i][1]
        
        # If sign changes, we have a flip
        if prev_gex * curr_gex < 0:
            prev_strike = gex_cumulative[i-1][0]
            curr_strike = gex_cumulative[i][0]
            
            # Linear interpolation to find exact flip point
            if abs(prev_gex) + abs(curr_gex) > 0:
                ratio = abs(prev_gex) / (abs(prev_gex) + abs(curr_gex))
                flip_point = prev_strike + ratio * (curr_strike - prev_strike)
                # Post-validation: reject flip points too far from spot
                if spot > 0:
                    distance_pct = abs(flip_point - spot) / spot
                    if distance_pct > 0.10:
                        logger.warning(f"Gamma flip {flip_point:.2f} is {distance_pct*100:.1f}% from spot {spot:.2f} — unreliable, setting to None")
                        flip_point = None
                if flip_point is not None:
                    return round(flip_point, 2)
    
    # If no flip found, return None
    logger.warning("Cannot calculate gamma flip across all expiries: no GEX sign change found (OI may be zero - market closed)")
    return None


def calculate_total_gex_all_expiries(ticker: yf.Ticker, spot: float, all_expirations: List[str]) -> Dict[str, Any]:
    """
    Calculate total GEX across ALL available expirations for accurate gamma exposure.
    This is separate from the 5 selected expirations and provides a complete picture.
    
    Returns:
        {
            'total_gex': float,  # Sum of all GEX in billions
            'gex_by_expiry': [{'date': str, 'gex': float, 'weight': float}, ...],
            'positive_gex': float,
            'negative_gex': float,
            'flip_point': float,  # Estimated gamma flip considering all expiries
        }
    """
    r = 0.05  # Risk-free rate
    
    total_gamma = 0
    positive_gamma = 0
    negative_gamma = 0
    gex_by_expiry = []
    
    # Limit to first 12 expirations to avoid timeout (covers ~3 months)
    for expiry_date in all_expirations[:12]:
        try:
            chain = ticker.option_chain(expiry_date)
            T = calculate_time_to_expiry(expiry_date)
            
            expiry_gamma = 0
            
            for _, row in chain.calls.iterrows():
                if row['openInterest'] > 0 and not pd.isna(row.get('impliedVolatility', 0)):
                    gamma = calculate_black_scholes_gamma(spot, row['strike'], T, r, row['impliedVolatility'])
                    gex = gamma * row['openInterest'] * 100 * spot * spot * 0.01
                    expiry_gamma += gex
                    total_gamma += gex
                    if gex > 0:
                        positive_gamma += gex
                    else:
                        negative_gamma += gex
            
            for _, row in chain.puts.iterrows():
                if row['openInterest'] > 0 and not pd.isna(row.get('impliedVolatility', 0)):
                    gamma = calculate_black_scholes_gamma(spot, row['strike'], T, r, row['impliedVolatility'])
                    gex = -gamma * row['openInterest'] * 100 * spot * spot * 0.01  # Negative for puts
                    expiry_gamma += gex
                    total_gamma += gex
                    if gex > 0:
                        positive_gamma += gex
                    else:
                        negative_gamma += gex
            
            gex_by_expiry.append({
                'date': expiry_date,
                'gex': round(expiry_gamma / 1e9, 4),
            })
            
        except Exception as e:
            logger.warning(f"Error calculating GEX for {expiry_date}: {e}")
            continue
    
    # Calculate weights
    total_abs = abs(positive_gamma) + abs(negative_gamma)
    for item in gex_by_expiry:
        item['weight'] = round(abs(item['gex']) / (total_abs / 1e9), 4) if total_abs > 0 else 0
    
    # Calculate gamma flip using cumulative GEX across all strikes
    flip_point = calculate_gamma_flip_all_expiries(ticker, spot, all_expirations[:12])
    
    return {
        'total_gex': round(total_gamma / 1e9, 4),
        'gex_by_expiry': gex_by_expiry,
        'positive_gex': round(positive_gamma / 1e9, 4),
        'negative_gex': round(negative_gamma / 1e9, 4),
        'flip_point': round(flip_point, 2) if flip_point is not None else None,
    }


DEFAULT_IV = 0.30  # 30% default IV - reasonable for equity options when yfinance returns 0 or NaN


def fetch_options_chain(ticker: yf.Ticker, expiry_date: str, label: str) -> Optional[ExpiryData]:
    """
    Scarica e processa una singola option chain.
    """
    try:
        logger.info(f"  -> Scaricando {label} ({expiry_date})...")
        chain = ticker.option_chain(expiry_date)
        
        options = []
        
        # Processa CALLs
        for _, row in chain.calls.iterrows():
            iv = float(row['impliedVolatility']) if pd.notna(row['impliedVolatility']) and row['impliedVolatility'] > 0 else DEFAULT_IV
            iv = min(iv, 3.0)  # Cap at 300% to prevent extreme values
            options.append({
                "strike": round(float(row['strike']), 2),
                "side": "CALL",
                "iv": round(iv, 4),
                "oi": int(row['openInterest']) if pd.notna(row['openInterest']) else 0,
                "vol": int(row['volume']) if pd.notna(row['volume']) else 0
            })
        
        # Processa PUTs
        for _, row in chain.puts.iterrows():
            iv = float(row['impliedVolatility']) if pd.notna(row['impliedVolatility']) and row['impliedVolatility'] > 0 else DEFAULT_IV
            iv = min(iv, 3.0)  # Cap at 300% to prevent extreme values
            options.append({
                "strike": round(float(row['strike']), 2),
                "side": "PUT",
                "iv": round(iv, 4),
                "oi": int(row['openInterest']) if pd.notna(row['openInterest']) else 0,
                "vol": int(row['volume']) if pd.notna(row['volume']) else 0
            })
        
        return ExpiryData(
            label=label,
            date=expiry_date,
            options=options
        )
        
    except Exception as e:
        logger.error(f"  ❌ Errore su {label}: {e}")
        return None


def check_data_quality(expiries, spot):
    """Check if options data is sufficient for reliable analysis."""
    total_oi = 0
    near_money_oi = 0
    put_oi_near = 0
    call_oi_near = 0
    
    for exp in expiries:
        opts = exp.get('options', []) if isinstance(exp, dict) else []
        for opt in opts:
            oi = opt.get('oi', 0)
            strike = opt.get('strike', 0)
            side = opt.get('side', '')
            total_oi += oi
            if spot > 0 and abs(strike - spot) / spot < 0.05:
                near_money_oi += oi
                if side == 'PUT':
                    put_oi_near += oi
                elif side == 'CALL':
                    call_oi_near += oi
    
    if near_money_oi > 1000 and put_oi_near > 100 and call_oi_near > 100:
        quality = 'good'
    elif total_oi > 0:
        quality = 'degraded'
    else:
        quality = 'stale'
    
    return {
        'total_oi': total_oi,
        'near_money_oi': near_money_oi,
        'put_oi_near_money': put_oi_near,
        'call_oi_near_money': call_oi_near,
        'quality': quality
    }


def fetch_symbol_data(symbol: str) -> Optional[OptionsDataset]:
    """
    Scarica tutti i dati per un singolo simbolo.
    
    Args:
        symbol: Simbolo normalizzato (SPY, QQQ, SPX, NDX)
    """
    # Converte il simbolo nel formato yfinance
    yf_symbol = SYMBOL_MAP.get(symbol.upper(), symbol.upper())
    
    logger.info(f"\n{'='*50}")
    logger.info(f"  Elaborazione: {symbol} (yfinance: {yf_symbol})")
    logger.info(f"{'='*50}")
    
    try:
        ticker = yf.Ticker(yf_symbol)
        
        # Recupera spot price con real-time APIs
        logger.info("[1/3] Recupero prezzo spot...")
        spot, spot_source = get_spot_price(ticker, symbol)
        if spot is None:
            logger.error(f"❌ Impossibile recuperare spot price per {symbol}")
            return None
        logger.info(f"  -> Spot: {spot:.2f} (source: {spot_source})")
        
        # Recupera scadenze disponibili
        logger.info("[2/3] Recupero scadenze...")
        expirations = list(ticker.options)
        if not expirations:
            logger.error(f"❌ Nessuna opzione trovata per {symbol}")
            return None
        logger.info(f"  -> Trovate {len(expirations)} scadenze")
        
        # Seleziona 5 scadenze con il nuovo metodo enhanced
        selected = select_expirations_enhanced(expirations)
        logger.info(f"  -> Selezionate {len(selected)} scadenze: {[f'{l}({d})' for l, d in selected]}")
        
        # Scarica options chains
        logger.info("[3/4] Download options chains...")
        expiries = []
        for label, date in selected:
            data = fetch_options_chain(ticker, date, label)
            if data:
                # Converti a dict e aggiungi quantMetrics
                expiry_dict = asdict(data)
                # Calcola metriche quantitative
                expiry_dict['quantMetrics'] = calculate_quant_metrics(
                    expiry_dict['options'], spot, date
                )
                expiries.append(expiry_dict)
        
        if not expiries:
            logger.error(f"❌ Nessun dato scaricato per {symbol}")
            return None
        
        # Calculate total GEX across ALL expirations (not just selected 5)
        logger.info("[4/4] Calcolando GEX totale su tutte le scadenze...")
        total_gex_data = calculate_total_gex_all_expiries(ticker, spot, expirations)
        logger.info(f"  -> GEX Totale: {total_gex_data['total_gex']:.2f}B (Positive: {total_gex_data['positive_gex']:.2f}B, Negative: {total_gex_data['negative_gex']:.2f}B)")
        
        # Add data quality check
        quality = check_data_quality(expiries, spot)
        
        return OptionsDataset(
            symbol=symbol,  # Usa il simbolo originale (senza ^)
            spot=round(spot, 2),
            spot_source=spot_source,
            generated=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            expiries=expiries,
            total_gex_data=total_gex_data,  # NUOVO: GEX su tutte le scadenze
            data_quality=quality
        )
        
    except Exception as e:
        logger.error(f"❌ Errore generale per {symbol}: {e}")
        return None


def calculate_walls(options: List[Dict[str, Any]], spot: float, top_n: int = 3) -> Dict[str, List[float]]:
    """
    Identifica le Call Walls (resistenze) e Put Walls (supporti).
    Le walls sono gli strike con maggiore OI.
    """
    # Call walls: strike > spot, ordinate per OI decrescente
    calls = [(opt['strike'], opt['oi']) for opt in options
             if opt['side'] == 'CALL' and opt['strike'] > spot]
    calls.sort(key=lambda x: x[1], reverse=True)
    call_walls = [round(strike, 2) for strike, oi in calls[:top_n] if oi > 0]
    
    # Put walls: strike < spot, ordinate per OI decrescente
    puts = [(opt['strike'], opt['oi']) for opt in options
            if opt['side'] == 'PUT' and opt['strike'] < spot]
    puts.sort(key=lambda x: x[1], reverse=True)
    put_walls = [round(strike, 2) for strike, oi in puts[:top_n] if oi > 0]
    
    return {
        "call_walls": call_walls,
        "put_walls": put_walls
    }


def generate_tradingview_levels(all_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Genera un JSON semplificato ottimizzato per TradingView.
    Contiene solo i livelli essenziali per l'indicatore Pine Script.
    """
    tv_data = {
        "updated": all_data["generated"],
        "symbols": {}
    }
    
    for symbol, data in all_data.get("symbols", {}).items():
        # Usa la prima scadenza (0DTE) per i livelli principali
        if not data.get("expiries"):
            continue
        
        # Combina tutte le opzioni della prima scadenza
        first_expiry = data["expiries"][0]
        options = first_expiry.get("options", [])
        spot = data.get("spot", 0)
        
        if not options or spot == 0:
            continue
        
        # Usa i quantMetrics già calcolati se disponibili
        quant_metrics = first_expiry.get("quantMetrics", {})
        gamma_flip = quant_metrics.get("gamma_flip")  # May be None if OI is zero
        
        # Calcola walls
        walls = calculate_walls(options, spot, top_n=3)
        
        tv_data["symbols"][symbol] = {
            "spot": spot,
            "gamma_flip": gamma_flip,  # Will be None if cannot be calculated
            "call_walls": walls["call_walls"],
            "put_walls": walls["put_walls"]
        }
    
    return tv_data


def generate_legacy_content(dataset: OptionsDataset) -> Dict[str, str]:
    """
    Genera il contenuto in formato legacy per compatibilità con QuantPanel.
    Questo permette al frontend di usare lo stesso parsing esistente.
    """
    legacy_datasets = {}
    
    for expiry in dataset.expiries:
        lines = [f"STRIKE | TIPO | IV | OI | VOL"]
        for opt in expiry['options']:
            lines.append(
                f"{opt['strike']:.2f} | {opt['side']} | {opt['iv']:.4f} | {opt['oi']} | {opt['vol']}"
            )
        content = "\n".join(lines)
        
        # Chiave nel formato "TYPE (DATE)"
        key = f"{expiry['label']} ({expiry['date']})"
        legacy_datasets[key] = {
            "content": content,
            "type": expiry['label'],
            "date": expiry['date']
        }
    
    return legacy_datasets


# Simboli supportati - ETF e Indici
# SPY, QQQ: ETF
# SPX, NDX: Indici (richiedono prefisso ^ in yfinance)
ALL_SYMBOLS = ['SPY', 'QQQ', 'SPX', 'NDX']

# Symbol mapping per yfinance
SYMBOL_MAP: Dict[str, str] = {
    'SPY': 'SPY',    # ETF - no change
    'QQQ': 'QQQ',    # ETF - no change
    'SPX': '^SPX',   # S&P 500 Index - requires caret
    'NDX': '^NDX',   # Nasdaq 100 Index - requires caret
}

# Rate limiting: pausa tra simboli per evitare blocchi di yfinance
import time
RATE_LIMIT_DELAY = 2  # secondi tra un simbolo e l'altro


# ============================================================================
# FUNZIONI PER CALCOLO METRICHE QUANTITATIVE
# ============================================================================

def calculate_black_scholes_gamma(spot: float, strike: float, T: float, r: float, iv: float) -> float:
    """
    Calcola la gamma usando Black-Scholes.
    
    Args:
        spot: Prezzo corrente dell'underlying
        strike: Strike price
        T: Time to expiry in years
        r: Risk-free rate
        iv: Implied volatility
    
    Returns:
        Gamma value
    """
    if iv <= 0 or T <= 0 or spot <= 0:
        return 0.0
    
    try:
        d1 = (math.log(spot / strike) + (r + 0.5 * iv ** 2) * T) / (iv * math.sqrt(T))
        gamma = math.exp(-0.5 * d1 ** 2) / (spot * iv * math.sqrt(2 * math.pi * T))
        return gamma
    except (ValueError, ZeroDivisionError):
        return 0.0


def norm_cdf(x):
    """Standard normal cumulative distribution function (approximation using math.erf)."""
    return (1.0 + math.erf(x / math.sqrt(2.0))) / 2.0


def simulate_dealer_flows(options_data, spot, price_range_pct=0.03, steps=61):
    """
    Simulate dealer delta-hedging flows across a price range.
    
    For each price point in the range, calculate:
    - Total dealer delta exposure
    - Estimated hedging flow (buy/sell pressure)
    - Delta change rate (acceleration)
    
    Args:
        options_data: list of option dicts with 'strike', 'side', 'oi', 'iv', 'T'
        spot: current spot price
        price_range_pct: range to simulate (default ±3%)
        steps: number of price points (default 61 = every 0.1%)
    
    Returns: dict with price_flows, acceleration_zones, pinning_zones, or None on error
    """
    if not options_data or spot <= 0:
        return None
    
    # Price range
    price_low = spot * (1 - price_range_pct)
    price_high = spot * (1 + price_range_pct)
    prices = [price_low + (price_high - price_low) * i / (steps - 1) for i in range(steps)]
    
    # Calculate delta at each price point
    # Dealer positioning assumption:
    # - Short calls (sold to buyers) → negative delta contribution
    # - Long puts (bought from sellers) → negative delta contribution
    # - For simplicity: assume dealers are short calls and long puts
    
    price_flows = []
    r = 0.05  # risk-free rate
    
    for price in prices:
        total_delta = 0.0
        total_gamma = 0.0
        
        for opt in options_data:
            strike = opt.get('strike', 0)
            oi = opt.get('oi', opt.get('open_interest', 0))
            iv = opt.get('iv', opt.get('implied_volatility', 0.3))
            opt_side = opt.get('side', opt.get('type', '')).upper()
            
            if oi <= 0 or iv <= 0 or strike <= 0:
                continue
            
            # Time to expiry (use pre-computed T or estimate)
            T = opt.get('T', opt.get('time_to_expiry', 30/365))
            if T <= 0:
                T = 1/365  # minimum 1 day
            
            # Black-Scholes d1
            d1 = (math.log(price / strike) + (r + iv**2 / 2) * T) / (iv * math.sqrt(T))
            
            if opt_side == 'CALL':
                # Dealer short call → delta contribution is negative
                delta = -oi * math.exp(-r * T) * norm_cdf(d1)
            elif opt_side == 'PUT':
                # Dealer long put → delta contribution is negative
                delta = -oi * math.exp(-r * T) * (norm_cdf(d1) - 1)
            else:
                continue
            
            total_delta += delta
            
            # Gamma for reference
            gamma = oi * math.exp(-d1**2 / 2) / (price * iv * math.sqrt(2 * math.pi * T))
            total_gamma += gamma
        
        # Hedging flow: positive delta → dealers need to SELL to hedge (negative flow)
        #                negative delta → dealers need to BUY to hedge (positive flow)
        hedging_flow = -total_delta * 100  # Scale for readability
        
        price_flows.append({
            'price': round(price, 2),
            'delta': round(total_delta, 2),
            'hedging_flow': round(hedging_flow, 2),
            'gamma': round(total_gamma, 4)
        })
    
    if len(price_flows) < 3:
        return None
    
    # Calculate flow changes (acceleration)
    for i in range(1, len(price_flows)):
        flow_change = price_flows[i]['hedging_flow'] - price_flows[i-1]['hedging_flow']
        price_flows[i]['flow_change'] = round(flow_change, 2)
    price_flows[0]['flow_change'] = 0.0
    
    # Find acceleration zones (where |flow_change| > 2x average)
    avg_flow_change = sum(abs(pf.get('flow_change', 0)) for pf in price_flows) / len(price_flows)
    threshold = max(avg_flow_change * 2, 1.0)  # At least 1.0 to avoid noise
    
    acceleration_zones = []
    for pf in price_flows:
        if abs(pf.get('flow_change', 0)) > threshold:
            direction = 'buying_pressure' if pf['flow_change'] > 0 else 'selling_pressure'
            acceleration_zones.append({
                'price': pf['price'],
                'flow_change': pf['flow_change'],
                'direction': direction,
                'strength': round(abs(pf['flow_change']) / avg_flow_change, 1) if avg_flow_change > 0 else 0
            })
    
    # Sort by strength, keep top 5
    acceleration_zones.sort(key=lambda x: x['strength'], reverse=True)
    acceleration_zones = acceleration_zones[:5]
    
    # Find pinning zones (where hedging flow is near zero → minimal dealer activity)
    min_abs_flow = min(abs(pf['hedging_flow']) for pf in price_flows)
    pinning_threshold = max(min_abs_flow * 3, 10)  # Within 3x of minimum
    
    pinning_zones = []
    for pf in price_flows:
        if abs(pf['hedging_flow']) <= pinning_threshold:
            pinning_zones.append({
                'price': pf['price'],
                'flow': pf['hedging_flow'],
                'strength': round(1 - abs(pf['hedging_flow']) / pinning_threshold, 2) if pinning_threshold > 0 else 0
            })
    
    # Sort by strength, keep top 3
    pinning_zones.sort(key=lambda x: x['strength'], reverse=True)
    pinning_zones = pinning_zones[:3]
    
    # Find max acceleration
    max_accel = max(price_flows, key=lambda x: abs(x.get('flow_change', 0)))
    
    return {
        'price_flows': price_flows,
        'acceleration_zones': acceleration_zones,
        'pinning_zones': pinning_zones,
        'max_acceleration': {
            'price': max_accel['price'],
            'flow_change': max_accel.get('flow_change', 0),
            'direction': 'buying_pressure' if max_accel.get('flow_change', 0) > 0 else 'selling_pressure'
        },
        'spot_index': next((i for i, pf in enumerate(price_flows) if pf['price'] >= spot), len(price_flows) // 2),
        'price_range': {
            'low': round(price_low, 2),
            'high': round(price_high, 2),
            'step_pct': round(price_range_pct * 100 / (steps - 1), 3)
        }
    }


def flatten_options_for_simulation(expiries):
    """
    Flatten all options across expiries for dealer flow simulation.
    Adds time-to-expiry (T) to each option based on the expiry date.
    
    Args:
        expiries: list of expiry dicts, each with 'date' and 'options' keys
    
    Returns:
        Flat list of option dicts with added 'T' and 'expiry_key' fields
    """
    all_options = []
    
    for expiry in expiries:
        if not isinstance(expiry, dict):
            continue
        
        expiry_date = expiry.get('date', '')
        expiry_label = expiry.get('label', '')
        expiry_key = f"{expiry_label} ({expiry_date})" if expiry_date else expiry_label
        
        # Compute time to expiry for this expiry
        T = calculate_time_to_expiry(expiry_date) if expiry_date else 30/365
        
        options = expiry.get('options', [])
        for opt in options:
            opt_with_expiry = dict(opt)
            opt_with_expiry['expiry_key'] = expiry_key
            opt_with_expiry['T'] = T
            all_options.append(opt_with_expiry)
    
    return all_options


def calculate_total_gex(options: List[Dict[str, Any]], spot: float, T: float, r: float = 0.05) -> float:
    """
    Calcola il Gamma Exposure totale.
    
    Call GEX = +gamma * OI * 100 * spot^2 * 0.01
    Put GEX = -gamma * OI * 100 * spot^2 * 0.01
    
    Returns:
        Total GEX in billions
    """
    total_gex = 0.0
    
    for opt in options:
        oi = opt.get('oi', 0)
        iv = opt.get('iv', 0.3)  # Default IV if not available
        strike = opt.get('strike', 0)
        
        if oi <= 0 or strike <= 0:
            continue
        
        gamma = calculate_black_scholes_gamma(spot, strike, T, r, iv)
        gex = gamma * oi * 100 * spot * spot * 0.01
        
        # Call GEX is positive, Put GEX is negative
        if opt.get('side') == 'PUT':
            gex = -gex
        
        total_gex += gex
    
    return total_gex / 1e9  # Convert to billions


def calculate_gamma_flip(options: List[Dict[str, Any]], spot: float, T: float, r: float = 0.05) -> float:
    """
    Trova lo strike dove il GEX cumulativo passa da positivo a negativo.
    
    Returns:
        Strike price dove avviene il gamma flip
    """
    # Raggruppa opzioni per strike
    strikes_data: Dict[float, Dict] = {}
    
    for opt in options:
        strike = opt.get('strike', 0)
        if strike <= 0:
            continue
        
        # Filter strikes beyond 10% from spot
        if spot > 0:
            max_dist = spot * 0.10
            if abs(strike - spot) > max_dist:
                continue
        
        if strike not in strikes_data:
            strikes_data[strike] = {'call_oi': 0, 'put_oi': 0, 'call_iv': 0.3, 'put_iv': 0.3}
        
        if opt.get('side') == 'CALL':
            strikes_data[strike]['call_oi'] = opt.get('oi', 0)
            strikes_data[strike]['call_iv'] = opt.get('iv', 0.3)
        else:
            strikes_data[strike]['put_oi'] = opt.get('oi', 0)
            strikes_data[strike]['put_iv'] = opt.get('iv', 0.3)
    
    if not strikes_data:
        logger.warning("Cannot calculate gamma flip: no valid strikes data (options list may be empty)")
        return None
    
    # Calcola GEX cumulativo per strike
    cumulative_gex = 0.0
    gex_by_strike = []
    
    for strike in sorted(strikes_data.keys()):
        data = strikes_data[strike]
        
        call_gamma = calculate_black_scholes_gamma(spot, strike, T, r, data['call_iv'])
        put_gamma = calculate_black_scholes_gamma(spot, strike, T, r, data['put_iv'])
        
        call_gex = call_gamma * data['call_oi'] * 100 * spot * spot * 0.01
        put_gex = -put_gamma * data['put_oi'] * 100 * spot * spot * 0.01
        
        gex = (call_gex + put_gex) / 1e9
        cumulative_gex += gex
        gex_by_strike.append((strike, cumulative_gex))
    
    # Trova il flip point - Metodo 1: Cambio di segno (standard industriale)
    gamma_flip = None
    flip_method = None
    
    for i in range(1, len(gex_by_strike)):
        prev_gex = gex_by_strike[i-1][1]
        curr_gex = gex_by_strike[i][1]
        
        # Se il segno cambia, abbiamo un flip
        if prev_gex * curr_gex < 0:
            # Interpolazione lineare per trovare il punto esatto
            prev_strike = gex_by_strike[i-1][0]
            curr_strike = gex_by_strike[i][0]
            # Interpolazione più precisa basata sulla distanza dallo zero
            if abs(curr_gex - prev_gex) > 0:
                gamma_flip = prev_strike + (curr_strike - prev_strike) * abs(prev_gex) / abs(curr_gex - prev_gex)
            else:
                gamma_flip = (prev_strike + curr_strike) / 2
            flip_method = "crossing"
            logger.info(f"Gamma flip found via sign change at {gamma_flip:.2f}")
            break
    
    # Metodo 2: Estrapolazione se non c'è cambio di segno
    if gamma_flip is None and len(gex_by_strike) >= 2:
        try:
            # Usa regressione lineare per estrapolare dove il GEX attraverserebbe lo zero
            strikes = [x[0] for x in gex_by_strike]
            cum_gex = [x[1] for x in gex_by_strike]
            
            # Regressione lineare semplice: y = slope * x + intercept
            n = len(strikes)
            sum_x = sum(strikes)
            sum_y = sum(cum_gex)
            sum_xy = sum(x * y for x, y in zip(strikes, cum_gex))
            sum_xx = sum(x * x for x in strikes)
            
            denominator = n * sum_xx - sum_x * sum_x
            if denominator != 0:
                slope = (n * sum_xy - sum_x * sum_y) / denominator
                intercept = (sum_y * sum_xx - sum_x * sum_xy) / denominator
                
                # Trova dove la linea attraversa lo zero: 0 = slope * x + intercept => x = -intercept / slope
                if abs(slope) > 1e-10:  # Evita divisione per zero
                    extrapolated_flip = -intercept / slope
                    
                    # Verifica che il punto estrapolato sia ragionevole (entro 50% del range strike)
                    min_strike = min(strikes)
                    max_strike = max(strikes)
                    range_strike = max_strike - min_strike
                    reasonable_min = min_strike - 0.1 * range_strike
                    reasonable_max = max_strike + 0.1 * range_strike
                    
                    if reasonable_min <= extrapolated_flip <= reasonable_max:
                        gamma_flip = extrapolated_flip
                        flip_method = "extrapolated"
                        logger.info(f"Gamma flip extrapolated at {gamma_flip:.2f} (no sign change in range)")
        except Exception as e:
            logger.debug(f"Extrapolation failed: {e}")
    
    # Metodo 3: Fallback - trova strike con GEX cumulativo più vicino a zero
    if gamma_flip is None and gex_by_strike:
        closest_strike, closest_gex = min(gex_by_strike, key=lambda x: abs(x[1]))
        gamma_flip = closest_strike
        flip_method = "boundary"
        logger.info(f"Gamma flip (boundary) at {gamma_flip:.2f} (cumulative GEX: {closest_gex:.4f}B)")
    
    if gamma_flip is None:
        # Check if IV is the issue
        avg_iv = sum(opt.get('iv', 0) for opt in options) / len(options) if options else 0
        if avg_iv == 0:
            logger.warning("Cannot calculate gamma flip: IV is zero for all options (data quality issue)")
        else:
            logger.warning("Cannot calculate gamma flip: insufficient data")
        return None
    
    # Post-validation: reject flip points too far from spot
    if gamma_flip is not None and spot > 0:
        distance_pct = abs(gamma_flip - spot) / spot
        if distance_pct > 0.10:
            logger.warning(f"Gamma flip {gamma_flip:.2f} is {distance_pct*100:.1f}% from spot {spot:.2f} — unreliable, setting to None")
            gamma_flip = None
    
    if gamma_flip is None:
        return None
    
    logger.info(f"Gamma flip calculated: {gamma_flip:.2f} (method: {flip_method})")
    return round(gamma_flip, 2)


def calculate_gamma_flip_zone(options: List[Dict[str, Any]], spot: float, T: float, r: float = 0.05) -> Dict[str, Any]:
    """
    Calculate gamma flip as a zone with confidence interval using multiple methods.
    
    Instead of a single flip point, this returns a zone [lower, upper] with a
    confidence score based on how well multiple estimation methods agree.
    
    Methods:
    1. Crossing detection: Find where total GEX crosses zero (interpolation)
    2. Nearest-to-zero: Strike where cumulative GEX is closest to zero
    3. Weighted average: Inverse-GEX-weighted average of near-zero strikes
    
    Args:
        options: List of option dicts with 'strike', 'side', 'oi', 'iv'
        spot: Current spot price
        T: Time to expiry in years
        r: Risk-free rate
    
    Returns:
        dict with flip_point, flip_zone (lower/upper), confidence, methods used,
        or None if insufficient data
    """
    if not options or spot <= 0:
        return None
    
    # Group options by strike (same approach as calculate_gamma_flip)
    strikes_data: Dict[float, Dict] = {}
    
    for opt in options:
        strike = opt.get('strike', 0)
        if strike <= 0:
            continue
        
        # Filter strikes beyond 10% from spot
        if spot > 0:
            max_dist = spot * 0.10
            if abs(strike - spot) > max_dist:
                continue
        
        if strike not in strikes_data:
            strikes_data[strike] = {'call_oi': 0, 'put_oi': 0, 'call_iv': 0.3, 'put_iv': 0.3}
        
        if opt.get('side') == 'CALL':
            strikes_data[strike]['call_oi'] = opt.get('oi', 0)
            strikes_data[strike]['call_iv'] = opt.get('iv', 0.3)
        else:
            strikes_data[strike]['put_oi'] = opt.get('oi', 0)
            strikes_data[strike]['put_iv'] = opt.get('iv', 0.3)
    
    if len(strikes_data) < 3:
        return None
    
    # Calculate cumulative GEX per strike (same convention as calculate_gamma_flip)
    cumulative_gex = 0.0
    gex_by_strike = []
    
    for strike in sorted(strikes_data.keys()):
        data = strikes_data[strike]
        
        call_gamma = calculate_black_scholes_gamma(spot, strike, T, r, data['call_iv'])
        put_gamma = calculate_black_scholes_gamma(spot, strike, T, r, data['put_iv'])
        
        call_gex = call_gamma * data['call_oi'] * 100 * spot * spot * 0.01
        put_gex = -put_gamma * data['put_oi'] * 100 * spot * spot * 0.01
        
        gex = (call_gex + put_gex) / 1e9
        cumulative_gex += gex
        gex_by_strike.append((strike, cumulative_gex))
    
    if len(gex_by_strike) < 3:
        return None
    
    strikes = [x[0] for x in gex_by_strike]
    cum_gex = [x[1] for x in gex_by_strike]
    
    flip_estimates = []
    methods_used = []
    
    # Method 1: Crossing detection (where cumulative GEX crosses zero)
    for i in range(1, len(gex_by_strike)):
        prev_gex = gex_by_strike[i - 1][1]
        curr_gex = gex_by_strike[i][1]
        
        if prev_gex * curr_gex < 0:  # Sign change
            prev_strike = gex_by_strike[i - 1][0]
            curr_strike = gex_by_strike[i][0]
            denom = abs(curr_gex - prev_gex)
            if denom > 0:
                ratio = abs(prev_gex) / denom
                flip_price = prev_strike + ratio * (curr_strike - prev_strike)
            else:
                flip_price = (prev_strike + curr_strike) / 2
            flip_estimates.append(flip_price)
            methods_used.append('crossing')
            break  # Use first crossing
    
    # Method 2: Nearest-to-zero strike (boundary method)
    min_gex_idx = min(range(len(cum_gex)), key=lambda i: abs(cum_gex[i]))
    nearest_zero_strike = strikes[min_gex_idx]
    flip_estimates.append(nearest_zero_strike)
    methods_used.append('nearest_zero')
    
    # Method 3: Weighted average of near-zero strikes (within 10% of minimum |GEX|)
    min_abs_gex = abs(cum_gex[min_gex_idx])
    threshold = min_abs_gex * 1.1 + 1e-9  # 10% tolerance + small buffer
    near_zero_strikes = [(s, abs(g)) for s, g in zip(strikes, cum_gex) if abs(g) <= threshold]
    if len(near_zero_strikes) >= 2:
        weights = [1.0 / (abs_g + 1e-9) for _, abs_g in near_zero_strikes]
        total_weight = sum(weights)
        weighted_avg = sum(s * w for (s, _), w in zip(near_zero_strikes, weights)) / total_weight
        flip_estimates.append(weighted_avg)
        methods_used.append('weighted_average')
    
    if not flip_estimates:
        return None
    
    # Calculate zone from method estimates
    flip_point = sum(flip_estimates) / len(flip_estimates)
    
    if len(flip_estimates) >= 2:
        zone_lower = min(flip_estimates)
        zone_upper = max(flip_estimates)
    else:
        # Single estimate — use ±0.1% as minimum zone
        zone_lower = flip_point * 0.999
        zone_upper = flip_point * 1.001
    
    # Ensure minimum zone width of 0.2% of spot
    min_width = spot * 0.002
    if (zone_upper - zone_lower) < min_width:
        center = (zone_upper + zone_lower) / 2
        zone_lower = center - min_width / 2
        zone_upper = center + min_width / 2
    
    # Confidence based on method agreement
    if len(flip_estimates) >= 3:
        spread = (zone_upper - zone_lower) / flip_point * 100
        if spread < 0.3:
            confidence = 0.9
        elif spread < 0.5:
            confidence = 0.7
        else:
            confidence = 0.5
    elif len(flip_estimates) == 2:
        confidence = 0.6
    else:
        confidence = 0.3
    
    zone_width_pct = (zone_upper - zone_lower) / flip_point * 100
    
    return {
        'flip_point': round(flip_point, 2),
        'flip_zone_lower': round(zone_lower, 2),
        'flip_zone_upper': round(zone_upper, 2),
        'zone_width_pct': round(zone_width_pct, 3),
        'confidence': round(confidence, 2),
        'methods_used': methods_used,
        'method_estimates': [round(e, 2) for e in flip_estimates],
        'spot_vs_flip': 'above' if spot > flip_point else 'below',
        'distance_from_spot_pct': round((spot - flip_point) / spot * 100, 3)
    }


def calculate_max_pain(options: List[Dict[str, Any]], spot: float) -> float:
    """
    Calcola il Max Pain - lo strike dove la perdita totale per option buyers è massima.
    
    Per ogni strike, calcola il valore totale delle opzioni alla scadenza.
    Il Max Pain è lo strike con valore minimo (max loss per buyers).
    
    Returns:
        Strike price del max pain
    """
    if not options:
        logger.warning("Cannot calculate max pain: options list is empty")
        return None
    
    # Raggruppa per strike
    strikes_data: Dict[float, Dict] = {}
    
    for opt in options:
        strike = opt.get('strike', 0)
        if strike <= 0:
            continue
        
        if strike not in strikes_data:
            strikes_data[strike] = {'call_oi': 0, 'put_oi': 0}
        
        if opt.get('side') == 'CALL':
            strikes_data[strike]['call_oi'] = opt.get('oi', 0)
        else:
            strikes_data[strike]['put_oi'] = opt.get('oi', 0)
    
    if not strikes_data:
        logger.warning("Cannot calculate max pain: no valid strikes data (OI may be zero - market closed)")
        return None
    
    # Check if all OI is zero
    total_oi = sum(d['call_oi'] + d['put_oi'] for d in strikes_data.values())
    if total_oi == 0:
        logger.warning("Cannot calculate max pain: total OI is zero (market may be closed)")
        return None
    
    # Testa ogni strike come possibile prezzo alla scadenza
    test_strikes = sorted(strikes_data.keys())
    
    # Filter test strikes to within 10% of spot
    if spot > 0:
        max_dist = spot * 0.10
        test_strikes = [s for s in test_strikes if abs(s - spot) <= max_dist]
    
    if not test_strikes:
        logger.warning("Cannot calculate max pain: no strikes within 10% of spot")
        return None
    
    min_value = float('inf')
    max_pain = None
    
    for test_strike in test_strikes:
        total_value = 0
        
        for strike, data in strikes_data.items():
            # Call value at expiration = max(0, test_strike - strike) * call_oi
            call_value = max(0, test_strike - strike) * data['call_oi']
            # Put value at expiration = max(0, strike - test_strike) * put_oi
            put_value = max(0, strike - test_strike) * data['put_oi']
            total_value += (call_value + put_value) * 100  # Contract multiplier
        
        if total_value < min_value:
            min_value = total_value
            max_pain = test_strike
    
    if max_pain is None:
        logger.warning("Cannot calculate max pain: no valid strike found")
        return None
    
    if max_pain is not None and spot > 0:
        distance_pct = abs(max_pain - spot) / spot
        if distance_pct > 0.10:
            logger.warning(f"Max pain {max_pain:.2f} is {distance_pct*100:.1f}% from spot — unreliable, setting to None")
            return None
    
    return round(max_pain, 2)


def calculate_skew_type(options: List[Dict[str, Any]], spot: float) -> str:
    """
    Determina il tipo di skew confrontando OI di calls vs puts ATM.
    
    ATM è definito come spot ± 2%.
    
    Returns:
        "CALL" se call_OI > put_OI * 1.2
        "PUT" se put_OI > call_OI * 1.2
        "NEUTRAL" altrimenti
    """
    lower_bound = spot * 0.98
    upper_bound = spot * 1.02
    
    call_oi_atm = 0
    put_oi_atm = 0
    
    for opt in options:
        strike = opt.get('strike', 0)
        if lower_bound <= strike <= upper_bound:
            if opt.get('side') == 'CALL':
                call_oi_atm += opt.get('oi', 0)
            else:
                put_oi_atm += opt.get('oi', 0)
    
    if call_oi_atm == 0 and put_oi_atm == 0:
        return "NEUTRAL"
    
    if call_oi_atm > put_oi_atm * 1.2:
        return "CALL"
    elif put_oi_atm > call_oi_atm * 1.2:
        return "PUT"
    else:
        return "NEUTRAL"


def calculate_put_call_ratios(options: List[Dict[str, Any]]) -> Dict[str, float]:
    """
    Calcola diverse varianti del Put/Call Ratio.
    
    Returns:
        {
            "oi_based": float,       # put_oi / call_oi
            "volume_based": float,   # put_vol / call_vol
            "weighted": float,       # weighted average based on OI
            "delta_adjusted": float  # (put_oi * put_delta) / (call_oi * call_delta)
        }
    """
    total_call_oi = 0
    total_put_oi = 0
    total_call_vol = 0
    total_put_vol = 0
    weighted_put_oi = 0.0
    weighted_call_oi = 0.0
    
    for opt in options:
        oi = opt.get('oi', 0)
        vol = opt.get('vol', 0)
        strike = opt.get('strike', 0)
        
        if opt.get('side') == 'CALL':
            total_call_oi += oi
            total_call_vol += vol
            # Weight by strike distance from typical ATM (higher weight for ATM options)
            weighted_call_oi += oi
        else:
            total_put_oi += oi
            total_put_vol += vol
            weighted_put_oi += oi
    
    # Calculate ratios with safe division
    oi_based = total_put_oi / total_call_oi if total_call_oi > 0 else 1.0
    volume_based = total_put_vol / total_call_vol if total_call_vol > 0 else 1.0
    
    # Weighted ratio - gives more weight to higher OI
    total_weighted = weighted_put_oi + weighted_call_oi
    if total_weighted > 0:
        weighted = weighted_put_oi / weighted_call_oi if weighted_call_oi > 0 else 2.0
    else:
        weighted = 1.0
    
    # Delta-adjusted ratio (simplified - using IV as proxy for delta)
    # In practice, delta ≈ 0.5 for ATM options, varies for ITM/OTM
    # Using a simplified approximation based on moneyness
    delta_adjusted = oi_based  # Fallback to OI-based if we can't calculate delta
    
    return {
        "oi_based": round(oi_based, 4),
        "volume_based": round(volume_based, 4),
        "weighted": round(weighted, 4),
        "delta_adjusted": round(delta_adjusted, 4)
    }


def calculate_volatility_skew(options: List[Dict[str, Any]], spot: float) -> Dict[str, Any]:
    """
    Calcola il volatility skew per determinare il sentiment di mercato.
    
    Returns:
        {
            "put_iv_avg": float,      # Average IV for puts
            "call_iv_avg": float,     # Average IV for calls
            "skew_ratio": float,      # put_iv_avg / call_iv_avg
            "skew_type": str,         # 'smirk', 'reverse_smirk', 'flat'
            "sentiment": str          # 'bearish', 'bullish', 'neutral'
        }
    """
    put_ivs = []
    call_ivs = []
    put_oi_weights = []
    call_oi_weights = []
    
    # Filter options near the money (±10% of spot)
    lower_bound = spot * 0.90
    upper_bound = spot * 1.10
    
    for opt in options:
        strike = opt.get('strike', 0)
        if not (lower_bound <= strike <= upper_bound):
            continue
            
        iv = opt.get('iv', 0)
        oi = opt.get('oi', 0)
        
        if iv <= 0 or iv > 2.0:  # Skip IV > 200%
            continue
        
        if opt.get('side') == 'PUT':
            put_ivs.append(iv)
            put_oi_weights.append(oi)
        else:
            call_ivs.append(iv)
            call_oi_weights.append(oi)
    
    # Calculate weighted average IV
    def weighted_avg(values, weights):
        if not values or sum(weights) == 0:
            return 0.0
        return sum(v * w for v, w in zip(values, weights)) / sum(weights)
    
    put_iv_avg = weighted_avg(put_ivs, put_oi_weights) if put_ivs else DEFAULT_IV
    call_iv_avg = weighted_avg(call_ivs, call_oi_weights) if call_ivs else DEFAULT_IV
    
    # Calculate skew ratio
    if call_iv_avg > 0:
        skew_ratio = put_iv_avg / call_iv_avg
    else:
        skew_ratio = 1.0
    
    # Determine skew type and sentiment
    if skew_ratio > 1.2:
        skew_type = "smirk"  # Puts more expensive = fear
        sentiment = "bearish"
    elif skew_ratio < 0.9:
        skew_type = "reverse_smirk"  # Calls more expensive = euphoria
        sentiment = "bullish"
    else:
        skew_type = "flat"
        sentiment = "neutral"
    
    return {
        "put_iv_avg": round(put_iv_avg, 2),
        "call_iv_avg": round(call_iv_avg, 2),
        "skew_ratio": round(skew_ratio, 4),
        "skew_type": skew_type,
        "sentiment": sentiment
    }


def calculate_gex_by_strike(options: List[Dict[str, Any]], spot: float, T: float, r: float = 0.05) -> List[Dict[str, Any]]:
    """
    Calcola il Gamma Exposure per ogni strike.
    
    Returns:
        List of {
            "strike": float,
            "gex": float,           # in billions
            "cumulative_gex": float  # cumulative GEX up to this strike
        }
    """
    # Group options by strike
    strikes_data: Dict[float, Dict] = {}
    
    for opt in options:
        strike = opt.get('strike', 0)
        if strike <= 0:
            continue
        
        if strike not in strikes_data:
            strikes_data[strike] = {'call_oi': 0, 'put_oi': 0, 'call_iv': 0.3, 'put_iv': 0.3}
        
        if opt.get('side') == 'CALL':
            strikes_data[strike]['call_oi'] = opt.get('oi', 0)
            strikes_data[strike]['call_iv'] = opt.get('iv', 0.3)
        else:
            strikes_data[strike]['put_oi'] = opt.get('oi', 0)
            strikes_data[strike]['put_iv'] = opt.get('iv', 0.3)
    
    if not strikes_data:
        return []
    
    # Calculate GEX for each strike
    gex_list = []
    cumulative_gex = 0.0
    
    for strike in sorted(strikes_data.keys()):
        data = strikes_data[strike]
        
        call_gamma = calculate_black_scholes_gamma(spot, strike, T, r, data['call_iv'])
        put_gamma = calculate_black_scholes_gamma(spot, strike, T, r, data['put_iv'])
        
        # Call GEX is positive, Put GEX is negative
        call_gex = call_gamma * data['call_oi'] * 100 * spot * spot * 0.01
        put_gex = -put_gamma * data['put_oi'] * 100 * spot * spot * 0.01
        
        gex = (call_gex + put_gex) / 1e9  # Convert to billions
        cumulative_gex += gex
        
        gex_list.append({
            "strike": strike,
            "gex": round(gex, 6),
            "cumulative_gex": round(cumulative_gex, 6)
        })
    
    return gex_list


def calculate_time_to_expiry(expiry_date: str) -> float:
    """
    Calcola il time to expiry in anni dalla data odierna.
    
    Args:
        expiry_date: Data di scadenza in formato 'YYYY-MM-DD'
    
    Returns:
        Time to expiry in anni (minimo 1/365 per evitare divisioni per zero)
    """
    try:
        expiry = datetime.strptime(expiry_date, '%Y-%m-%d')
        now = datetime.now()
        days = max((expiry - now).days, 1)
        return days / 365.0
    except ValueError:
        return 1 / 365.0  # Default 1 giorno


def calculate_quant_metrics(options: List[Dict[str, Any]], spot: float, expiry_date: str) -> Dict[str, Any]:
    """
    Calcola tutte le metriche quantitative per una expiry.
    
    Returns:
        {
            "gamma_flip": float,
            "max_pain": float,
            "total_gex": float,
            "put_call_ratios": {...},
            "volatility_skew": {...},
            "gex_by_strike": [...]
        }
    """
    if not options:
        logger.warning("Returning None for gamma_flip/max_pain - insufficient options data (options list is empty)")
        return {
            "gamma_flip": None,
            "gamma_flip_zone": None,
            "max_pain": None,
            "total_gex": 0.0,
            "put_call_ratios": {
                "oi_based": 1.0,
                "volume_based": 1.0,
                "weighted": 1.0,
                "delta_adjusted": 1.0
            },
            "volatility_skew": {
                "put_iv_avg": 0.0,
                "call_iv_avg": 0.0,
                "skew_ratio": 1.0,
                "skew_type": "flat",
                "sentiment": "neutral"
            },
            "gex_by_strike": []
        }
    
    # Check for valid IV data before calculating gamma flip
    valid_iv_count = sum(1 for opt in options if opt.get('iv', 0) > 0)
    if valid_iv_count < len(options) * 0.10:  # Less than 10% have valid IV
        logger.warning(f"Low IV data quality: only {valid_iv_count}/{len(options)} options have valid IV")
    
    T = calculate_time_to_expiry(expiry_date)
    r = 0.05  # Risk-free rate assumption
    
    gamma_flip = calculate_gamma_flip(options, spot, T, r)
    gamma_flip_zone = calculate_gamma_flip_zone(options, spot, T, r)
    max_pain = calculate_max_pain(options, spot)
    total_gex = calculate_total_gex(options, spot, T, r)
    put_call_ratios = calculate_put_call_ratios(options)
    volatility_skew = calculate_volatility_skew(options, spot)
    gex_by_strike = calculate_gex_by_strike(options, spot, T, r)
    
    return {
        "gamma_flip": gamma_flip,
        "gamma_flip_zone": gamma_flip_zone,
        "max_pain": max_pain,
        "total_gex": round(total_gex, 6),
        "put_call_ratios": put_call_ratios,
        "volatility_skew": volatility_skew,
        "gex_by_strike": gex_by_strike
    }


# ============================================================================
# FUNZIONE PER AGGREGAZIONE DATI AI
# ============================================================================

def calculate_significance_score(strike_data: Dict, spot: float,
                                  max_oi: int, max_vol: int, avg_iv: float) -> float:
    """
    Calculate significance score for a strike.
    Score = 35% OI + 20% Vol + 20% Vol/OI Ratio + 15% Proximity + 10% IV
    """
    total_oi = strike_data['call_oi'] + strike_data['put_oi']
    total_vol = strike_data['call_vol'] + strike_data['put_vol']
    avg_strike_iv = (strike_data['call_iv'] + strike_data['put_iv']) / 2
    
    # 1. OI Score (0-35): Normalized by max OI
    oi_score = (total_oi / max_oi) * 35 if max_oi > 0 else 0
    
    # 2. Volume Score (0-20): Normalized by max volume
    vol_score = (total_vol / max_vol) * 20 if max_vol > 0 else 0
    
    # 3. Vol/OI Ratio Score (0-20): Unusual activity detection
    vol_oi_ratio = total_vol / total_oi if total_oi > 0 else 0
    vol_oi_score = min(vol_oi_ratio, 2) * 10  # Cap at 2x ratio
    
    # 4. Proximity Score (0-15): Gaussian decay from spot
    distance_pct = abs(strike_data['strike'] - spot) / spot if spot > 0 else 0
    proximity_score = math.exp(-((distance_pct / 0.03) ** 2)) * 15
    
    # 5. IV Extremity Score (0-10): Deviation from average IV
    iv_deviation = abs(avg_strike_iv - avg_iv) / avg_iv if avg_iv > 0 else 0
    iv_score = min(iv_deviation, 0.5) * 20
    
    return oi_score + vol_score + vol_oi_score + proximity_score + iv_score


def create_ai_ready_data(expiries: List[Dict[str, Any]], spot: float) -> Dict[str, Any]:
    """
    Crea un dataset aggregato e ottimizzato per l'analisi AI.
    
    Questo riduce il numero di token mantenendo il valore analitico:
    - Filtra strike entro ±5% del prezzo spot
    - Aggrega opzioni per strike (combina call/put)
    - Include metriche pre-calcolate
    
    Args:
        expiries: Lista di expiry data con options
        spot: Prezzo spot corrente
    
    Returns:
        {
            "spot": float,
            "expiries": {
                "0DTE": {
                    "date": str,
                    "strikes": [...],
                    "totals": {...}
                },
                ...
            },
            "precalc_metrics": {
                "gamma_flip": float,
                "total_gex": float,
                "max_pain": float
            }
        }
    """
    spot_range = spot * 0.05  # ±5% of spot
    lower_bound = spot - spot_range
    upper_bound = spot + spot_range
    
    aggregated_expiries = {}
    all_metrics = []  # For calculating aggregate metrics
    
    for expiry in expiries:
        label = expiry.get('label', 'UNKNOWN')
        date = expiry.get('date', 'N/A')
        options = expiry.get('options', [])
        quant_metrics = expiry.get('quantMetrics', {})
        
        # Group options by strike
        strikes_data: Dict[float, Dict] = {}
        
        for opt in options:
            strike = opt.get('strike', 0)
            
            # Filter strikes within ±5% of spot
            if not (lower_bound <= strike <= upper_bound):
                continue
            
            if strike not in strikes_data:
                strikes_data[strike] = {
                    'call_oi': 0,
                    'put_oi': 0,
                    'call_vol': 0,
                    'put_vol': 0,
                    'call_iv': 0.0,
                    'put_iv': 0.0,
                    'call_iv_count': 0,
                    'put_iv_count': 0
                }
            
            if opt.get('side') == 'CALL':
                strikes_data[strike]['call_oi'] += opt.get('oi', 0)
                strikes_data[strike]['call_vol'] += opt.get('vol', 0)
                if opt.get('iv', 0) > 0:
                    strikes_data[strike]['call_iv'] += opt.get('iv', 0)
                    strikes_data[strike]['call_iv_count'] += 1
            else:
                strikes_data[strike]['put_oi'] += opt.get('oi', 0)
                strikes_data[strike]['put_vol'] += opt.get('vol', 0)
                if opt.get('iv', 0) > 0:
                    strikes_data[strike]['put_iv'] += opt.get('iv', 0)
                    strikes_data[strike]['put_iv_count'] += 1
        
        # Build strikes list with averaged IVs first
        all_strikes = []
        for strike, data in strikes_data.items():
            # Average IV if multiple options per strike
            call_iv = data['call_iv'] / data['call_iv_count'] if data['call_iv_count'] > 0 else 0
            put_iv = data['put_iv'] / data['put_iv_count'] if data['put_iv_count'] > 0 else 0
            
            all_strikes.append({
                "strike": strike,
                "call_oi": data['call_oi'],
                "put_oi": data['put_oi'],
                "call_vol": data['call_vol'],
                "put_vol": data['put_vol'],
                "call_iv": round(call_iv, 4),
                "put_iv": round(put_iv, 4)
            })
        
        # Calculate normalization metrics for significance score
        max_oi = max((s['call_oi'] + s['put_oi']) for s in all_strikes) if all_strikes else 1
        max_vol = max((s['call_vol'] + s['put_vol']) for s in all_strikes) if all_strikes else 1
        avg_iv = sum((s['call_iv'] + s['put_iv']) / 2 for s in all_strikes) / len(all_strikes) if all_strikes else 0
        
        # Calculate scores and sort by significance
        scored_strikes = [
            (strike_data, calculate_significance_score(strike_data, spot, max_oi, max_vol, avg_iv))
            for strike_data in all_strikes
        ]
        scored_strikes.sort(key=lambda x: x[1], reverse=True)
        
        # Always include ATM strikes (within 1% of spot)
        atm_strike_set = set()
        for strike_data in all_strikes:
            if spot > 0 and abs(strike_data['strike'] - spot) / spot <= 0.01:
                atm_strike_set.add(strike_data['strike'])
        
        # Build final list: ATM + top scored
        selected_strikes = set(atm_strike_set)
        strikes_list = []
        for strike_data, score in scored_strikes:
            if len(strikes_list) >= 30:  # Max 30 strikes per expiry
                break
            if strike_data['strike'] not in selected_strikes:
                strikes_list.append(strike_data)
                selected_strikes.add(strike_data['strike'])
        
        # Sort final list by strike price for readability
        strikes_list.sort(key=lambda x: x['strike'])
        
        # Calculate totals
        total_call_oi = sum(s['call_oi'] for s in strikes_list)
        total_put_oi = sum(s['put_oi'] for s in strikes_list)
        total_call_vol = sum(s['call_vol'] for s in strikes_list)
        total_put_vol = sum(s['put_vol'] for s in strikes_list)
        
        aggregated_expiries[label] = {
            "date": date,
            "strikes": strikes_list,
            "totals": {
                "call_oi": total_call_oi,
                "put_oi": total_put_oi,
                "call_vol": total_call_vol,
                "put_vol": total_put_vol
            }
        }
        
        # Collect metrics for aggregation
        if quant_metrics:
            all_metrics.append(quant_metrics)
    
    # Calculate aggregate pre-calculated metrics
    precalc_metrics = {
        "gamma_flip": None,  # Default to None instead of spot
        "total_gex": 0.0,
        "max_pain": None  # Default to None instead of spot
    }
    
    if all_metrics:
        # Use weighted average based on OI totals
        total_weight = 0
        weighted_gamma_flip = 0.0
        weighted_total_gex = 0.0
        weighted_max_pain = 0.0
        gamma_flip_count = 0
        max_pain_count = 0
        
        for i, metrics in enumerate(all_metrics):
            # Use expiry label to determine weight (0DTE highest weight)
            expiry_data = expiries[i] if i < len(expiries) else {}
            label = expiry_data.get('label', '')
            
            if label == '0DTE':
                weight = 3.0
            elif label.startswith('WEEKLY'):
                weight = 2.0
            else:
                weight = 1.0
            
            # Only include gamma_flip in weighted average if not None
            gf = metrics.get('gamma_flip')
            if gf is not None:
                weighted_gamma_flip += gf * weight
                gamma_flip_count += weight
            
            weighted_total_gex += metrics.get('total_gex', 0) * weight
            
            # Only include max_pain in weighted average if not None
            mp = metrics.get('max_pain')
            if mp is not None:
                weighted_max_pain += mp * weight
                max_pain_count += weight
            
            total_weight += weight
        
        if total_weight > 0:
            precalc_metrics = {
                "gamma_flip": round(weighted_gamma_flip / gamma_flip_count, 2) if gamma_flip_count > 0 else None,
                "total_gex": round(weighted_total_gex / total_weight, 4),
                "max_pain": round(weighted_max_pain / max_pain_count, 2) if max_pain_count > 0 else None
            }
    
    return {
        "spot": spot,
        "expiries": aggregated_expiries,
        "precalc_metrics": precalc_metrics
    }


# ============================================================================
# FUNZIONI PER SELEZIONE LIVELLI IMPORTANTI
# ============================================================================

def find_resonance_levels(expiries: List[Dict], spot: float, tolerance_pct: float = 0.005) -> List[Dict]:
    """
    Trova i livelli di RESONANCE - strike presenti in TUTTE e 3 le scadenze.
    
    Args:
        expiries: Lista di expiry data con options
        spot: Prezzo spot corrente
        tolerance_pct: Tolleranza percentuale per considerare strike uguali (default 0.5%)
    
    Returns:
        Lista di max 2 strike più vicini allo spot
    """
    if len(expiries) < 3:
        return []
    
    # Estrai tutti gli strike da ogni expiry
    all_strikes_by_expiry = []
    for expiry in expiries:
        strikes = set()
        for opt in expiry.get('options', []):
            strikes.add(round(opt['strike'], 2))
        all_strikes_by_expiry.append(strikes)
    
    # Trova strike comuni con tolleranza
    # Per ogni strike nella prima expiry, controlla se esiste in tutte le altre
    common_strikes = []
    
    for strike in all_strikes_by_expiry[0]:
        found_in_all = True
        for other_strikes in all_strikes_by_expiry[1:]:
            # Cerca strike simile entro tolleranza
            found = False
            for other_strike in other_strikes:
                if abs(other_strike - strike) / strike <= tolerance_pct:
                    found = True
                    break
            if not found:
                found_in_all = False
                break
        
        if found_in_all:
            common_strikes.append(strike)
    
    # Ordina per distanza dallo spot e prendi i 2 più vicini
    common_strikes.sort(key=lambda s: abs(s - spot))
    
    return [
        {"strike": s, "distance_pct": round(abs(s - spot) / spot * 100, 2)}
        for s in common_strikes[:2]
    ]


def find_confluence_levels(expiries: List[Dict], spot: float, tolerance_pct: float = 0.01) -> List[Dict]:
    """
    Trova i livelli di CONFLUENCE - strike presenti in ESATTAMENTE 2 scadenze.
    
    Args:
        expiries: Lista di expiry data con options
        spot: Prezzo spot corrente
        tolerance_pct: Tolleranza percentuale per considerare strike uguali (default 1%)
    
    Returns:
        Lista di max 5 strike più vicini allo spot
    """
    if len(expiries) < 2:
        return []
    
    # Estrai tutti gli strike da ogni expiry
    all_strikes_by_expiry = []
    for expiry in expiries:
        strikes = set()
        for opt in expiry.get('options', []):
            strikes.add(round(opt['strike'], 2))
        all_strikes_by_expiry.append(strikes)
    
    # Conta quante volte ogni strike appare (con tolleranza)
    strike_counts = {}  # strike -> count
    
    for i, expiry_strikes in enumerate(all_strikes_by_expiry):
        for strike in expiry_strikes:
            # Cerca se esiste già uno strike simile
            found_key = None
            for existing_strike in strike_counts.keys():
                if abs(existing_strike - strike) / max(existing_strike, strike) <= tolerance_pct:
                    found_key = existing_strike
                    break
            
            if found_key is not None:
                strike_counts[found_key] += 1
            else:
                if strike not in strike_counts:
                    strike_counts[strike] = 1
    
    # Filtra solo quelli che appaiono esattamente 2 volte
    confluence_strikes = [s for s, count in strike_counts.items() if count == 2]
    
    # Ordina per distanza dallo spot e prendi i 5 più vicini
    confluence_strikes.sort(key=lambda s: abs(s - spot))
    
    return [
        {"strike": s, "distance_pct": round(abs(s - spot) / spot * 100, 2)}
        for s in confluence_strikes[:5]
    ]


def get_options_at_strike(options: List[Dict], strike: float, tolerance_pct: float = 0.01) -> Dict[str, Any]:
    """
    Find call and put options at a specific strike price within tolerance.
    
    Args:
        options: List of option dictionaries for a single expiry
        strike: Target strike price
        tolerance_pct: Tolerance percentage for strike matching (default 1%)
    
    Returns:
        {
            'call_oi': int,
            'put_oi': int,
            'call_vol': int,
            'put_vol': int,
            'call_gamma': float,
            'put_gamma': float
        }
    """
    result = {
        'call_oi': 0,
        'put_oi': 0,
        'call_vol': 0,
        'put_vol': 0,
        'call_gamma': 0.0,
        'put_gamma': 0.0
    }
    
    for opt in options:
        opt_strike = opt.get('strike', 0)
        # Check if strike is within tolerance
        if abs(opt_strike - strike) / max(strike, opt_strike, 1) > tolerance_pct:
            continue
        
        if opt.get('side') == 'CALL':
            result['call_oi'] += opt.get('oi', 0)
            result['call_vol'] += opt.get('vol', 0)
            # Gamma will be calculated separately if needed
        else:  # PUT
            result['put_oi'] += opt.get('oi', 0)
            result['put_vol'] += opt.get('vol', 0)
    
    return result


def find_confluence_levels_enhanced(expiries: List[Dict], spot: float, tolerance_pct: float = 0.01) -> List[Dict]:
    """
    Trova i livelli di CONFLUENCE con metriche dettagliate per expiry.
    
    Args:
        expiries: Lista di expiry data con options e quantMetrics
        spot: Prezzo spot corrente
        tolerance_pct: Tolleranza percentuale per considerare strike uguali (default 1%)
    
    Returns:
        Lista di max 5 strike con dettagli completi:
        {
            "strike": float,
            "expiries": ["0DTE", "WEEKLY"],
            "expiry_label": "0DTE+WEEKLY",
            "total_call_oi": int,
            "total_put_oi": int,
            "total_call_vol": int,
            "total_put_vol": int,
            "put_call_ratio": float,
            "total_gamma": float,
            "expiry_details": [...]
        }
    """
    if len(expiries) < 2:
        return []
    
    # Build strike presence map: strike -> list of (expiry_index, expiry_label)
    strike_presence = {}  # strike -> [(expiry_idx, expiry_label, actual_strike), ...]
    
    for idx, expiry in enumerate(expiries):
        expiry_label = expiry.get('label', 'UNKNOWN')
        options = expiry.get('options', [])
        
        for opt in options:
            opt_strike = round(opt.get('strike', 0), 2)
            if opt_strike <= 0:
                continue
            
            # Check if we already have a similar strike
            found_key = None
            for existing_strike in strike_presence.keys():
                if abs(existing_strike - opt_strike) / max(existing_strike, opt_strike) <= tolerance_pct:
                    found_key = existing_strike
                    break
            
            if found_key is not None:
                # Add to existing if not already from this expiry
                existing_expiry_indices = [e[0] for e in strike_presence[found_key]]
                if idx not in existing_expiry_indices:
                    strike_presence[found_key].append((idx, expiry_label, opt_strike))
            else:
                if opt_strike not in strike_presence:
                    strike_presence[opt_strike] = [(idx, expiry_label, opt_strike)]
    
    # Filter strikes that appear in exactly 2 expiries
    confluence_strikes = {
        s: exp_list for s, exp_list in strike_presence.items()
        if len(exp_list) == 2
    }
    
    # Sort by distance from spot
    sorted_strikes = sorted(confluence_strikes.keys(), key=lambda s: abs(s - spot))
    
    # Build enhanced results
    results = []
    for strike in sorted_strikes[:5]:  # Max 5 confluence levels
        expiry_info = confluence_strikes[strike]
        expiry_labels = [e[1] for e in expiry_info]
        
        # Aggregate metrics
        total_call_oi = 0
        total_put_oi = 0
        total_call_vol = 0
        total_put_vol = 0
        total_gamma = 0.0
        
        expiry_details = []
        
        for exp_idx, exp_label, actual_strike in expiry_info:
            expiry = expiries[exp_idx]
            options = expiry.get('options', [])
            quant_metrics = expiry.get('quantMetrics', {})
            
            # Get options at this strike
            opts_at_strike = get_options_at_strike(options, actual_strike, tolerance_pct=tolerance_pct)
            
            # Calculate gamma for this strike using Black-Scholes
            expiry_date = expiry.get('date', '')
            T = calculate_time_to_expiry(expiry_date)
            r = 0.05
            
            # Get IV from options (average of call and put IV)
            call_iv = 0.3
            put_iv = 0.3
            for opt in options:
                if abs(opt.get('strike', 0) - actual_strike) / max(actual_strike, 1) <= tolerance_pct:
                    if opt.get('side') == 'CALL':
                        call_iv = opt.get('iv', 0.3)
                    else:
                        put_iv = opt.get('iv', 0.3)
            
            call_gamma = calculate_black_scholes_gamma(spot, actual_strike, T, r, call_iv)
            put_gamma = calculate_black_scholes_gamma(spot, actual_strike, T, r, put_iv)
            
            # Update totals
            total_call_oi += opts_at_strike['call_oi']
            total_put_oi += opts_at_strike['put_oi']
            total_call_vol += opts_at_strike['call_vol']
            total_put_vol += opts_at_strike['put_vol']
            total_gamma += (call_gamma * opts_at_strike['call_oi'] + put_gamma * opts_at_strike['put_oi']) * 100 * spot * spot * 0.01 / 1e9
            
            # Add expiry detail
            expiry_details.append({
                'expiry_label': exp_label,
                'call_oi': opts_at_strike['call_oi'],
                'put_oi': opts_at_strike['put_oi'],
                'call_vol': opts_at_strike['call_vol'],
                'put_vol': opts_at_strike['put_vol'],
                'call_gamma': round(call_gamma, 6),
                'put_gamma': round(put_gamma, 6)
            })
        
        # Calculate put/call ratio
        if total_call_oi > 0:
            put_call_ratio = round(total_put_oi / total_call_oi, 2)
        else:
            put_call_ratio = 0.0 if total_put_oi == 0 else 99.99
        
        results.append({
            'strike': round(strike, 2),
            'expiries': expiry_labels,
            'expiry_label': '+'.join(expiry_labels),
            'total_call_oi': total_call_oi,
            'total_put_oi': total_put_oi,
            'total_call_vol': total_call_vol,
            'total_put_vol': total_put_vol,
            'put_call_ratio': put_call_ratio,
            'total_gamma': round(total_gamma, 6),
            'expiry_details': expiry_details
        })
    
    return results


def find_resonance_levels_enhanced(expiries: List[Dict], spot: float, tolerance_pct: float = 0.005) -> List[Dict]:
    """
    Trova i livelli di RESONANCE con metriche dettagliate per expiry.
    
    Args:
        expiries: Lista di expiry data con options e quantMetrics
        spot: Prezzo spot corrente
        tolerance_pct: Tolleranza percentuale per considerare strike uguali (default 0.5%)
    
    Returns:
        Lista di max 2 strike con dettagli completi:
        {
            "strike": float,
            "expiries": ["0DTE", "WEEKLY", "MONTHLY"],
            "expiry_label": "0DTE+WEEKLY+MONTHLY",
            "total_call_oi": int,
            "total_put_oi": int,
            "total_call_vol": int,
            "total_put_vol": int,
            "put_call_ratio": float,
            "total_gamma": float,
            "expiry_details": [...]
        }
    """
    if len(expiries) < 3:
        return []
    
    # Build strike presence map: strike -> list of (expiry_index, expiry_label)
    strike_presence = {}  # strike -> [(expiry_idx, expiry_label, actual_strike), ...]
    
    for idx, expiry in enumerate(expiries):
        expiry_label = expiry.get('label', 'UNKNOWN')
        options = expiry.get('options', [])
        
        for opt in options:
            opt_strike = round(opt.get('strike', 0), 2)
            if opt_strike <= 0:
                continue
            
            # Check if we already have a similar strike
            found_key = None
            for existing_strike in strike_presence.keys():
                if abs(existing_strike - opt_strike) / max(existing_strike, opt_strike) <= tolerance_pct:
                    found_key = existing_strike
                    break
            
            if found_key is not None:
                # Add to existing if not already from this expiry
                existing_expiry_indices = [e[0] for e in strike_presence[found_key]]
                if idx not in existing_expiry_indices:
                    strike_presence[found_key].append((idx, expiry_label, opt_strike))
            else:
                if opt_strike not in strike_presence:
                    strike_presence[opt_strike] = [(idx, expiry_label, opt_strike)]
    
    # Filter strikes that appear in all 3 expiries
    resonance_strikes = {
        s: exp_list for s, exp_list in strike_presence.items()
        if len(exp_list) == 3
    }
    
    # Sort by distance from spot
    sorted_strikes = sorted(resonance_strikes.keys(), key=lambda s: abs(s - spot))
    
    # Build enhanced results
    results = []
    for strike in sorted_strikes[:2]:  # Max 2 resonance levels
        expiry_info = resonance_strikes[strike]
        expiry_labels = [e[1] for e in expiry_info]
        
        # Aggregate metrics
        total_call_oi = 0
        total_put_oi = 0
        total_call_vol = 0
        total_put_vol = 0
        total_gamma = 0.0
        
        expiry_details = []
        
        for exp_idx, exp_label, actual_strike in expiry_info:
            expiry = expiries[exp_idx]
            options = expiry.get('options', [])
            quant_metrics = expiry.get('quantMetrics', {})
            
            # Get options at this strike
            opts_at_strike = get_options_at_strike(options, actual_strike, tolerance_pct=tolerance_pct)
            
            # Calculate gamma for this strike using Black-Scholes
            expiry_date = expiry.get('date', '')
            T = calculate_time_to_expiry(expiry_date)
            r = 0.05
            
            # Get IV from options (average of call and put IV)
            call_iv = 0.3
            put_iv = 0.3
            for opt in options:
                if abs(opt.get('strike', 0) - actual_strike) / max(actual_strike, 1) <= tolerance_pct:
                    if opt.get('side') == 'CALL':
                        call_iv = opt.get('iv', 0.3)
                    else:
                        put_iv = opt.get('iv', 0.3)
            
            call_gamma = calculate_black_scholes_gamma(spot, actual_strike, T, r, call_iv)
            put_gamma = calculate_black_scholes_gamma(spot, actual_strike, T, r, put_iv)
            
            # Update totals
            total_call_oi += opts_at_strike['call_oi']
            total_put_oi += opts_at_strike['put_oi']
            total_call_vol += opts_at_strike['call_vol']
            total_put_vol += opts_at_strike['put_vol']
            total_gamma += (call_gamma * opts_at_strike['call_oi'] + put_gamma * opts_at_strike['put_oi']) * 100 * spot * spot * 0.01 / 1e9
            
            # Add expiry detail
            expiry_details.append({
                'expiry_label': exp_label,
                'call_oi': opts_at_strike['call_oi'],
                'put_oi': opts_at_strike['put_oi'],
                'call_vol': opts_at_strike['call_vol'],
                'put_vol': opts_at_strike['put_vol'],
                'call_gamma': round(call_gamma, 6),
                'put_gamma': round(put_gamma, 6)
            })
        
        # Calculate put/call ratio
        if total_call_oi > 0:
            put_call_ratio = round(total_put_oi / total_call_oi, 2)
        else:
            put_call_ratio = 0.0 if total_put_oi == 0 else 99.99
        
        results.append({
            'strike': round(strike, 2),
            'expiries': expiry_labels,
            'expiry_label': '+'.join(expiry_labels),
            'total_call_oi': total_call_oi,
            'total_put_oi': total_put_oi,
            'total_call_vol': total_call_vol,
            'total_put_vol': total_put_vol,
            'put_call_ratio': put_call_ratio,
            'total_gamma': round(total_gamma, 6),
            'expiry_details': expiry_details
        })
    
    return results


def select_walls_by_expiry(expiries: List[Dict], spot: float, top_n: int = 3) -> Dict[str, List[Dict]]:
    """
    Seleziona le Call Walls e Put Walls per ogni expiry.
    Top N per Open Interest.
    
    Args:
        expiries: Lista di expiry data con options
        spot: Prezzo spot corrente
        top_n: Numero di walls da selezionare per tipo (default 3)
    
    Returns:
        {
            "call_walls": [{"strike": float, "oi": int, "expiry": str}, ...],
            "put_walls": [{"strike": float, "oi": int, "expiry": str}, ...]
        }
    """
    call_walls = []
    put_walls = []
    
    for expiry in expiries:
        expiry_label = expiry.get('label', 'UNKNOWN')
        
        # Separa calls e puts
        calls = [(opt['strike'], opt['oi']) for opt in expiry.get('options', [])
                 if opt['side'] == 'CALL' and opt['oi'] > 0]
        puts = [(opt['strike'], opt['oi']) for opt in expiry.get('options', [])
                if opt['side'] == 'PUT' and opt['oi'] > 0]
        
        # Ordina per OI decrescente
        calls.sort(key=lambda x: x[1], reverse=True)
        puts.sort(key=lambda x: x[1], reverse=True)
        
        # Filter to above spot FIRST, then take top N by OI
        calls_above = [(s, o) for s, o in calls if s > spot and o > 0]
        calls_above.sort(key=lambda x: x[1], reverse=True)
        for strike, oi in calls_above[:top_n]:
            call_walls.append({"strike": round(strike, 2), "oi": oi, "expiry": expiry_label})
        
        # Filter to below spot FIRST, then take top N by OI
        puts_below = [(s, o) for s, o in puts if s < spot and o > 0]
        puts_below.sort(key=lambda x: x[1], reverse=True)
        for strike, oi in puts_below[:top_n]:
            put_walls.append({"strike": round(strike, 2), "oi": oi, "expiry": expiry_label})
    
    # Ordina per OI decrescente e limita a top N globali
    call_walls.sort(key=lambda x: x['oi'], reverse=True)
    put_walls.sort(key=lambda x: x['oi'], reverse=True)
    
    return {
        "call_walls": call_walls[:top_n * len(expiries)],  # Max top_n per expiry
        "put_walls": put_walls[:top_n * len(expiries)]
    }


def fetch_vix() -> Optional[float]:
    """
    Fetch the current VIX (CBOE Volatility Index) value from yfinance.
    
    Returns:
        VIX value as float, or None if fetch fails
    """
    try:
        vix_ticker = yf.Ticker("^VIX")
        vix_hist = vix_ticker.history(period="1d")
        if vix_hist is not None and not vix_hist.empty:
            vix_value = vix_hist['Close'].iloc[-1]
            logger.info(f"📊 VIX fetched: {vix_value:.2f}")
            return float(vix_value)
        else:
            logger.warning("⚠️ VIX history empty, using default tolerances")
            return None
    except Exception as e:
        logger.warning(f"⚠️ VIX fetch failed: {e}, using default tolerances")
        return None


def detect_market_regime(spot: Optional[float], total_gex: Optional[float],
                         gamma_flip: Optional[float], vix: Optional[float] = None,
                         pcr: Optional[float] = None) -> Dict[str, Any]:
    """
    Detect market regime by aggregating multiple options-based signals.
    
    Uses Total GEX, Gamma Flip position relative to spot, VIX level, and
    Put/Call Ratio to classify the current market state for each symbol.
    
    Args:
        spot: Current spot price of the underlying
        total_gex: Total Gamma Exposure in billions (from calculate_total_gex_all_expiries)
        gamma_flip: Gamma flip strike price (from calculate_gamma_flip_all_expiries)
        vix: Current VIX value (from fetch_vix), optional
        pcr: OI-based Put/Call Ratio, optional
    
    Returns:
        Dict with keys:
            regime: 'trending_up' | 'trending_down' | 'range_bound' | 'volatile'
            confidence: 0.0-1.0
            signals: dict of individual signal scores per regime
            indicators: dict of individual signal contributions
            interpretation: human-readable description
    """
    signals = {
        'trending_up': 0.0,
        'trending_down': 0.0,
        'range_bound': 0.0,
        'volatile': 0.0
    }
    indicators = {}
    
    # Signal 1: Total GEX
    # High positive GEX → dealers buy dips / sell rips → range_bound / mean reversion
    # Negative GEX → dealers sell dips / buy rips → volatile / trending
    if total_gex is not None:
        indicators['total_gex'] = round(total_gex, 4)
        if total_gex > 5.0:
            signals['range_bound'] += 0.4
            indicators['gex_signal'] = 'high_positive'
        elif total_gex > 1.0:
            signals['range_bound'] += 0.2
            signals['trending_up'] += 0.1
            indicators['gex_signal'] = 'moderate_positive'
        elif total_gex > -1.0:
            signals['volatile'] += 0.2
            signals['trending_down'] += 0.1
            indicators['gex_signal'] = 'near_zero'
        else:
            signals['volatile'] += 0.4
            signals['trending_down'] += 0.2
            indicators['gex_signal'] = 'negative'
    
    # Signal 2: Gamma Flip Position relative to spot
    # Spot above gamma flip → positive GEX regime → support below
    # Spot below gamma flip → negative GEX regime → resistance above
    # Spot near gamma flip → transition zone → volatile
    if gamma_flip is not None and spot is not None and gamma_flip > 0:
        flip_distance_pct = (spot - gamma_flip) / gamma_flip * 100
        indicators['flip_distance_pct'] = round(flip_distance_pct, 2)
        if abs(flip_distance_pct) < 0.3:
            signals['volatile'] += 0.3
            indicators['flip_signal'] = 'near_flip'
        elif flip_distance_pct > 1.0:
            signals['trending_up'] += 0.3
            signals['range_bound'] += 0.1
            indicators['flip_signal'] = 'above_flip'
        elif flip_distance_pct > 0:
            signals['range_bound'] += 0.2
            signals['trending_up'] += 0.1
            indicators['flip_signal'] = 'slightly_above_flip'
        else:
            signals['trending_down'] += 0.3
            indicators['flip_signal'] = 'below_flip'
    
    # Signal 3: VIX level
    if vix is not None:
        indicators['vix'] = vix
        if vix > 30:
            signals['volatile'] += 0.4
            indicators['vix_signal'] = 'high_volatility'
        elif vix > 20:
            signals['volatile'] += 0.1
            signals['trending_down'] += 0.1
            indicators['vix_signal'] = 'elevated'
        elif vix < 15:
            signals['range_bound'] += 0.3
            signals['trending_up'] += 0.1
            indicators['vix_signal'] = 'low_volatility'
        else:
            signals['trending_up'] += 0.1
            indicators['vix_signal'] = 'normal'
    
    # Signal 4: Put/Call Ratio
    if pcr is not None:
        indicators['pcr'] = round(pcr, 3)
        if pcr > 1.5:
            signals['trending_down'] += 0.3
            indicators['pcr_signal'] = 'heavy_put_bias'
        elif pcr > 1.0:
            signals['trending_down'] += 0.1
            indicators['pcr_signal'] = 'moderate_put_bias'
        elif pcr < 0.5:
            signals['trending_up'] += 0.3
            indicators['pcr_signal'] = 'heavy_call_bias'
        elif pcr < 0.8:
            signals['trending_up'] += 0.1
            indicators['pcr_signal'] = 'moderate_call_bias'
        else:
            signals['range_bound'] += 0.1
            indicators['pcr_signal'] = 'balanced'
    
    # Determine winner
    regime = max(signals, key=signals.get)
    total_signal = sum(signals.values())
    confidence = signals[regime] / total_signal if total_signal > 0 else 0.5
    
    # Interpretation text
    interpretations = {
        'trending_up': 'Call walls are temporary resistance (breakout likely). Put walls are strong support. Gamma flip acts as dynamic support.',
        'trending_down': 'Put walls are temporary support (breakdown likely). Call walls are strong resistance. Gamma flip acts as dynamic resistance.',
        'range_bound': 'Call walls are solid resistance. Put walls are solid support. Gamma flip acts as a pivot point. Expect mean reversion.',
        'volatile': 'Levels are less reliable. Gamma flip zone is a transition area. Expect larger swings and whipsaws. Use caution.'
    }
    
    return {
        'regime': regime,
        'confidence': round(confidence, 3),
        'signals': {k: round(v, 3) for k, v in signals.items()},
        'indicators': indicators,
        'interpretation': interpretations[regime]
    }


# ============================================================================
# LEVEL ACTIONABILITY FRAMEWORK
# ============================================================================

def assign_actionability(level, regime, spot, expiry_label='MONTHLY'):
    """
    Assign actionable trading metadata to a level based on its properties and market regime.
    
    Args:
        level: dict with at least 'strike', 'type'/'role', 'significance_score'/'score'
        regime: str - market regime from detect_market_regime()
        spot: float - current spot price
        expiry_label: str - '0DTE', 'WEEKLY', 'MONTHLY'
    
    Returns: dict with actionability metadata
    """
    strike = level.get('strike', 0)
    level_type = level.get('type', level.get('role', '')).upper()
    score = level.get('significance_score', level.get('score', 0))
    distance_pct = abs(strike - spot) / spot * 100 if spot > 0 else 999
    
    # Determine expected behavior based on level type and regime
    behavior = _determine_behavior(level_type, regime, strike, spot)
    
    # Calculate confidence (base from score, modified by regime alignment)
    confidence = min(100, max(20, score))
    
    # Generate confirmation signals
    confirmation_signals = _get_confirmation_signals(level_type, regime, strike, spot)
    
    # Calculate invalidation level
    invalidation = _calculate_invalidation(strike, level_type, spot)
    
    # Time decay impact (only relevant for 0DTE)
    time_decay = _get_time_decay_impact(expiry_label, level_type)
    
    # Trading priority based on distance
    if distance_pct < 1.0:
        priority = 'primary'
    elif distance_pct < 2.0:
        priority = 'secondary'
    else:
        priority = 'contextual'
    
    return {
        'expected_behavior': behavior,
        'confidence': round(confidence, 1),
        'confirmation_signals': confirmation_signals,
        'invalidation_level': round(invalidation, 2),
        'invalidation_description': _describe_invalidation(level_type, behavior, strike, invalidation),
        'time_decay_impact': time_decay,
        'trading_priority': priority
    }


def _determine_behavior(level_type, regime, strike, spot):
    """Determine expected price behavior at this level."""
    is_call = 'CALL' in level_type
    is_put = 'PUT' in level_type
    is_magnet = 'MAGNET' in level_type
    is_confluence = 'CONFLUENCE' in level_type or 'RESONANCE' in level_type
    
    if is_magnet:
        return 'magnet'
    
    if is_confluence:
        # Confluence levels are strong - usually bounce unless in trending market
        if regime == 'trending_up' and is_call:
            return 'break'  # Call wall likely to break in uptrend
        elif regime == 'trending_down' and is_put:
            return 'break'  # Put wall likely to break in downtrend
        return 'bounce'
    
    if is_call:  # CALL WALL
        if regime == 'trending_up':
            return 'break'     # Resistance likely to break
        elif regime == 'volatile':
            return 'magnet'    # Price gets drawn then rejects
        else:
            return 'bounce'    # Solid resistance
    
    if is_put:  # PUT WALL
        if regime == 'trending_down':
            return 'break'     # Support likely to break
        elif regime == 'volatile':
            return 'magnet'    # Price gets drawn then bounces
        else:
            return 'bounce'    # Solid support
    
    # PIVOT, FRICTION, or other
    return 'pin'


def _get_confirmation_signals(level_type, regime, strike, spot):
    """List what to watch for to confirm the expected behavior."""
    signals = []
    is_call = 'CALL' in level_type
    is_put = 'PUT' in level_type
    
    # Volume confirmation
    signals.append('Volume spike > 2x average at ' + str(strike))
    
    # Price action confirmation
    if is_call:
        signals.append('Rejection candle (shooting star / bearish engulfing)')
        signals.append('Break: sustained close above ' + str(strike) + ' for 5+ min')
    elif is_put:
        signals.append('Bounce candle (hammer / bullish engulfing)')
        signals.append('Break: sustained close below ' + str(strike) + ' for 5+ min')
    
    # Regime-specific
    if regime == 'volatile':
        signals.append('Reduced confidence in volatile regime - use smaller size')
    elif regime == 'range_bound':
        signals.append('Range-bound: expect mean reversion from this level')
    
    return signals[:4]  # Max 4 signals


def _calculate_invalidation(strike, level_type, spot):
    """Calculate where the level thesis is invalidated."""
    is_call = 'CALL' in level_type
    is_put = 'PUT' in level_type
    
    if is_call:
        # Call wall invalidated if price breaks above convincingly
        return round(strike * 1.005, 2)  # 0.5% above strike
    elif is_put:
        # Put wall invalidated if price breaks below convincingly
        return round(strike * 0.995, 2)  # 0.5% below strike
    else:
        # Generic: 0.3% on either side
        if strike > spot:
            return round(strike * 1.003, 2)
        else:
            return round(strike * 0.997, 2)


def _describe_invalidation(level_type, behavior, strike, invalidation):
    """Human-readable invalidation description."""
    is_call = 'CALL' in level_type
    is_put = 'PUT' in level_type
    
    if behavior == 'bounce':
        if is_call:
            return f'Invalidated if price sustains above {invalidation}'
        elif is_put:
            return f'Invalidated if price sustains below {invalidation}'
    elif behavior == 'break':
        if is_call:
            return f'Break fails if price rejects below {invalidation}'
        elif is_put:
            return f'Break fails if price bounces above {invalidation}'
    elif behavior == 'magnet':
        return f'Magnet effect fails if price reverses before reaching {strike}'
    return f'Thesis invalidated beyond {invalidation}'


def _get_time_decay_impact(expiry_label, level_type):
    """Time decay impact varies by time of day for 0DTE."""
    if expiry_label != '0DTE':
        return {
            'morning': 'strong',
            'midday': 'strong',
            'afternoon': 'moderate',
            'note': 'Non-0DTE: minimal theta impact intraday'
        }
    
    # 0DTE options: gamma increases as expiry approaches
    is_magnet = 'MAGNET' in level_type
    if is_magnet:
        return {
            'morning': 'moderate',
            'midday': 'strong',
            'afternoon': 'very_strong',
            'note': '0DTE magnet: pinning effect increases into close'
        }
    
    return {
        'morning': 'strong',
        'midday': 'moderate',
        'afternoon': 'weak',
        'note': '0DTE: level significance decays into close (except gamma squeeze window 14:30-15:30)'
    }


def calculate_theta_adjusted_score(level, spot, current_time_utc=None):
    """
    Adjust level score based on time-of-day for 0DTE options.
    
    0DTE options rapidly lose extrinsic value as expiry approaches.
    This adjustment reflects the diminishing significance of OI-based levels
    throughout the day, with a special exception for gamma flip zones.
    
    Time schedule (ET = UTC-4/5 depending on DST):
    - 9:30-11:00 ET → factor 1.0 (full strength)
    - 11:00-13:00 ET → factor 0.8
    - 13:00-14:30 ET → factor 0.6
    - 14:30-15:30 ET → factor 0.4 (gamma squeeze window!)
    - 15:30-16:00 ET → factor 0.2 (expiring)
    
    Special: Gamma flip GAINS importance near expiry (×1.2 after 14:30)
    
    Args:
        level: dict with level data including 'significance_score'/'score', 'type'/'role'
        spot: current spot price
        current_time_utc: datetime object in UTC (default: datetime.utcnow())
    
    Returns: dict with adjusted_score, decay_factor, status, note
    """
    if current_time_utc is None:
        current_time_utc = datetime.now(timezone.utc)
    
    # Convert to Eastern Time (ET = UTC-5 EST, UTC-4 EDT)
    # Simple approach: use UTC-5 as rough ET approximation
    hour_utc = current_time_utc.hour
    # Market hours: 9:30-16:00 ET = 13:30-20:00 UTC (EDT) or 14:30-21:00 UTC (EST)
    # Use approximate: hour_et = hour_utc - 5
    hour_et_approx = hour_utc - 5  # Rough ET approximation
    
    # Determine time window and decay factor
    if 9 <= hour_et_approx < 11:
        decay_factor = 1.0
        window = 'morning'
    elif 11 <= hour_et_approx < 13:
        decay_factor = 0.8
        window = 'midday'
    elif 13 <= hour_et_approx < 14.5:
        decay_factor = 0.6
        window = 'early_afternoon'
    elif 14.5 <= hour_et_approx < 15.5:
        decay_factor = 0.4
        window = 'gamma_squeeze_window'
    elif 15.5 <= hour_et_approx < 16:
        decay_factor = 0.2
        window = 'expiring'
    elif hour_et_approx >= 16:
        decay_factor = 0.1
        window = 'after_hours'
    else:
        decay_factor = 1.0  # Pre-market or unknown time
        window = 'pre_market'
    
    # Get original score
    original_score = level.get('significance_score', level.get('score', 0))
    
    # Special case: Gamma flip GAINS importance near expiry
    level_type = level.get('type', level.get('role', '')).upper()
    is_gamma_flip = 'GAMMA' in level_type or 'FLIP' in level_type
    
    if is_gamma_flip and hour_et_approx >= 14.5:
        # Gamma flip becomes MORE important into the close
        adjusted_score = original_score * 1.2
        note = 'Gamma flip GAINS importance near expiry (×1.2 boost) — potential gamma squeeze zone'
    else:
        adjusted_score = original_score * decay_factor
        if decay_factor < 1.0:
            note = f'0DTE theta decay: {window} window (×{decay_factor} adjustment)'
        else:
            note = f'0DTE full strength: {window} window'
    
    # Determine status
    if adjusted_score >= original_score * 0.5:
        status = 'ACTIVE'
    elif adjusted_score >= original_score * 0.2:
        status = 'FADING'
    else:
        status = 'EXPIRING'
    
    return {
        'adjusted_score': round(adjusted_score, 1),
        'original_score': round(original_score, 1),
        'decay_factor': decay_factor,
        'time_window': window,
        'status': status,
        'note': note
    }


def apply_theta_to_0dte_levels(selected_levels, spot):
    """
    Apply theta decay adjustment to all 0DTE levels in selected_levels.
    Only affects levels from 0DTE expiry — Weekly and Monthly are untouched.
    
    Adds 'theta_adjustment' field to each qualifying level dict.
    Does NOT modify the original significance_score.
    
    Args:
        selected_levels: dict from select_important_levels() with keys:
            'resonance', 'confluence', 'call_walls', 'put_walls', 'gamma_flip', 'max_pain'
        spot: current spot price
    
    Returns:
        Number of levels that received theta adjustment
    """
    adjusted_count = 0
    
    # Process resonance levels (check if 0DTE is in the expiry label)
    for level in selected_levels.get('resonance', []):
        expiry_label = level.get('expiry_label', '')
        if '0DTE' in expiry_label:
            theta_level = {
                'strike': level.get('strike', 0),
                'type': 'RESONANCE',
                'role': 'RESONANCE',
                'significance_score': 95,
                'score': 95,
            }
            level['theta_adjustment'] = calculate_theta_adjusted_score(theta_level, spot)
            adjusted_count += 1
    
    # Process confluence levels
    for level in selected_levels.get('confluence', []):
        expiry_label = level.get('expiry_label', '')
        if '0DTE' in expiry_label:
            theta_level = {
                'strike': level.get('strike', 0),
                'type': 'CONFLUENCE',
                'role': 'CONFLUENCE',
                'significance_score': 85,
                'score': 85,
            }
            level['theta_adjustment'] = calculate_theta_adjusted_score(theta_level, spot)
            adjusted_count += 1
    
    # Process call walls
    for level in selected_levels.get('call_walls', []):
        if level.get('expiry') == '0DTE':
            theta_level = {
                'strike': level.get('strike', 0),
                'type': 'CALL WALL',
                'role': 'WALL',
                'significance_score': 70,
                'score': 70,
            }
            level['theta_adjustment'] = calculate_theta_adjusted_score(theta_level, spot)
            adjusted_count += 1
    
    # Process put walls
    for level in selected_levels.get('put_walls', []):
        if level.get('expiry') == '0DTE':
            theta_level = {
                'strike': level.get('strike', 0),
                'type': 'PUT WALL',
                'role': 'WALL',
                'significance_score': 70,
                'score': 70,
            }
            level['theta_adjustment'] = calculate_theta_adjusted_score(theta_level, spot)
            adjusted_count += 1
    
    return adjusted_count


def enrich_levels_with_actionability(selected_levels, regime_data, spot):
    """
    Enrich all levels in selected_levels with actionability metadata.
    
    Modifies levels in-place by adding an 'actionability' key to each level dict.
    
    Args:
        selected_levels: dict from select_important_levels() with keys:
            'resonance', 'confluence', 'call_walls', 'put_walls', 'gamma_flip', 'max_pain'
        regime_data: dict from detect_market_regime() with key 'regime'
        spot: current spot price
    
    Returns:
        The selected_levels dict with actionability added to each level
    """
    regime = regime_data.get('regime', 'range_bound') if regime_data else 'range_bound'
    
    # Enrich resonance levels
    for level in selected_levels.get('resonance', []):
        call_oi = level.get('total_call_oi', 0)
        put_oi = level.get('total_put_oi', 0)
        if call_oi > put_oi * 1.5:
            side = 'CALL'
        elif put_oi > call_oi * 1.5:
            side = 'PUT'
        else:
            side = 'BOTH'
        
        actionability_level = {
            'strike': level.get('strike', 0),
            'type': f'{side}_RESONANCE',
            'role': 'RESONANCE',
            'score': 95,
        }
        expiry_label = level.get('expiry_label', 'MONTHLY')
        primary_expiry = expiry_label.split('+')[0] if '+' in expiry_label else expiry_label
        level['actionability'] = assign_actionability(
            actionability_level, regime, spot, expiry_label=primary_expiry
        )
    
    # Enrich confluence levels
    for level in selected_levels.get('confluence', []):
        call_oi = level.get('total_call_oi', 0)
        put_oi = level.get('total_put_oi', 0)
        if call_oi > put_oi * 1.5:
            side = 'CALL'
        elif put_oi > call_oi * 1.5:
            side = 'PUT'
        else:
            side = 'BOTH'
        
        actionability_level = {
            'strike': level.get('strike', 0),
            'type': f'{side}_CONFLUENCE',
            'role': 'CONFLUENCE',
            'score': 85,
        }
        expiry_label = level.get('expiry_label', 'MONTHLY')
        primary_expiry = expiry_label.split('+')[0] if '+' in expiry_label else expiry_label
        level['actionability'] = assign_actionability(
            actionability_level, regime, spot, expiry_label=primary_expiry
        )
    
    # Enrich call walls
    for level in selected_levels.get('call_walls', []):
        actionability_level = {
            'strike': level.get('strike', 0),
            'type': 'CALL_WALL',
            'role': 'WALL',
            'score': 70,
        }
        expiry_label = level.get('expiry', 'MONTHLY')
        level['actionability'] = assign_actionability(
            actionability_level, regime, spot, expiry_label=expiry_label
        )
    
    # Enrich put walls
    for level in selected_levels.get('put_walls', []):
        actionability_level = {
            'strike': level.get('strike', 0),
            'type': 'PUT_WALL',
            'role': 'WALL',
            'score': 70,
        }
        expiry_label = level.get('expiry', 'MONTHLY')
        level['actionability'] = assign_actionability(
            actionability_level, regime, spot, expiry_label=expiry_label
        )
    
    return selected_levels


def calculate_dynamic_tolerances(vix: Optional[float]) -> Dict[str, Any]:
    """
    Calculate dynamic tolerance percentages based on VIX level.
    
    When VIX is high (e.g., 35+), tolerances widen to account for
    larger price swings. When VIX is low (e.g., 12), tolerances tighten.
    
    Scale mapping:
        VIX 12 → scale 0.7  (tight)
        VIX 20 → scale 1.0  (baseline)
        VIX 40 → scale 1.5  (wide)
    
    Args:
        vix: Current VIX value, or None if unavailable
        
    Returns:
        Dict with keys:
            - resonance: tolerance for resonance level detection (decimal fraction)
            - confluence: tolerance for confluence level detection (decimal fraction)
            - wall_proximity: tolerance for wall proximity detection (decimal fraction)
            - vix: the VIX value used (or None)
            - scale: the computed scale factor
    """
    # Default tolerances (VIX-neutral, ~20)
    defaults = {
        'resonance': 0.005,      # 0.5%
        'confluence': 0.01,      # 1.0%
        'wall_proximity': 0.01   # 1.0%
    }
    
    if vix is None:
        return {**defaults, 'vix': None, 'scale': 1.0}
    
    # Piecewise linear scale factor
    # VIX 12 → 0.7, VIX 20 → 1.0, VIX 40 → 1.5
    if vix <= 12:
        scale = 0.7
    elif vix <= 20:
        scale = 0.7 + (vix - 12) * (0.3 / 8)   # 0.7 → 1.0
    elif vix <= 40:
        scale = 1.0 + (vix - 20) * (0.5 / 20)   # 1.0 → 1.5
    else:
        scale = 1.5
    
    return {
        'resonance': round(defaults['resonance'] * scale, 5),
        'confluence': round(defaults['confluence'] * scale, 5),
        'wall_proximity': round(defaults['wall_proximity'] * scale, 5),
        'vix': round(vix, 2),
        'scale': round(scale, 3)
    }


def select_important_levels(expiries: List[Dict], spot: float,
                            tolerances: Optional[Dict[str, Any]] = None) -> Dict:
    """
    Seleziona i livelli più importanti usando regole algoritmiche.
    
    Regole:
    1. RESONANCE: Strike in TUTTE e 3 le scadenze (max 2 più vicini allo spot)
    2. CONFLUENCE: Strike in ESATTAMENTE 2 scadenze (max 5 più vicini allo spot)
    3. WALLS: Top 3 per OI per tipo per expiry
    4. GAMMA_FLIP: Dal 0DTE (già calcolato)
    5. MAX_PAIN: Dal 0DTE (già calcolato)
    
    Args:
        expiries: Lista di expiry data con options e quantMetrics
        spot: Prezzo spot corrente
        tolerances: Dict with dynamic tolerances from calculate_dynamic_tolerances().
                    If None, defaults are used.
    
    Returns:
        {
            'resonance': [...],  # Max 2 livelli
            'confluence': [...], # Max 5 livelli
            'call_walls': [...], # Top 3 per expiry
            'put_walls': [...],  # Top 3 per expiry
            'gamma_flip': float,
            'max_pain': float
        }
    """
    # Use dynamic tolerances if provided, otherwise fall back to defaults
    res_tol = tolerances.get('resonance', 0.005) if tolerances else 0.005
    conf_tol = tolerances.get('confluence', 0.01) if tolerances else 0.01
    
    # Trova livelli resonance (enhanced with detailed metrics)
    resonance = find_resonance_levels_enhanced(expiries, spot, tolerance_pct=res_tol)
    
    # Trova livelli confluence (enhanced with detailed metrics)
    confluence = find_confluence_levels_enhanced(expiries, spot, tolerance_pct=conf_tol)
    
    # Seleziona walls
    walls = select_walls_by_expiry(expiries, spot, top_n=3)
    
    # Estrai gamma_flip e max_pain dal 0DTE (prima expiry)
    gamma_flip = None
    max_pain = None
    
    if expiries:
        first_expiry = expiries[0]
        quant_metrics = first_expiry.get('quantMetrics', {})
        gamma_flip = quant_metrics.get('gamma_flip')
        max_pain = quant_metrics.get('max_pain')
    
    return {
        "resonance": resonance,
        "confluence": confluence,
        "call_walls": walls["call_walls"],
        "put_walls": walls["put_walls"],
        "gamma_flip": round(gamma_flip, 2) if gamma_flip is not None else None,
        "max_pain": round(max_pain, 2) if max_pain is not None else None
    }


# ============================================================================
# LEVEL HISTORY TRACKING
# ============================================================================

def extract_level_snapshot(symbol, symbol_data, spot):
    """
    Extract a lightweight snapshot of key levels for history tracking.
    Only stores the most important data points to keep file size manageable.
    
    Args:
        symbol: The symbol being tracked (e.g., 'SPY', 'QQQ')
        symbol_data: The symbol's data dict from all_data["symbols"]
        spot: Current spot price
    
    Returns:
        Dict with timestamp, spot, key_levels, gamma_flip, total_gex
    """
    snapshot = {
        'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'spot': spot,
        'key_levels': [],
        'gamma_flip': None,
        'total_gex': None
    }
    
    # Extract from selected_levels (algorithmic levels)
    selected_levels = symbol_data.get('selected_levels', {})
    
    # Resonance levels (highest importance)
    for level in selected_levels.get('resonance', []):
        snapshot['key_levels'].append({
            'strike': level.get('strike'),
            'role': 'RESONANCE',
            'score': 95,
            'oi': level.get('total_call_oi', 0) + level.get('total_put_oi', 0),
            'volume': level.get('total_call_vol', 0) + level.get('total_put_vol', 0),
            'expiry': level.get('expiry_label', '')
        })
    
    # Confluence levels
    for level in selected_levels.get('confluence', []):
        snapshot['key_levels'].append({
            'strike': level.get('strike'),
            'role': 'CONFLUENCE',
            'score': 85,
            'oi': level.get('total_call_oi', 0) + level.get('total_put_oi', 0),
            'volume': level.get('total_call_vol', 0) + level.get('total_put_vol', 0),
            'expiry': level.get('expiry_label', '')
        })
    
    # Call walls
    for level in selected_levels.get('call_walls', []):
        snapshot['key_levels'].append({
            'strike': level.get('strike'),
            'role': 'CALL_WALL',
            'score': 70,
            'oi': level.get('oi', 0),
            'volume': 0,
            'expiry': level.get('expiry', '')
        })
    
    # Put walls
    for level in selected_levels.get('put_walls', []):
        snapshot['key_levels'].append({
            'strike': level.get('strike'),
            'role': 'PUT_WALL',
            'score': 70,
            'oi': level.get('oi', 0),
            'volume': 0,
            'expiry': level.get('expiry', '')
        })
    
    # Extract gamma flip and total GEX
    gamma_flip = selected_levels.get('gamma_flip')
    if gamma_flip is not None:
        snapshot['gamma_flip'] = gamma_flip
    
    total_gex_data = symbol_data.get('totalGexData', {})
    if total_gex_data:
        snapshot['total_gex'] = total_gex_data.get('total_gex')
        # If gamma_flip not yet set, try from totalGexData flip_point
        if snapshot['gamma_flip'] is None:
            snapshot['gamma_flip'] = total_gex_data.get('flip_point')
    
    return snapshot


def update_level_history(symbol, snapshot, history_file='data/level_history.json', max_snapshots=10):
    """
    Update level history file with new snapshot.
    Keeps only the last max_snapshots per symbol to control file size.
    
    Args:
        symbol: The symbol being tracked
        snapshot: The snapshot dict from extract_level_snapshot()
        history_file: Path to the history JSON file
        max_snapshots: Maximum number of snapshots to keep per symbol (default 10)
    
    Returns:
        Number of snapshots now stored for this symbol
    """
    # Load existing history
    history = {}
    if os.path.exists(history_file):
        try:
            with open(history_file, 'r') as f:
                history = json.load(f)
        except (json.JSONDecodeError, IOError):
            logger.warning(f"⚠️ Could not read level history file, starting fresh")
            history = {}
    
    # Initialize symbol history if needed
    if 'level_history' not in history:
        history['level_history'] = {}
    if symbol not in history['level_history']:
        history['level_history'][symbol] = []
    
    # Append new snapshot
    history['level_history'][symbol].append(snapshot)
    
    # Trim to max_snapshots (keep most recent)
    if len(history['level_history'][symbol]) > max_snapshots:
        history['level_history'][symbol] = history['level_history'][symbol][-max_snapshots:]
    
    # Update metadata
    history['last_updated'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    history['max_snapshots'] = max_snapshots
    
    # Save
    history_path = Path(history_file)
    history_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(history_file, 'w') as f:
        json.dump(history, f, indent=2)
    
    snapshot_count = len(history['level_history'][symbol])
    logger.info(f"📊 Level history updated for {symbol}: {snapshot_count} snapshots")
    return snapshot_count


# ============================================================================
# INTER-SYMBOL CORRELATION ANALYSIS
# ============================================================================

def _extract_strikes_with_scores(symbol_data):
    """Extract key strikes with their scores and roles from symbol data."""
    result = {}
    selected = symbol_data.get('selected_levels', {})
    
    for category in ['resonance', 'confluence', 'call_walls', 'put_walls']:
        levels = selected.get(category, [])
        if isinstance(levels, dict):
            levels = [levels]
        for level in levels:
            strike = level.get('strike', 0)
            if strike > 0:
                result[strike] = {
                    'score': level.get('significance_score', level.get('score', 0)),
                    'role': level.get('type', level.get('role', category)),
                    'oi': level.get('open_interest', level.get('oi', 0))
                }
    
    return result


def analyze_cross_symbol_correlation(symbols_data):
    """
    Analyze correlations between symbols to find confirmation signals.
    
    Checks:
    1. Equivalent levels: SPY↔SPX (×10), QQQ↔NDX (×40.5)
    2. Divergence detection: SPY vs QQQ regime divergence
    
    Args:
        symbols_data: dict of {symbol: symbol_data} with selected_levels, market_regime, etc.
    
    Returns: list of correlation findings
    """
    correlations = []
    
    # Define equivalent symbol pairs with conversion factors
    equivalent_pairs = [
        ('SPY', 'SPX', 10.0),      # SPX ≈ SPY × 10
        ('QQQ', 'NDX', 40.5),      # NDX ≈ QQQ × 40.5 (approximate)
    ]
    
    # Also check SPY ↔ QQQ for divergence
    divergence_pairs = [
        ('SPY', 'QQQ'),
    ]
    
    # 1. Find equivalent levels
    for sym_a, sym_b, multiplier in equivalent_pairs:
        data_a = symbols_data.get(sym_a, {})
        data_b = symbols_data.get(sym_b, {})
        
        if not data_a or not data_b:
            continue
        
        levels_a = _extract_strikes_with_scores(data_a)
        levels_b = _extract_strikes_with_scores(data_b)
        
        for strike_a, info_a in levels_a.items():
            # Convert strike_a to sym_b equivalent
            equivalent_strike = strike_a * multiplier
            
            # Find matching strikes within 0.5% tolerance
            for strike_b, info_b in levels_b.items():
                if strike_b <= 0:
                    continue
                distance_pct = abs(strike_b - equivalent_strike) / equivalent_strike * 100
                
                if distance_pct < 0.5:
                    # Found equivalent level!
                    correlations.append({
                        'type': 'equivalent_level',
                        'symbols': [sym_a, sym_b],
                        'strikes': {sym_a: strike_a, sym_b: strike_b},
                        'roles': {sym_a: info_a['role'], sym_b: info_b['role']},
                        'scores': {sym_a: info_a['score'], sym_b: info_b['score']},
                        'distance_pct': round(distance_pct, 3),
                        'confidence_boost': 15,  # +15 importance for cross-confirmation
                        'description': f'{sym_a} {info_a["role"]} at {strike_a} ≈ {sym_b} {info_b["role"]} at {strike_b} (±{distance_pct:.2f}%)'
                    })
    
    # 2. Detect SPY-QQQ divergence
    for sym_a, sym_b in divergence_pairs:
        regime_a = symbols_data.get(sym_a, {}).get('market_regime', {})
        regime_b = symbols_data.get(sym_b, {}).get('market_regime', {})
        
        if not regime_a or not regime_b:
            continue
        
        regime_a_type = regime_a.get('regime', '')
        regime_b_type = regime_b.get('regime', '')
        
        if regime_a_type != regime_b_type:
            correlations.append({
                'type': 'regime_divergence',
                'symbols': [sym_a, sym_b],
                'regimes': {sym_a: regime_a_type, sym_b: regime_b_type},
                'confidence': {sym_a: regime_a.get('confidence', 0), sym_b: regime_b.get('confidence', 0)},
                'description': f'{sym_a} is {regime_a_type} while {sym_b} is {regime_b_type} — possible sector rotation',
                'trading_implication': 'Sector rotation signal: consider relative strength plays between S&P 500 and Nasdaq 100'
            })
    
    # 3. Gamma flip correlation (same direction across symbols)
    gamma_flips = {}
    for sym, data in symbols_data.items():
        gf = data.get('selected_levels', {}).get('gamma_flip')
        if gf is not None:
            gamma_flips[sym] = gf
    
    # Check if correlated symbols have gamma flips on the same side of spot
    for sym_a, sym_b, _ in equivalent_pairs:
        if sym_a in gamma_flips and sym_b in gamma_flips:
            spot_a = symbols_data[sym_a].get('spot', 0)
            spot_b = symbols_data[sym_b].get('spot', 0)
            if spot_a > 0 and spot_b > 0:
                a_above = spot_a > gamma_flips[sym_a]
                b_above = spot_b > gamma_flips[sym_b]
                if a_above == b_above:
                    side = 'above' if a_above else 'below'
                    correlations.append({
                        'type': 'gamma_flip_alignment',
                        'symbols': [sym_a, sym_b],
                        'gamma_flips': {sym_a: gamma_flips[sym_a], sym_b: gamma_flips[sym_b]},
                        'spots': {sym_a: spot_a, sym_b: spot_b},
                        'both': side,
                        'description': f'Both {sym_a} and {sym_b} are {side} their gamma flip — aligned dealer positioning'
                    })
    
    return correlations


def main():
    parser = argparse.ArgumentParser(
        description='QUANT Smart Sweep - GitHub Actions Edition'
    )
    parser.add_argument(
        '--symbol',
        type=str,
        default='SPY',
        help='Simbolo da scaricare (SPY, QQQ, SPX, NDX, o ALL)'
    )
    parser.add_argument(
        '--output',
        type=str,
        default='data/options_data.json',
        help='Percorso file output JSON'
    )
    parser.add_argument(
        '--tv-output',
        type=str,
        default='data/tv_levels.json',
        help='Percorso file output TradingView JSON'
    )
    parser.add_argument(
        '--symbols',
        type=str,
        nargs='+',
        help='Lista di simboli da scaricare'
    )
    parser.add_argument(
        '--tv-only',
        action='store_true',
        help='Genera solo il file TradingView (senza full options data)'
    )
    
    args = parser.parse_args()
    
    # Determina simboli da processare
    if args.symbols:
        symbols = [s.upper() for s in args.symbols]
    elif args.symbol.upper() == 'ALL':
        # Usa i 4 simboli principali: ETF + Indici
        symbols = ALL_SYMBOLS
    else:
        symbols = [args.symbol.upper()]
    
    # Valida simboli
    valid_symbols = []
    for s in symbols:
        if s in SYMBOL_MAP or s in ['SPY', 'QQQ', 'SPX', 'NDX']:
            valid_symbols.append(s)
        else:
            logger.warning(f"⚠️ Simbolo non supportato: {s}, verrà saltato")
    symbols = valid_symbols
    
    if not symbols:
        logger.error("❌ Nessun simbolo valido specificato")
        sys.exit(1)
    
    logger.info(f"\n{'#'*60}")
    logger.info("# QUANT SMART SWEEP v15.0 - GitHub Actions Edition")
    logger.info(f"{'#'*60}")
    logger.info(f"Simboli: {symbols}")
    logger.info(f"Output: {args.output}")
    logger.info(f"TV Output: {args.tv_output}")
    
    # =========================================================================
    # PHASE 0: Fetch VIX and compute dynamic tolerances
    # =========================================================================
    logger.info("\n📊 PHASE 0: Fetching VIX for dynamic tolerances...")
    vix_value = fetch_vix()
    dynamic_tolerances = calculate_dynamic_tolerances(vix_value)
    logger.info(f"  📏 Dynamic tolerances (scale={dynamic_tolerances['scale']}):")
    logger.info(f"     Resonance:  ±{dynamic_tolerances['resonance']*100:.2f}%")
    logger.info(f"     Confluence: ±{dynamic_tolerances['confluence']*100:.2f}%")
    logger.info(f"     Wall Prox:  ±{dynamic_tolerances['wall_proximity']*100:.2f}%")
    
    # Scarica dati per ogni simbolo
    all_data = {
        "version": "2.0",
        "generated": datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        "dynamic_tolerances": dynamic_tolerances,
        "symbols": {}
    }
    
    successful = 0
    
    # =========================================================================
    # PHASE 1: Collect data for all symbols (sequential to avoid rate limiting)
    # =========================================================================
    logger.info("\n📥 PHASE 1: Collecting data for all symbols...")
    
    symbols_data_raw = {}  # Store raw data before AI analysis
    for i, symbol in enumerate(symbols):
        # Rate limiting: pausa tra richieste (tranne la prima)
        if i > 0:
            logger.info(f"⏳ Pausa {RATE_LIMIT_DELAY}s per rate limiting...")
            time.sleep(RATE_LIMIT_DELAY)
        
        data = fetch_symbol_data(symbol)
        if data:
            # Genera anche formato legacy
            legacy = generate_legacy_content(data)
            
            # Seleziona i livelli più importanti (algoritmici, con tolleranze dinamiche)
            selected_levels = select_important_levels(data.expiries, data.spot, tolerances=dynamic_tolerances)
            
            symbols_data_raw[symbol] = {
                "spot": data.spot,
                "generated": data.generated,
                "expiries": data.expiries,
                "selected_levels": selected_levels,
                "totalGexData": data.total_gex_data,
                "legacy": legacy
            }
            successful += 1
            
            # Log dei livelli selezionati
            logger.info(f"  📊 Livelli algoritmici per {symbol}:")
            logger.info(f"     Resonance: {len(selected_levels['resonance'])} livelli")
            logger.info(f"     Confluence: {len(selected_levels['confluence'])} livelli")
            logger.info(f"     Call Walls: {len(selected_levels['call_walls'])} livelli")
            logger.info(f"     Put Walls: {len(selected_levels['put_walls'])} livelli")
            logger.info(f"     Gamma Flip: {selected_levels['gamma_flip']}")
            logger.info(f"     Max Pain: {selected_levels['max_pain']}")
            
            # --- Market Regime Detection ---
            # Flatten all options across expiries for aggregate PCR
            all_options_flat = []
            for expiry in data.expiries:
                all_options_flat.extend(expiry.get('options', []) if isinstance(expiry, dict) else [])
            
            aggregate_pcr = None
            if all_options_flat:
                pcr_ratios = calculate_put_call_ratios(all_options_flat)
                aggregate_pcr = pcr_ratios.get('oi_based')
            
            # Get total_gex and gamma_flip for regime detection
            total_gex_for_regime = data.total_gex_data.get('total_gex') if data.total_gex_data else None
            gamma_flip_for_regime = selected_levels.get('gamma_flip')
            
            regime_data = detect_market_regime(
                spot=data.spot,
                total_gex=total_gex_for_regime,
                gamma_flip=gamma_flip_for_regime,
                vix=vix_value,
                pcr=aggregate_pcr
            )
            
            symbols_data_raw[symbol]['market_regime'] = regime_data
            
            # Log regime detection results
            logger.info(f"  🏛️ Market Regime for {symbol}:")
            logger.info(f"     Regime: {regime_data['regime']} (confidence: {regime_data['confidence']:.1%})")
            logger.info(f"     Signals: {regime_data['signals']}")
            logger.info(f"     Indicators: {regime_data['indicators']}")
            logger.info(f"     Interpretation: {regime_data['interpretation']}")
            
            # --- Level Actionability Enrichment ---
            selected_levels = enrich_levels_with_actionability(
                selected_levels, regime_data, data.spot
            )
            symbols_data_raw[symbol]['selected_levels'] = selected_levels
            
            # Log actionability summary
            actionable_count = 0
            for level in selected_levels.get('resonance', []):
                if 'actionability' in level:
                    actionable_count += 1
            for level in selected_levels.get('confluence', []):
                if 'actionability' in level:
                    actionable_count += 1
            for level in selected_levels.get('call_walls', []):
                if 'actionability' in level:
                    actionable_count += 1
            for level in selected_levels.get('put_walls', []):
                if 'actionability' in level:
                    actionable_count += 1
            logger.info(f"  🎯 Actionability enriched for {symbol}: {actionable_count} levels annotated")
            
            # --- 0DTE Theta Decay Adjustment ---
            theta_count = apply_theta_to_0dte_levels(selected_levels, data.spot)
            if theta_count > 0:
                logger.info(f"  ⏱️ 0DTE theta adjustment applied for {symbol}: {theta_count} levels adjusted")
                # Log details for each adjusted level
                for level in selected_levels.get('call_walls', []) + selected_levels.get('put_walls', []):
                    if 'theta_adjustment' in level:
                        ta = level['theta_adjustment']
                        logger.info(f"     → Strike {level['strike']}: {ta['status']} (×{ta['decay_factor']}, {ta['time_window']})")
                for level in selected_levels.get('resonance', []) + selected_levels.get('confluence', []):
                    if 'theta_adjustment' in level:
                        ta = level['theta_adjustment']
                        logger.info(f"     → Strike {level['strike']}: {ta['status']} (×{ta['decay_factor']}, {ta['time_window']})")
            else:
                logger.info(f"  ⏱️ No 0DTE levels found for theta adjustment in {symbol}")
            
            # --- Dealer Flow Simulation ---
            logger.info(f"  🔄 Running dealer flow simulation for {symbol}...")
            try:
                flat_options = flatten_options_for_simulation(data.expiries)
                dealer_flow = simulate_dealer_flows(flat_options, data.spot)
                if dealer_flow:
                    symbols_data_raw[symbol]['dealer_flow_simulation'] = dealer_flow
                    n_accel = len(dealer_flow.get('acceleration_zones', []))
                    n_pin = len(dealer_flow.get('pinning_zones', []))
                    max_accel = dealer_flow.get('max_acceleration', {})
                    logger.info(f"  ✅ Dealer flow simulation for {symbol}:")
                    logger.info(f"     Price range: {dealer_flow['price_range']['low']:.2f} - {dealer_flow['price_range']['high']:.2f}")
                    logger.info(f"     Acceleration zones: {n_accel}")
                    for az in dealer_flow.get('acceleration_zones', []):
                        logger.info(f"       → {az['price']:.2f} ({az['direction']}, strength={az['strength']})")
                    logger.info(f"     Pinning zones: {n_pin}")
                    for pz in dealer_flow.get('pinning_zones', []):
                        logger.info(f"       → {pz['price']:.2f} (flow={pz['flow']:.1f}, strength={pz['strength']})")
                    logger.info(f"     Max acceleration: {max_accel.get('price', 0):.2f} ({max_accel.get('direction', 'N/A')})")
                else:
                    logger.info(f"  ⚠️ Dealer flow simulation for {symbol}: insufficient data, skipped")
            except Exception as e:
                logger.error(f"  ❌ Dealer flow simulation failed for {symbol}: {e}")
    
    # =========================================================================
    # PHASE 1.5: Inter-Symbol Correlation Analysis
    # =========================================================================
    logger.info("\n🔗 PHASE 1.5: Analyzing cross-symbol correlations...")
    cross_symbol_correlations = []
    if len(symbols_data_raw) >= 2:
        try:
            cross_symbol_correlations = analyze_cross_symbol_correlation(symbols_data_raw)
            if cross_symbol_correlations:
                logger.info(f"  🔗 Found {len(cross_symbol_correlations)} cross-symbol correlations:")
                for corr in cross_symbol_correlations:
                    logger.info(f"     → [{corr['type']}] {corr['description']}")
            else:
                logger.info("  🔗 No cross-symbol correlations found")
        except Exception as e:
            logger.error(f"  ❌ Cross-symbol correlation analysis failed: {e}")
    else:
        logger.info("  🔗 Skipping cross-symbol correlation (need ≥2 symbols)")
    
    # =========================================================================
    # PHASE 2: Execute AI calls in parallel
    # =========================================================================
    logger.info(f"\n🤖 PHASE 2: Executing AI analysis in parallel for {len(symbols_data_raw)} symbols...")
    
    ai_results = {}
    if AI_API_KEY and symbols_data_raw:
        # Prepare data for parallel execution
        ai_tasks = []
        for symbol, data in symbols_data_raw.items():
            ai_tasks.append((symbol, data['expiries'], data['spot']))
        
        # Execute AI calls in parallel using ThreadPoolExecutor
        start_time = time.time()
        with ThreadPoolExecutor(max_workers=4) as executor:
            # Submit all AI analysis tasks
            future_to_symbol = {
                executor.submit(process_ai_analysis_for_symbol, symbol, expiries, spot): symbol
                for symbol, expiries, spot in ai_tasks
            }
            
            # Collect results as they complete
            for future in as_completed(future_to_symbol):
                symbol = future_to_symbol[future]
                try:
                    result_symbol, ai_analysis = future.result()
                    ai_results[result_symbol] = ai_analysis
                    
                    # Log AI analysis result
                    if ai_analysis:
                        outlook = ai_analysis.get('outlook', {})
                        levels = ai_analysis.get('levels', [])
                        logger.info(f"  🤖 AI Analysis per {result_symbol}:")
                        logger.info(f"     Sentiment: {outlook.get('sentiment', 'N/A')}")
                        logger.info(f"     Volatility: {outlook.get('volatilityExpectation', 'N/A')}")
                        logger.info(f"     AI Levels: {len(levels)} livelli identificati")
                    else:
                        logger.info(f"  🤖 AI Analysis per {result_symbol}: Nessun risultato")
                        
                except Exception as e:
                    logger.error(f"❌ Error collecting AI result for {symbol}: {e}")
                    ai_results[symbol] = None
        
        elapsed_time = time.time() - start_time
        logger.info(f"✅ Parallel AI analysis completed in {elapsed_time:.1f}s")
    else:
        if not AI_API_KEY:
            logger.info("ℹ️ AI_API_KEY not configured, skipping AI analysis")
    
    # =========================================================================
    # PHASE 3: Combine data and save output
    # =========================================================================
    logger.info("\n📁 PHASE 3: Combining data and saving output...")
    
    # Merge AI results into symbol data
    for symbol, data in symbols_data_raw.items():
        all_data["symbols"][symbol] = {
            **data,
            "ai_analysis": ai_results.get(symbol, None)
        }
    
    # Create AI-ready data for each symbol (optimized for AI token efficiency)
    logger.info("\n📊 Creating AI-ready data for each symbol...")
    ai_ready_data = {}
    for symbol, symbol_data in all_data["symbols"].items():
        spot = symbol_data.get('spot', 0)
        expiries = symbol_data.get('expiries', [])
        ai_ready_data[symbol] = create_ai_ready_data(expiries, spot)
        logger.info(f"  -> {symbol}: {len(ai_ready_data[symbol].get('expiries', {}))} expiries prepared")
    
    # Add ai_ready_data to output
    all_data["ai_ready_data"] = ai_ready_data
    
    # Add cross-symbol correlations to output (top-level, not per-symbol)
    all_data["cross_symbol_correlations"] = cross_symbol_correlations
    
    # Salva output principale
    if not args.tv_only:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(all_data, f, indent=2, ensure_ascii=False)
        logger.info(f"📁 File salvato: {output_path.absolute()}")
    
    # Genera e salva output TradingView
    tv_data = generate_tradingview_levels(all_data)
    tv_output_path = Path(args.tv_output)
    tv_output_path.parent.mkdir(parents=True, exist_ok=True)
    
    with open(tv_output_path, 'w', encoding='utf-8') as f:
        json.dump(tv_data, f, indent=2, ensure_ascii=False)
    
    # =========================================================================
    # PHASE 5: Level History Tracking
    # =========================================================================
    logger.info("\n📊 PHASE 5: Updating level history...")
    
    history_file = 'data/level_history.json'
    for symbol, symbol_data in all_data["symbols"].items():
        try:
            spot = symbol_data.get('spot', 0)
            if spot > 0:
                snapshot = extract_level_snapshot(symbol, symbol_data, spot)
                update_level_history(symbol, snapshot, history_file=history_file, max_snapshots=10)
        except Exception as e:
            logger.error(f"❌ Level history update failed for {symbol}: {e}")
    
    logger.info(f"✅ Level history saved to {history_file}")
    
    logger.info(f"\n{'='*60}")
    logger.info(f"✅ COMPLETATO! Scaricati {successful}/{len(symbols)} simboli")
    logger.info(f"📁 TV Levels: {tv_output_path.absolute()}")
    logger.info(f"📁 Level History: {Path(history_file).absolute()}")
    logger.info(f"{'='*60}")
    
    # Exit code per GitHub Actions
    sys.exit(0 if successful > 0 else 1)


if __name__ == "__main__":
    main()
