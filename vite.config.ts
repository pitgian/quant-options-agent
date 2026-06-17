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
                  // Helper function to check if the US stock market is open
                  const isMarketOpen = () => {
                    const nd = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
                    const nyDate = new Date(nd);
                    const day = nyDate.getDay(); // 0 = Sunday, 6 = Saturday
                    const hour = nyDate.getHours();
                    const minute = nyDate.getMinutes();
                    
                    // Market is open Mon-Fri, 9:30 AM - 4:00 PM
                    if (day === 0 || day === 6) return false;
                    const timeInMinutes = hour * 60 + minute;
                    return timeInMinutes >= 9 * 60 + 30 && timeInMinutes < 16 * 60;
                  };

                  // Fetch SPY, QQQ, ES=F, NQ=F, ^SPX, and ^NDX quotes in parallel
                  const symbols = ['SPY', 'QQQ', 'ES=F', 'NQ=F', '^SPX', '^NDX'];
                  const quotes: Record<string, { live: number | null; prevClose: number | null }> = {};

                  await Promise.all(
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
                        const data = (await response.json()) as any;
                        const result = data?.chart?.result?.[0];
                        const meta = result?.meta;
                        const closes = result?.indicators?.quote?.[0]?.close || [];
                        
                        let lastCandlePrice = null;
                        for (let i = closes.length - 1; i >= 0; i--) {
                          if (closes[i] !== null && closes[i] !== undefined) {
                            lastCandlePrice = closes[i];
                            break;
                          }
                        }
                        
                        const live = meta?.regularMarketPrice || lastCandlePrice;
                        const prevClose = meta?.chartPreviousClose || meta?.previousClose || lastCandlePrice;
                        
                        quotes[symbol] = { live, prevClose };
                      } catch (err) {
                        console.error(`Error fetching ${symbol} in dev server:`, err);
                        quotes[symbol] = { live: null, prevClose: null };
                      }
                    })
                  );

                  // Extract variables with defaults
                  const spyLive = quotes['SPY']?.live || null;
                  const spyPrev = quotes['SPY']?.prevClose || null;
                  
                  const qqqLive = quotes['QQQ']?.live || null;
                  const qqqPrev = quotes['QQQ']?.prevClose || null;
                  
                  const esLive = quotes['ES=F']?.live || null;
                  const esPrev = quotes['ES=F']?.prevClose || null;
                  
                  const nqLive = quotes['NQ=F']?.live || null;
                  const nqPrev = quotes['NQ=F']?.prevClose || null;
                  
                  const spxLive = quotes['^SPX']?.live || null;
                  const spxPrev = quotes['^SPX']?.prevClose || null;
                  
                  const ndxLive = quotes['^NDX']?.live || null;
                  const ndxPrev = quotes['^NDX']?.prevClose || null;

                  const marketOpen = isMarketOpen();

                  let derivedSPX: number | null = null;
                  let derivedNDX: number | null = null;
                  let derivedSPY: number | null = null;
                  let derivedQQQ: number | null = null;

                  if (marketOpen) {
                    // Active Trading Hours
                    const spxRatio = (spxPrev && spyPrev) ? (spxPrev / spyPrev) : 10.024;
                    const ndxRatio = (ndxPrev && qqqPrev) ? (ndxPrev / qqqPrev) : 41.121;
                    
                    derivedSPX = spyLive ? Number((spyLive * spxRatio).toFixed(2)) : (spxLive || spxPrev);
                    derivedNDX = qqqLive ? Number((qqqLive * ndxRatio).toFixed(2)) : (ndxLive || ndxPrev);
                    derivedSPY = spyLive;
                    derivedQQQ = qqqLive;
                  } else {
                    // Overnight / Closed Hours (Estimate from futures relative returns)
                    const esRatio = (esLive && esPrev) ? (esLive / esPrev) : 1.0;
                    const nqRatio = (nqLive && nqPrev) ? (nqLive / nqPrev) : 1.0;
                    
                    derivedSPX = spxPrev ? Number((spxPrev * esRatio).toFixed(2)) : null;
                    derivedNDX = ndxPrev ? Number((ndxPrev * nqRatio).toFixed(2)) : null;
                    derivedSPY = spyPrev ? Number((spyPrev * esRatio).toFixed(2)) : null;
                    derivedQQQ = qqqPrev ? Number((qqqPrev * nqRatio).toFixed(2)) : null;
                  }

                  const spotData = {
                    SPX: derivedSPX,
                    NDX: derivedNDX,
                    SPY: derivedSPY,
                    QQQ: derivedQQQ,
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
