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
                  const symbols = ['SPY', 'QQQ', '^SPX', '^NDX'];
                  const quotes = await Promise.all(
                    symbols.map(async (symbol) => {
                      try {
                        const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`);
                        const data = await response.json();
                        const meta = data?.chart?.result?.[0]?.meta;
                        return { symbol, price: meta?.regularMarketPrice || null };
                      } catch (err) {
                        console.error(`Error fetching ${symbol} in dev server:`, err);
                        return { symbol, price: null };
                      }
                    })
                  );

                  const spotData = {
                    SPY: quotes.find(q => q.symbol === 'SPY')?.price || null,
                    QQQ: quotes.find(q => q.symbol === 'QQQ')?.price || null,
                    SPX: quotes.find(q => q.symbol === '^SPX')?.price || null,
                    NDX: quotes.find(q => q.symbol === '^NDX')?.price || null,
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
