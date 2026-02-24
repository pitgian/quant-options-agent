import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    
    const plugins = [react()];
    
    // Solo in development: usa il plugin Python server
    if (mode === 'development') {
      try {
        const { pythonServerPlugin } = require('./vitePlugins/pythonServerPlugin');
        plugins.push(pythonServerPlugin());
      } catch (e) {
        console.warn('Python server plugin not available:', e);
      }
    }
    
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
