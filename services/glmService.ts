
import { AnalysisLevel, AnalysisResponse, MarketDataset } from '../types';
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
- **GAMMA FLIP**: Punto di equilibrio sentiment. Ruolo 'PIVOT', Colore 'indigo', Lato 'GAMMA_FLIP'.

Rispondi SOLO con un oggetto JSON valido con la seguente struttura:
{
  "outlook": {
    "sentiment": "string (bullish/bearish/neutral)",
    "gammaFlipZone": number,
    "volatilityExpectation": "string",
    "summary": "string"
  },
  "levels": [
    {
      "livello": "string",
      "prezzo": number,
      "motivazione": "string",
      "sintesiOperativa": "string",
      "colore": "rosso|verde|indigo|ambra",
      "importanza": number (0-100),
      "ruolo": "WALL|PIVOT|MAGNET|FRICTION|CONFLUENCE",
      "isDayTrade": boolean,
      "scadenzaTipo": "string",
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

export const getAnalysis = async (datasets: MarketDataset[], currentPrice: string, model?: string): Promise<AnalysisResponse> => {
    const selectedModel = model || GLM_MODEL;
    const apiCall = async () => {
        const formattedData = datasets.map(d => `DATASET [${d.type}] (${d.name}):\n${d.content}`).join('\n\n---\n\n');
        
        const messages: GLMMessage[] = [
            { role: 'system', content: harmonicSystemInstruction },
            {
                role: 'user',
                content: `ESEGUI DEEP QUANT ANALYSIS. SPOT: ${currentPrice}.
                Fornisci segnali operativi brevi e decisi per ogni livello.
                
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
        { role: 'system', content: 'Sei un assistente Quant. Spiega i flussi di Hedging.' }
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
    return responseText || "Errore nella risposta.";
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
    throw new Error("Errore critico analisi.");
};

// Export model info for UI
export const getGLMModelInfo = () => ({
    name: 'GLM-5',
    provider: 'Z.ai',
    model: GLM_MODEL
});
