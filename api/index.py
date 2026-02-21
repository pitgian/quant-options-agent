import sys
import traceback
import logging
from flask import Request, Response, jsonify
import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def handler(request: Request):
    """
    Vercel Python function to fetch options data using yfinance.
    
    Query parameters:
        symbol: The ticker symbol (SPY, QQQ, SPX, NDX)
        expiry: Optional expiry date (YYYY-MM-DD)
    """
    try:
        logger.info(f"Received request: {request.method} {request.path}")
        logger.info(f"Query params: {dict(request.args)}")
        
        # Handle CORS preflight
        if request.method == 'OPTIONS':
            return Response(
                status=204,
                headers={
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                }
            )
        
        # Parse query parameters
        symbol = request.args.get('symbol', 'SPY').upper()
        expiry = request.args.get('expiry', None)
        
        logger.info(f"Fetching data for symbol: {symbol}, expiry: {expiry}")
        
        # Validate symbol
        valid_symbols = ['SPY', 'QQQ', 'SPX', 'NDX']
        if symbol not in valid_symbols:
            logger.warning(f"Invalid symbol requested: {symbol}")
            response = jsonify({
                'error': f'Invalid symbol. Must be one of: {", ".join(valid_symbols)}',
                'validSymbols': valid_symbols
            })
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response, 400
        
        # Fetch data from yfinance
        logger.info(f"Creating yfinance Ticker for {symbol}")
        ticker = yf.Ticker(symbol)
        
        # Get current price
        logger.info("Fetching price history")
        history = ticker.history(period='1d')
        if history.empty:
            logger.error(f"No price history available for {symbol}")
            response = jsonify({
                'error': f'No price history available for {symbol}',
                'symbol': symbol
            })
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response, 404
        
        current_price = history['Close'].iloc[-1]
        logger.info(f"Current price: {current_price}")
        
        # Get options expirations
        logger.info("Fetching options expirations")
        expirations = ticker.options
        
        if not expirations:
            logger.error(f"No options data available for {symbol}")
            response = jsonify({
                'error': f'No options data available for {symbol}',
                'symbol': symbol
            })
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response, 404
        
        logger.info(f"Available expirations: {expirations[:5]}...")
        
        # Select expiry date
        if expiry and expiry in expirations:
            selected_expiry = expiry
        else:
            # Default to nearest expiry
            selected_expiry = expirations[0]
        
        logger.info(f"Selected expiry: {selected_expiry}")
        
        # Get option chain
        logger.info(f"Fetching option chain for {selected_expiry}")
        option_chain = ticker.option_chain(selected_expiry)
        
        # Process calls
        logger.info(f"Processing {len(option_chain.calls)} calls")
        calls_data = []
        for _, row in option_chain.calls.iterrows():
            try:
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
            except Exception as row_error:
                logger.warning(f"Error processing call row: {row_error}")
                continue
        
        # Process puts
        logger.info(f"Processing {len(option_chain.puts)} puts")
        puts_data = []
        for _, row in option_chain.puts.iterrows():
            try:
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
            except Exception as row_error:
                logger.warning(f"Error processing put row: {row_error}")
                continue
        
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
        
        logger.info(f"Successfully processed data: {len(calls_data)} calls, {len(puts_data)} puts")
        
        response = jsonify(response_data)
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response
    
    except Exception as e:
        logger.error(f"Error in handler: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        
        response = jsonify({
            'error': f'Failed to fetch options data: {str(e)}',
            'errorType': type(e).__name__,
            'timestamp': datetime.utcnow().isoformat() + 'Z'
        })
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response, 500


# For Vercel, export as main handler
app = handler
