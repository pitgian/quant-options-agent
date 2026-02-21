
import { AnalysisResponse, MarketDataset } from '../types';
import { Content } from "@google/genai";
import * as geminiService from './geminiService';
import * as glmService from './glmService';

// Supported AI providers
export type AIProvider = 'gemini' | 'glm';

// Available models for each provider
export const GEMINI_MODELS = [
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', description: 'Most advanced, complex reasoning' },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', description: 'High precision, multimodal' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', description: 'Super fast, efficient' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Stable, long context' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Balanced speed & quality' },
] as const;

export const GLM_MODELS = [
    { id: 'glm-5', name: 'GLM-5', description: 'Z.ai new-generation flagship base model' },
    { id: 'glm-4.7', name: 'GLM-4.7', description: 'Latest flagship with open-source SOTA capabilities' },
    { id: 'glm-4.5-air', name: 'GLM-4.5-Air', description: 'New lightweight flagship model' },
    { id: 'glm-4.7-flash', name: 'GLM-4.7-Flash', description: '30B parameters, lightweight and efficient' },
    { id: 'glm-4-32b-0414-128k', name: 'GLM-4-32B', description: 'General-purpose, cost-efficient LLM' },
] as const;

export type GeminiModelId = typeof GEMINI_MODELS[number]['id'];
export type GLMModelId = typeof GLM_MODELS[number]['id'];
export type AIModelId = GeminiModelId | GLMModelId;

// Storage keys
const PROVIDER_STORAGE_KEY = 'ai_provider_preference';
const MODEL_STORAGE_KEY = 'ai_model_preference';

// Get the stored provider preference or default to gemini
export const getStoredProvider = (): AIProvider => {
    if (typeof window === 'undefined') return 'gemini';
    const stored = localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (stored === 'gemini' || stored === 'glm') {
        return stored;
    }
    return 'gemini';
};

// Store provider preference
export const setStoredProvider = (provider: AIProvider): void => {
    if (typeof window !== 'undefined') {
        localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
    }
};

// Get the stored model preference for a provider
export const getStoredModel = (provider: AIProvider): string => {
    if (typeof window === 'undefined') {
        return provider === 'gemini' ? 'gemini-2.5-flash' : 'glm-5';
    }
    const stored = localStorage.getItem(`${MODEL_STORAGE_KEY}_${provider}`);
    if (stored) {
        return stored;
    }
    // Default models
    return provider === 'gemini' ? 'gemini-2.5-flash' : 'glm-5';
};

// Store model preference
export const setStoredModel = (provider: AIProvider, model: string): void => {
    if (typeof window !== 'undefined') {
        localStorage.setItem(`${MODEL_STORAGE_KEY}_${provider}`, model);
    }
};

// Check if API keys are configured
export const getAPIStatus = (): { gemini: boolean; glm: boolean } => {
    return {
        gemini: !!import.meta.env.VITE_GEMINI_API_KEY && 
                import.meta.env.VITE_GEMINI_API_KEY !== 'your_gemini_api_key_here',
        glm: !!import.meta.env.VITE_GLM_API_KEY && 
             import.meta.env.VITE_GLM_API_KEY !== 'your_glm_api_key_here'
    };
};

// Get available providers (those with configured API keys)
export const getAvailableProviders = (): AIProvider[] => {
    const status = getAPIStatus();
    const available: AIProvider[] = [];
    if (status.gemini) available.push('gemini');
    if (status.glm) available.push('glm');
    return available;
};

// Get models for a provider
export const getModelsForProvider = (provider: AIProvider) => {
    return provider === 'gemini' ? GEMINI_MODELS : GLM_MODELS;
};

// Provider display info
export const getProviderInfo = (provider: AIProvider, modelId?: string) => {
    const model = modelId || getStoredModel(provider);
    const models = getModelsForProvider(provider);
    const modelInfo = models.find(m => m.id === model) || models[0];
    
    switch (provider) {
        case 'gemini':
            return {
                name: 'Google Gemini',
                model: modelInfo.id,
                modelName: modelInfo.name,
                description: modelInfo.description
            };
        case 'glm':
            return {
                name: 'Zhipu AI',
                model: modelInfo.id,
                modelName: modelInfo.name,
                description: modelInfo.description
            };
    }
};

// Unified analysis function
export const getAnalysis = async (
    datasets: MarketDataset[], 
    currentPrice: string,
    provider?: AIProvider,
    modelId?: string
): Promise<AnalysisResponse> => {
    const selectedProvider = provider || getStoredProvider();
    const selectedModel = modelId || getStoredModel(selectedProvider);
    
    // Check if selected provider is available, fallback to other if not
    const status = getAPIStatus();
    if (!status[selectedProvider]) {
        const availableProviders = getAvailableProviders();
        if (availableProviders.length === 0) {
            throw new Error('No AI API keys configured. Please set VITE_GEMINI_API_KEY or VITE_GLM_API_KEY in .env.local');
        }
        // Use first available provider
        const fallbackProvider = availableProviders[0];
        console.log(`Provider ${selectedProvider} not available, falling back to ${fallbackProvider}`);
        return getAnalysis(datasets, currentPrice, fallbackProvider);
    }

    try {
        if (selectedProvider === 'gemini') {
            return await geminiService.getAnalysis(datasets, currentPrice, selectedModel);
        } else {
            return await glmService.getAnalysis(datasets, currentPrice, selectedModel);
        }
    } catch (error) {
        console.error(`Provider ${selectedProvider} failed:`, error);
        
        // Try fallback to other provider
        const otherProvider: AIProvider = selectedProvider === 'gemini' ? 'glm' : 'gemini';
        if (status[otherProvider]) {
            console.log(`Trying fallback to ${otherProvider}`);
            try {
                if (otherProvider === 'gemini') {
                    return await geminiService.getAnalysis(datasets, currentPrice);
                } else {
                    return await glmService.getAnalysis(datasets, currentPrice);
                }
            } catch (fallbackError) {
                console.error(`Fallback to ${otherProvider} also failed:`, fallbackError);
            }
        }
        
        throw error;
    }
};

// Unified chat function (uses continueChat from services)
export const getChat = async (
    history: Content[],
    provider?: AIProvider,
    modelId?: string
): Promise<string> => {
    const selectedProvider = provider || getStoredProvider();
    const selectedModel = modelId || getStoredModel(selectedProvider);
    
    const status = getAPIStatus();
    if (!status[selectedProvider]) {
        const availableProviders = getAvailableProviders();
        if (availableProviders.length === 0) {
            throw new Error('No AI API keys configured');
        }
        const fallbackProvider = availableProviders[0];
        return getChat(history, fallbackProvider);
    }

    try {
        if (selectedProvider === 'gemini') {
            return await geminiService.continueChat(history, selectedModel);
        } else {
            return await glmService.continueChat(history, selectedModel);
        }
    } catch (error) {
        console.error(`Provider ${selectedProvider} failed:`, error);
        
        const otherProvider: AIProvider = selectedProvider === 'gemini' ? 'glm' : 'gemini';
        if (status[otherProvider]) {
            console.log(`Trying fallback to ${otherProvider}`);
            try {
                if (otherProvider === 'gemini') {
                    return await geminiService.continueChat(history);
                } else {
                    return await glmService.continueChat(history);
                }
            } catch (fallbackError) {
                console.error(`Fallback to ${otherProvider} also failed:`, fallbackError);
            }
        }
        
        throw error;
    }
};
