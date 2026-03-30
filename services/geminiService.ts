
import { GoogleGenAI, Type, Content } from "@google/genai";
import {
  AnalysisLevel,
  AnalysisResponse,
  MarketDataset,
  ConfluenceLevel,
  ResonanceLevel,
  LegacyConfluenceLevel,
  LegacyResonanceLevel,
  SelectedLevels,
  AIReadyData,
  MarketContext,
  isEnhancedConfluenceLevel,
  isEnhancedResonanceLevel
} from '../types';

const MAX_RETRIES = 3;

// Get API key from Vite environment variables
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.warn('VITE_GEMINI_API_KEY not set. Gemini AI features will not work.');
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY || '' });

const cleanJson = (text: string): string => {
    let cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
    const firstBracket = cleaned.indexOf('{');
    const lastBracket = cleaned.lastIndexOf('}');
    if (firstBracket !== -1 && lastBracket !== -1) {
        return cleaned.substring(firstBracket, lastBracket + 1);
    }
    return cleaned;
};

const harmonicSystemInstruction = `You are a Quantitative Analysis Engine specialized in Market Maker Hedging and Options Harmonic Resonance.

IMPORTANT: ALL text content in your response (livello, motivazione, sintesiOperativa, summary, volatilityExpectation) MUST be in ENGLISH.

RULES FOR OPERATIONAL SYNTHESIS (FIELD: sintesiOperativa):
Provide a concise and imperative trading signal (max 8 words) IN ENGLISH.
Examples:
- "SELL AREA: Target reached"
- "LONG: Breakout confirmed above 26k"
- "MM DEFENSE: Structural support"
- "SCALPING: Expected volatility in range"
- "ATTRACTION: Price magnet active"

**HYBRID AI APPROACH - DYNAMIC LEVEL DETECTION:**
When AGGREGATED OPTIONS DATA is provided, you MUST:
1. DYNAMICALLY identify levels from the raw strike data - do NOT just rely on pre-calculated levels
2. Use PRE-CALCULATED METRICS (Gamma Flip, Total GEX, Max Pain) as reference/validation points
3. Discover patterns and levels that may not be in pre-calculated data
4. Cross-reference your findings with pre-calculated metrics for accuracy

**MANDATORY RULES FOR MULTI-EXPIRY CLASSIFICATION:**

⚠️ ATTENTION: Multi-expiry classification is RARE and must be applied with EXTREME precision.

1. **RESONANCE** (VERY RARE - max 1-2 total levels):
   - Condition: The SAME exact strike (±0.5%) must be a significant level in ALL THREE expirations (0DTE + WEEKLY + MONTHLY)
   - VALID EXAMPLES: Strike 25000 is Call Wall in 0DTE, Put Wall in WEEKLY, and Max Pain in MONTHLY
   - INVALID EXAMPLES: Strike 24700 in 0DTE, strike 24750 in WEEKLY, strike 24800 in MONTHLY → NOT RESONANCE (too different)
   - Importance: 98-100
   - Use this ONLY when there is perfect alignment across all expirations

2. **CONFLUENCE** (RARE - max 3-5 total levels):
   - Condition: The SAME strike (±1%) is significant in EXACTLY TWO expirations
   - Importance: 85-94
   - Example: Strike 24500 is Wall in 0DTE and Wall in WEEKLY, but not present in MONTHLY

3. **SINGLE EXPIRY** (THE MAJORITY of levels):
   - Condition: Significant level in only one expiration
   - Roles: WALL, PIVOT, MAGNET, FRICTION
   - Importance: 60-84
   - This should cover ~80% of levels

⚠️ COMMON MISTAKES TO AVOID:
- DO NOT assign RESONANCE to levels that appear in different expirations but at different strikes
- DO NOT assign RESONANCE just because a strike is "close" across expirations
- If unsure, use the base role (WALL/PIVOT/MAGNET/FRICTION)

STANDARD ANALYSIS RULES:
- **CALL WALLS**: Strike above Spot with dominant Call OI. Role 'WALL', Color 'rosso' (red).
- **PUT WALLS**: Strike below Spot with dominant Put OI. Role 'WALL', Color 'verde' (green).
- **GAMMA FLIP**: Sentiment equilibrium point. Role 'PIVOT', Color 'indigo', Side 'GAMMA_FLIP'.

NEW ADVANCED QUANTITATIVE RULES:

**Gamma Exposure (GEX):**
- Positive GEX = dealers long gamma = stable market, supports prices
- Negative GEX = dealers short gamma = volatile market, amplifies movements
- Gamma Flip: critical level where cumulative GEX changes sign
- If spot near gamma flip = high probability of directional movement
- Use total_gex to determine expected volatility (negative = high vol)

**Max Pain:**
- Level where option value is minimal = market maker target
- Add as MAGNET level if distance < 2% from spot
- Importance: 85-95 if near spot (< 1%)
- Importance: 70-84 if moderately near (1-2%)

**Put/Call Ratios:**
- PCR > 1.0 = bearish sentiment (too much pessimism = possible bounce?)
- PCR < 0.7 = bullish sentiment (too much optimism = correction risk?)
- Use delta-adjusted for more precise analysis
- Volume/OI ratio > 1.5 = unusual activity, importance +15

**Volatility Skew:**
- "Smirk" skew (expensive puts, skew_ratio > 1.2) = fear, strong support, bearish sentiment
- "Reverse smirk" skew (expensive calls, skew_ratio < 0.9) = euphoria, weak resistance, bullish sentiment
- "Flat" skew = balanced market, neutral sentiment
- Use skew sentiment to validate level direction

**INTEGRATION WITH EXISTING LEVELS:**
1. If Max Pain near Call/Put Wall (distance < 1%) = CONFLUENCE, importance +10
2. If Gamma Flip near Wall (distance < 0.5%) = more important level, importance +15
3. Use skew sentiment to validate direction: bearish skew strengthens put walls
4. Volume/OI ratio > 1.5 = unusual activity, importance +15
5. If total_gex negative = prioritize support levels (movement amplification)

MARKET CONTEXT RULES:
- Use VIX level to calibrate level confidence: high VIX (>25) = wider tolerances, lower confidence; low VIX (<15) = tighter tolerances, higher confidence
- If market_regime is provided, interpret levels accordingly:
  * trending_up: Call walls are temporary resistance (breakout likely), put walls are strong support
  * trending_down: Put walls are temporary support (breakdown likely), call walls are strong resistance
  * range_bound: Both walls are solid, expect mean reversion between them
  * volatile: All levels less reliable, use caution, wider stops needed
- Dynamic tolerances are already calibrated to VIX — respect them for level classification
- If actionability data is provided for a level, incorporate it into your analysis:
  * expected_behavior indicates the most likely price reaction
  * confirmation_signals list what to watch for
  * invalidation_level is where the thesis fails
- Previous day levels that held as support/resistance deserve extra attention
- On high-VIX days (>25), reduce confidence of all levels by 10 points in your assessment`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    outlook: {
      type: Type.OBJECT,
      properties: {
        sentiment: { type: Type.STRING },
        gammaFlipZone: { type: Type.NUMBER },
        volatilityExpectation: { type: Type.STRING },
        summary: { type: Type.STRING }
      },
      required: ["sentiment", "gammaFlipZone", "volatilityExpectation", "summary"]
    },
    levels: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          livello: { type: Type.STRING },
          prezzo: { type: Type.NUMBER },
          motivazione: { type: Type.STRING },
          sintesiOperativa: { type: Type.STRING },
          colore: { type: Type.STRING, enum: ["rosso", "verde", "indigo", "ambra"] },
          importanza: { type: Type.NUMBER },
          ruolo: { type: Type.STRING, enum: ["WALL", "PIVOT", "MAGNET", "FRICTION", "CONFLUENCE", "RESONANCE"] },
          isDayTrade: { type: Type.BOOLEAN },
          scadenzaTipo: { type: Type.STRING },
          lato: { type: Type.STRING, enum: ["CALL", "PUT", "BOTH", "GAMMA_FLIP"] }
        },
        required: ["livello", "prezzo", "motivazione", "sintesiOperativa", "colore", "importanza", "ruolo", "isDayTrade", "scadenzaTipo", "lato"]
      }
    }
  },
  required: ["outlook", "levels"]
};

/**
 * Formats quantitative metrics for AI analysis
 */
const formatQuantMetrics = (quantMetrics: import('../types').QuantMetrics): string => {
  const gexSign = quantMetrics.total_gex > 0 ? 'positive/stable' : 'negative/volatile';
  const skewType = quantMetrics.volatility_skew.skew_type;
  const sentiment = quantMetrics.volatility_skew.sentiment;
  
  return `
=== ADVANCED QUANTITATIVE METRICS ===
Gamma Flip: ${quantMetrics.gamma_flip}
Total GEX: ${quantMetrics.total_gex.toFixed(2)}B (${gexSign})
Max Pain: ${quantMetrics.max_pain}

Put/Call Ratios:
- OI-Based: ${quantMetrics.put_call_ratios.oi_based.toFixed(2)}
- Volume-Based: ${quantMetrics.put_call_ratios.volume_based.toFixed(2)}
- Weighted: ${quantMetrics.put_call_ratios.weighted.toFixed(2)}
- Delta-Adjusted: ${quantMetrics.put_call_ratios.delta_adjusted.toFixed(2)}

Volatility Skew:
- Type: ${skewType}
- Sentiment: ${sentiment}
- Skew Ratio: ${quantMetrics.volatility_skew.skew_ratio.toFixed(2)}
- Put IV Avg: ${quantMetrics.volatility_skew.put_iv_avg.toFixed(2)}%
- Call IV Avg: ${quantMetrics.volatility_skew.call_iv_avg.toFixed(2)}%

Top GEX Strikes (for level reference):
${quantMetrics.gex_by_strike.slice(0, 5).map(s =>
  `  Strike ${s.strike}: GEX ${s.gex.toFixed(2)}B, Cumulative ${s.cumulative_gex.toFixed(2)}B`
).join('\n')}
`;
};

/**
 * Formats AI-ready aggregated data for hybrid AI analysis
 * This provides raw strike data for dynamic level detection
 */
const formatAIReadyData = (data: AIReadyData): string => {
  return `
=== AGGREGATED OPTIONS DATA ===
Spot Price: ${data.spot}

${Object.entries(data.expiries).map(([label, expiry]) => `
EXPIRY: ${label} (${expiry.date})
Total Call OI: ${expiry.totals.call_oi.toLocaleString()}
Total Put OI: ${expiry.totals.put_oi.toLocaleString()}

Strikes (sorted by significance score - OI, Volume, proximity, IV):
${expiry.strikes.slice(0, 25).map(s =>
  `  ${s.strike}: Call OI ${s.call_oi.toLocaleString()}, Put OI ${s.put_oi.toLocaleString()}, Call IV ${(s.call_iv * 100).toFixed(1)}%, Put IV ${(s.put_iv * 100).toFixed(1)}%`
).join('\n')}
`).join('\n')}

=== PRE-CALCULATED METRICS ===
Gamma Flip: ${data.precalc_metrics.gamma_flip}
Total GEX: ${data.precalc_metrics.total_gex.toFixed(2)}B
Max Pain: ${data.precalc_metrics.max_pain}

ANALYSIS INSTRUCTIONS:
1. Identify CALL WALLS (strikes with dominant call OI above spot)
2. Identify PUT WALLS (strikes with dominant put OI below spot)
3. Find CONFLUENCE (same strike significant in 2+ expiries within ±1%)
4. Find RESONANCE (same strike significant in ALL3 expiries within ±0.5%)
5. Assess sentiment based on put/call ratios and IV skew
6. Provide trading signals for each level identified
`;
};

/**
 * Formats a single enhanced confluence/resonance level for AI prompt
 */
const formatEnhancedLevel = (
  level: ConfluenceLevel | ResonanceLevel,
  spotPrice: number,
  levelType: 'CONFLUENCE' | 'RESONANCE'
): string => {
  const distancePct = ((level.strike - spotPrice) / spotPrice * 100).toFixed(2);
  const bias = level.put_call_ratio < 0.7 ? 'Bullish bias' :
               level.put_call_ratio > 1.0 ? 'Bearish bias' : 'Neutral';
  
  let details = `- Strike ${level.strike.toFixed(2)} [${level.expiry_label}] (Distance: ${distancePct}%)
  - Call OI: ${level.total_call_oi.toLocaleString()} | Put OI: ${level.total_put_oi.toLocaleString()}
  - Call Vol: ${level.total_call_vol.toLocaleString()} | Put Vol: ${level.total_put_vol.toLocaleString()}
  - PCR: ${level.put_call_ratio.toFixed(2)} (${bias})
  - Total Gamma: ${level.total_gamma.toFixed(2)}`;
  
  // Add per-expiry breakdown if available
  if (level.expiry_details && level.expiry_details.length > 0) {
    level.expiry_details.forEach(expiry => {
      details += `
  - ${expiry.expiry_label}: Call OI ${expiry.call_oi.toLocaleString()}, Put OI ${expiry.put_oi.toLocaleString()}, Call Vol ${expiry.call_vol.toLocaleString()}, Put Vol ${expiry.put_vol.toLocaleString()}`;
    });
  }
  
  // Add actionability data if available
  if (level.actionability) {
    const a = level.actionability;
    details += `
  - ACTIONABILITY: Expected ${a.expected_behavior} (confidence: ${(a.confidence * 100).toFixed(0)}%)
  - Confirmation: ${a.confirmation_signals.join(', ')}
  - Invalidation: ${a.invalidation_level} (${a.invalidation_description})
  - Priority: ${a.trading_priority}`;
    if (a.time_decay_impact) {
      details += `
  - Time Decay: Morning=${a.time_decay_impact.morning}, Midday=${a.time_decay_impact.midday}, Afternoon=${a.time_decay_impact.afternoon}`;
    }
  }
  
  return details;
};

/**
 * Formats selected levels including enhanced confluence/resonance data
 */
const formatSelectedLevels = (selectedLevels: SelectedLevels, spotPrice: number): string => {
  let output = '\n=== PRE-CALCULATED KEY LEVELS ===\n';
  
  // Format Gamma Flip
  if (selectedLevels.gamma_flip) {
    output += `\nGAMMA FLIP: ${selectedLevels.gamma_flip}\n`;
  }
  
  // Format Max Pain
  if (selectedLevels.max_pain) {
    output += `MAX PAIN: ${selectedLevels.max_pain}\n`;
  }
  
  // Format Call Walls
  if (selectedLevels.call_walls && selectedLevels.call_walls.length > 0) {
    output += '\nCALL WALLS:\n';
    selectedLevels.call_walls.slice(0, 5).forEach(wall => {
      output += `- Strike ${wall.strike}: OI ${wall.oi?.toLocaleString() || 'N/A'} (${wall.expiry || 'unknown'})\n`;
    });
  }
  
  // Format Put Walls
  if (selectedLevels.put_walls && selectedLevels.put_walls.length > 0) {
    output += '\nPUT WALLS:\n';
    selectedLevels.put_walls.slice(0, 5).forEach(wall => {
      output += `- Strike ${wall.strike}: OI ${wall.oi?.toLocaleString() || 'N/A'} (${wall.expiry || 'unknown'})\n`;
    });
  }
  
  // Format Confluence Levels (enhanced or legacy)
  if (selectedLevels.confluence && selectedLevels.confluence.length > 0) {
    output += '\nCONFLUENCE LEVELS (Multi-Expiry Support):\n';
    selectedLevels.confluence.forEach(level => {
      if (isEnhancedConfluenceLevel(level)) {
        output += formatEnhancedLevel(level, spotPrice, 'CONFLUENCE') + '\n';
      } else {
        // Legacy format
        const distancePct = level.distance_pct || ((level.strike - spotPrice) / spotPrice * 100);
        output += `- Strike ${level.strike.toFixed(2)} (Distance: ${distancePct.toFixed(2)}%) [Legacy Format]\n`;
      }
    });
  }
  
  // Format Resonance Levels (enhanced or legacy)
  if (selectedLevels.resonance && selectedLevels.resonance.length > 0) {
    output += '\nRESONANCE LEVELS (Triple-Expiry Alignment):\n';
    selectedLevels.resonance.forEach(level => {
      if (isEnhancedResonanceLevel(level)) {
        output += formatEnhancedLevel(level, spotPrice, 'RESONANCE') + '\n';
      } else {
        // Legacy format
        const distancePct = level.distance_pct || ((level.strike - spotPrice) / spotPrice * 100);
        output += `- Strike ${level.strike.toFixed(2)} (Distance: ${distancePct.toFixed(2)}%) [Legacy Format]\n`;
      }
    });
  }
  
  return output;
};

/**
 * Formats market context data for AI prompt enhancement.
 * Provides VIX, regime, tolerances, and timestamp information.
 * Returns empty string if no market context is available (backward-compatible).
 */
const formatMarketContext = (context: MarketContext | undefined): string => {
  if (!context) return '';
  
  const parts: string[] = ['\n=== MARKET CONTEXT ==='];
  
  // VIX and regime
  if (context.regime) {
    const vix = context.tolerances?.vix;
    const regimeLabel = vix !== null && vix !== undefined
      ? (vix > 25 ? 'HIGH VOLATILITY' : vix < 15 ? 'LOW VOLATILITY' : 'NORMAL')
      : 'UNKNOWN';
    parts.push(`- VIX: ${vix ?? 'N/A'} (${regimeLabel})`);
    parts.push(`- Market Regime: ${context.regime.regime} (confidence: ${(context.regime.confidence * 100).toFixed(0)}%)`);
    parts.push(`- Regime Interpretation: ${context.regime.interpretation}`);
  }
  
  // Dynamic tolerances
  if (context.tolerances) {
    const t = context.tolerances;
    parts.push(`- Tolerance Scale: ${t.scale.toFixed(1)}x (resonance: ±${(t.resonance * 100).toFixed(2)}%, confluence: ±${(t.confluence * 100).toFixed(2)}%)`);
  }
  
  // Timestamp
  if (context.timestamp) {
    parts.push(`- Data Timestamp: ${context.timestamp}`);
  }
  
  return parts.join('\n') + '\n';
};

export const getAnalysis = async (
  datasets: MarketDataset[],
  currentPrice: string,
  model?: string,
  selectedLevels?: SelectedLevels,
  aiReadyData?: AIReadyData,
  marketContext?: MarketContext
): Promise<AnalysisResponse> => {
  const selectedModel = model || 'gemini-2.5-flash';
  const spotPrice = parseFloat(currentPrice) || 0;
  
  const apiCall = async () => {
    // Format each dataset with its quantitative metrics if available
    const formattedData = datasets.map(d => {
      let section = `DATASET [${d.type}] (${d.name}):\n${d.content}`;
      
      // Add quantitative metrics section if available
      if (d.quantMetrics) {
        section += '\n' + formatQuantMetrics(d.quantMetrics);
      }
      
      return section;
    }).join('\n\n---\n\n');
    
    // Add enhanced selected levels if available
    let levelsSection = '';
    if (selectedLevels) {
      levelsSection = formatSelectedLevels(selectedLevels, spotPrice);
    }
    
    // Add AI-ready aggregated data if available (hybrid approach)
    let aiReadySection = '';
    if (aiReadyData) {
      aiReadySection = formatAIReadyData(aiReadyData);
    }
    
    // Add market context section if available
    const marketContextSection = formatMarketContext(marketContext);
    
    const prompt = `EXECUTE DEEP QUANT ANALYSIS. SPOT: ${currentPrice}.
    Provide concise and decisive trading signals for each level.
    Use ADVANCED QUANTITATIVE METRICS to identify additional levels (Max Pain, Gamma Flip).
    Integrate skew sentiment and PCR to validate level importance.
    
    ${marketContextSection ? 'MARKET CONTEXT is provided below — use it to calibrate confidence and interpret levels:\n' + marketContextSection : ''}
    
    ${aiReadySection ? 'HYBRID AI APPROACH: Use AGGREGATED OPTIONS DATA below to DYNAMICALLY identify levels. Pre-calculated metrics are for reference:\n' + aiReadySection : ''}
    
    ${levelsSection ? 'IMPORTANT: Pre-calculated CONFLUENCE and RESONANCE levels are provided below. Use these for multi-expiry analysis:\n' + levelsSection : ''}
    
    ${formattedData}`;
    
    const response = await ai.models.generateContent({
        model: selectedModel,
        contents: prompt,
        config: {
            systemInstruction: harmonicSystemInstruction,
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: 0.1,
        }
    });
    const text = response.text;
    if (!text) throw new Error("No response");
    return JSON.parse(cleanJson(text)) as AnalysisResponse;
  };
  return withRetry(apiCall);
};

export const continueChat = async (history: Content[], model?: string): Promise<string> => {
    const selectedModel = model || 'gemini-2.5-flash';
    const response = await ai.models.generateContent({
        model: selectedModel,
        contents: history,
        config: {
            systemInstruction: `You are a Quant assistant. Explain Hedging flows.`,
            temperature: 0.2,
        }
    });
    return response.text || "Error.";
};

const withRetry = async <T,>(apiCall: () => Promise<T>): Promise<T> => {
  let attempts = 0;
  while (attempts < MAX_RETRIES) {
    try { return await apiCall(); } catch (error) {
      attempts++;
      if (attempts >= MAX_RETRIES) throw error;
      await new Promise(res => setTimeout(res, 1000));
    }
  }
  throw new Error("Critical analysis error.");
};
