import { ZodType } from 'zod';
import { GEMINI, GROQ, OPENROUTER } from '../config/constants';

// Provider identifiers: 'gemini' | 'groq' | 'openrouter' (values come from constants.ts)
export type LLMProviderName = typeof GEMINI | typeof GROQ | typeof OPENROUTER;

// The format we want the answer in.
export type LLMResponseFormat = 'text' | 'json';

// What we send to a provider.
export interface LLMInput {
  systemPrompt?: string;
  userPrompt: string;
  responseFormat?: LLMResponseFormat; // default is 'text'
  schema?: ZodType; // optional Zod schema to check JSON answers
  temperature?: number; // uses the configured default if not set
  maxTokens?: number;
  timeout?: number; // in milliseconds
  signal?: AbortSignal; // lets the caller cancel the request while it is running
}

// Tracing information about who made the request. Used in logs.
export interface LLMRequestMetadata {
  workflowId: string;
  newsId: string;
  attempt: number;
}

// Token usage for one request.
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// Extra information the router adds to a successful response.
export interface LLMResponseMetadata {
  latencyMs: number; // how long the successful provider took
  attemptedProviders: LLMProviderName[]; // every provider we called, in order
  request?: LLMRequestMetadata; // the tracing info that was passed in
}

// What we get back from a provider.
export interface LLMResponse {
  content: string;
  provider: LLMProviderName;
  model: string;
  usage?: TokenUsage; // optional because a provider may not send it
  data?: unknown; // parsed JSON, set by the router when responseFormat is 'json'
  metadata?: LLMResponseMetadata; // set by the router
}

// Provider error classification.
export type LLMErrorType =
  | 'RATE_LIMIT' // 429, too many requests
  | 'TIMEOUT' // provider took too long
  | 'NETWORK' // could not reach the provider
  | 'AUTHENTICATION' // wrong, expired or missing API key
  | 'INVALID_REQUEST' // our request is wrong, other providers will fail too
  | 'MODEL_UNAVAILABLE' // model not found, not supported, or no credits left
  | 'INVALID_RESPONSE' // empty answer or broken JSON
  | 'PROVIDER_ERROR' // 5xx, problem on the provider side
  | 'ALL_PROVIDERS_FAILED' // used by the router only
  | 'UNKNOWN';
