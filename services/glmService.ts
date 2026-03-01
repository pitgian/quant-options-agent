
import {
  AnalysisLevel,
  AnalysisResponse,
  MarketDataset,
  ConfluenceLevel,
  ResonanceLevel,
  LegacyConfluenceLevel,
  LegacyResonanceLevel,
  SelectedLevels,
  TotalGexData,
  isEnhancedConfluenceLevel,
  isEnhancedResonanceLevel
} from '../types';
import { Content } from "@google/genai";

const MAX_RETRIES = 3;

// Get API key from Vite environment variables
const GLM_API_KEY = import.meta.env.VITE_GLM_API_KEY;
const GLM_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';
const GLM_MODEL = 'glm-5'; // GLM-5 model

if (!GLM_API_KEY) {
    console.warn('VITE_GLM_API_KEY not set. GLM AI features will not work.');
}

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
5. If total_gex negative = prioritize support levels (movement amplification)

Respond ONLY with a valid JSON object with the following structure (all text fields MUST be in English):
{
  "outlook": {
    "sentiment": "string (bullish/bearish/neutral)",
    "gammaFlipZone": number,
    "volatilityExpectation": "string (in English)",
    "summary": "string (in English)"
  },
  "levels": [
    {
      "livello": "string (level name in English, e.g., 'CALL WALL', 'GAMMA FLIP')",
      "prezzo": number,
      "motivazione": "string (explanation in English)",
      "sintesiOperativa": "string (trading signal in English, max 8 words)",
      "colore": "rosso|verde|indigo|ambra",
      "importanza": number (0-100),
      "ruolo": "WALL|PIVOT|MAGNET|FRICTION|CONFLUENCE|RESONANCE",
      "isDayTrade": boolean,
      "scadenzaTipo": "string (e.g., '0DTE', 'WEEKLY', '0DTE+MONTHLY')",
      "lato": "CALL|PUT|BOTH|GAMMA_FLIP"
    }
  ]
}`;

interface GLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface GLMResponse {
    id: string;
    choices: {
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }[];
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

const callGLMAPI = async (messages: GLMMessage[], model?: string): Promise<string> => {
    if (!GLM_API_KEY) {
        throw new Error('GLM API key not configured. Please set VITE_GLM_API_KEY in .env.local');
    }

    const selectedModel = model || GLM_MODEL;
    const response = await fetch(GLM_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept-Language': 'en-US,en',
            'Authorization': `Bearer ${GLM_API_KEY}`
        },
        body: JSON.stringify({
            model: selectedModel,
            messages: messages,
            temperature: 0.1,
            top_p: 0.9
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GLM API error: ${response.status} - ${errorText}`);
    }

    const data: GLMResponse = await response.json();
    return data.choices[0]?.message?.content || '';
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
 * Formats total GEX data for AI analysis
 * Provides aggregate market gamma exposure across all expiries
 */
const formatTotalGexData = (totalGexData: TotalGexData): string => {
  const gexSign = totalGexData.total_gex > 0 ? 'positive/stable' : 'negative/volatile';
  const netGex = totalGexData.positive_gex + totalGexData.negative_gex;
  
  let output = `
=== TOTAL MARKET GEX (ALL EXPIRIES) ===
Aggregate GEX: ${totalGexData.total_gex.toFixed(2)}B (${gexSign})
Positive GEX: +${totalGexData.positive_gex.toFixed(2)}B
Negative GEX: ${totalGexData.negative_gex.toFixed(2)}B
Net GEX: ${netGex.toFixed(2)}B
Estimated Gamma Flip: ${totalGexData.flip_point}

GEX by Expiry:
`;

  if (totalGexData.gex_by_expiry && totalGexData.gex_by_expiry.length > 0) {
    totalGexData.gex_by_expiry.forEach(expiry => {
      const weightPct = (expiry.weight * 100).toFixed(1);
      const gexSign = expiry.gex >= 0 ? '+' : '';
      output += `  - ${expiry.date}: ${gexSign}${expiry.gex.toFixed(2)}B (weight: ${weightPct}%)\n`;
    });
  }

  // Add interpretation guidance
  output += `
INTERPRETATION:
${totalGexData.total_gex > 0
  ? '- Positive aggregate GEX: Dealers are LONG gamma, expect mean-reversion behavior'
  : '- Negative aggregate GEX: Dealers are SHORT gamma, expect trend-acceleration behavior'}
- Gamma Flip at ${totalGexData.flip_point}: Key level where dealer behavior shifts
- ${Math.abs(totalGexData.negative_gex) > totalGexData.positive_gex
  ? 'Negative GEX dominates: Higher volatility expected, use tight stops'
  : 'Positive GEX dominates: Range-bound behavior likely, fade extremes'}
`;

  return output;
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

export const getAnalysis = async (
  datasets: MarketDataset[],
  currentPrice: string,
  model?: string,
  selectedLevels?: SelectedLevels,
  totalGexData?: TotalGexData
): Promise<AnalysisResponse> => {
    const selectedModel = model || GLM_MODEL;
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
        
        // Add total GEX data if available
        let totalGexSection = '';
        if (totalGexData) {
          totalGexSection = formatTotalGexData(totalGexData);
        }
        
        const messages: GLMMessage[] = [
            { role: 'system', content: harmonicSystemInstruction },
            {
                role: 'user',
                content: `EXECUTE DEEP QUANT ANALYSIS. SPOT: ${currentPrice}.
                Provide concise and decisive trading signals for each level.
                Use ADVANCED QUANTITATIVE METRICS to identify additional levels (Max Pain, Gamma Flip).
                Integrate skew sentiment and PCR to validate level importance.
                
                ${levelsSection ? 'IMPORTANT: Pre-calculated CONFLUENCE and RESONANCE levels are provided below. Use these for multi-expiry analysis:\n' + levelsSection : ''}
                
                ${totalGexSection ? 'CRITICAL: Total Market GEX data across ALL expiries is provided below. Use this for overall market sentiment:\n' + totalGexSection : ''}
                
                ${formattedData}`
            }
        ];

        const responseText = await callGLMAPI(messages, selectedModel);
        if (!responseText) throw new Error("No response from GLM");
        return JSON.parse(cleanJson(responseText)) as AnalysisResponse;
    };
    
    return withRetry(apiCall);
};

export const continueChat = async (history: Content[], model?: string): Promise<string> => {
    const selectedModel = model || GLM_MODEL;
    // Convert Gemini-style history to GLM format
    const messages: GLMMessage[] = [
        { role: 'system', content: 'You are a Quant assistant. Explain Hedging flows.' }
    ];
    
    // Convert history to GLM message format
    for (const msg of history) {
        const role = msg.role === 'user' ? 'user' : 'assistant';
        const content = msg.parts?.map(p => p.text).join('\n') || '';
        if (content) {
            messages.push({ role, content });
        }
    }

    const responseText = await callGLMAPI(messages, selectedModel);
    return responseText || "Error in response.";
};

const withRetry = async <T,>(apiCall: () => Promise<T>): Promise<T> => {
    let attempts = 0;
    while (attempts < MAX_RETRIES) {
        try {
            return await apiCall();
        } catch (error) {
            attempts++;
            if (attempts >= MAX_RETRIES) throw error;
            await new Promise(res => setTimeout(res, 1000));
        }
    }
    throw new Error("Critical analysis error.");
};

// Export model info for UI
export const getGLMModelInfo = () => ({
    name: 'GLM-5',
    provider: 'Z.ai',
    model: GLM_MODEL
});
