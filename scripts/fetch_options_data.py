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
from datetime import datetime
from typing import Optional, Dict, List, Any, Tuple
from dataclasses import dataclass, asdict
from pathlib import Path

# Configurazione logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)


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


def get_spot_price(ticker: yf.Ticker) -> Optional[float]:
    """
    Recupera il prezzo spot corrente con fallback multipli.
    """
    try:
        # Metodo 1: fast_info (più veloce)
        return float(ticker.fast_info['last_price'])
    except (KeyError, TypeError):
        pass
    
    try:
        # Metodo 2: history
        hist = ticker.history(period="1d")
        if not hist.empty:
            return float(hist['Close'].iloc[-1])
    except Exception:
        pass
    
    return None


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
        
        # Recupera spot price
        logger.info("[1/3] Recupero prezzo spot...")
        spot = get_spot_price(ticker)
        if spot is None:
            logger.error(f"❌ Impossibile recuperare spot price per {symbol}")
            return None
        logger.info(f"  -> Spot: {spot:.2f}")
        
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
            generated=datetime.now().isoformat(),
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
        "generated": datetime.now().isoformat(),
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
            all_data["symbols"][symbol] = {
                "spot": data.spot,
                "generated": data.generated,
                "expiries": data.expiries,
                "legacy": legacy
            }
            successful += 1
    
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
