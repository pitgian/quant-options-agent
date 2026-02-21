
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

REGOLE TASSATIVE PER LE CONFLUENZE (MULTI-EXPIRY):
1. **DEFINIZIONE DI CONFLUENZA**: Se uno strike price appare in PIÙ di una scadenza, ruolo 'CONFLUENCE', lato 'BOTH'.
2. **PRIORITÀ VISIVA**: Le confluenze sono i livelli più importanti. Importanza 98-100 se 3+ scadenze.

REGOLE DI ANALISI STANDARD:
- **CALL WALLS**: Strike sopra lo Spot con OI Call dominante. Ruolo 'WALL', Colore 'rosso'.
- **PUT WALLS**: Strike sotto lo Spot con OI Put dominante. Ruolo 'WALL', Colore 'verde'.
- **GAMMA FLIP**: Punto di equilibrio sentiment. Ruolo 'PIVOT', Colore 'indigo', Lato 'GAMMA_FLIP'.`;

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
          ruolo: { type: Type.STRING, enum: ["WALL", "PIVOT", "MAGNET", "FRICTION", "CONFLUENCE"] },
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

export const getAnalysis = async (datasets: MarketDataset[], currentPrice: string, model?: string): Promise<AnalysisResponse> => {
  const selectedModel = model || 'gemini-2.5-flash';
  const apiCall = async () => {
    const formattedData = datasets.map(d => `DATASET [${d.type}] (${d.name}):\n${d.content}`).join('\n\n---\n\n');
    
    const response = await ai.models.generateContent({
        model: selectedModel,
        contents: `ESEGUI DEEP QUANT ANALYSIS. SPOT: ${currentPrice}.
        Fornisci segnali operativi brevi e decisi per ogni livello.
        
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
