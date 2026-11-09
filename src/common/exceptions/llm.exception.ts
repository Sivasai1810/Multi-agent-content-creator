import { LLMErrorType, LLMProviderName } from '../../llm/llm.types';

// Temporary errors. Trying the same provider again later might work.
export const RETRYABLE_ERRORS: LLMErrorType[] = ['RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'PROVIDER_ERROR'];

interface LLMErrorDetails {
  statusCode?: number; // HTTP status from the provider
  retryAfterMs?: number; // how long the provider asked us to wait
  originalError?: unknown; // the error the SDK threw, never hidden
  failures?: LLMError[]; // filled only when all providers fail
}

// One error class for every LLM problem, so the router can handle all providers the same way.
export class LLMError extends Error {
  type: LLMErrorType;
  provider?: LLMProviderName;
  statusCode?: number;
  retryAfterMs?: number;
  originalError?: unknown;
  failures: LLMError[];

  constructor(
    type: LLMErrorType,
    message: string,
    provider?: LLMProviderName,
    details: LLMErrorDetails = {},
  ) {
    super(message);
    this.name = 'LLMError';
    this.type = type;
    this.provider = provider;
    this.statusCode = details.statusCode;
    this.retryAfterMs = details.retryAfterMs;
    this.originalError = details.originalError;
    this.failures = details.failures || [];
  }

  isRetryable(): boolean {
    return RETRYABLE_ERRORS.includes(this.type);
  }
}

// Converts any SDK error into an LLMError.
// All three SDKs put the HTTP status code in error.status.
// The provider message is kept as it is, and the full SDK error is saved in originalError.
export function toLLMError(
  error: unknown,
  provider: LLMProviderName,
  retryAfterMs?: number,
): LLMError {
  if (error instanceof LLMError) {
    return error;
  }

  const err = error as { status?: number; message?: string; name?: string };
  const status = err?.status;
  const message = err?.message || String(error);
  const text = `${err?.name} ${message}`.toLowerCase();
  const details = { statusCode: status, retryAfterMs, originalError: error };

  if (status === 401 || status === 403) {
    return new LLMError('AUTHENTICATION', `Invalid API key or no access: ${message}`, provider, details);
  }

  // 402 = no credits left (OpenRouter). The model cannot be used until credits are added.
  if (status === 402 || status === 404) {
    return new LLMError('MODEL_UNAVAILABLE', message, provider, details);
  }

  if (status === 408) {
    return new LLMError('TIMEOUT', message, provider, details);
  }

  if (status === 429) {
    return new LLMError('RATE_LIMIT', message, provider, details);
  }

  if (status !== undefined && status >= 500) {
    return new LLMError('PROVIDER_ERROR', message, provider, details);
  }

  if (status === 400) {
    // Gemini sends 400 (not 401) when the API key is wrong
    if (text.includes('api key')) {
      return new LLMError('AUTHENTICATION', `Invalid API key: ${message}`, provider, details);
    }

    // Groq sends 400 when the model could not produce valid JSON
    if (text.includes('json')) {
      return new LLMError('INVALID_RESPONSE', message, provider, details);
    }

    if (text.includes('model')) {
      return new LLMError('MODEL_UNAVAILABLE', message, provider, details);
    }

    return new LLMError('INVALID_REQUEST', message, provider, details);
  }

  // Errors without a status code: timeouts and network problems
  if (text.includes('timeout') || text.includes('timed out') || text.includes('abort')) {
    return new LLMError('TIMEOUT', message, provider, details);
  }

  if (
    text.includes('fetch failed') ||
    text.includes('connection') ||
    text.includes('network') ||
    text.includes('econn')
  ) {
    return new LLMError('NETWORK', message, provider, details);
  }

  return new LLMError('UNKNOWN', message, provider, details);
}
