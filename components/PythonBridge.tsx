
import React, { useState } from 'react';

export const PythonBridge: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);

  const pythonScript = `
import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime

def is_monthly(date_str):
    """Check if a date is the third Friday of the month."""
    dt = datetime.strptime(date_str, '%Y-%m-%d')
    return dt.weekday() == 4 and 15 <= dt.day <= 21

def generate_consolidated_quant_file():
    print("\\n" + "="*50)
    print("   QUANT SMART SWEEP v13.0 - DYNAMIC RESONANCE")
    print("="*50)
    print("1. SPY  | 2. QQQ  | 3. ^SPX | 4. ^NDX")
    
    choice = input("\\nSelect Asset (1-4): ")
    mapping = {"1": "SPY", "2": "QQQ", "3": "^SPX", "4": "^NDX"}
    symbol = mapping.get(choice)
    if not symbol: return

    ticker = yf.Ticker(symbol)
    print(f"\\n[1/3] Fetching Spot Data...")
    try:
        spot = ticker.fast_info['last_price']
    except:
        spot = ticker.history(period="1d")['Close'].iloc[-1]
        
    expirations = list(ticker.options)
    if not expirations:
        print("❌ No options found.")
        return

    # LOGIC FOR SELECTING 3 DISTINCT EXPIRATIONS
    selected_dates = []
    
    # 1. 0DTE (Always the first one)
    selected_dates.append(("0DTE", expirations[0]))
    
    # 2. WEEKLY (First available that is not 0DTE)
    for exp in expirations[1:]:
        if exp not in [d[1] for d in selected_dates]:
            selected_dates.append(("WEEKLY", exp))
            break
            
    # 3. MONTHLY (First monthly expiration not already taken)
    monthly_found = False
    for exp in expirations:
        if is_monthly(exp) and exp not in [d[1] for d in selected_dates]:
            selected_dates.append(("MONTHLY", exp))
            monthly_found = True
            break
            
    # If we don't have 3 dates yet (e.g., monthly was already 0DTE or Weekly), take the next available
    if len(selected_dates) < 3:
        for exp in expirations:
            if exp not in [d[1] for d in selected_dates]:
                selected_dates.append(("EXTRA_EXP", exp))
                if len(selected_dates) == 3: break

    filename = f"QUANT_SWEEP_{symbol}_{datetime.now().strftime('%H%M%S')}.txt"
    
    with open(filename, "w") as f:
        f.write(f"--- GLOBAL HEADER ---\\n")
        f.write(f"SYMBOL: {symbol} | SPOT: {spot:.2f} | GENERATED: {datetime.now()}\\n")
        f.write(f"--- END HEADER ---\\n\\n")

        for label, date in selected_dates:
            print(f" -> Downloading {label} ({date})...")
            try:
                chain = ticker.option_chain(date)
                cols = ['strike', 'impliedVolatility', 'openInterest', 'volume']
                calls = chain.calls[cols].copy(); calls['side'] = 'CALL'
                puts = chain.puts[cols].copy(); puts['side'] = 'PUT'
                df = pd.concat([calls, puts])

                f.write(f"=== START_EXPIRY: {label} | DATE: {date} ===\\n")
                f.write(f"STRIKE | TYPE | IV | OI | VOL\\n")
                for _, row in df.iterrows():
                    oi = int(row['openInterest']) if not pd.isna(row['openInterest']) else 0
                    vol = int(row['volume']) if not pd.isna(row['volume']) else 0
                    f.write(f"{row['strike']:.2f} | {row['side']} | {row['impliedVolatility']:.4f} | {oi} | {vol}\\n")
                f.write(f"=== END_EXPIRY: {label} ===\\n\\n")
            except Exception as e:
                print(f"❌ Error on {label}: {e}")

    print(f"\\n✅ SWEEP COMPLETE! Downloaded {len(selected_dates)} expirations.")
    print(f"File: {filename}")

if __name__ == "__main__":
    generate_consolidated_quant_file()
    input("\\nPress ENTER to exit...")
  `;

  return (
    <div className="mt-4">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="text-[10px] font-black text-indigo-400 hover:text-white uppercase tracking-[0.2em] flex items-center gap-2 transition-all"
      >
        <span className={`w-2 h-2 rounded-full ${isOpen ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-gray-600'}`}></span>
        {isOpen ? 'Hide Script' : 'Generate Python Script v13.0 (Smart Monthly Fix)'}
      </button>

      {isOpen && (
        <div className="mt-4 p-6 bg-black/80 border border-indigo-500/30 rounded-2xl animate-in fade-in zoom-in duration-300">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-xs font-bold text-indigo-300 uppercase tracking-widest">Smart Sweep Generator (v13.0)</h3>
            <button
              onClick={() => navigator.clipboard.writeText(pythonScript)}
              className="text-[10px] bg-indigo-600 px-3 py-1 rounded-md text-white font-bold hover:bg-indigo-500"
            >
              COPY CODE
            </button>
          </div>
          <pre className="text-[11px] font-mono text-gray-400 overflow-x-auto leading-relaxed max-h-60 overflow-y-auto custom-scrollbar">
            {pythonScript}
          </pre>
          <div className="mt-4 p-3 bg-indigo-950/20 rounded-lg border border-indigo-900/30">
            <p className="text-[10px] text-indigo-400 leading-tight">
              <strong>v13.0 Fixed:</strong> The script now guarantees 3 different expirations. If Monthly coincides with 0DTE or Weekly, it automatically downloads the next Monthly.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
