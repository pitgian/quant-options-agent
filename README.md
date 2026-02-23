<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Quant Options Agent

An interactive AI-powered options analysis web application built with React and Python.

## Features

- **Options Data Analysis**: Fetch and analyze options data
- **AI Integration**: Powered by Gemini AI for intelligent analysis
- **Web-Based**: Runs in any modern browser

## Prerequisites

- **Node.js** 18+
- **Python** 3.10+ with pip (for data fetching scripts)
- **npm** or **yarn**

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd agente-quant-interattivo-per-opzioni
   ```

2. Install Node.js dependencies:
   ```bash
   npm install
   ```

3. (Optional) Set up Python virtual environment for local data fetching:
   ```bash
   # Linux/macOS
   npm run python:setup
   
   # Windows
   npm run python:setup:win
   
   # Or manually:
   python3 -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   pip install -r scripts/requirements.txt
   ```

## Development

Run the app in development mode with hot reload:

```bash
npm run dev
```

This will:
- Start the Vite development server on port 5173
- **Automatically start the local Python FastAPI server** on port 8765
- Enable hot reload for React components

### Local Python Backend

When running locally, the application automatically:
1. Detects if the local Python server is available
2. Uses the local server for fetching options data (via yfinance)
3. Falls back to the Vercel API if the local server is unavailable

The Python server provides:
- `/health` - Health check endpoint
- `/options/{symbol}` - Options data for a specific symbol (SPY, QQQ, SPX, NDX)

To manually start the Python server:
```bash
# Linux/macOS
npm run python:start

# Windows
npm run python:start:win
```

## Build for Production

Build the application for deployment:

```bash
npm run build
```

The built files will be in the `dist/` directory.

## Project Structure

```
├── api/                     # Vercel serverless functions
├── backend/                 # Python backend
├── scripts/                 # Python data fetching scripts
│   └── fetch_options_data.py
├── components/              # React components
├── services/                # Frontend services
├── data/                    # Static data files
└── dist/                    # Built frontend files
```

## Configuration

### Environment Variables

Create a `.env.local` file for local development:

```
GEMINI_API_KEY=your_api_key_here
GLM_API_KEY=your_api_key_here
```

## Deployment

This project is configured for deployment on Vercel. The `vercel.json` file contains the routing configuration.

## License

MIT License - See LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request
