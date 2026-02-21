#!/usr/bin/env python3
"""
QUANT SMART SWEEP v14.0 - GitHub Actions Edition
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
from datetime import datetime
from typing import Optional, Dict, List, Any
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
    Seleziona 3 scadenze distinte secondo la logica v13.0:
    1. 0DTE - Prima scadenza disponibile
    2. WEEKLY - Prima scadenza che non sia 0DTE
    3. MONTHLY - Prima scadenza mensile standard
    """
    if not expirations:
        return []
    
    selected = []
    used_dates = set()
    
    # 1. 0DTE - sempre la prima
    selected.append(("0DTE", expirations[0]))
    used_dates.add(expirations[0])
    
    # 2. WEEKLY - prima disponibile diversa da 0DTE
    for exp in expirations[1:]:
        if exp not in used_dates:
            selected.append(("WEEKLY", exp))
            used_dates.add(exp)
            break
    
    # 3. MONTHLY - prima scadenza mensile non ancora usata
    for exp in expirations:
        if is_monthly(exp) and exp not in used_dates:
            selected.append(("MONTHLY", exp))
            used_dates.add(exp)
            break
    
    # Se non abbiamo trovato un mensile, prendiamo la prossima disponibile
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
    """
    logger.info(f"\n{'='*50}")
    logger.info(f"  Elaborazione: {symbol}")
    logger.info(f"{'='*50}")
    
    try:
        ticker = yf.Ticker(symbol)
        
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
                expiries.append(asdict(data))
        
        if not expiries:
            logger.error(f"❌ Nessun dato scaricato per {symbol}")
            return None
        
        return OptionsDataset(
            symbol=symbol,
            spot=round(spot, 2),
            generated=datetime.now().isoformat(),
            expiries=expiries
        )
        
    except Exception as e:
        logger.error(f"❌ Errore generale per {symbol}: {e}")
        return None


def calculate_gamma_flip(options: List[Dict[str, Any]], spot: float) -> Optional[float]:
    """
    Calcola il livello di gamma flip basato sulla distribuzione di OI.
    Il gamma flip è il livello dove la gamma netta passa da positiva a negativa.
    Semplificato: media ponderata degli strike per OI delle put sotto spot vs call sopra spot.
    """
    try:
        put_strikes_oi = [(opt['strike'], opt['oi']) for opt in options
                          if opt['side'] == 'PUT' and opt['strike'] < spot and opt['oi'] > 0]
        call_strikes_oi = [(opt['strike'], opt['oi']) for opt in options
                           if opt['side'] == 'CALL' and opt['strike'] > spot and opt['oi'] > 0]
        
        if not put_strikes_oi and not call_strikes_oi:
            return round(spot, 2)
        
        # Calcola media ponderata
        total_oi = sum(oi for _, oi in put_strikes_oi + call_strikes_oi)
        if total_oi == 0:
            return round(spot, 2)
        
        weighted_sum = sum(strike * oi for strike, oi in put_strikes_oi + call_strikes_oi)
        gamma_flip = weighted_sum / total_oi
        
        return round(gamma_flip, 2)
    except Exception:
        return round(spot, 2)


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
        
        # Calcola livelli
        gamma_flip = calculate_gamma_flip(options, spot)
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


# Simboli supportati per TradingView (ETF comuni)
TV_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'GLD', 'TLT']

# Rate limiting: pausa tra simboli per evitare blocchi di yfinance
import time
RATE_LIMIT_DELAY = 2  # secondi tra un simbolo e l'altro


def main():
    parser = argparse.ArgumentParser(
        description='QUANT Smart Sweep - GitHub Actions Edition'
    )
    parser.add_argument(
        '--symbol',
        type=str,
        default='SPY',
        help='Simbolo da scaricare (SPY, QQQ, ^SPX, ^NDX, o ALL)'
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
        symbols = args.symbols
    elif args.symbol.upper() == 'ALL':
        # Usa la lista estesa per TradingView
        symbols = TV_SYMBOLS
    elif args.symbol.upper() == 'TV':
        # Alias per i simboli TradingView
        symbols = TV_SYMBOLS
    else:
        symbols = [args.symbol.upper()]
    
    logger.info(f"\n{'#'*60}")
    logger.info("# QUANT SMART SWEEP v14.0 - GitHub Actions Edition")
    logger.info(f"{'#'*60}")
    logger.info(f"Simboli: {symbols}")
    logger.info(f"Output: {args.output}")
    logger.info(f"TV Output: {args.tv_output}")
    
    # Scarica dati per ogni simbolo
    all_data = {
        "version": "14.0",
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
