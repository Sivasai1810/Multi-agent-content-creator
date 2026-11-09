import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Groq from 'groq-sdk';
import { DEFAULT_TEMPERATURE, GROQ } from '../../config/constants';
import { LLMError, toLLMError } from '../../common/exceptions/llm.exception';
import { buildSystemPrompt, getRetryAfterFromHeaders } from '../../common/utils/llm.utils';
import { LLMProvider } from '../llm.interface';
import { LLMInput, LLMProviderName, LLMResponse } from '../llm.types';
import { MODEL_CONFIG } from '../model-config';

// Secondary provider
@Injectable()
export class GroqProvider implements LLMProvider {
  name: LLMProviderName = GROQ;

  private client: Groq | null = null;
  private model: string;
  private timeout: number;
  private temperature: number;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('groq.apiKey');

    this.model = this.configService.get<string>('groq.model') || MODEL_CONFIG.models[GROQ];
    this.timeout = this.configService.get<number>('groq.timeout') || MODEL_CONFIG.timeout;
    this.temperature = this.configService.get<number>('groq.temperature') ?? DEFAULT_TEMPERATURE;

    if (apiKey) {
      // maxRetries 0: the SDK retries 2 times by default. The router decides about retries instead.
      this.client = new Groq({ apiKey, maxRetries: 0 });
    }
  }

  async generate(input: LLMInput): Promise<LLMResponse> {
    if (!this.client) {
      throw new LLMError('AUTHENTICATION', 'GROQ_API_KEY is not set', GROQ);
    }

    const useJsonMode = input.responseFormat === 'json' && MODEL_CONFIG.providers[GROQ].supportsJsonMode;
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

      const content = response.choices?.[0]?.message?.content;

      if (!content || content.trim() === '') {
        throw new LLMError('INVALID_RESPONSE', 'Groq returned an empty response', GROQ);
      }

      const usage = response.usage;

      return {
        content,
        provider: GROQ,
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
      // Groq sends a Retry-After header with 429 responses
      throw toLLMError(error, GROQ, getRetryAfterFromHeaders(error));
    }
  }
}
