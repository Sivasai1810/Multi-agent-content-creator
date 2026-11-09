import {
  DEFAULT_LLM_TIMEOUT,
  GEMINI,
  GROQ,
  OPENROUTER,
  PROVIDER_PRIORITY,
} from '../config/constants';
import { LLMProviderName } from './llm.types';

// All LLM settings in one place. Agents never choose a model themselves.
export const MODEL_CONFIG = {
  // Order comes from constants.ts: Gemini first, then Groq, then OpenRouter
  primary: PROVIDER_PRIORITY[0] as LLMProviderName,
  fallback: PROVIDER_PRIORITY.slice(1) as LLMProviderName[],

  // Default model names. Used only when *_MODEL is empty in the .env file.
  models: {
    [GEMINI]: 'gemini-flash-latest',
    [GROQ]: 'openai/gpt-oss-20b',
    [OPENROUTER]: 'openrouter/free',
  },

  // Used only when *_TIMEOUT is not set in the .env file
  timeout: DEFAULT_LLM_TIMEOUT,

  // Extra tries on the SAME provider for temporary errors (rate limit, timeout, 5xx).
  // 0 means: move to the next provider straight away.
  maxRetries: 0,

  // When a provider keeps failing, we stop calling it for a while
  health: {
    failureThreshold: 3, // failures in a row before we pause the provider
    cooldownMs: 60000, // pause for 1 minute
    authCooldownMs: 300000, // a wrong API key will not fix itself, so pause for 5 minutes
  },

  // Provider specific settings
  providers: {
    [GEMINI]: {
      supportsJsonMode: true,
    },
    [GROQ]: {
      supportsJsonMode: true,
    },
    [OPENROUTER]: {
      // The free router picks a different model each time, so we do not
      // rely on native JSON mode. The prompt asks for JSON and Zod checks it.
      supportsJsonMode: false,
      baseUrl: 'https://openrouter.ai/api/v1',
    },
  },
};
