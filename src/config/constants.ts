// Application-wide constants.
// Do NOT put API keys here. API keys go in the .env file.

export const APP_NAME = 'ai-social-content-agent';

// LLM provider names
export const GEMINI = 'gemini';
export const GROQ = 'groq';
export const OPENROUTER = 'openrouter';

// Order in which providers are tried. The first one is tried first.
export const PROVIDER_PRIORITY = [GEMINI, GROQ, OPENROUTER];

// Default timeouts in milliseconds
export const DEFAULT_LLM_TIMEOUT = 60000; // 60 seconds
export const DEFAULT_HTTP_TIMEOUT = 15000; // 15 seconds

// Default LLM temperature (0 = focused, 1 = more creative)
export const DEFAULT_TEMPERATURE = 0.7;
