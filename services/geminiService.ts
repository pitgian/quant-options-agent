
import { GoogleGenAI, Type, Content } from "@google/genai";
import { AnalysisLevel, AnalysisResponse, MarketDataset } from '../types';

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
5. If total_gex negative = prioritize support levels (movement amplification)`;

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

export const getAnalysis = async (datasets: MarketDataset[], currentPrice: string, model?: string): Promise<AnalysisResponse> => {
  const selectedModel = model || 'gemini-2.5-flash';
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
    
    const response = await ai.models.generateContent({
        model: selectedModel,
        contents: `EXECUTE DEEP QUANT ANALYSIS. SPOT: ${currentPrice}.
        Provide concise and decisive trading signals for each level.
        Use ADVANCED QUANTITATIVE METRICS to identify additional levels (Max Pain, Gamma Flip).
        Integrate skew sentiment and PCR to validate level importance.
        
        ${formattedData}`,
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
