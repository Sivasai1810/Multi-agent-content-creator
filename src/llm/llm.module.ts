import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LLMRouterService } from './llm-router.service';
import { ProviderHealthService } from './provider-health.service';
import { GeminiProvider } from './providers/gemini.provider';
import { GroqProvider } from './providers/groq.provider';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { RateLimiterService } from './rate-limiter.service';

// Agents import this module and inject LLMRouterService.
// They never need to know which provider answered.
@Module({
  imports: [ConfigModule],
  providers: [
    GeminiProvider,
    GroqProvider,
    OpenRouterProvider,
    RateLimiterService,
    ProviderHealthService,
    LLMRouterService,
  ],
  // ProviderHealthService is exported so other modules can read provider status
  exports: [LLMRouterService, ProviderHealthService],
})
export class LLMModule {}
