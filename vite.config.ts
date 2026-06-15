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
                  // Fetch ES=F and NQ=F quotes in parallel
                  const symbols = ['ES=F', 'NQ=F'];
                  const quotes = await Promise.all(
                    symbols.map(async (symbol) => {
                      try {
                        const response = await fetch(
                          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`,
                          {
                            headers: {
                              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                            }
                          }
                        );
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        const data = await response.json();
                        const meta = data?.chart?.result?.[0]?.meta;
                        return { symbol, price: meta?.regularMarketPrice || null };
                      } catch (err) {
                        console.error(`Error fetching ${symbol} in dev server:`, err);
                        return { symbol, price: null };
                      }
                    })
                  );

                  const esPrice = quotes.find(q => q.symbol === 'ES=F')?.price || null;
                  const nqPrice = quotes.find(q => q.symbol === 'NQ=F')?.price || null;

                  // Map ETF prices using standard ratios
                  const SPY_RATIO = 10.09;
                  const QQQ_RATIO = 41.57;

                  const spotData = {
                    SPX: esPrice,
                    NDX: nqPrice,
                    SPY: esPrice ? Number((esPrice / SPY_RATIO).toFixed(2)) : null,
                    QQQ: nqPrice ? Number((nqPrice / QQQ_RATIO).toFixed(2)) : null,
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
