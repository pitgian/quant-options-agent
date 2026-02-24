
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

const harmonicSystemInstruction = `Sei un Engine di Analisi Quantitativa specializzato in Market Maker Hedging e Risonanza Armonica delle Opzioni.

REGOLE PER LA SINTESI OPERATIVA (CAMPO: sintesiOperativa):
Fornisci un segnale di trading secco e imperativo (max 8 parole).
Esempi:
- "AREA DI VENDITA: Target raggiunto"
- "LONG: Breakout confermato sopra 26k"
- "DIFESA MM: Supporto strutturale"
- "SCALPING: Volatilità attesa nel range"
- "ATTRAZIONE: Magnete di prezzo attivo"

**REGOLE TASSATIVE PER CLASSIFICAZIONE MULTI-EXPIRY:**

⚠️ ATTENZIONE: La classificazione multi-expiry è RARA e deve essere applicata con ESTREMA precisione.

1. **RESONANCE** (MOLTO RARO - max 1-2 livelli totali):
   - Condizione: Lo STESSO strike esatto (±0.5%) deve essere un livello significativo in TUTTE E TRE le scadenze (0DTE + WEEKLY + MONTHLY)
   - ESEMPI VALIDI: Strike 25000 è Call Wall in 0DTE, Put Wall in WEEKLY, e Max Pain in MONTHLY
   - ESEMPI NON VALIDI: Strike 24700 in 0DTE, strike 24750 in WEEKLY, strike 24800 in MONTHLY → NON è RESONANCE (troppo diversi)
   - Importanza: 98-100
   - Usa questo SOLO quando c'è perfetta allineazione tra tutte le scadenze

2. **CONFLUENCE** (RARO - max 3-5 livelli totali):
   - Condizione: Lo STESSO strike (±1%) è significativo in ESATTAMENTE DUE scadenze
   - Importanza: 85-94
   - Esempio: Strike 24500 è Wall in 0DTE e Wall in WEEKLY, ma non presente in MONTHLY

3. **SINGOLO EXPIRY** (LA MAGGIORANZA dei livelli):
   - Condizione: Livello significativo in una sola scadenza
   - Ruoli: WALL, PIVOT, MAGNET, FRICTION
   - Importanza: 60-84
   - Questo dovrebbe coprire ~80% dei livelli

⚠️ ERRORI COMUNI DA EVITARE:
- NON assegnare RESONANCE a livelli che appaiono in scadenze diverse ma a strike diversi
- NON assegnare RESONANCE solo perché uno strike è "vicino" tra le scadenze
- Se non sei sicuro, usa il ruolo base (WALL/PIVOT/MAGNET/FRICTION)

REGOLE DI ANALISI STANDARD:
- **CALL WALLS**: Strike sopra lo Spot con OI Call dominante. Ruolo 'WALL', Colore 'rosso'.
- **PUT WALLS**: Strike sotto lo Spot con OI Put dominante. Ruolo 'WALL', Colore 'verde'.
- **GAMMA FLIP**: Punto di equilibrio sentiment. Ruolo 'PIVOT', Colore 'indigo', Lato 'GAMMA_FLIP'.

NUOVE REGOLE QUANTITATIVE AVANZATE:

**Gamma Exposure (GEX):**
- GEX positivo = dealer long gamma = mercato stabile, supporta prezzi
- GEX negativo = dealer short gamma = mercato volatile, amplifica movimenti
- Gamma Flip: livello critico dove GEX cumulativo cambia segno
- Se spot vicino a gamma flip = alta probabilità di movimento direzionale
- Usare total_gex per determinare volatilità attesa (negativo = alta vol)

**Max Pain:**
- Livello dove valore opzioni è minimo = target market maker
- Aggiungere come livello MAGNET se distanza < 2% dal spot
- Importance: 85-95 se vicino a spot (< 1%)
- Importance: 70-84 se moderately vicino (1-2%)

**Put/Call Ratios:**
- PCR > 1.0 = sentimento ribassista (troppo pessimismo = possibile rimbalzo?)
- PCR < 0.7 = sentimento rialzista (troppo ottimismo = rischio correzione?)
- Usare delta-adjusted per analisi più precisa
- Volume/OI ratio > 1.5 = unusual activity, importance +15

**Volatility Skew:**
- Skew "smirk" (put costose, skew_ratio > 1.2) = paura, supporto forte, sentiment bearish
- Skew "reverse_smirk" (call costose, skew_ratio < 0.9) = euforia, resistenza debole, sentiment bullish
- Skew "flat" = mercato equilibrato, neutral sentiment
- Usare skew sentiment per validare direzione dei livelli

**INTEGRAZIONE CON LIVELLI ESISTENTI:**
1. Se Max Pain vicino a Call/Put Wall (distanza < 1%) = CONFLUENCE, importance +10
2. Se Gamma Flip vicino a Wall (distanza < 0.5%) = livello più importante, importance +15
3. Usare skew sentiment per validare direzione: skew bearish rafforza put walls
4. Volume/OI ratio > 1.5 = unusual activity, importance +15
5. Se total_gex negativo = priorità a livelli di supporto (amplificazione movimenti)`;

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
  const gexSign = quantMetrics.total_gex > 0 ? 'positivo/stabile' : 'negativo/volatile';
  const skewType = quantMetrics.volatility_skew.skew_type;
  const sentiment = quantMetrics.volatility_skew.sentiment;
  
  return `
=== METRICHE QUANTITATIVE AVANZATE ===
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

Top GEX Strikes (per riferimento livelli):
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
        contents: `ESEGUI DEEP QUANT ANALYSIS. SPOT: ${currentPrice}.
        Fornisci segnali operativi brevi e decisi per ogni livello.
        Usa le METRICHE QUANTITATIVE AVANZATE per identificare livelli aggiuntivi (Max Pain, Gamma Flip).
        Integra skew sentiment e PCR per validare l'importanza dei livelli.
        
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
            systemInstruction: `Sei un assistente Quant. Spiega i flussi di Hedging.`,
            temperature: 0.2,
        }
    });
    return response.text || "Errore.";
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
  throw new Error("Errore critico analisi.");
};
