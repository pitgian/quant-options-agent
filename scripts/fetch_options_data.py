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
   - Condition: The SAME exact strike (±0.5%) must be a significant level in ALL THREE expirations (0DTE + WEEKLY + MONTHLY)
   - VALID EXAMPLES: Strike 25000 is Call Wall in 0DTE, Put Wall in WEEKLY, and Max Pain in MONTHLY
   - INVALID EXAMPLES: Strike 24700 in 0DTE, strike 24750 in WEEKLY, strike 24800 in MONTHLY → NOT RESONANCE (too different)
   - Importance: 98-100
   - Use this ONLY when there is perfect alignment across all expirations

2. **CONFLUENCE** (RARE - max 3-5 total levels):
   - Condition: The SAME strike (±1%) is significant in EXACTLY TWO expirations
   - Importance: 85-94
   - Example: Strike 24500 is Wall in 0DTE and Wall in WEEKLY, but not present in MONTHLY

3. **SINGLE EXPIRY** (THE MAJORITY of levels):
   - Condition: Significant level in only one expiration
   - Roles: WALL, PIVOT, MAGNET, FRICTION
   - Importance: 60-84
   - This should cover ~80% of levels

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


def format_quant_metrics_for_ai(quant_metrics: Dict[str, Any]) -> str:
    """Format quantitative metrics for AI analysis - same as formatQuantMetrics in glmService.ts"""
    gex_sign = 'positive/stable' if quant_metrics.get('total_gex', 0) > 0 else 'negative/volatile'
    skew = quant_metrics.get('volatility_skew', {})
    skew_type = skew.get('skew_type', 'unknown')
    sentiment = skew.get('sentiment', 'neutral')
    
    return f"""
=== ADVANCED QUANTITATIVE METRICS ===
Gamma Flip: {quant_metrics.get('gamma_flip', 'N/A')}
Total GEX: {quant_metrics.get('total_gex', 0):.2f}B ({gex_sign})
Max Pain: {quant_metrics.get('max_pain', 'N/A')}

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
    Get real-time spot price with multi-source fallback.
    
    Priority:
    1. Twelve Data (real-time, supports indices like SPX, NDX)
    2. Yahoo Finance fallback (passed as parameter)
    
    Returns:
        Tuple of (price, source) where source is 'twelvedata', 'yahoo', or 'none'
    """
    if not HAS_REQUESTS:
        return (yahoo_fallback, 'yahoo' if yahoo_fallback else 'none')
    
    # Get mapped symbol for Twelve Data API
    twelvedata_symbol = SPOT_SYMBOL_MAP.get(symbol, symbol)
    
    # Try Twelve Data first (real-time, supports indices)
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
                        logger.info(f"💰 Spot price from Twelve Data: {symbol} = {price}")
                        return (price, 'twelvedata')
                else:
                    logger.info(f"ℹ️ Twelve Data returned no price for {symbol}")
            else:
                logger.warning(f"⚠️ Twelve Data HTTP {response.status_code} for {symbol}")
        except Exception as e:
            logger.warning(f"⚠️ Twelve Data error for {symbol}: {e}")
    else:
        logger.info(f"ℹ️ TWELVEDATA_API_KEY not set, skipping Twelve Data")
    
    # Fallback to Yahoo
    if yahoo_fallback:
        logger.info(f"💰 Spot price from Yahoo (delayed): {symbol} = {yahoo_fallback}")
        return (yahoo_fallback, 'yahoo')
    
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


def select_expirations(expirations: List[str]) -> List[tuple]:
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
            options.append({
                "strike": round(float(row['strike']), 2),
                "side": "CALL",
                "iv": round(float(row['impliedVolatility']), 4),
                "oi": int(row['openInterest']) if pd.notna(row['openInterest']) else 0,
                "vol": int(row['volume']) if pd.notna(row['volume']) else 0
            })
        
        # Processa PUTs
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
        logger.error(f"  ❌ Errore su {label}: {e}")
        return None


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
        
        # Seleziona 3 scadenze
        selected = select_expirations(expirations)
        logger.info(f"  -> Selezionate: {[f'{l}({d})' for l, d in selected]}")
        
        # Scarica options chains
        logger.info("[3/3] Download options chains...")
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
        
        return OptionsDataset(
            symbol=symbol,  # Usa il simbolo originale (senza ^)
            spot=round(spot, 2),
            spot_source=spot_source,
            generated=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            expiries=expiries
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
        gamma_flip = quant_metrics.get("gamma_flip", spot)
        
        # Calcola walls
        walls = calculate_walls(options, spot, top_n=3)
        
        tv_data["symbols"][symbol] = {
            "spot": spot,
            "gamma_flip": gamma_flip,
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
        
        if strike not in strikes_data:
            strikes_data[strike] = {'call_oi': 0, 'put_oi': 0, 'call_iv': 0.3, 'put_iv': 0.3}
        
        if opt.get('side') == 'CALL':
            strikes_data[strike]['call_oi'] = opt.get('oi', 0)
            strikes_data[strike]['call_iv'] = opt.get('iv', 0.3)
        else:
            strikes_data[strike]['put_oi'] = opt.get('oi', 0)
            strikes_data[strike]['put_iv'] = opt.get('iv', 0.3)
    
    if not strikes_data:
        return round(spot, 2)
    
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
    
    # Trova il flip point
    gamma_flip = spot  # Default
    for i in range(1, len(gex_by_strike)):
        prev_gex = gex_by_strike[i-1][1]
        curr_gex = gex_by_strike[i][1]
        
        # Se il segno cambia, abbiamo un flip
        if prev_gex * curr_gex < 0:
            # Interpolazione lineare
            prev_strike = gex_by_strike[i-1][0]
            curr_strike = gex_by_strike[i][0]
            gamma_flip = (prev_strike + curr_strike) / 2
            break
    
    return round(gamma_flip, 2)


def calculate_max_pain(options: List[Dict[str, Any]], spot: float) -> float:
    """
    Calcola il Max Pain - lo strike dove la perdita totale per option buyers è massima.
    
    Per ogni strike, calcola il valore totale delle opzioni alla scadenza.
    Il Max Pain è lo strike con valore minimo (max loss per buyers).
    
    Returns:
        Strike price del max pain
    """
    if not options:
        return round(spot, 2)
    
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
        return round(spot, 2)
    
    # Testa ogni strike come possibile prezzo alla scadenza
    test_strikes = sorted(strikes_data.keys())
    min_value = float('inf')
    max_pain = spot
    
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
            "skew_type": str
        }
    """
    T = calculate_time_to_expiry(expiry_date)
    r = 0.05  # Risk-free rate assumption
    
    gamma_flip = calculate_gamma_flip(options, spot, T, r)
    max_pain = calculate_max_pain(options, spot)
    total_gex = calculate_total_gex(options, spot, T, r)
    skew_type = calculate_skew_type(options, spot)
    
    return {
        "gamma_flip": gamma_flip,
        "max_pain": max_pain,
        "total_gex": round(total_gex, 6),
        "skew_type": skew_type
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
        
        # Prendi top N call walls (sopra lo spot)
        for strike, oi in calls[:top_n]:
            if strike > spot:
                call_walls.append({
                    "strike": round(strike, 2),
                    "oi": oi,
                    "expiry": expiry_label
                })
        
        # Prendi top N put walls (sotto lo spot)
        for strike, oi in puts[:top_n]:
            if strike < spot:
                put_walls.append({
                    "strike": round(strike, 2),
                    "oi": oi,
                    "expiry": expiry_label
                })
    
    # Ordina per OI decrescente e limita a top N globali
    call_walls.sort(key=lambda x: x['oi'], reverse=True)
    put_walls.sort(key=lambda x: x['oi'], reverse=True)
    
    return {
        "call_walls": call_walls[:top_n * len(expiries)],  # Max top_n per expiry
        "put_walls": put_walls[:top_n * len(expiries)]
    }


def select_important_levels(expiries: List[Dict], spot: float) -> Dict:
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
    # Trova livelli resonance (enhanced with detailed metrics)
    resonance = find_resonance_levels_enhanced(expiries, spot, tolerance_pct=0.005)
    
    # Trova livelli confluence (enhanced with detailed metrics)
    confluence = find_confluence_levels_enhanced(expiries, spot, tolerance_pct=0.01)
    
    # Seleziona walls
    walls = select_walls_by_expiry(expiries, spot, top_n=3)
    
    # Estrai gamma_flip e max_pain dal 0DTE (prima expiry)
    gamma_flip = spot
    max_pain = spot
    
    if expiries:
        first_expiry = expiries[0]
        quant_metrics = first_expiry.get('quantMetrics', {})
        gamma_flip = quant_metrics.get('gamma_flip', spot)
        max_pain = quant_metrics.get('max_pain', spot)
    
    return {
        "resonance": resonance,
        "confluence": confluence,
        "call_walls": walls["call_walls"],
        "put_walls": walls["put_walls"],
        "gamma_flip": round(gamma_flip, 2),
        "max_pain": round(max_pain, 2)
    }


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
    
    # Scarica dati per ogni simbolo
    all_data = {
        "version": "2.0",
        "generated": datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        "symbols": {}
    }
    
    successful = 0
    for i, symbol in enumerate(symbols):
        # Rate limiting: pausa tra richieste (tranne la prima)
        if i > 0:
            logger.info(f"⏳ Pausa {RATE_LIMIT_DELAY}s per rate limiting...")
            time.sleep(RATE_LIMIT_DELAY)
        
        data = fetch_symbol_data(symbol)
        if data:
            # Genera anche formato legacy
            legacy = generate_legacy_content(data)
            
            # Seleziona i livelli più importanti (algoritmici)
            selected_levels = select_important_levels(data.expiries, data.spot)
            
            # Chiama AI per analisi avanzata (se API key configurata)
            ai_analysis = get_ai_analysis(data.expiries, data.spot)
            
            all_data["symbols"][symbol] = {
                "spot": data.spot,
                "generated": data.generated,
                "expiries": data.expiries,
                "selected_levels": selected_levels,
                "ai_analysis": ai_analysis,  # Aggiungi analisi AI
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
            
            # Log AI analysis
            if ai_analysis:
                outlook = ai_analysis.get('outlook', {})
                levels = ai_analysis.get('levels', [])
                logger.info(f"  🤖 AI Analysis per {symbol}:")
                logger.info(f"     Sentiment: {outlook.get('sentiment', 'N/A')}")
                logger.info(f"     Volatility: {outlook.get('volatilityExpectation', 'N/A')}")
                logger.info(f"     AI Levels: {len(levels)} livelli identificati")
    
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
    
    logger.info(f"\n{'='*60}")
    logger.info(f"✅ COMPLETATO! Scaricati {successful}/{len(symbols)} simboli")
    logger.info(f"📁 TV Levels: {tv_output_path.absolute()}")
    logger.info(f"{'='*60}")
    
    # Exit code per GitHub Actions
    sys.exit(0 if successful > 0 else 1)


if __name__ == "__main__":
    main()
