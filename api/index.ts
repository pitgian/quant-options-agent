import type { VercelRequest, VercelResponse } from '@vercel/node';
// @ts-ignore - yahoo-finance2 CommonJS module
import yahooFinance from 'yahoo-finance2';

// Ensure we have the default export (CommonJS interop)
const yf = (yahooFinance as any).default || yahooFinance;

// Symbol mapping for yfinance format
// Indices require ^ prefix in yfinance (e.g., ^SPX, ^NDX)
// ETFs are used as-is (SPY, QQQ)
const SYMBOL_MAP: Record<string, string> = {
  'SPY': 'SPY',   // ETF - no change
  'QQQ': 'QQQ',   // ETF - no change
  'SPX': '^SPX',  // S&P 500 Index - requires caret
  'NDX': '^NDX',  // Nasdaq 100 Index - requires caret
};

interface OptionContract {
  strike: number;
  lastPrice: number;
  bid: number;
  ask: number;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number;
  inTheMoney: boolean;
}

interface OptionsData {
  calls: OptionContract[];
  puts: OptionContract[];
  currentPrice: number;
  expiry: string;
  availableExpirations: string[];
}

async function fetchOptionsData(symbol: string, expiry?: string): Promise<OptionsData> {
  // Map symbol to yfinance format
  const yfSymbol = SYMBOL_MAP[symbol] || symbol;
  console.log(`Fetching data for ${symbol} -> ${yfSymbol}`);
  
  // Get the stock/quote data
  const quote = await yf.quote(yfSymbol);
  const currentPrice = quote.regularMarketPrice || 0;
  
  // Get options data
  const options = await yf.options(yfSymbol);
  
  // Get available expirations
  const availableExpirations = options.expirationDates.map((d: Date) => 
    d.toISOString().split('T')[0]
  );
  
  // Select expiry date
  let selectedExpiry = expiry;
  if (!selectedExpiry || !availableExpirations.includes(selectedExpiry)) {
    // Use the first available expiration (usually nearest)
    selectedExpiry = availableExpirations[0];
  }
  
  // Get the option chain for selected expiry
  const optionChain = options.options.find((chain: any) => 
    chain.expirationDate.toISOString().split('T')[0] === selectedExpiry
  );
  
  if (!optionChain) {
    throw new Error(`No option chain found for expiry ${selectedExpiry}`);
  }
  
  // Process calls
  const calls: OptionContract[] = (optionChain.calls || []).map((call: any) => ({
    strike: call.strike,
    lastPrice: call.lastPrice || 0,
    bid: call.bid || 0,
    ask: call.ask || 0,
    volume: call.volume,
    openInterest: call.openInterest,
    impliedVolatility: call.impliedVolatility || 0,
    inTheMoney: call.inTheMoney || false,
  }));
  
  // Process puts
  const puts: OptionContract[] = (optionChain.puts || []).map((put: any) => ({
    strike: put.strike,
    lastPrice: put.lastPrice || 0,
    bid: put.bid || 0,
    ask: put.ask || 0,
    volume: put.volume,
    openInterest: put.openInterest,
    impliedVolatility: put.impliedVolatility || 0,
    inTheMoney: put.inTheMoney || false,
  }));
  
  return {
    calls,
    puts,
    currentPrice,
    expiry: selectedExpiry,
    availableExpirations,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    // Get query parameters
    const symbol = (req.query.symbol as string || 'SPY').toUpperCase();
    const expiry = req.query.expiry as string | undefined;
    
    console.log(`Request: symbol=${symbol}, expiry=${expiry}`);
    
    // Validate symbol
    const validSymbols = Object.keys(SYMBOL_MAP);
    if (!validSymbols.includes(symbol)) {
      return res.status(400).json({
        error: `Invalid symbol. Must be one of: ${validSymbols.join(', ')}`,
        validSymbols,
      });
    }
    
    // Fetch options data
    const data = await fetchOptionsData(symbol, expiry);
    
    // Return the data
    return res.status(200).json({
      symbol,
      ...data,
      timestamp: new Date().toISOString(),
    });
    
  } catch (error: any) {
    console.error('Error fetching options data:', error);
    return res.status(500).json({
      error: 'Failed to fetch options data',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}
