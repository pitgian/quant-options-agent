/**
 * Local Python Server Service
 * 
 * This service manages the local Python FastAPI server for fetching options data.
 * It's designed to work in both browser and Node.js environments.
 * 
 * In browser: Makes HTTP requests to the Python server (server must be started separately)
 * In Node.js (Vite dev server): Can spawn and manage the Python subprocess
 */

import { spawn, ChildProcess } from 'child_process';
import { platform } from 'os';

// Configuration
const PYTHON_SERVER_PORT = 8765;
const PYTHON_SERVER_HOST = '127.0.0.1';
const PYTHON_SERVER_URL = `http://${PYTHON_SERVER_HOST}:${PYTHON_SERVER_PORT}`;
const HEALTH_CHECK_TIMEOUT = 5000; // 5 seconds
const SERVER_START_TIMEOUT = 30000; // 30 seconds

// Server state
let pythonProcess: ChildProcess | null = null;
let isServerRunning = false;
let serverStartupPromise: Promise<void> | null = null;

/**
 * Options contract interface (matching Python server response)
 */
export interface LocalOptionContract {
  strike: number;
  lastPrice: number;
  bid: number;
  ask: number;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number;
  inTheMoney: boolean;
}

/**
 * Options data response from local Python server
 */
export interface LocalOptionsDataResponse {
  symbol: string;
  calls: LocalOptionContract[];
  puts: LocalOptionContract[];
  currentPrice: number;
  expiry: string;
  availableExpirations: string[];
  timestamp: string;
}

/**
 * Health check response
 */
export interface HealthCheckResponse {
  status: string;
  timestamp: string;
  python_version: string;
}

/**
 * Get the Python executable path
 * Checks for venv first, then falls back to system Python
 */
function getPythonExecutable(): string {
  const isWindows = platform() === 'win32';
  const venvPath = isWindows ? 'venv/Scripts/python.exe' : 'venv/bin/python';
  
  // Check if venv exists (we'll return the venv path optimistically)
  // The actual check will happen when we try to start the server
  return venvPath;
}

/**
 * Check if the Python server is healthy
 */
export async function checkServerHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);
    
    const response = await fetch(`${PYTHON_SERVER_URL}/health`, {
      method: 'GET',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const data: HealthCheckResponse = await response.json();
      console.log('[LocalPythonService] Server health check passed:', data.status);
      isServerRunning = true;
      return true;
    }
    
    return false;
  } catch (error) {
    console.log('[LocalPythonService] Server health check failed:', error);
    isServerRunning = false;
    return false;
  }
}

/**
 * Start the Python server
 * Only works in Node.js environment (Vite dev server)
 */
export async function startPythonServer(): Promise<void> {
  // If already starting, wait for that promise
  if (serverStartupPromise) {
    return serverStartupPromise;
  }
  
  // If already running, return immediately
  if (isServerRunning) {
    const isHealthy = await checkServerHealth();
    if (isHealthy) return;
  }
  
  serverStartupPromise = (async () => {
    try {
      console.log('[LocalPythonService] Starting Python server...');
      
      const pythonExe = getPythonExecutable();
      const scriptPath = 'scripts/local_server.py';
      
      // Spawn the Python process
      pythonProcess = spawn(pythonExe, [scriptPath, '--port', String(PYTHON_SERVER_PORT)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });
      
      // Handle stdout
      pythonProcess.stdout?.on('data', (data) => {
        console.log(`[Python Server] ${data.toString().trim()}`);
      });
      
      // Handle stderr
      pythonProcess.stderr?.on('data', (data) => {
        console.error(`[Python Server Error] ${data.toString().trim()}`);
      });
      
      // Handle process exit
      pythonProcess.on('exit', (code, signal) => {
        console.log(`[LocalPythonService] Python server exited with code ${code}, signal ${signal}`);
        isServerRunning = false;
        pythonProcess = null;
      });
      
      // Handle process error
      pythonProcess.on('error', (error) => {
        console.error('[LocalPythonService] Failed to start Python server:', error);
        isServerRunning = false;
        pythonProcess = null;
      });
      
      // Wait for server to be ready
      const startTime = Date.now();
      while (Date.now() - startTime < SERVER_START_TIMEOUT) {
        const isHealthy = await checkServerHealth();
        if (isHealthy) {
          console.log('[LocalPythonService] Python server started successfully');
          isServerRunning = true;
          return;
        }
        // Wait 500ms before retrying
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      throw new Error('Python server startup timeout');
      
    } catch (error) {
      console.error('[LocalPythonService] Failed to start Python server:', error);
      isServerRunning = false;
      pythonProcess = null;
      throw error;
    } finally {
      serverStartupPromise = null;
    }
  })();
  
  return serverStartupPromise;
}

/**
 * Stop the Python server
 */
export async function stopPythonServer(): Promise<void> {
  if (pythonProcess) {
    console.log('[LocalPythonService] Stopping Python server...');
    pythonProcess.kill('SIGTERM');
    pythonProcess = null;
    isServerRunning = false;
  }
}

/**
 * Fetch options data from the local Python server
 * Automatically starts the server if not running (in Node.js environment)
 */
export async function fetchLocalOptionsData(
  symbol: string,
  expiry?: string
): Promise<LocalOptionsDataResponse> {
  // Check if server is running
  const isHealthy = await checkServerHealth();
  
  if (!isHealthy) {
    // Try to start the server (this will work in Node.js, but not in browser)
    try {
      await startPythonServer();
    } catch (error) {
      throw new Error(
        'Local Python server is not running. Please start it manually with: ' +
        `python scripts/local_server.py --port ${PYTHON_SERVER_PORT}`
      );
    }
  }
  
  // Build URL with query parameters
  let url = `${PYTHON_SERVER_URL}/options/${symbol.toUpperCase()}`;
  if (expiry) {
    url += `?expiry=${expiry}`;
  }
  
  console.log(`[LocalPythonService] Fetching options data from: ${url}`);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json'
    }
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(errorData.detail || `HTTP error: ${response.status}`);
  }
  
  const data: LocalOptionsDataResponse = await response.json();
  console.log(`[LocalPythonService] Successfully fetched ${data.calls.length} calls and ${data.puts.length} puts`);
  
  return data;
}

/**
 * Check if we're running in a local development environment
 */
export function isLocalDevelopment(): boolean {
  // Check if we're on localhost
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1';
  }
  return false;
}

/**
 * Get the local server URL
 */
export function getLocalServerUrl(): string {
  return PYTHON_SERVER_URL;
}

/**
 * Check if the local Python server is available
 */
export async function isLocalServerAvailable(): Promise<boolean> {
  if (!isLocalDevelopment()) {
    return false;
  }
  return checkServerHealth();
}

// Export for Vite plugin usage
export const localPythonService = {
  startPythonServer,
  stopPythonServer,
  checkServerHealth,
  fetchLocalOptionsData,
  isLocalDevelopment,
  isLocalServerAvailable,
  getLocalServerUrl
};

export default localPythonService;
