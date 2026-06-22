import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fetchSpotPrices } from './lib/spotPrices';

export default defineConfig(({ mode }) => {
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
              
              if (urlPath.startsWith('/data/')) {
                const fileName = path.basename(urlPath);
                const filePath = path.join(process.cwd(), 'data', fileName);
                if (fs.existsSync(filePath)) {
                  res.setHeader('Content-Type', 'application/json');
                  res.setHeader('Access-Control-Allow-Origin', '*');
                  res.end(fs.readFileSync(filePath));
                  return;
                }
              }

              if (urlPath === '/api-spot') {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
                try {
                  const spotData = await fetchSpotPrices();
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
    
    return {
      server: {
        port: 5173,
        host: '0.0.0.0',
        watch: {
          ignored: ['**/venv/**', '**/node_modules/**', '**/.git/**']
        }
      },
      plugins,
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
