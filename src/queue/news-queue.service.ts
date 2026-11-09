import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import { QueueUnavailableError } from '../common/exceptions/queue.exception';
import {
  BATCH_INDEX_KEY_PREFIX,
  BATCH_INDEX_TTL,
  DEFAULT_JOB_PRIORITY,
  JOB_PRIORITIES,
  NEWS_QUEUE_NAME,
  PROCESS_NEWS_JOB_NAME,
  QUEUE_AVAILABILITY_TIMEOUT,
  QUEUE_OPERATION_TIMEOUT,
} from './queue.constants';
import {
  BatchProgress,
  NewsJobPayload,
  NewsJobRequest,
  NewsJobResult,
  NewsJobStatus,
  QueuedNewsJob,
} from './queue.types';

// Converts a BullMQ job state into our own status
function toNewsJobStatus(state: string): NewsJobStatus {
  switch (state) {
    case 'active':
    case 'delayed':
    case 'completed':
    case 'failed':
      return state;
    case 'unknown':
      return 'not_found';
    default:
      // 'waiting' and 'prioritized' both mean no worker has taken the job yet
      return 'waiting';
  }
}

function batchIndexKey(batchId: string): string {
  return `${BATCH_INDEX_KEY_PREFIX}:${batchId}:jobs`;
}

// The only place in the app that talks to the news queue.
// It adds jobs and reads their status. It does not process jobs.
@Injectable()
export class NewsQueueService implements OnModuleInit {
  private readonly logger = new Logger(NewsQueueService.name);

  constructor(
    @InjectQueue(NEWS_QUEUE_NAME)
    private readonly queue: Queue<NewsJobPayload, NewsJobResult>,
  ) {}

  onModuleInit() {
    // Without this listener, Redis connection problems are silent
    this.queue.on('error', (error) => {
      this.logger.error(`Queue or Redis error: ${error.message}`);
    });
  }

  // Adds one independent news job
  async addNewsJob(request: NewsJobRequest): Promise<QueuedNewsJob> {
    const results = await this.addNewsJobs([request]);
    return results[0];
  }

  // Adds many independent jobs in one bulk insert: one job per news item, never one batch job.
  // Results are in the same order as the requests.
  async addNewsJobs(requests: NewsJobRequest[]): Promise<QueuedNewsJob[]> {
    if (requests.length === 0) {
      return [];
    }

    return this.runWhenAvailable('add news jobs', async () => {
      const jobIds = requests.map((request) => request.jobId || request.payload.newsId);

      // BullMQ never creates a second job with the same ID.
      // This check is only there so we can tell the caller it was a duplicate.
      const states = await Promise.all(jobIds.map((jobId) => this.queue.getJobState(jobId)));

      const seenJobIds = new Set<string>();
      const results: QueuedNewsJob[] = [];
      const newJobs = [];

      for (let i = 0; i < requests.length; i++) {
        const request = requests[i];
        const jobId = jobIds[i];
        const isDuplicate = states[i] !== 'unknown' || seenJobIds.has(jobId);

        seenJobIds.add(jobId);
        results.push({ jobId, isDuplicate });

        if (!isDuplicate) {
          newJobs.push({
            name: PROCESS_NEWS_JOB_NAME,
            data: request.payload,
            opts: {
              jobId,
              priority: JOB_PRIORITIES[request.priority || DEFAULT_JOB_PRIORITY],
            },
          });
        }
      }

      // The index is written first. If adding the jobs then fails, progress shows
      // them as not_found, which is better than jobs that no batch knows about.
      await this.addToBatchIndex(requests, jobIds);

      if (newJobs.length > 0) {
        await this.queue.addBulk(newJobs);
      }

      this.logger.log(`Added ${newJobs.length} new jobs, ${requests.length - newJobs.length} duplicates skipped`);

      return results;
    });
  }

  // Returns the job, or null if there is no job with this ID
  async getJob(jobId: string): Promise<Job<NewsJobPayload, NewsJobResult> | null> {
    return this.runWhenAvailable('get a job', async () => {
      const job = await this.queue.getJob(jobId);
      return job || null;
    });
  }

  async getJobStatus(jobId: string): Promise<NewsJobStatus> {
    return this.runWhenAvailable('get a job status', async () => {
      return toNewsJobStatus(await this.queue.getJobState(jobId));
    });
  }

  // Reads only this batch's job IDs from the index. It never scans all jobs in Redis.
  async getBatchProgress(batchId: string): Promise<BatchProgress> {
    return this.runWhenAvailable('get batch progress', async () => {
      const client = await this.getRedisClient();
      const jobIds = await client.smembers(batchIndexKey(batchId));
      const states = await Promise.all(jobIds.map((jobId) => this.queue.getJobState(jobId)));

      const counts: Record<NewsJobStatus, number> = {
        waiting: 0,
        active: 0,
        delayed: 0,
        completed: 0,
        failed: 0,
        not_found: 0,
      };

      for (const state of states) {
        counts[toNewsJobStatus(state)]++;
      }

      const unfinished = counts.waiting + counts.active + counts.delayed;

      return {
        batchId,
        total: jobIds.length,
        counts,
        isFinished: jobIds.length > 0 && unfinished === 0,
      };
    });
  }

  // Returns true if Redis answers within the time limit. It never throws.
  async checkQueueAvailability(timeoutMs: number = QUEUE_AVAILABILITY_TIMEOUT): Promise<boolean> {
    try {
      return await this.withTimeout(this.pingRedis(), timeoutMs, 'reach Redis');
    } catch {
      return false;
    }
  }

  // Uses the queue's own connection, so no extra Redis connection is opened.
  // BullMQ's type for it is small, but the real object is an ioredis client.
  private async getRedisClient(): Promise<Redis> {
    return (await this.queue.client) as unknown as Redis;
  }

  private async pingRedis(): Promise<boolean> {
    const client = await this.getRedisClient();

    // If the connection is down, a ping would wait in memory until Redis comes back
    if (client.status !== 'ready') {
      return false;
    }

    return (await client.ping()) === 'PONG';
  }

  private async addToBatchIndex(requests: NewsJobRequest[], jobIds: string[]): Promise<void> {
    const client = await this.getRedisClient();
    const transaction = client.multi();

    for (let i = 0; i < requests.length; i++) {
      const key = batchIndexKey(requests[i].payload.batchId);
      transaction.sadd(key, jobIds[i]);
      transaction.expire(key, BATCH_INDEX_TTL);
    }

    const results = await transaction.exec();
    const failed = results?.find(([error]) => error);

    if (failed) {
      throw failed[0];
    }
  }

  // Every queue operation goes through here, so nothing can wait forever during a
  // Redis outage, and a submission is never accepted while Redis is down.
  private async runWhenAvailable<T>(action: string, operation: () => Promise<T>): Promise<T> {
    const isAvailable = await this.checkQueueAvailability();

    if (!isAvailable) {
      throw new QueueUnavailableError(`Cannot ${action}: Redis is not available`);
    }

    return this.withTimeout(operation(), QUEUE_OPERATION_TIMEOUT, action);
  }

  // Note: this stops the waiting, not the work. If Redis comes back, a timed-out add
  // can still finish. Trying again with the same job IDs is safe, it makes no duplicates.
  private async withTimeout<T>(work: Promise<T>, timeoutMs: number, action: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new QueueUnavailableError(`Timed out after ${timeoutMs}ms trying to ${action}`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
