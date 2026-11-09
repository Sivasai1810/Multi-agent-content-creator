import { Injectable, Logger } from '@nestjs/common';
import { GEMINI, GROQ, OPENROUTER } from '../config/constants';
import { LLMError, toLLMError } from '../common/exceptions/llm.exception';
import { LLMProvider } from './llm.interface';
import { LLMInput, LLMProviderName, LLMRequestMetadata, LLMResponse } from './llm.types';
import { MODEL_CONFIG } from './model-config';
import { ProviderHealthService } from './provider-health.service';
import { GeminiProvider } from './providers/gemini.provider';
import { GroqProvider } from './providers/groq.provider';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { RateLimiterService } from './rate-limiter.service';

// The only LLM service that agents use.
// It tries Gemini first, then Groq, then OpenRouter, and returns the first good answer.
// Providers that are paused or over their rate limit are skipped.
@Injectable()
export class LLMRouterService {
  private readonly logger = new Logger(LLMRouterService.name);
  private providers: Record<LLMProviderName, LLMProvider>;

  constructor(
    geminiProvider: GeminiProvider,
    groqProvider: GroqProvider,
    openRouterProvider: OpenRouterProvider,
    private readonly rateLimiter: RateLimiterService,
    private readonly providerHealth: ProviderHealthService,
  ) {
    this.providers = {
      [GEMINI]: geminiProvider,
      [GROQ]: groqProvider,
      [OPENROUTER]: openRouterProvider,
    };
  }

  async generate(input: LLMInput, metadata?: LLMRequestMetadata): Promise<LLMResponse> {
    // Invalid input fails on every provider, so check it before calling any of them
    this.validateInput(input);

    // Added to every log line so we can follow one news item through the logs
    const trace = metadata
      ? ` [workflow ${metadata.workflowId}, news ${metadata.newsId}, attempt ${metadata.attempt}]`
      : '';

    const providerOrder = [MODEL_CONFIG.primary, ...MODEL_CONFIG.fallback];
    const failures: LLMError[] = [];
    const attemptedProviders: LLMProviderName[] = [];

    for (const providerName of providerOrder) {
      // The caller cancelled this request, so never start another provider
      if (input.signal?.aborted) {
        throw new LLMError('TIMEOUT', 'The request was cancelled', providerName);
      }

      // Skip a provider that is paused after errors
      if (!this.providerHealth.isAvailable(providerName)) {
        const waitMs = this.providerHealth.getWaitTime(providerName);
        this.logger.warn(`Skipping ${providerName}${trace}: paused for ${waitMs}ms after errors`);
        failures.push(
          new LLMError('MODEL_UNAVAILABLE', `${providerName} is paused after errors`, providerName, {
            retryAfterMs: waitMs,
          }),
        );
        continue;
      }

      try {
        const response = await this.tryProvider(this.providers[providerName], input, metadata, trace, attemptedProviders);
        return response;
      } catch (error) {
        const llmError = toLLMError(error, providerName);
        failures.push(llmError);

        // The provider says our request is wrong. Other providers would reject it too.
        if (llmError.type === 'INVALID_REQUEST') {
          this.logger.error(`${providerName} rejected the request as invalid${trace}. Not trying other providers.`);
          throw llmError;
        }
      }
    }

    const summary = failures
      .map((failure) => `${failure.provider} (${failure.type}): ${failure.message}`)
      .join(' | ');

    // The shortest wait time, so a queue knows when to try this job again
    const waitTimes = failures
      .map((failure) => failure.retryAfterMs)
      .filter((ms): ms is number => ms !== undefined);
    const retryAfterMs = waitTimes.length > 0 ? Math.min(...waitTimes) : undefined;

    this.logger.error(`All LLM providers failed${trace}. ${summary}`);
    throw new LLMError('ALL_PROVIDERS_FAILED', `All LLM providers failed. ${summary}`, undefined, {
      failures,
      retryAfterMs,
    });
  }

  // Calls one provider. Retries only temporary errors, and only MODEL_CONFIG.maxRetries times.
  private async tryProvider(
    provider: LLMProvider,
    input: LLMInput,
    metadata: LLMRequestMetadata | undefined,
    trace: string,
    attemptedProviders: LLMProviderName[],
  ): Promise<LLMResponse> {
    const maxAttempts = MODEL_CONFIG.maxRetries + 1;
    let lastError: LLMError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Our own requests-per-minute limit. This is not a provider failure, so health is not changed.
      if (!this.rateLimiter.tryAcquire(provider.name)) {
        const waitMs = this.rateLimiter.getWaitTime(provider.name);
        this.logger.warn(`Skipping ${provider.name}${trace}: requests-per-minute limit reached`);
        throw new LLMError('RATE_LIMIT', `${provider.name} requests-per-minute limit reached`, provider.name, {
          retryAfterMs: waitMs,
        });
      }

      const startTime = Date.now();
      attemptedProviders.push(provider.name);
      this.logger.log(`Trying ${provider.name} (attempt ${attempt} of ${maxAttempts})${trace}`);

      try {
        const response = await provider.generate(input, metadata);

        if (input.responseFormat === 'json') {
          response.data = this.parseJson(response.content, input, provider.name);
        }

        const latencyMs = Date.now() - startTime;
        const tokens = response.usage ? response.usage.totalTokens : 0;

        response.metadata = { latencyMs, attemptedProviders, request: metadata };
        this.providerHealth.recordSuccess(provider.name, latencyMs, tokens);

        this.logger.log(
          `${provider.name} succeeded in ${latencyMs}ms${trace}, model: ${response.model}, ` +
            `tokens: ${response.usage ? response.usage.totalTokens : 'unknown'}`,
        );

        return response;
      } catch (error) {
        lastError = toLLMError(error, provider.name);
        const latencyMs = Date.now() - startTime;

        // A bad request or our own cancel is not the provider's fault, so it does not hurt its health
        if (lastError.type !== 'INVALID_REQUEST' && !input.signal?.aborted) {
          this.providerHealth.recordFailure(provider.name, lastError, latencyMs);
        }

        if (lastError.type === 'AUTHENTICATION') {
          this.logger.error(`${provider.name} credential problem${trace}, check the API key: ${lastError.message}`);
        } else {
          this.logger.warn(
            `${provider.name} failed after ${latencyMs}ms${trace} (${lastError.type}): ${lastError.message}`,
          );
        }

        // Permanent errors or a cancel: trying the same provider again will not help
        if (!lastError.isRetryable() || input.signal?.aborted) {
          break;
        }

        // The provider asked us to wait, so do not try it again right now
        if (lastError.retryAfterMs) {
          break;
        }
      }
    }

    throw lastError;
  }

  // Turns the text answer into JSON, and checks it with the Zod schema when one is given
  private parseJson(content: string, input: LLMInput, providerName: LLMProviderName): unknown {
    // Some models wrap JSON in ```json ... ``` even when we ask them not to
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');

    let data: unknown;

    try {
      data = JSON.parse(cleaned);
    } catch {
      throw new LLMError('INVALID_RESPONSE', `${providerName} returned invalid JSON`, providerName);
    }

    if (input.schema) {
      const result = input.schema.safeParse(data);

      if (!result.success) {
        throw new LLMError(
          'INVALID_RESPONSE',
          `${providerName} JSON does not match the schema: ${result.error.message}`,
          providerName,
        );
      }

      return result.data;
    }

    return data;
  }

  private validateInput(input: LLMInput): void {
    if (!input || typeof input.userPrompt !== 'string' || input.userPrompt.trim() === '') {
      throw new LLMError('INVALID_REQUEST', 'userPrompt must be a non-empty string');
    }

    if (input.responseFormat && input.responseFormat !== 'text' && input.responseFormat !== 'json') {
      throw new LLMError('INVALID_REQUEST', `responseFormat must be 'text' or 'json'`);
    }

    if (input.schema && input.responseFormat !== 'json') {
      throw new LLMError('INVALID_REQUEST', `schema can only be used with responseFormat 'json'`);
    }

    if (input.temperature !== undefined && (input.temperature < 0 || input.temperature > 2)) {
      throw new LLMError('INVALID_REQUEST', 'temperature must be between 0 and 2');
    }

    if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens < 1)) {
      throw new LLMError('INVALID_REQUEST', 'maxTokens must be a whole number above 0');
    }
  }
}
