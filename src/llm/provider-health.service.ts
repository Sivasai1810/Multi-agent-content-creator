import { Injectable } from '@nestjs/common';
import { GEMINI, GROQ, OPENROUTER } from '../config/constants';
import { LLMError } from '../common/exceptions/llm.exception';
import { LLMProviderName } from './llm.types';
import { MODEL_CONFIG } from './model-config';

export interface ProviderHealth {
  consecutiveFailures: number;
  unavailableUntil: number; // time in ms. 0 means the provider can be used
  lastError?: LLMError;
  totalRequests: number;
  totalFailures: number;
  totalTokens: number;
  totalLatencyMs: number;
}

function newHealth(): ProviderHealth {
  return {
    consecutiveFailures: 0,
    unavailableUntil: 0,
    totalRequests: 0,
    totalFailures: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
  };
}

// Remembers how each provider is doing.
// A provider is paused (skipped by the router) when:
// - it sends 429 with a wait time  -> paused for that wait time
// - the API key is wrong           -> paused for authCooldownMs
// - it fails several times in a row -> paused for cooldownMs
@Injectable()
export class ProviderHealthService {
  private health: Record<LLMProviderName, ProviderHealth> = {
    [GEMINI]: newHealth(),
    [GROQ]: newHealth(),
    [OPENROUTER]: newHealth(),
  };

  isAvailable(provider: LLMProviderName): boolean {
    return Date.now() >= this.health[provider].unavailableUntil;
  }

  // How many ms until the provider can be used again. 0 means now.
  getWaitTime(provider: LLMProviderName): number {
    return Math.max(this.health[provider].unavailableUntil - Date.now(), 0);
  }

  recordSuccess(provider: LLMProviderName, latencyMs: number, tokens: number): void {
    const health = this.health[provider];

    health.consecutiveFailures = 0;
    health.unavailableUntil = 0;
    health.totalRequests++;
    health.totalTokens += tokens;
    health.totalLatencyMs += latencyMs;
  }

  recordFailure(provider: LLMProviderName, error: LLMError, latencyMs: number): void {
    const health = this.health[provider];

    health.consecutiveFailures++;
    health.totalRequests++;
    health.totalFailures++;
    health.totalLatencyMs += latencyMs;
    health.lastError = error;

    if (error.type === 'RATE_LIMIT' && error.retryAfterMs) {
      this.pause(provider, error.retryAfterMs);
    } else if (error.type === 'AUTHENTICATION') {
      this.pause(provider, MODEL_CONFIG.health.authCooldownMs);
    } else if (health.consecutiveFailures >= MODEL_CONFIG.health.failureThreshold) {
      this.pause(provider, MODEL_CONFIG.health.cooldownMs);
    }
  }

  // A copy of the health of every provider, for logs or a status page
  getStatus(): Record<LLMProviderName, ProviderHealth> {
    return {
      [GEMINI]: { ...this.health[GEMINI] },
      [GROQ]: { ...this.health[GROQ] },
      [OPENROUTER]: { ...this.health[OPENROUTER] },
    };
  }

  private pause(provider: LLMProviderName, ms: number): void {
    this.health[provider].unavailableUntil = Date.now() + ms;
  }
}
