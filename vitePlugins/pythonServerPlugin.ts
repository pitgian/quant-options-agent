/**
 * Vite Plugin: Python Server Manager
 * 
 * This plugin automatically starts the local Python FastAPI server when
 * the Vite dev server starts, and stops it when Vite shuts down.
 */

import type { Plugin } from 'vite';
import { spawn, ChildProcess } from 'child_process';
import { platform } from 'os';

const PYTHON_SERVER_PORT = 8765;
const PYTHON_SERVER_HOST = '127.0.0.1';
const HEALTH_CHECK_TIMEOUT = 5000;
const SERVER_START_TIMEOUT = 30000;

let pythonProcess: ChildProcess | null = null;

/**
 * Get the Python executable path
 */
function getPythonExecutable(): string {
  const isWindows = platform() === 'win32';
  const venvPath = isWindows ? 'venv/Scripts/python.exe' : 'venv/bin/python';
  return venvPath;
}

/**
 * Check if the Python server is healthy
 */
async function checkServerHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);
    
    const response = await fetch(`http://${PYTHON_SERVER_HOST}:${PYTHON_SERVER_PORT}/health`, {
      method: 'GET',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for server to be ready
 */
async function waitForServer(): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < SERVER_START_TIMEOUT) {
    const isHealthy = await checkServerHealth();
    if (isHealthy) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Python server startup timeout');
}

/**
 * Start the Python server
 */
async function startPythonServer(): Promise<void> {
  // Check if already running
  const isHealthy = await checkServerHealth();
  if (isHealthy) {
    console.log('[vite-plugin-python] Python server already running');
    return;
  }
  
  console.log('[vite-plugin-python] Starting Python server...');
  
  const pythonExe = getPythonExecutable();
  const scriptPath = 'scripts/local_server.py';
  
  pythonProcess = spawn(pythonExe, [scriptPath, '--port', String(PYTHON_SERVER_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });
  
  pythonProcess.stdout?.on('data', (data) => {
    console.log(`[Python] ${data.toString().trim()}`);
  });
  
  pythonProcess.stderr?.on('data', (data) => {
    console.error(`[Python Error] ${data.toString().trim()}`);
  });
  
  pythonProcess.on('exit', (code, signal) => {
    console.log(`[vite-plugin-python] Python server exited (code: ${code}, signal: ${signal})`);
    pythonProcess = null;
  });
  
  pythonProcess.on('error', (error) => {
    console.error('[vite-plugin-python] Failed to start Python server:', error.message);
  });
  
  // Wait for server to be ready
  await waitForServer();
  console.log('[vite-plugin-python] Python server started successfully');
}

/**
 * Stop the Python server
 */
function stopPythonServer(): void {
  if (pythonProcess) {
    console.log('[vite-plugin-python] Stopping Python server...');
    pythonProcess.kill('SIGTERM');
    pythonProcess = null;
  }
}

/**
 * Vite plugin to manage Python server
 */
export function pythonServerPlugin(): Plugin {
  return {
    name: 'vite-plugin-python-server',
    
    async configureServer(server) {
      // Start Python server when Vite server starts
      try {
        await startPythonServer();
      } catch (error) {
        console.error('[vite-plugin-python] Failed to start Python server:', error);
        console.log('[vite-plugin-python] You may need to install Python dependencies:');
        console.log('  python -m venv venv');
        console.log('  source venv/bin/activate  # On Windows: venv\\Scripts\\activate');
        console.log('  pip install -r scripts/requirements.txt');
      }
      
      // Stop Python server when Vite server stops
      server.httpServer?.on('close', () => {
        stopPythonServer();
      });
      
      // Handle process termination
      process.on('SIGINT', () => {
        stopPythonServer();
        process.exit(0);
      });
      
      process.on('SIGTERM', () => {
        stopPythonServer();
        process.exit(0);
      });
    }
  };
}

export default pythonServerPlugin;
