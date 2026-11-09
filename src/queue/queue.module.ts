import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MockWorkflowHandler } from '../orchestration/mock-workflow.handler';
import { BatchService } from './batch.service';
import { NewsQueueService } from './news-queue.service';
import { NewsProcessor } from './news.processor';
import {
  BACKOFF_TYPE,
  COMPLETED_JOB_RETENTION,
  FAILED_JOB_RETENTION,
  NEWS_QUEUE_NAME,
  REDIS_MAX_RETRY_DELAY,
  REDIS_RETRY_STEP,
} from './queue.constants';

// Builds the Redis connection from the existing redis settings in configuration.ts
function buildRedisConnection(configService: ConfigService) {
  return {
    host: configService.getOrThrow<string>('redis.host'),
    port: configService.getOrThrow<number>('redis.port'),
    password: configService.get<string>('redis.password'),

    // An empty object turns TLS on with the normal settings
    tls: configService.get<boolean>('redis.tls') ? {} : undefined,

    // BullMQ workers need this to be null
    maxRetriesPerRequest: null,

    // Called each time the connection is lost. Returns how many ms to wait before trying again.
    retryStrategy: (times: number) => Math.min(times * REDIS_RETRY_STEP, REDIS_MAX_RETRY_DELAY),
  };
}

// Connects the app to Redis through BullMQ and registers the news queue.
// Jobs use the defaultJobOptions below unless a single job sets its own options.
//
// Shutdown: BullMQ creates these Redis connections itself, and BullModule closes
// the queue when the app stops. main.ts turns this on with enableShutdownHooks().
@Module({
  imports: [
    ConfigModule,

    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: buildRedisConnection(configService),
        defaultJobOptions: {
          attempts: configService.getOrThrow<number>('queue.maxAttempts'),
          backoff: {
            type: BACKOFF_TYPE,
            delay: configService.getOrThrow<number>('queue.backoffDelay'),
          },
          removeOnComplete: COMPLETED_JOB_RETENTION,
          removeOnFail: FAILED_JOB_RETENTION,
        },
      }),
    }),

    BullModule.registerQueue({ name: NEWS_QUEUE_NAME }),
  ],

  providers: [NewsQueueService, BatchService, NewsProcessor, MockWorkflowHandler],

  exports: [BullModule, NewsQueueService, BatchService],
})
export class QueueModule {}
