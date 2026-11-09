import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { DEFAULT_TEMPERATURE, GEMINI } from '../../config/constants';
import { LLMError, toLLMError } from '../../common/exceptions/llm.exception';
import { buildSystemPrompt } from '../../common/utils/llm.utils';
import { LLMProvider } from '../llm.interface';
import { LLMInput, LLMProviderName, LLMResponse } from '../llm.types';
import { MODEL_CONFIG } from '../model-config';

// Primary provider
@Injectable()
export class GeminiProvider implements LLMProvider {
  name: LLMProviderName = GEMINI;

  private client: GoogleGenAI | null = null;
  private model: string;
  private timeout: number;
  private temperature: number;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('gemini.apiKey');

    this.model = this.configService.get<string>('gemini.model') || MODEL_CONFIG.models[GEMINI];
    this.timeout = this.configService.get<number>('gemini.timeout') || MODEL_CONFIG.timeout;
    this.temperature = this.configService.get<number>('gemini.temperature') ?? DEFAULT_TEMPERATURE;

    // The key is optional in development, so only create the client when we have one
    if (apiKey) {
      this.client = new GoogleGenAI({ apiKey });
    }
  }

  async generate(input: LLMInput): Promise<LLMResponse> {
    if (!this.client) {
      throw new LLMError('AUTHENTICATION', 'GEMINI_API_KEY is not set', GEMINI);
    }

    const useJsonMode = input.responseFormat === 'json' && MODEL_CONFIG.providers[GEMINI].supportsJsonMode;
    const systemPrompt = buildSystemPrompt(input);

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: input.userPrompt,
        config: {
          systemInstruction: systemPrompt || undefined,
          temperature: input.temperature ?? this.temperature,
          maxOutputTokens: input.maxTokens,
          responseMimeType: useJsonMode ? 'application/json' : 'text/plain',
          abortSignal: input.signal,
          httpOptions: {
            timeout: input.timeout || this.timeout,
            // The SDK retries 5 times by default. The router decides about retries instead.
            retryOptions: { attempts: 1 },
          },
        },
      });

      const content = response.text;

      if (!content || content.trim() === '') {
        throw new LLMError('INVALID_RESPONSE', 'Gemini returned an empty response', GEMINI);
      }

      const usage = response.usageMetadata;

      return {
        content,
        provider: GEMINI,
        model: this.model,
        usage: usage
          ? {
              inputTokens: usage.promptTokenCount || 0,
              outputTokens: usage.candidatesTokenCount || 0,
              totalTokens: usage.totalTokenCount || 0,
            }
          : undefined,
      };
    } catch (error) {
      throw toLLMError(error, GEMINI, this.getRetryAfterMs(error));
    }
  }

  // Gemini does not send a Retry-After header. It puts the wait time
  // inside the error message instead, like: "retryDelay": "23s"
  private getRetryAfterMs(error: unknown): number | undefined {
    const message = (error as { message?: string })?.message || '';
    const match =
      message.match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/) ||
      message.match(/retry in (\d+(?:\.\d+)?)s/i);

    if (!match) {
      return undefined;
    }

    return Math.ceil(Number(match[1]) * 1000);
  }
}
