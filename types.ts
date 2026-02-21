
export interface AnalysisLevel {
  livello: string; 
  prezzo: number;
  motivazione: string;
  sintesiOperativa: string; // Nuova descrizione operativa rapida
  colore: 'rosso' | 'verde' | 'indigo' | 'ambra';
  importanza: number; 
  ruolo: 'WALL' | 'PIVOT' | 'MAGNET' | 'FRICTION' | 'CONFLUENCE';
  isDayTrade: boolean;
  scadenzaTipo?: string;
  lato: 'CALL' | 'PUT' | 'BOTH' | 'GAMMA_FLIP';
}

export interface DailyOutlook {
  sentiment: string;
  gammaFlipZone: number;
  volatilityExpectation: string;
  summary: string;
}

export interface MarketDataset {
  id: string;
  name: string;
  content: string;
  type: '0DTE' | 'WEEKLY' | 'MONTHLY' | 'OTHER';
}

export interface AnalysisResponse {
  levels: AnalysisLevel[];
  outlook: DailyOutlook;
}

export interface ChatMessage {
  role: 'user' | 'model';
  parts: { text: string }[];
}

// Types for auto-fetch options data

export interface OptionsMetadata {
  timestamp: string;
  symbol: string;
  source: string;
}

export interface GammaLevel {
  strike: number;
  gamma: number;
  type: 'call' | 'put';
}

export interface OptionLevel {
  strike: number;
  open_interest: number;
  volume: number;
  gamma: number;
  delta: number;
  vega: number;
  theta: number;
}

export interface StructuredLevels {
  spot_price: number;
  call_levels: OptionLevel[];
  put_levels: OptionLevel[];
  gamma_levels: GammaLevel[];
  gamma_flip: number | null;
}

// Types for Python-generated symbols format

export interface OptionData {
  strike: number;
  side: 'CALL' | 'PUT';
  iv: number;
  oi: number;
  vol: number;
}

export interface ExpiryData {
  label: string;
  date: string;
  options: OptionData[];
}

export interface LegacyExpiryContent {
  content: string;
  type: string;
  date: string;
}

export interface SymbolData {
  spot: number;
  generated: string;
  expiries: ExpiryData[];
  legacy?: Record<string, LegacyExpiryContent>;
}

export interface OptionsDataResponse {
  version: string;
  generated: string | null;
  metadata?: OptionsMetadata;
  structured?: StructuredLevels;
  legacy?: string;
  symbols?: Record<string, SymbolData>;
}

export interface CachedData {
  data: OptionsDataResponse;
  timestamp: number;
}

export interface FetchResult {
  success: boolean;
  data?: OptionsDataResponse;
  error?: string;
  fromCache?: boolean;
}
