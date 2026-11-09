import { LLMInput, LLMProviderName, LLMRequestMetadata, LLMResponse } from './llm.types';

// Every LLM provider (Gemini, Groq, OpenRouter) must follow this interface.
// The rest of the app only uses this, so it does not depend on any SDK.
export interface LLMProvider {
  name: LLMProviderName;

  // metadata is optional and only used for tracing
  generate(input: LLMInput, metadata?: LLMRequestMetadata): Promise<LLMResponse>;
}
