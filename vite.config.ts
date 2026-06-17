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

              console.log('[DEBUG] Vite middleware - req.url:', req.url, 'urlPath:', urlPath);
              if (urlPath === '/api-spot') {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
                try {
                  // Fetch SPY, QQQ, ES=F, NQ=F, ^SPX, and ^NDX quotes in parallel
                  const symbols = ['SPY', 'QQQ', 'ES=F', 'NQ=F', '^SPX', '^NDX'];
                  const quotes: Record<string, { live: number | null; prevClose: number | null }> = {};

                  await Promise.all(
                    symbols.map(async (symbol) => {
                      try {
                        const response = await fetch(
                          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=5m&includePrePost=true`,
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
                  const spyPrev = quotes['SPY']?.prevClose || null;
                  const qqqPrev = quotes['QQQ']?.prevClose || null;
                  
                  const esLive = quotes['ES=F']?.live || null;
                  const esPrev = quotes['ES=F']?.prevClose || null;
                  
                  const nqLive = quotes['NQ=F']?.live || null;
                  const nqPrev = quotes['NQ=F']?.prevClose || null;
                  
                  const spxPrev = quotes['^SPX']?.prevClose || null;
                  const ndxPrev = quotes['^NDX']?.prevClose || null;

                  // Always derive spot prices from active futures returns 24/5
                  const esRatio = (esLive && esPrev) ? (esLive / esPrev) : 1.0;
                  const nqRatio = (nqLive && nqPrev) ? (nqLive / nqPrev) : 1.0;
                  
                  const derivedSPX = spxPrev ? Number((spxPrev * esRatio).toFixed(2)) : null;
                  const derivedNDX = ndxPrev ? Number((ndxPrev * nqRatio).toFixed(2)) : null;
                  const derivedSPY = spyPrev ? Number((spyPrev * esRatio).toFixed(2)) : null;
                  const derivedQQQ = qqqPrev ? Number((qqqPrev * nqRatio).toFixed(2)) : null;

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
