import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { DEFAULT_TEMPERATURE, OPENROUTER } from '../../config/constants';
import { LLMError, toLLMError } from '../../common/exceptions/llm.exception';
import { buildSystemPrompt, getRetryAfterFromHeaders } from '../../common/utils/llm.utils';
import { LLMProvider } from '../llm.interface';
import { LLMInput, LLMProviderName, LLMResponse } from '../llm.types';
import { MODEL_CONFIG } from '../model-config';

// Third provider. OpenRouter uses the same API as OpenAI, so we use the OpenAI SDK.
@Injectable()
export class OpenRouterProvider implements LLMProvider {
  name: LLMProviderName = OPENROUTER;

  private client: OpenAI | null = null;
  private model: string;
  private timeout: number;
  private temperature: number;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('openrouter.apiKey');

    this.model = this.configService.get<string>('openrouter.model') || MODEL_CONFIG.models[OPENROUTER];
    this.timeout = this.configService.get<number>('openrouter.timeout') || MODEL_CONFIG.timeout;
    this.temperature = this.configService.get<number>('openrouter.temperature') ?? DEFAULT_TEMPERATURE;

    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: MODEL_CONFIG.providers[OPENROUTER].baseUrl,
        maxRetries: 0, // the router decides about retries
      });
    }
  }

  async generate(input: LLMInput): Promise<LLMResponse> {
    if (!this.client) {
      throw new LLMError('AUTHENTICATION', 'OPENROUTER_API_KEY is not set', OPENROUTER);
    }

    // Not every OpenRouter model supports native JSON mode. When it is turned off,
    // the JSON instruction in the system prompt is used and the router checks the result.
    const useJsonMode =
      input.responseFormat === 'json' && MODEL_CONFIG.providers[OPENROUTER].supportsJsonMode;
    const systemPrompt = buildSystemPrompt(input);

    const messages: { role: 'system' | 'user'; content: string }[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: input.userPrompt });

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          temperature: input.temperature ?? this.temperature,
          max_tokens: input.maxTokens,
          response_format: useJsonMode ? { type: 'json_object' } : undefined,
        },
        { timeout: input.timeout || this.timeout, signal: input.signal },
      );

      // OpenRouter can send an error inside a normal response, so choices may be missing
      const content = response.choices?.[0]?.message?.content;

      if (!content || content.trim() === '') {
        throw new LLMError('INVALID_RESPONSE', 'OpenRouter returned an empty response', OPENROUTER);
      }

      const usage = response.usage;

      return {
        content,
        provider: OPENROUTER,
        // With openrouter/free this is the real model that answered
        model: response.model || this.model,
        usage: usage
          ? {
              inputTokens: usage.prompt_tokens || 0,
              outputTokens: usage.completion_tokens || 0,
              totalTokens: usage.total_tokens || 0,
            }
          : undefined,
      };
    } catch (error) {
      // OpenRouter sends a Retry-After header when it is available
      throw toLLMError(error, OPENROUTER, getRetryAfterFromHeaders(error));
    }
  }
}
