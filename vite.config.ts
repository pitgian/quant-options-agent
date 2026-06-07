import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    
    const plugins = [react()];
    
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
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url) {
              const urlPath = req.url.split('?')[0];
              if (urlPath.startsWith('/data/')) {
                const filePath = path.join(__dirname, urlPath);
                if (fs.existsSync(filePath)) {
                  res.setHeader('Content-Type', 'application/json');
                  res.end(fs.readFileSync(filePath));
                  return;
                }
              }
            }
            next();
          });
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
