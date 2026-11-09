import { LLMInput } from '../../llm/llm.types';

export const JSON_INSTRUCTION =
  'Reply with valid JSON only. Do not add any text or markdown before or after the JSON.';

// Every provider gets the JSON instruction in the system prompt when JSON is wanted.
// This also works for models that have no native JSON mode.
export function buildSystemPrompt(input: LLMInput): string {
  const systemPrompt = input.systemPrompt || '';

  if (input.responseFormat === 'json') {
    return `${systemPrompt}\n\n${JSON_INSTRUCTION}`.trim();
  }

  return systemPrompt;
}

// Reads the Retry-After header from an SDK error (the Groq and OpenAI SDKs keep the headers).
// The header can be seconds ("20") or a date. Returns milliseconds, or undefined.
export function getRetryAfterFromHeaders(error: unknown): number | undefined {
  const headers = (error as { headers?: Headers })?.headers;
  const value = headers?.get?.('retry-after');

  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }

  const date = Date.parse(value);

  if (!Number.isNaN(date)) {
    return Math.max(date - Date.now(), 0);
  }

  return undefined;
}
