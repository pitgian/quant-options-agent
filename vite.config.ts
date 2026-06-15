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
                  // Fetch SPY and QQQ quotes in parallel with pre-market data
                  const symbols = ['SPY', 'QQQ'];
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
                        const closes = result?.indicators?.quote?.[0]?.close || [];
                        
                        let price = null;
                        for (let i = closes.length - 1; i >= 0; i--) {
                          if (closes[i] !== null && closes[i] !== undefined) {
                            price = closes[i];
                            break;
                          }
                        }
                        if (price === null) {
                          price = meta?.regularMarketPrice || null;
                        }
                        return { symbol, price };
                      } catch (err) {
                        console.error(`Error fetching ${symbol} in dev server:`, err);
                        return { symbol, price: null };
                      }
                    })
                  );

                  const spyPrice = quotes.find(q => q.symbol === 'SPY')?.price || null;
                  const qqqPrice = quotes.find(q => q.symbol === 'QQQ')?.price || null;

                  // Use standard completed-close cash ratios to derive index spot prices
                  const SPX_SPY_RATIO = 10.024;
                  const NDX_QQQ_RATIO = 41.121;

                  const spotData = {
                    SPX: spyPrice ? Number((spyPrice * SPX_SPY_RATIO).toFixed(2)) : null,
                    NDX: qqqPrice ? Number((qqqPrice * NDX_QQQ_RATIO).toFixed(2)) : null,
                    SPY: spyPrice,
                    QQQ: qqqPrice,
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
