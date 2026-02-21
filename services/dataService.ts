import { OptionsDataResponse, CachedData, FetchResult, MarketDataset, SymbolData, ExpiryData } from '../types';

// Cache configuration
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_KEY = 'options_data_cache';
const BACKEND_CACHE_KEY = 'backend_options_data_cache';

// Get the data URL from environment variables
const getDataUrl = (): string => {
  return import.meta.env.VITE_DATA_URL || '/data/options_data.json';
};

// Get the backend API URL from environment variables
// Uses Vercel Python function endpoint by default, falls back to localhost for development
const getApiUrl = (): string => {
  return import.meta.env.VITE_API_URL || '/api/fetch_data';
};

/**
 * Get cached data if still valid
 */
const getCachedData = (): CachedData | null => {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return null;
    
    const parsed: CachedData = JSON.parse(cached);
    const now = Date.now();
    
    // Check if cache is still valid
    if (now - parsed.timestamp < CACHE_TTL_MS) {
      return parsed;
    }
    
    // Cache expired, remove it
    localStorage.removeItem(CACHE_KEY);
    return null;
  } catch {
    return null;
  }
};

/**
 * Save data to cache
 */
const setCachedData = (data: OptionsDataResponse): void => {
  try {
    const cacheEntry: CachedData = {
      data,
      timestamp: Date.now()
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cacheEntry));
  } catch (e) {
    console.warn('Failed to cache options data:', e);
  }
};

/**
 * Clear the cache
 */
export const clearCache = (): void => {
  localStorage.removeItem(CACHE_KEY);
};

/**
 * Fetch options data from JSON file
 */
export const fetchOptionsData = async (forceRefresh: boolean = false): Promise<FetchResult> => {
  // Check cache first unless force refresh
  if (!forceRefresh) {
    const cached = getCachedData();
    if (cached) {
      return {
        success: true,
        data: cached.data,
        fromCache: true
      };
    }
  }

  try {
    const url = getDataUrl();
    
    // Add timestamp to prevent browser caching
    const fetchUrl = url.includes('?') 
      ? `${url}&t=${Date.now()}` 
      : `${url}?t=${Date.now()}`;
    
    const response = await fetch(fetchUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    const data: OptionsDataResponse = await response.json();
    
    // Validate the response has expected structure
    // Accept: symbols format (Python), structured format, or legacy format
    if (!data.version && !data.structured && !data.legacy && !data.symbols) {
      throw new Error('Invalid data format');
    }

    // Cache the successful response
    setCachedData(data);

    return {
      success: true,
      data,
      fromCache: false
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to fetch options data:', errorMessage);
    
    return {
      success: false,
      error: errorMessage
    };
  }
};

/**
 * Parse structured levels into MarketDataset format
 */
const parseStructuredLevels = (structured: NonNullable<OptionsDataResponse['structured']>): MarketDataset[] => {
  const datasets: MarketDataset[] = [];
  
  // Create a combined dataset from structured data
  const lines: string[] = [];
  lines.push(`SPOT: ${structured.spot_price}`);
  lines.push('');
  
  if (structured.call_levels?.length) {
    lines.push('=== CALL LEVELS ===');
    structured.call_levels.forEach(level => {
      lines.push(`Strike: ${level.strike} | OI: ${level.open_interest} | Vol: ${level.volume} | Gamma: ${level.gamma?.toFixed(4) || 'N/A'}`);
    });
    lines.push('');
  }
  
  if (structured.put_levels?.length) {
    lines.push('=== PUT LEVELS ===');
    structured.put_levels.forEach(level => {
      lines.push(`Strike: ${level.strike} | OI: ${level.open_interest} | Vol: ${level.volume} | Gamma: ${level.gamma?.toFixed(4) || 'N/A'}`);
    });
    lines.push('');
  }
  
  if (structured.gamma_levels?.length) {
    lines.push('=== GAMMA LEVELS ===');
    structured.gamma_levels.forEach(level => {
      lines.push(`${level.type.toUpperCase()}: ${level.strike} | Gamma: ${level.gamma?.toFixed(4) || 'N/A'}`);
    });
    lines.push('');
  }
  
  if (structured.gamma_flip) {
    lines.push(`GAMMA FLIP: ${structured.gamma_flip}`);
  }

  datasets.push({
    id: `structured-${Date.now()}`,
    name: 'Auto-Fetched Data',
    content: lines.join('\n'),
    type: 'OTHER'
  });

  return datasets;
};

/**
 * Parse symbols format (Python-generated) into MarketDataset format
 */
const parseSymbolsFormat = (symbols: Record<string, SymbolData>): { datasets: MarketDataset[]; spotPrice: number | null } => {
  const datasets: MarketDataset[] = [];
  let spotPrice: number | null = null;
  
  // Process each symbol
  for (const [symbol, data] of Object.entries(symbols)) {
    // Extract spot price from first symbol
    if (!spotPrice && data.spot) {
      spotPrice = data.spot;
    }
    
    // If legacy format is available, use it directly
    if (data.legacy) {
      for (const [key, legacyData] of Object.entries(data.legacy)) {
        const expiryType = legacyData.type.includes('0DTE') ? '0DTE' :
                          legacyData.type.includes('WEEKLY') ? 'WEEKLY' :
                          legacyData.type.includes('MONTHLY') ? 'MONTHLY' : 'OTHER';
        
        datasets.push({
          id: `symbols-${symbol}-${key}`,
          name: `${symbol} - ${key}`,
          content: legacyData.content,
          type: expiryType
        });
      }
    } else if (data.expiries?.length) {
      // Generate content from expiries if no legacy format
      for (const expiry of data.expiries) {
        const lines: string[] = [];
        lines.push(`SPOT: ${data.spot}`);
        lines.push(`SYMBOL: ${symbol}`);
        lines.push(`EXPIRY: ${expiry.date}`);
        lines.push('');
        lines.push('STRIKE | TIPO | IV | OI | VOL');
        
        for (const opt of expiry.options) {
          lines.push(
            `${opt.strike.toFixed(2)} | ${opt.side} | ${opt.iv.toFixed(4)} | ${opt.oi} | ${opt.vol}`
          );
        }
        
        const expiryType = expiry.label.includes('0DTE') ? '0DTE' :
                          expiry.label.includes('WEEKLY') ? 'WEEKLY' :
                          expiry.label.includes('MONTHLY') ? 'MONTHLY' : 'OTHER';
        
        datasets.push({
          id: `symbols-${symbol}-${expiry.label}-${expiry.date}`,
          name: `${symbol} - ${expiry.label} (${expiry.date})`,
          content: lines.join('\n'),
          type: expiryType
        });
      }
    }
  }
  
  return { datasets, spotPrice };
};

/**
 * Parse legacy format (QUANT_SWEEP text) into MarketDataset format
 */
const parseLegacyFormat = (legacy: string, spotPrice?: number): MarketDataset[] => {
  const datasets: MarketDataset[] = [];
  
  // Check if it's the new format with expiry sections
  if (legacy.includes('=== START_EXPIRY:')) {
    const sections = legacy.split('=== START_EXPIRY:');
    
    sections.forEach(section => {
      if (!section.trim() || !section.includes('=== END_EXPIRY:')) return;
      
      const headerLine = section.split('\n')[0];
      const expiryLabel = headerLine.split('|')[0].trim();
      const dateMatch = headerLine.match(/DATE:\s*([\d-]+)/);
      const date = dateMatch ? dateMatch[1] : expiryLabel;
      const content = section.split('=== END_EXPIRY:')[0].split('\n').slice(1).join('\n').trim();
      
      datasets.push({
        id: `legacy-${Math.random().toString(36).substr(2, 9)}`,
        name: `${expiryLabel} (${date})`,
        content,
        type: expiryLabel.includes('0DTE') ? '0DTE' : 
              expiryLabel.includes('WEEKLY') ? 'WEEKLY' : 
              expiryLabel.includes('MONTHLY') ? 'MONTHLY' : 'OTHER'
      });
    });
  } else {
    // Simple legacy format - create a single dataset
    datasets.push({
      id: `legacy-${Date.now()}`,
      name: 'Legacy Data',
      content: legacy,
      type: 'OTHER'
    });
  }

  return datasets;
};

/**
 * Convert OptionsDataResponse to MarketDataset array
 */
export const convertToDatasets = (
  response: OptionsDataResponse,
  spotPrice?: number
): { datasets: MarketDataset[]; extractedSpotPrice: number | null } => {
  const datasets: MarketDataset[] = [];
  let extractedSpotPrice: number | null = null;

  // Priority 1: Parse symbols format (Python-generated)
  if (response.symbols && Object.keys(response.symbols).length > 0) {
    const symbolsResult = parseSymbolsFormat(response.symbols);
    datasets.push(...symbolsResult.datasets);
    if (symbolsResult.spotPrice) {
      extractedSpotPrice = symbolsResult.spotPrice;
    }
  }

  // Priority 2: Extract spot price from structured data
  if (response.structured?.spot_price) {
    extractedSpotPrice = response.structured.spot_price;
  }

  // Priority 3: Parse structured data if available (backward compatibility)
  if (response.structured) {
    datasets.push(...parseStructuredLevels(response.structured));
  }

  // Priority 4: Parse legacy format if available (backward compatibility)
  if (response.legacy) {
    datasets.push(...parseLegacyFormat(response.legacy, spotPrice ?? undefined));
    
    // Try to extract spot price from legacy format if not found yet
    if (!extractedSpotPrice && response.legacy) {
      const spotMatch = response.legacy.match(/SPOT[:\s|]+(\d+\.?\d*)/i);
      if (spotMatch?.[1]) {
        extractedSpotPrice = parseFloat(spotMatch[1]);
      }
    }
  }

  return { datasets, extractedSpotPrice };
};

/**
 * Get time since last update in human-readable format
 */
export const getTimeSinceUpdate = (timestamp: string | null | undefined): string => {
  if (!timestamp) return 'Mai';
  
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    
    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days} giorn${days === 1 ? 'o' : 'i'} fa`;
    if (hours > 0) return `${hours} or${hours === 1 ? 'a' : 'e'} fa`;
    if (minutes > 0) return `${minutes} minut${minutes === 1 ? 'o' : 'i'} fa`;
    return 'Adesso';
  } catch {
    return 'Data non valida';
  }
};

/**
 * Get cache status
 */
export const getCacheStatus = (): { cached: boolean; age: number; expiresAt: number | null } => {
  const cached = getCachedData();
  if (!cached) {
    return { cached: false, age: 0, expiresAt: null };
  }
  
  const age = Date.now() - cached.timestamp;
  const expiresAt = cached.timestamp + CACHE_TTL_MS;
  
  return { cached: true, age, expiresAt };
};

/**
 * Get cached backend data if still valid
 */
const getCachedBackendData = (symbol: string): CachedData | null => {
  try {
    const cacheKey = `${BACKEND_CACHE_KEY}_${symbol}`;
    const cached = localStorage.getItem(cacheKey);
    if (!cached) return null;
    
    const parsed: CachedData = JSON.parse(cached);
    const now = Date.now();
    
    // Check if cache is still valid
    if (now - parsed.timestamp < CACHE_TTL_MS) {
      return parsed;
    }
    
    // Cache expired, remove it
    localStorage.removeItem(cacheKey);
    return null;
  } catch {
    return null;
  }
};

/**
 * Save backend data to cache
 */
const setCachedBackendData = (symbol: string, data: OptionsDataResponse): void => {
  try {
    const cacheKey = `${BACKEND_CACHE_KEY}_${symbol}`;
    const cacheEntry: CachedData = {
      data,
      timestamp: Date.now()
    };
    localStorage.setItem(cacheKey, JSON.stringify(cacheEntry));
  } catch (e) {
    console.warn('Failed to cache backend options data:', e);
  }
};

/**
 * Clear backend cache for a specific symbol or all
 */
export const clearBackendCache = (symbol?: string): void => {
  if (symbol) {
    localStorage.removeItem(`${BACKEND_CACHE_KEY}_${symbol}`);
  } else {
    // Clear all backend cache entries
    Object.keys(localStorage)
      .filter(key => key.startsWith(BACKEND_CACHE_KEY))
      .forEach(key => localStorage.removeItem(key));
  }
};

/**
 * Fetch options data from backend API
 */
export const fetchFromBackend = async (
  symbol: string = 'SPY',
  forceRefresh: boolean = false
): Promise<FetchResult> => {
  // Check cache first unless force refresh
  if (!forceRefresh) {
    const cached = getCachedBackendData(symbol);
    if (cached) {
      return {
        success: true,
        data: cached.data,
        fromCache: true
      };
    }
  }

  try {
    const apiUrl = getApiUrl();
    const url = `${apiUrl}?symbol=${encodeURIComponent(symbol)}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      // Try to parse error message from response
      let errorMessage = `HTTP error: ${response.status}`;
      try {
        const errorData = await response.json();
        if (errorData.detail) {
          errorMessage = errorData.detail;
        }
      } catch {
        // Ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }

    const data: OptionsDataResponse = await response.json();
    
    // Validate the response has expected structure
    if (!data.version && !data.structured && !data.legacy && !data.symbols) {
      throw new Error('Invalid data format from backend');
    }

    // Cache the successful response
    setCachedBackendData(symbol, data);

    return {
      success: true,
      data,
      fromCache: false
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to fetch from backend:', errorMessage);
    
    // Check if it's a network error (backend not available)
    if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
      return {
        success: false,
        error: 'Backend non disponibile. Verificare che il server sia avviato.'
      };
    }
    
    return {
      success: false,
      error: errorMessage
    };
  }
};

/**
 * Fetch options data for multiple symbols from backend
 */
export const fetchMultipleFromBackend = async (
  symbols: string[],
  forceRefresh: boolean = false
): Promise<FetchResult> => {
  try {
    const apiUrl = getApiUrl();
    const url = `${apiUrl}/multiple?symbols=${encodeURIComponent(symbols.join(','))}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      let errorMessage = `HTTP error: ${response.status}`;
      try {
        const errorData = await response.json();
        if (errorData.detail) {
          errorMessage = errorData.detail;
        }
      } catch {
        // Ignore JSON parse errors
      }
      throw new Error(errorMessage);
    }

    const data: OptionsDataResponse = await response.json();
    
    if (!data.version && !data.structured && !data.legacy && !data.symbols) {
      throw new Error('Invalid data format from backend');
    }

    // Cache each symbol separately
    if (data.symbols) {
      for (const [sym, symData] of Object.entries(data.symbols)) {
        setCachedBackendData(sym, {
          ...data,
          symbols: { [sym]: symData }
        });
      }
    }

    return {
      success: true,
      data,
      fromCache: false
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to fetch multiple from backend:', errorMessage);
    
    if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
      return {
        success: false,
        error: 'Backend non disponibile. Verificare che il server sia avviato.'
      };
    }
    
    return {
      success: false,
      error: errorMessage
    };
  }
};
