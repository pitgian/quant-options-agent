// Simplified Options Data Types - Put Wall / Call Wall Only

export interface WallLevel {
  strike: number;
  totalOI: number;        // sum of OI across all expirations at this strike
  totalVolume: number;    // sum of volume across all expirations at this strike
  score: number;          // combined score: OI*0.6 + Volume*0.4 (normalized)
  expirations: ExpirationDetail[];  // breakdown per expiration
  type: 'put' | 'call';
}

export interface ExpirationDetail {
  expirationDate: string;   // e.g. "2026-05-16"
  daysToExpiry: number;
  oi: number;
  volume: number;
}

export interface OptionsData {
  symbol: string;
  spotPrice: number;
  timestamp: string;        // ISO timestamp of data fetch
  putWalls: WallLevel[];    // top put walls (supports), sorted by score desc
  callWalls: WallLevel[];   // top call walls (resistances), sorted by score desc
  allExpirations: string[]; // list of all expiration dates analyzed
}
