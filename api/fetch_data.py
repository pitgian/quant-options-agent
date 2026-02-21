from flask import Request, jsonify
import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta


def handler(request: Request):
    """
    Vercel Python function to fetch options data using yfinance.
    
    Query parameters:
        symbol: The ticker symbol (SPY, QQQ, SPX, NDX)
        expiry: Optional expiry date (YYYY-MM-DD)
    """
    try:
        # Parse query parameters
        symbol = request.args.get('symbol', 'SPY').upper()
        expiry = request.args.get('expiry', None)
        
        # Validate symbol
        valid_symbols = ['SPY', 'QQQ', 'SPX', 'NDX']
        if symbol not in valid_symbols:
            return jsonify({
                'error': f'Invalid symbol. Must be one of: {", ".join(valid_symbols)}'
            }), 400
        
        # Fetch data from yfinance
        ticker = yf.Ticker(symbol)
        
        # Get current price
        current_price = ticker.history(period='1d')['Close'].iloc[-1]
        
        # Get options expirations
        expirations = ticker.options
        
        if not expirations:
            return jsonify({
                'error': 'No options data available for this symbol'
            }), 404
        
        # Select expiry date
        if expiry and expiry in expirations:
            selected_expiry = expiry
        else:
            # Default to nearest expiry
            selected_expiry = expirations[0]
        
        # Get option chain
        option_chain = ticker.option_chain(selected_expiry)
        
        # Process calls
        calls_data = []
        for _, row in option_chain.calls.iterrows():
            calls_data.append({
                'strike': float(row['strike']),
                'lastPrice': float(row['lastPrice']),
                'bid': float(row['bid']),
                'ask': float(row['ask']),
                'volume': int(row['volume']) if pd.notna(row['volume']) else 0,
                'openInterest': int(row['openInterest']) if pd.notna(row['openInterest']) else 0,
                'impliedVolatility': float(row['impliedVolatility']),
                'delta': float(row.get('delta', 0)) if 'delta' in row and pd.notna(row.get('delta')) else None,
                'gamma': float(row.get('gamma', 0)) if 'gamma' in row and pd.notna(row.get('gamma')) else None,
                'theta': float(row.get('theta', 0)) if 'theta' in row and pd.notna(row.get('theta')) else None,
                'vega': float(row.get('vega', 0)) if 'vega' in row and pd.notna(row.get('vega')) else None,
            })
        
        # Process puts
        puts_data = []
        for _, row in option_chain.puts.iterrows():
            puts_data.append({
                'strike': float(row['strike']),
                'lastPrice': float(row['lastPrice']),
                'bid': float(row['bid']),
                'ask': float(row['ask']),
                'volume': int(row['volume']) if pd.notna(row['volume']) else 0,
                'openInterest': int(row['openInterest']) if pd.notna(row['openInterest']) else 0,
                'impliedVolatility': float(row['impliedVolatility']),
                'delta': float(row.get('delta', 0)) if 'delta' in row and pd.notna(row.get('delta')) else None,
                'gamma': float(row.get('gamma', 0)) if 'gamma' in row and pd.notna(row.get('gamma')) else None,
                'theta': float(row.get('theta', 0)) if 'theta' in row and pd.notna(row.get('theta')) else None,
                'vega': float(row.get('vega', 0)) if 'vega' in row and pd.notna(row.get('vega')) else None,
            })
        
        # Build response
        response_data = {
            'symbol': symbol,
            'currentPrice': float(current_price),
            'expiry': selected_expiry,
            'availableExpirations': list(expirations),
            'calls': calls_data,
            'puts': puts_data,
            'timestamp': datetime.utcnow().isoformat() + 'Z'
        }
        
        return jsonify(response_data)
    
    except Exception as e:
        return jsonify({
            'error': f'Failed to fetch options data: {str(e)}'
        }), 500
