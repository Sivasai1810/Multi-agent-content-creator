import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import configuration from '../../src/config/configuration';
import { GEMINI, GROQ, OPENROUTER } from '../../src/config/constants';
import { LLMError, toLLMError } from '../../src/common/exceptions/llm.exception';
import { getRetryAfterFromHeaders } from '../../src/common/utils/llm.utils';
import { LLMRouterService } from '../../src/llm/llm-router.service';
import { LLMModule } from '../../src/llm/llm.module';
import { LLMProviderName, LLMResponse } from '../../src/llm/llm.types';
import { MODEL_CONFIG } from '../../src/llm/model-config';
import { ProviderHealthService } from '../../src/llm/provider-health.service';
import { GeminiProvider } from '../../src/llm/providers/gemini.provider';
import { GroqProvider } from '../../src/llm/providers/groq.provider';
import { OpenRouterProvider } from '../../src/llm/providers/openrouter.provider';
import { RateLimiterService } from '../../src/llm/rate-limiter.service';

// Load real API keys from .env (only needed for Test group A)
dotenv.config({ quiet: true });

// ---------- Helpers ----------

// A fake provider that returns a fixed answer or throws a fixed error
function fakeProvider(name: LLMProviderName, result: Partial<LLMResponse> | Error) {
  const generate = jest.fn(async (..._args: unknown[]) => {
    if (result instanceof Error) {
      throw result;
    }
    return { provider: name, model: `${name}-model`, ...result } as LLMResponse;
  });

  return { name, generate };
}

type FakeProvider = ReturnType<typeof fakeProvider>;

// Builds a router with fake providers. Rate limits are off unless a config is given.
function makeRouter(
  gemini: FakeProvider,
  groq: FakeProvider,
  openrouter: FakeProvider,
  options: { config?: Record<string, unknown>; health?: ProviderHealthService } = {},
) {
  return new LLMRouterService(
    gemini as any,
    groq as any,
    openrouter as any,
    new RateLimiterService(new ConfigService(options.config || {})),
    options.health || new ProviderHealthService(),
  );
}

const ok = (text: string) => ({
  content: text,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});

const rateLimit = (name: LLMProviderName) => new LLMError('RATE_LIMIT', 'Too many requests', name);
const timeout = (name: LLMProviderName) => new LLMError('TIMEOUT', 'Request timed out', name);
const serverError = (name: LLMProviderName) => new LLMError('PROVIDER_ERROR', 'Service unavailable', name);

// Hide router logs while tests run
beforeAll(() => Logger.overrideLogger(false));

// ---------- Test group A: real providers (run only when the API key is in .env) ----------

describe('A - Individual provider integration (real API calls)', () => {
  const config = new ConfigService(configuration());
  const jsonInput = {
    userPrompt: 'Give a JSON object with a "city" field set to "Paris".',
    responseFormat: 'json' as const,
  };

  const geminiTest = process.env.GEMINI_API_KEY ? it : it.skip;
  const groqTest = process.env.GROQ_API_KEY ? it : it.skip;
  const openRouterTest = process.env.OPENROUTER_API_KEY ? it : it.skip;

  geminiTest('Gemini text generation', async () => {
    const response = await new GeminiProvider(config).generate({ userPrompt: 'Say hello in one word.' });
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.provider).toBe(GEMINI);
  }, 60000);

  geminiTest('Gemini JSON generation', async () => {
    const response = await new GeminiProvider(config).generate(jsonInput);
    expect(JSON.parse(response.content).city).toBe('Paris');
  }, 60000);

  groqTest('Groq text generation', async () => {
    const response = await new GroqProvider(config).generate({ userPrompt: 'Say hello in one word.' });
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.provider).toBe(GROQ);
  }, 60000);

  groqTest('Groq JSON generation', async () => {
    const response = await new GroqProvider(config).generate(jsonInput);
    expect(JSON.parse(response.content).city).toBe('Paris');
  }, 60000);

  openRouterTest('OpenRouter text generation', async () => {
    const response = await new OpenRouterProvider(config).generate({ userPrompt: 'Say hello in one word.' });
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.provider).toBe(OPENROUTER);
  }, 60000);

  openRouterTest('OpenRouter JSON generation (through the router, so Zod checks it)', async () => {
    const onlyOpenRouter = new LLMRouterService(
      { name: GEMINI, generate: async () => { throw serverError(GEMINI); } } as any,
      { name: GROQ, generate: async () => { throw serverError(GROQ); } } as any,
      new OpenRouterProvider(config),
      new RateLimiterService(config),
      new ProviderHealthService(),
    );
    const response = await onlyOpenRouter.generate({ ...jsonInput, schema: z.object({ city: z.string() }) });
    expect(response.data).toEqual({ city: 'Paris' });
  }, 60000);
});

// ---------- Test group B: fallback behaviour ----------

describe('B - Fallback behaviour', () => {
  it('Gemini success returns the Gemini response', async () => {
    const router = makeRouter(fakeProvider(GEMINI, ok('hi')), fakeProvider(GROQ, ok('x')), fakeProvider(OPENROUTER, ok('x')));
    const response = await router.generate({ userPrompt: 'hello' });
    expect(response.provider).toBe(GEMINI);
    expect(response.content).toBe('hi');
  });

  it('Gemini failure -> Groq success', async () => {
    const router = makeRouter(fakeProvider(GEMINI, serverError(GEMINI)), fakeProvider(GROQ, ok('from groq')), fakeProvider(OPENROUTER, ok('x')));
    const response = await router.generate({ userPrompt: 'hello' });
    expect(response.provider).toBe(GROQ);
  });

  it('Gemini failure -> Groq failure -> OpenRouter success', async () => {
    const router = makeRouter(
      fakeProvider(GEMINI, serverError(GEMINI)),
      fakeProvider(GROQ, serverError(GROQ)),
      fakeProvider(OPENROUTER, ok('from openrouter')),
    );
    const response = await router.generate({ userPrompt: 'hello' });
    expect(response.provider).toBe(OPENROUTER);
  });

  it('All providers fail -> one normalized error with every failure', async () => {
    const router = makeRouter(
      fakeProvider(GEMINI, rateLimit(GEMINI)),
      fakeProvider(GROQ, timeout(GROQ)),
      fakeProvider(OPENROUTER, serverError(OPENROUTER)),
    );

    const error = await router.generate({ userPrompt: 'hello' }).catch((e) => e);
    expect(error).toBeInstanceOf(LLMError);
    expect(error.type).toBe('ALL_PROVIDERS_FAILED');
    expect(error.failures.map((f: LLMError) => f.type)).toEqual(['RATE_LIMIT', 'TIMEOUT', 'PROVIDER_ERROR']);
  });

  it('Timeout on Gemini -> tries Groq', async () => {
    const router = makeRouter(fakeProvider(GEMINI, timeout(GEMINI)), fakeProvider(GROQ, ok('ok')), fakeProvider(OPENROUTER, ok('x')));
    expect((await router.generate({ userPrompt: 'hello' })).provider).toBe(GROQ);
  });

  it('Rate limit on Gemini -> tries Groq', async () => {
    const router = makeRouter(fakeProvider(GEMINI, rateLimit(GEMINI)), fakeProvider(GROQ, ok('ok')), fakeProvider(OPENROUTER, ok('x')));
    expect((await router.generate({ userPrompt: 'hello' })).provider).toBe(GROQ);
  });

  it('Wrong API key on Gemini -> logged and tries Groq', async () => {
    const authError = new LLMError('AUTHENTICATION', 'bad key', GEMINI);
    const router = makeRouter(fakeProvider(GEMINI, authError), fakeProvider(GROQ, ok('ok')), fakeProvider(OPENROUTER, ok('x')));
    expect((await router.generate({ userPrompt: 'hello' })).provider).toBe(GROQ);
  });

  it('Invalid input -> no provider is called', async () => {
    const gemini = fakeProvider(GEMINI, ok('x'));
    const groq = fakeProvider(GROQ, ok('x'));
    const openrouter = fakeProvider(OPENROUTER, ok('x'));
    const router = makeRouter(gemini, groq, openrouter);

    await expect(router.generate({ userPrompt: '   ' })).rejects.toMatchObject({ type: 'INVALID_REQUEST' });
    await expect(router.generate({ userPrompt: 'hi', temperature: 5 })).rejects.toMatchObject({ type: 'INVALID_REQUEST' });
    expect(gemini.generate).not.toHaveBeenCalled();
    expect(groq.generate).not.toHaveBeenCalled();
    expect(openrouter.generate).not.toHaveBeenCalled();
  });

  it('Provider rejects the request as invalid (HTTP 400) -> no fallback', async () => {
    const badRequest = new LLMError('INVALID_REQUEST', 'bad request', GEMINI);
    const groq = fakeProvider(GROQ, ok('x'));
    const router = makeRouter(fakeProvider(GEMINI, badRequest), groq, fakeProvider(OPENROUTER, ok('x')));

    await expect(router.generate({ userPrompt: 'hello' })).rejects.toMatchObject({ type: 'INVALID_REQUEST' });
    expect(groq.generate).not.toHaveBeenCalled();
  });
});

// ---------- Test group C: output validation ----------

describe('C - Output validation', () => {
  const schema = z.object({ title: z.string() });

  it('Valid JSON is parsed into response.data', async () => {
    const router = makeRouter(fakeProvider(GEMINI, ok('{"title":"Hello"}')), fakeProvider(GROQ, ok('x')), fakeProvider(OPENROUTER, ok('x')));
    const response = await router.generate({ userPrompt: 'hi', responseFormat: 'json', schema });
    expect(response.data).toEqual({ title: 'Hello' });
  });

  it('JSON inside ```json fences is still parsed', async () => {
    const router = makeRouter(fakeProvider(GEMINI, ok('```json\n{"title":"Hi"}\n```')), fakeProvider(GROQ, ok('x')), fakeProvider(OPENROUTER, ok('x')));
    const response = await router.generate({ userPrompt: 'hi', responseFormat: 'json' });
    expect(response.data).toEqual({ title: 'Hi' });
  });

  it('Invalid JSON is recorded as a failure and the next provider is used', async () => {
    const health = new ProviderHealthService();
    const router = makeRouter(
      fakeProvider(GEMINI, ok('not json')),
      fakeProvider(GROQ, ok('{"title":"From Groq"}')),
      fakeProvider(OPENROUTER, ok('x')),
      { health },
    );
    const response = await router.generate({ userPrompt: 'hi', responseFormat: 'json', schema });
    expect(response.provider).toBe(GROQ);
    expect(response.data).toEqual({ title: 'From Groq' });
    expect(health.getStatus()[GEMINI].lastError?.type).toBe('INVALID_RESPONSE');
  });

  it('JSON that does not match the schema is a failure', async () => {
    const router = makeRouter(
      fakeProvider(GEMINI, ok('{"wrong":1}')),
      fakeProvider(GROQ, ok('{"wrong":2}')),
      fakeProvider(OPENROUTER, ok('{"wrong":3}')),
    );
    const error = await router.generate({ userPrompt: 'hi', responseFormat: 'json', schema }).catch((e) => e);
    expect(error.type).toBe('ALL_PROVIDERS_FAILED');
    expect(error.failures[0].message).toContain('does not match the schema');
  });

  it('Empty content counts as a failed generation', async () => {
    const emptyError = new LLMError('INVALID_RESPONSE', 'Gemini returned an empty response', GEMINI);
    const router = makeRouter(fakeProvider(GEMINI, emptyError), fakeProvider(GROQ, ok('ok')), fakeProvider(OPENROUTER, ok('x')));
    expect((await router.generate({ userPrompt: 'hi' })).provider).toBe(GROQ);
  });

  it('Missing usage information is allowed', async () => {
    const router = makeRouter(fakeProvider(GEMINI, { content: 'hi' }), fakeProvider(GROQ, ok('x')), fakeProvider(OPENROUTER, ok('x')));
    const response = await router.generate({ userPrompt: 'hi' });
    expect(response.usage).toBeUndefined();
  });

  it('Correct provider name and model name are returned', async () => {
    const router = makeRouter(fakeProvider(GEMINI, serverError(GEMINI)), fakeProvider(GROQ, ok('ok')), fakeProvider(OPENROUTER, ok('x')));
    const response = await router.generate({ userPrompt: 'hi' });
    expect(response.provider).toBe(GROQ);
    expect(response.model).toBe(`${GROQ}-model`);
  });
});

// ---------- Test group D: cost and reliability ----------

describe('D - Cost and reliability', () => {
  it('Tracks token usage', async () => {
    const health = new ProviderHealthService();
    const router = makeRouter(fakeProvider(GEMINI, ok('hi')), fakeProvider(GROQ, ok('x')), fakeProvider(OPENROUTER, ok('x')), { health });
    const response = await router.generate({ userPrompt: 'hi' });
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(health.getStatus()[GEMINI].totalTokens).toBe(15);
  });

  it('Tracks provider latency', async () => {
    const router = makeRouter(fakeProvider(GEMINI, ok('hi')), fakeProvider(GROQ, ok('x')), fakeProvider(OPENROUTER, ok('x')));
    const response = await router.generate({ userPrompt: 'hi' });
    expect(typeof response.metadata?.latencyMs).toBe('number');
    expect(response.metadata?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('Prevents infinite retries: each provider is called at most maxRetries + 1 times', async () => {
    const gemini = fakeProvider(GEMINI, rateLimit(GEMINI));
    const groq = fakeProvider(GROQ, rateLimit(GROQ));
    const openrouter = fakeProvider(OPENROUTER, rateLimit(OPENROUTER));
    const router = makeRouter(gemini, groq, openrouter);

    await expect(router.generate({ userPrompt: 'hi' })).rejects.toMatchObject({ type: 'ALL_PROVIDERS_FAILED' });

    const maxCalls = MODEL_CONFIG.maxRetries + 1;
    expect(gemini.generate).toHaveBeenCalledTimes(maxCalls);
    expect(groq.generate).toHaveBeenCalledTimes(maxCalls);
    expect(openrouter.generate).toHaveBeenCalledTimes(maxCalls);
  });

  it('Permanent errors are not retried on the same provider', async () => {
    const gemini = fakeProvider(GEMINI, new LLMError('AUTHENTICATION', 'bad key', GEMINI));
    const router = makeRouter(gemini, fakeProvider(GROQ, ok('ok')), fakeProvider(OPENROUTER, ok('x')));
    await router.generate({ userPrompt: 'hi' });
    expect(gemini.generate).toHaveBeenCalledTimes(1);
  });

  it('Avoids unnecessary requests: fallbacks are not called when Gemini works', async () => {
    const gemini = fakeProvider(GEMINI, ok('hi'));
    const groq = fakeProvider(GROQ, ok('x'));
    const openrouter = fakeProvider(OPENROUTER, ok('x'));
    await makeRouter(gemini, groq, openrouter).generate({ userPrompt: 'hi' });

    expect(gemini.generate).toHaveBeenCalledTimes(1);
    expect(groq.generate).not.toHaveBeenCalled();
    expect(openrouter.generate).not.toHaveBeenCalled();
  });

  it('Confirms provider switching order: Gemini, then Groq, then OpenRouter', async () => {
    const router = makeRouter(fakeProvider(GEMINI, serverError(GEMINI)), fakeProvider(GROQ, serverError(GROQ)), fakeProvider(OPENROUTER, ok('ok')));
    const response = await router.generate({ userPrompt: 'hi' });
    expect(response.metadata?.attemptedProviders).toEqual([GEMINI, GROQ, OPENROUTER]);
  });
});

// ---------- Test group E: request metadata (tracing) ----------

describe('E - Request metadata', () => {
  const metadata = { workflowId: 'wf-1', newsId: 'news-7', attempt: 2 };

  it('Passes metadata to the provider and returns it in the response', async () => {
    const gemini = fakeProvider(GEMINI, ok('hi'));
    const router = makeRouter(gemini, fakeProvider(GROQ, ok('x')), fakeProvider(OPENROUTER, ok('x')));
    const response = await router.generate({ userPrompt: 'hi' }, metadata);

    expect(gemini.generate).toHaveBeenCalledWith({ userPrompt: 'hi' }, metadata);
    expect(response.metadata?.request).toEqual(metadata);
  });

  it('Works without metadata', async () => {
    const router = makeRouter(fakeProvider(GEMINI, ok('hi')), fakeProvider(GROQ, ok('x')), fakeProvider(OPENROUTER, ok('x')));
    const response = await router.generate({ userPrompt: 'hi' });
    expect(response.metadata?.request).toBeUndefined();
  });
});

// ---------- Test group F: rate limiter ----------

describe('F - Rate limiter', () => {
  it('Allows requests up to the per-minute limit, then blocks', () => {
    const limiter = new RateLimiterService(new ConfigService({ gemini: { requestsPerMinute: 2 } }));
    expect(limiter.tryAcquire(GEMINI)).toBe(true);
    expect(limiter.tryAcquire(GEMINI)).toBe(true);
    expect(limiter.tryAcquire(GEMINI)).toBe(false);
    expect(limiter.getWaitTime(GEMINI)).toBeGreaterThan(0);
  });

  it('No limit set means no blocking', () => {
    const limiter = new RateLimiterService(new ConfigService({}));
    for (let i = 0; i < 100; i++) {
      expect(limiter.tryAcquire(GROQ)).toBe(true);
    }
    expect(limiter.getWaitTime(GROQ)).toBe(0);
  });

  it('Allows requests again after one minute', () => {
    jest.useFakeTimers();
    const limiter = new RateLimiterService(new ConfigService({ groq: { requestsPerMinute: 1 } }));
    expect(limiter.tryAcquire(GROQ)).toBe(true);
    expect(limiter.tryAcquire(GROQ)).toBe(false);
    jest.advanceTimersByTime(60001);
    expect(limiter.tryAcquire(GROQ)).toBe(true);
    jest.useRealTimers();
  });

  it('Router skips a provider over its limit without calling it', async () => {
    const gemini = fakeProvider(GEMINI, ok('from gemini'));
    const router = makeRouter(gemini, fakeProvider(GROQ, ok('from groq')), fakeProvider(OPENROUTER, ok('x')), {
      config: { gemini: { requestsPerMinute: 1 } },
    });

    expect((await router.generate({ userPrompt: 'one' })).provider).toBe(GEMINI);
    expect((await router.generate({ userPrompt: 'two' })).provider).toBe(GROQ);
    expect(gemini.generate).toHaveBeenCalledTimes(1);
  });
});

// ---------- Test group G: provider health ----------

describe('G - Provider health', () => {
  it('Pauses a provider after several failures in a row', async () => {
    const health = new ProviderHealthService();
    const gemini = fakeProvider(GEMINI, serverError(GEMINI));
    const router = makeRouter(gemini, fakeProvider(GROQ, ok('ok')), fakeProvider(OPENROUTER, ok('x')), { health });

    for (let i = 0; i < MODEL_CONFIG.health.failureThreshold + 2; i++) {
      await router.generate({ userPrompt: 'hi' });
    }

    expect(gemini.generate).toHaveBeenCalledTimes(MODEL_CONFIG.health.failureThreshold);
    expect(health.isAvailable(GEMINI)).toBe(false);
  });

  it('A success resets the failure count', () => {
    const health = new ProviderHealthService();
    health.recordFailure(GROQ, serverError(GROQ), 10);
    health.recordFailure(GROQ, serverError(GROQ), 10);
    health.recordSuccess(GROQ, 10, 5);
    health.recordFailure(GROQ, serverError(GROQ), 10);
    expect(health.isAvailable(GROQ)).toBe(true);
    expect(health.getStatus()[GROQ].consecutiveFailures).toBe(1);
  });

  it('Respects the provider Retry-After time on 429', async () => {
    const health = new ProviderHealthService();
    const limited = new LLMError('RATE_LIMIT', 'slow down', GEMINI, { retryAfterMs: 20000 });
    const gemini = fakeProvider(GEMINI, limited);
    const router = makeRouter(gemini, fakeProvider(GROQ, ok('ok')), fakeProvider(OPENROUTER, ok('x')), { health });

    await router.generate({ userPrompt: 'hi' });
    await router.generate({ userPrompt: 'hi again' });

    expect(gemini.generate).toHaveBeenCalledTimes(1); // second call skipped Gemini
    expect(health.getWaitTime(GEMINI)).toBeGreaterThan(19000);
  });

  it('Pauses a provider straight away when the API key is wrong', () => {
    const health = new ProviderHealthService();
    health.recordFailure(OPENROUTER, new LLMError('AUTHENTICATION', 'bad key', OPENROUTER), 5);
    expect(health.isAvailable(OPENROUTER)).toBe(false);
  });

  it('When all fail, the error has the shortest wait time for the queue', async () => {
    const router = makeRouter(
      fakeProvider(GEMINI, new LLMError('RATE_LIMIT', 'wait', GEMINI, { retryAfterMs: 30000 })),
      fakeProvider(GROQ, new LLMError('RATE_LIMIT', 'wait', GROQ, { retryAfterMs: 7000 })),
      fakeProvider(OPENROUTER, serverError(OPENROUTER)),
    );
    const error = await router.generate({ userPrompt: 'hi' }).catch((e) => e);
    expect(error.type).toBe('ALL_PROVIDERS_FAILED');
    expect(error.retryAfterMs).toBe(7000);
  });
});

// ---------- Provider error handling (SDK errors -> LLMError) ----------

describe('Provider error handling', () => {
  it.each([
    [{ status: 401, message: 'Invalid API Key' }, 'AUTHENTICATION'],
    [{ status: 400, message: 'API key not valid. Please pass a valid API key.' }, 'AUTHENTICATION'],
    [{ status: 429, message: 'Rate limit reached' }, 'RATE_LIMIT'],
    [{ status: 402, message: 'Insufficient credits' }, 'MODEL_UNAVAILABLE'],
    [{ status: 404, message: 'No endpoints found for this model' }, 'MODEL_UNAVAILABLE'],
    [{ status: 400, message: 'The model `old-model` has been decommissioned' }, 'MODEL_UNAVAILABLE'],
    [{ status: 400, message: 'json_validate_failed' }, 'INVALID_RESPONSE'],
    [{ status: 400, message: 'messages: field required' }, 'INVALID_REQUEST'],
    [{ status: 503, message: 'Service unavailable' }, 'PROVIDER_ERROR'],
    [{ name: 'APIConnectionTimeoutError', message: 'Request timed out.' }, 'TIMEOUT'],
    [{ name: 'TypeError', message: 'fetch failed' }, 'NETWORK'],
    [{ name: 'Error', message: 'connect ECONNREFUSED 127.0.0.1:443' }, 'NETWORK'],
  ])('%j -> %s', (sdkError, expectedType) => {
    expect(toLLMError(sdkError, GROQ).type).toBe(expectedType);
  });

  it('Keeps the original provider error, status code and message', () => {
    const sdkError = { status: 429, message: 'Rate limit reached for model X' };
    const error = toLLMError(sdkError, GROQ, 5000);
    expect(error.originalError).toBe(sdkError);
    expect(error.statusCode).toBe(429);
    expect(error.message).toContain('Rate limit reached for model X');
    expect(error.retryAfterMs).toBe(5000);
  });

  it('Reads the Retry-After header in seconds and as a date', () => {
    expect(getRetryAfterFromHeaders({ headers: new Headers({ 'retry-after': '20' }) })).toBe(20000);

    const inTenSeconds = new Date(Date.now() + 10000).toUTCString();
    const fromDate = getRetryAfterFromHeaders({ headers: new Headers({ 'retry-after': inTenSeconds }) });
    expect(fromDate).toBeGreaterThan(8000);
    expect(fromDate).toBeLessThanOrEqual(10000);

    expect(getRetryAfterFromHeaders({ headers: new Headers() })).toBeUndefined();
    expect(getRetryAfterFromHeaders({ message: 'no headers' })).toBeUndefined();
  });

  it('A provider without an API key fails with AUTHENTICATION and makes no request', async () => {
    const emptyConfig = new ConfigService({});
    await expect(new GeminiProvider(emptyConfig).generate({ userPrompt: 'hi' })).rejects.toMatchObject({ type: 'AUTHENTICATION' });
    await expect(new GroqProvider(emptyConfig).generate({ userPrompt: 'hi' })).rejects.toMatchObject({ type: 'AUTHENTICATION' });
    await expect(new OpenRouterProvider(emptyConfig).generate({ userPrompt: 'hi' })).rejects.toMatchObject({ type: 'AUTHENTICATION' });
  });

  it('Gemini 429 -> RATE_LIMIT with the retryDelay from the message', async () => {
    const provider = new GeminiProvider(new ConfigService({ gemini: { apiKey: 'test' } }));
    const geminiError = {
      status: 429,
      message: '{"error":{"code":429,"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"23s"}]}}',
    };
    (provider as any).client = { models: { generateContent: jest.fn().mockRejectedValue(geminiError) } };

    const error = await provider.generate({ userPrompt: 'hi' }).catch((e) => e);
    expect(error.type).toBe('RATE_LIMIT');
    expect(error.retryAfterMs).toBe(23000);
    expect(error.originalError).toBe(geminiError);
  });

  it('Groq 429 -> RATE_LIMIT with the Retry-After header', async () => {
    const provider = new GroqProvider(new ConfigService({ groq: { apiKey: 'test' } }));
    const groqError = { status: 429, message: 'Rate limit reached', headers: new Headers({ 'retry-after': '7' }) };
    (provider as any).client = { chat: { completions: { create: jest.fn().mockRejectedValue(groqError) } } };

    const error = await provider.generate({ userPrompt: 'hi' }).catch((e) => e);
    expect(error.type).toBe('RATE_LIMIT');
    expect(error.retryAfterMs).toBe(7000);
  });

  it('Gemini empty response becomes INVALID_RESPONSE', async () => {
    const provider = new GeminiProvider(new ConfigService({ gemini: { apiKey: 'test' } }));
    (provider as any).client = { models: { generateContent: jest.fn().mockResolvedValue({ text: '' }) } };
    await expect(provider.generate({ userPrompt: 'hi' })).rejects.toMatchObject({ type: 'INVALID_RESPONSE' });
  });

  it('Groq response is normalized into LLMResponse', async () => {
    const provider = new GroqProvider(new ConfigService({ groq: { apiKey: 'test' } }));
    (provider as any).client = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            model: 'test-model',
            choices: [{ message: { content: 'hello' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        },
      },
    };

    const response = await provider.generate({ userPrompt: 'hi' });
    expect(response).toEqual({
      content: 'hello',
      provider: GROQ,
      model: 'test-model',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
  });

  it('OpenRouter response without choices becomes INVALID_RESPONSE', async () => {
    const provider = new OpenRouterProvider(new ConfigService({ openrouter: { apiKey: 'test' } }));
    (provider as any).client = {
      chat: { completions: { create: jest.fn().mockResolvedValue({ error: { message: 'upstream error' } }) } },
    };
    await expect(provider.generate({ userPrompt: 'hi' })).rejects.toMatchObject({ type: 'INVALID_RESPONSE' });
  });
});

// ---------- NestJS dependency injection ----------

describe('LLMModule', () => {
  it('lets any module inject LLMRouterService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [configuration] }), LLMModule],
    }).compile();

    expect(moduleRef.get(LLMRouterService)).toBeInstanceOf(LLMRouterService);
  });
});
