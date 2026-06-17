import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    
    const plugins = [
      react(),
      {
        name: 'dev-server-api',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url) {
              const url = new URL(req.url, 'http://localhost');
              const urlPath = url.pathname;

              if (urlPath === '/api-spot') {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                try {
                  // Fetch SPY, QQQ, ES=F, and NQ=F quotes in parallel with pre-market data
                  const symbols = ['SPY', 'QQQ', 'ES=F', 'NQ=F'];
                  const quotes = await Promise.all(
                    symbols.map(async (symbol) => {
                      try {
                        const response = await fetch(
                          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`,
                          {
                            headers: {
                              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                            }
                          }
                        );
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        const data = await response.json();
                        const result = data?.chart?.result?.[0];
                        const meta = result?.meta;
                        const timestamps = result?.timestamp || [];
                        const closes = result?.indicators?.quote?.[0]?.close || [];
                        
                        const candles = [];
                        for (let i = 0; i < closes.length; i++) {
                          if (closes[i] !== null && closes[i] !== undefined) {
                            candles.push({
                              time: timestamps[i],
                              price: closes[i]
                            });
                          }
                        }
                        
                        let latestPrice = meta?.regularMarketPrice || null;
                        let latestTime = Math.floor(Date.now() / 1000);
                        if (candles.length > 0) {
                          latestPrice = candles[candles.length - 1].price;
                          latestTime = candles[candles.length - 1].time;
                        }
                        
                        return { symbol, candles, latestPrice, latestTime };
                      } catch (err) {
                        console.error(`Error fetching ${symbol} in dev server:`, err);
                        return { symbol, candles: [], latestPrice: null, latestTime: 0 };
                      }
                    })
                  );

                  const spyChart = quotes.find(q => q.symbol === 'SPY') || { candles: [], latestPrice: null, latestTime: 0 };
                  const qqqChart = quotes.find(q => q.symbol === 'QQQ') || { candles: [], latestPrice: null, latestTime: 0 };
                  const esChart = quotes.find(q => q.symbol === 'ES=F') || { candles: [], latestPrice: null, latestTime: 0 };
                  const nqChart = quotes.find(q => q.symbol === 'NQ=F') || { candles: [], latestPrice: null, latestTime: 0 };

                  // Helper function to find price of a chart at a specific timestamp
                  const getPriceAtTime = (chart: any, targetTime: number, fallbackPrice: number | null) => {
                    if (!chart.candles || chart.candles.length === 0) return fallbackPrice;
                    
                    let closestCandle = chart.candles[0];
                    let minDiff = Math.abs(closestCandle.time - targetTime);
                    
                    for (const candle of chart.candles) {
                      const diff = Math.abs(candle.time - targetTime);
                      if (diff < minDiff) {
                        minDiff = diff;
                        closestCandle = candle;
                      }
                    }
                    
                    // If the closest candle is more than 30 minutes away, fallback
                    if (minDiff > 1800) {
                      return fallbackPrice;
                    }
                    
                    return closestCandle.price;
                  };

                  const SPX_SPY_RATIO = 10.024;
                  const NDX_QQQ_RATIO = 41.121;

                  // S&P 500 Calculations
                  const spyPrice = spyChart.latestPrice;
                  const spyTime = spyChart.latestTime;
                  const esLive = esChart.latestPrice;

                  let esBasis = 0;
                  if (spyPrice && esLive && spyTime) {
                    const esPriceAtSpyTime = getPriceAtTime(esChart, spyTime, esLive) || esLive;
                    esBasis = esPriceAtSpyTime - (spyPrice * SPX_SPY_RATIO);
                  }

                  const spxPrice = esLive ? Number((esLive - esBasis).toFixed(2)) : (spyPrice ? Number((spyPrice * SPX_SPY_RATIO).toFixed(2)) : null);
                  const spyDerived = spxPrice ? Number((spxPrice / SPX_SPY_RATIO).toFixed(2)) : spyPrice;

                  // Nasdaq 105 Calculations
                  const qqqPrice = qqqChart.latestPrice;
                  const qqqTime = qqqChart.latestTime;
                  const nqLive = nqChart.latestPrice;

                  let nqBasis = 0;
                  if (qqqPrice && nqLive && qqqTime) {
                    const nqPriceAtQqqTime = getPriceAtTime(nqChart, qqqTime, nqLive) || nqLive;
                    nqBasis = nqPriceAtQqqTime - (qqqPrice * NDX_QQQ_RATIO);
                  }

                  const ndxPrice = nqLive ? Number((nqLive - nqBasis).toFixed(2)) : (qqqPrice ? Number((qqqPrice * NDX_QQQ_RATIO).toFixed(2)) : null);
                  const qqqDerived = ndxPrice ? Number((ndxPrice / NDX_QQQ_RATIO).toFixed(2)) : qqqPrice;

                  const spotData = {
                    SPX: spxPrice,
                    NDX: ndxPrice,
                    SPY: spyDerived,
                    QQQ: qqqDerived,
                    ES: esLive,
                    NQ: nqLive,
                    timestamp: new Date().toISOString()
                  };

                  res.end(JSON.stringify(spotData));
                } catch (error) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: 'Failed to fetch spot prices', details: String(error) }));
                }
                return;
              }
            }
            next();
          });
        }
      }
    ];
    
    // Copy data folder to dist for Vercel deployment
    plugins.push(viteStaticCopy({
      targets: [
        {
          src: 'data',
          dest: '.'
        }
      ]
    }));
    
    return {
      server: {
        port: 5173,
        host: '0.0.0.0',
        watch: {
          ignored: ['**/venv/**', '**/node_modules/**', '**/.git/**']
        }
      },
      plugins,
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        outDir: 'dist',
        emptyOutDir: true,
      }
    };
});
