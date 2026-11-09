import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GEMINI, GROQ, OPENROUTER } from '../config/constants';
import { LLMProviderName } from './llm.types';

const ONE_MINUTE = 60 * 1000;

// Our own requests-per-minute limit for each provider.
// It stops us from sending more requests than the provider allows,
// so we skip a busy provider BEFORE it answers with 429.
// Note: the counts are kept in memory, so each running app process has its own count.
@Injectable()
export class RateLimiterService {
  private limits: Record<LLMProviderName, number>;

  // Times (in ms) of the requests sent in the last minute
  private requestTimes: Record<LLMProviderName, number[]> = {
    [GEMINI]: [],
    [GROQ]: [],
    [OPENROUTER]: [],
  };

  constructor(private readonly configService: ConfigService) {
    // 0 or missing means no limit
    this.limits = {
      [GEMINI]: this.configService.get<number>('gemini.requestsPerMinute') || 0,
      [GROQ]: this.configService.get<number>('groq.requestsPerMinute') || 0,
      [OPENROUTER]: this.configService.get<number>('openrouter.requestsPerMinute') || 0,
    };
  }

  // Returns true and counts the request if the provider is under its limit.
  // Returns false if the limit is reached.
  tryAcquire(provider: LLMProviderName): boolean {
    const limit = this.limits[provider];

    if (!limit) {
      return true;
    }

    this.removeOldRequests(provider);

    if (this.requestTimes[provider].length >= limit) {
      return false;
    }

    this.requestTimes[provider].push(Date.now());
    return true;
  }

  // How many ms until the provider allows a new request. 0 means now.
  getWaitTime(provider: LLMProviderName): number {
    const limit = this.limits[provider];

    if (!limit) {
      return 0;
    }

    this.removeOldRequests(provider);
    const times = this.requestTimes[provider];

    if (times.length < limit) {
      return 0;
    }

    // The oldest request leaves the one-minute window first
    return times[0] + ONE_MINUTE - Date.now();
  }

  private removeOldRequests(provider: LLMProviderName): void {
    const oneMinuteAgo = Date.now() - ONE_MINUTE;
    this.requestTimes[provider] = this.requestTimes[provider].filter((time) => time > oneMinuteAgo);
  }
}
