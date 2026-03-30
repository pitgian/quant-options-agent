#!/usr/bin/env python3
"""
Level Hit-Rate Validation Script

Validates whether previously identified levels actually functioned as
support/resistance by comparing historical levels with actual price action.

Usage:
    python scripts/validate_levels.py [--days 5] [--output data/validation_results.json]

Requires: yfinance (already in requirements.txt)
"""

import json
import os
import sys
import argparse
from datetime import datetime, timedelta, timezone
from collections import defaultdict

# Try to import yfinance
try:
    import yfinance as yf
except ImportError:
    print("❌ yfinance required. Install: pip install yfinance")
    sys.exit(1)


def load_level_history(history_file='data/level_history.json'):
    """Load level history from JSON file."""
    if not os.path.exists(history_file):
        print(f"❌ History file not found: {history_file}")
        return None

    with open(history_file, 'r') as f:
        return json.load(f)


def fetch_intraday_prices(symbol, days_back=1):
    """
    Fetch intraday price data for validation.
    Returns list of {timestamp, open, high, low, close} dicts.
    """
    # Map symbol names for yfinance
    yf_symbol = symbol
    if symbol == 'SPX':
        yf_symbol = '^GSPC'
    elif symbol == 'NDX':
        yf_symbol = '^NDX'
    elif symbol == 'VIX':
        yf_symbol = '^VIX'

    try:
        ticker = yf.Ticker(yf_symbol)
        # Get 5-minute interval data for the last few days
        hist = ticker.history(period=f'{days_back}d', interval='5m')

        if hist.empty:
            print(f"  ⚠️ No intraday data for {symbol}")
            return []

        prices = []
        for timestamp, row in hist.iterrows():
            prices.append({
                'timestamp': timestamp.isoformat(),
                'open': float(row['Open']),
                'high': float(row['High']),
                'low': float(row['Low']),
                'close': float(row['Close'])
            })

        return prices

    except Exception as e:
        print(f"  ⚠️ Error fetching prices for {symbol}: {e}")
        return []


def validate_level_against_prices(level, prices, tolerance_pct=0.2):
    """
    Validate a single level against actual price action.

    A level is "tested" if price comes within tolerance_pct of the strike.
    A CALL WALL "held" if the high didn't exceed strike * (1 + tolerance_pct/100).
    A PUT WALL "held" if the low didn't go below strike * (1 - tolerance_pct/100).

    Args:
        level: Dict with 'strike', 'role', 'score' keys
        prices: List of price candle dicts
        tolerance_pct: Percentage tolerance for level testing (default 0.2%)

    Returns:
        Dict with validation results, or None if invalid level
    """
    strike = level.get('strike', 0)
    role = level.get('role', level.get('type', '')).upper()
    score = level.get('score', 0)

    if strike <= 0 or not prices:
        return None

    tolerance = strike * tolerance_pct / 100

    # Find if price tested this level
    tested = False
    test_count = 0
    held = False
    broken = False
    max_move_after_test = 0
    first_test_time = None

    is_call = 'CALL' in role
    is_put = 'PUT' in role
    is_magnet = 'MAGNET' in role
    is_confluence = 'CONFLUENCE' in role or 'RESONANCE' in role

    for i, candle in enumerate(prices):
        high = candle['high']
        low = candle['low']

        # Check if this candle tested the level
        if is_call or is_confluence:
            # Call wall / resistance: price approached from below
            if high >= strike - tolerance:
                tested = True
                test_count += 1
                if first_test_time is None:
                    first_test_time = candle['timestamp']

                # Did it hold? High should not exceed strike significantly
                if high <= strike * (1 + tolerance_pct / 100 * 0.5):
                    held = True
                elif high > strike * (1 + tolerance_pct / 100):
                    broken = True

                # Max move after test (look ahead up to 12 candles = 1 hour)
                for j in range(i + 1, min(i + 13, len(prices))):
                    move = abs(prices[j]['close'] - strike) / strike * 100
                    max_move_after_test = max(max_move_after_test, move)

        elif is_put:
            # Put wall / support: price approached from above
            if low <= strike + tolerance:
                tested = True
                test_count += 1
                if first_test_time is None:
                    first_test_time = candle['timestamp']

                # Did it hold? Low should not go below strike significantly
                if low >= strike * (1 - tolerance_pct / 100 * 0.5):
                    held = True
                elif low < strike * (1 - tolerance_pct / 100):
                    broken = True

                # Max move after test
                for j in range(i + 1, min(i + 13, len(prices))):
                    move = abs(prices[j]['close'] - strike) / strike * 100
                    max_move_after_test = max(max_move_after_test, move)

        elif is_magnet:
            # Magnet: price should be drawn toward the strike
            mid = (high + low) / 2
            if abs(mid - strike) <= tolerance * 2:
                tested = True
                test_count += 1
                if first_test_time is None:
                    first_test_time = candle['timestamp']
                held = True  # Magnets "work" if price reaches them

    # Determine outcome
    if not tested:
        outcome = 'not_tested'
    elif held and not broken:
        outcome = 'held'
    elif broken and not held:
        outcome = 'broken'
    elif held and broken:
        outcome = 'mixed'  # Both held and broken at different times
    else:
        outcome = 'inconclusive'

    return {
        'strike': strike,
        'role': role,
        'original_score': score,
        'tested': tested,
        'test_count': test_count,
        'outcome': outcome,
        'held': held,
        'broken': broken,
        'max_move_after_test_pct': round(max_move_after_test, 3),
        'first_test_time': first_test_time
    }


def validate_symbol_history(symbol, snapshots, days_back=1):
    """
    Validate all levels for a symbol across its history snapshots.

    Args:
        symbol: The ticker symbol (e.g., 'SPY', 'QQQ')
        snapshots: List of snapshot dicts from level_history
        days_back: Number of days of price history to fetch

    Returns:
        Dict with validation results for this symbol, or None if no data
    """
    print(f"\n📊 Validating {symbol}...")

    # Fetch price data
    prices = fetch_intraday_prices(symbol, days_back)
    if not prices:
        print(f"  ⚠️ No price data available for {symbol}")
        return None

    print(f"  📈 Got {len(prices)} price candles")

    results = {
        'symbol': symbol,
        'total_levels': 0,
        'tested_levels': 0,
        'held_levels': 0,
        'broken_levels': 0,
        'not_tested_levels': 0,
        'hit_rate': 0.0,
        'by_type': defaultdict(lambda: {'total': 0, 'held': 0, 'broken': 0, 'not_tested': 0}),
        'details': []
    }

    # Get the most recent snapshot's levels
    if not snapshots:
        return results

    latest = snapshots[-1]
    levels = latest.get('key_levels', [])

    for level in levels:
        validation = validate_level_against_prices(level, prices)
        if validation is None:
            continue

        results['total_levels'] += 1
        results['details'].append(validation)

        if validation['tested']:
            results['tested_levels'] += 1
            if validation['held']:
                results['held_levels'] += 1
            if validation['broken']:
                results['broken_levels'] += 1
        else:
            results['not_tested_levels'] += 1

        # Track by type
        role = level.get('role', 'UNKNOWN')
        results['by_type'][role]['total'] += 1
        if validation['tested']:
            if validation['held']:
                results['by_type'][role]['held'] += 1
            if validation['broken']:
                results['by_type'][role]['broken'] += 1
        else:
            results['by_type'][role]['not_tested'] += 1

    # Calculate hit rate
    if results['tested_levels'] > 0:
        results['hit_rate'] = round(results['held_levels'] / results['tested_levels'] * 100, 1)

    # Convert defaultdict to regular dict for JSON serialization
    results['by_type'] = dict(results['by_type'])

    print(f"  ✅ {results['total_levels']} levels analyzed")
    print(f"  🎯 {results['tested_levels']} tested, {results['held_levels']} held, {results['broken_levels']} broken")
    print(f"  📊 Hit rate: {results['hit_rate']}%")

    return results


def generate_improvement_suggestions(all_results):
    """
    Generate suggestions for improving level detection based on validation results.

    Args:
        all_results: List of per-symbol validation result dicts

    Returns:
        List of suggestion dicts with symbol, type, message, severity
    """
    suggestions = []

    for result in all_results:
        if result is None:
            continue

        symbol = result['symbol']
        hit_rate = result['hit_rate']

        if hit_rate < 40:
            suggestions.append({
                'symbol': symbol,
                'type': 'low_hit_rate',
                'message': f'{symbol} hit rate is {hit_rate}% — consider adjusting scoring weights or tolerances',
                'severity': 'high'
            })
        elif hit_rate < 60:
            suggestions.append({
                'symbol': symbol,
                'type': 'moderate_hit_rate',
                'message': f'{symbol} hit rate is {hit_rate}% — acceptable but could improve',
                'severity': 'medium'
            })

        # Check by type
        for role, stats in result.get('by_type', {}).items():
            if stats['total'] >= 3:
                type_rate = stats['held'] / stats['total'] * 100 if stats['total'] > 0 else 0
                if type_rate < 30:
                    suggestions.append({
                        'symbol': symbol,
                        'type': 'poor_level_type',
                        'message': f'{symbol} {role} levels have {type_rate:.0f}% hit rate — this level type may need recalibration',
                        'severity': 'high',
                        'role': role
                    })

    return suggestions


def main():
    parser = argparse.ArgumentParser(description='Validate options levels against actual price action')
    parser.add_argument('--days', type=int, default=1, help='Days of price history to check')
    parser.add_argument('--history', type=str, default='data/level_history.json', help='Path to level history file')
    parser.add_argument('--output', type=str, default='data/validation_results.json', help='Output file path')
    args = parser.parse_args()

    print("=" * 60)
    print("📋 LEVEL HIT-RATE VALIDATION")
    print("=" * 60)

    # Load history
    history = load_level_history(args.history)
    if not history or 'level_history' not in history:
        print("❌ No level history available. Run the main pipeline first.")
        sys.exit(1)

    # Validate each symbol
    all_results = []
    for symbol, snapshots in history['level_history'].items():
        result = validate_symbol_history(symbol, snapshots, args.days)
        if result:
            all_results.append(result)

    # Generate suggestions
    suggestions = generate_improvement_suggestions(all_results)

    # Compile final report
    report = {
        'validation_timestamp': datetime.now(timezone.utc).isoformat(),
        'days_analyzed': args.days,
        'symbols_validated': len(all_results),
        'overall_summary': {
            'total_levels': sum(r['total_levels'] for r in all_results),
            'tested_levels': sum(r['tested_levels'] for r in all_results),
            'held_levels': sum(r['held_levels'] for r in all_results),
            'broken_levels': sum(r['broken_levels'] for r in all_results),
            'overall_hit_rate': round(
                sum(r['held_levels'] for r in all_results) /
                max(sum(r['tested_levels'] for r in all_results), 1) * 100, 1
            )
        },
        'by_symbol': all_results,
        'improvement_suggestions': suggestions
    }

    # Save report
    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    with open(args.output, 'w') as f:
        json.dump(report, f, indent=2)

    # Print summary
    print("\n" + "=" * 60)
    print("📊 VALIDATION SUMMARY")
    print("=" * 60)
    print(f"Symbols validated: {report['symbols_validated']}")
    print(f"Total levels: {report['overall_summary']['total_levels']}")
    print(f"Tested: {report['overall_summary']['tested_levels']}")
    print(f"Held: {report['overall_summary']['held_levels']}")
    print(f"Broken: {report['overall_summary']['broken_levels']}")
    print(f"Overall hit rate: {report['overall_summary']['overall_hit_rate']}%")

    if suggestions:
        print(f"\n💡 {len(suggestions)} improvement suggestions:")
        for s in suggestions:
            print(f"  [{s['severity'].upper()}] {s['message']}")

    print(f"\n💾 Report saved to {args.output}")


if __name__ == '__main__':
    main()
