# QUANT Smart Sweep - Backend API

FastAPI backend for on-demand options data fetching.

## Setup

### 1. Activate Virtual Environment

The project includes an existing virtual environment (`venv/`). Activate it before running:

```bash
# Activate the virtual environment
source venv/bin/activate
```

### 2. Install Python Dependencies

Make sure you have Python 3.8+ and pip installed:

```bash
# Install dependencies (from project root)
pip install -r backend/requirements.txt
```

### 3. Run the Backend Server

```bash
# From the project root directory (with venv activated)
uvicorn backend.main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`

## API Endpoints

### `GET /api/health`
Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-20T12:00:00",
  "service": "QUANT Smart Sweep API"
}
```

### `GET /api/symbols`
Get list of supported symbols.

**Response:**
```json
{
  "symbols": [
    {"symbol": "SPY", "description": "S&P 500 ETF", "proxy": "SPY"},
    {"symbol": "QQQ", "description": "Nasdaq 100 ETF", "proxy": "QQQ"},
    {"symbol": "SPX", "description": "S&P 500 Index", "proxy": "SPY"},
    {"symbol": "NDX", "description": "Nasdaq 100 Index", "proxy": "QQQ"}
  ]
}
```

### `GET /api/fetch?symbol=SPY`
Fetch options data for a specific symbol.

**Parameters:**
- `symbol` (query): One of SPY, QQQ, SPX, NDX (default: SPY)

**Response:**
```json
{
  "version": "2.0",
  "generated": "2024-01-20T12:00:00",
  "metadata": {
    "timestamp": "2024-01-20T12:00:00",
    "symbol": "SPY",
    "source": "yfinance_api"
  },
  "symbols": {
    "SPY": {
      "spot": 450.25,
      "generated": "2024-01-20T12:00:00",
      "expiries": [
        {
          "label": "0DTE",
          "date": "2024-01-20",
          "options": [
            {"strike": 450.0, "side": "CALL", "iv": 0.25, "oi": 1000, "vol": 500},
            {"strike": 449.0, "side": "PUT", "iv": 0.28, "oi": 800, "vol": 300}
          ]
        }
      ],
      "legacy": {
        "0DTE (2024-01-20)": {
          "content": "STRIKE | TIPO | IV | OI | VOL\n...",
          "type": "0DTE",
          "date": "2024-01-20"
        }
      }
    }
  }
}
```

### `GET /api/fetch-multiple?symbols=SPY,QQQ`
Fetch options data for multiple symbols.

**Parameters:**
- `symbols` (query): Comma-separated list of symbols (default: SPY,QQQ)

## Notes

- **SPX** and **NDX** are indices that yfinance may not have direct data for. The API uses **SPY** as a proxy for SPX and **QQQ** as a proxy for NDX.
- Data is fetched in real-time from Yahoo Finance via the yfinance library.
- The response format is compatible with the existing frontend [`dataService.ts`](../services/dataService.ts).

## Troubleshooting

### "pip not found"
Install pip first:
```bash
# Ubuntu/Debian
sudo apt-get install python3-pip

# macOS
brew install python3

# Windows
python -m ensurepip --upgrade
```

### "Module not found"
Make sure you're in the correct directory and have activated your virtual environment if using one:
```bash
# Create virtual environment
python3 -m venv venv

# Activate it
source venv/bin/activate  # Linux/macOS
# or
.\venv\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt
```

### CORS Issues
The backend is configured to allow all origins (`allow_origins=["*"]`). For production, restrict this to your frontend domain in [`main.py`](main.py).
