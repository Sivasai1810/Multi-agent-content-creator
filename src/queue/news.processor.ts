import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, MinimalJob, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { LLMError } from '../common/exceptions/llm.exception';
import { JobTimeoutError } from '../common/exceptions/queue.exception';
import { MockWorkflowHandler, WorkflowRunInput } from '../orchestration/mock-workflow.handler';
import {
  DEFAULT_BACKOFF_DELAY,
  JOB_CANCEL_GRACE_PERIOD,
  JOB_PROGRESS,
  NEWS_QUEUE_NAME,
  RETRYABLE_JOB_ERRORS,
} from './queue.constants';
import { NewsJobPayload, NewsJobResult } from './queue.types';

const newsJobPayloadSchema = z.object({
  workflowId: z.string().min(1),
  batchId: z.string().min(1),
  newsId: z.string().min(1),
  content: z.string().trim().min(1),
  sourceUrl: z.string().optional(),
  submittedAt: z.string().min(1),
});

const TIMED_OUT = Symbol('timed out');

interface JobErrorDecision {
  retryable: boolean;
  retryAfterMs?: number; // only set when a provider told us how long to wait
}

// A provider failure that can go away by itself.
// A paused provider has a wait time and no HTTP status, because it was skipped and never called.
function isTemporaryFailure(failure: LLMError): boolean {
  const isPaused =
    failure.type === 'MODEL_UNAVAILABLE' &&
    failure.statusCode === undefined &&
    failure.retryAfterMs !== undefined;

  return RETRYABLE_JOB_ERRORS.includes(failure.type) || isPaused;
}

// Decides if a failed job should be tried again
export function classifyJobError(error: unknown): JobErrorDecision {
  if (error instanceof JobTimeoutError) {
    return { retryable: true };
  }

  // Bugs and unknown errors will fail the same way again
  if (!(error instanceof LLMError)) {
    return { retryable: false };
  }

  if (error.type === 'ALL_PROVIDERS_FAILED') {
    const temporary = error.failures.filter(isTemporaryFailure);

    // Every provider failed for a permanent reason
    if (temporary.length === 0) {
      return { retryable: false };
    }

    // If one temporary provider gave no wait time, it may work soon, so the normal backoff is used.
    // Otherwise wait for the provider that is ready first.
    const waitTimes = temporary.map((failure) => failure.retryAfterMs);
    const allHaveWaitTime = waitTimes.every((ms) => ms !== undefined);

    return {
      retryable: true,
      retryAfterMs: allHaveWaitTime ? Math.min(...(waitTimes as number[])) : undefined,
    };
  }

  return {
    retryable: RETRYABLE_JOB_ERRORS.includes(error.type),
    retryAfterMs: error.retryAfterMs,
  };
}

// BullMQ calls this to know how long a job waits before its next try.
// Exponential backoff, but never shorter than the wait a provider asked for.
export function calculateRetryDelay(
  attemptsMade: number,
  _type?: string,
  error?: Error,
  job?: MinimalJob,
): number {
  const backoff = job?.opts?.backoff;
  const baseDelay = typeof backoff === 'object' && backoff.delay ? backoff.delay : DEFAULT_BACKOFF_DELAY;
  const backoffDelay = Math.pow(2, attemptsMade - 1) * baseDelay;

  return Math.max(backoffDelay, classifyJobError(error).retryAfterMs || 0);
}

function describeError(error: unknown): string {
  if (error instanceof LLMError) {
    const failures = error.failures.map((failure) => `${failure.provider}:${failure.type}`).join(',');
    return `type=${error.type} message="${error.message}"${failures ? ` failures=${failures}` : ''}`;
  }

  if (error instanceof Error) {
    return `type=${error.name} message="${error.message}"`;
  }

  return `type=unknown message="${String(error)}"`;
}

// Runs one news job at a time. BullMQ handles retries and delays, and the workflow
// handler does the actual work. autorun is off so concurrency can be set from config first.
@Processor(NEWS_QUEUE_NAME, {
  autorun: false,
  settings: { backoffStrategy: calculateRetryDelay },
})
export class NewsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(NewsProcessor.name);
  private readonly jobTimeout: number;
  private readonly concurrency: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly workflowHandler: MockWorkflowHandler,
  ) {
    super();
    this.jobTimeout = this.configService.getOrThrow<number>('queue.jobTimeout');
    this.concurrency = this.configService.getOrThrow<number>('queue.concurrency');
  }

  onApplicationBootstrap() {
    this.worker.on('error', (error) => {
      this.logger.error(`Worker or Redis error: ${error.message}`);
    });

    this.worker.concurrency = this.concurrency;

    // run() only finishes when the worker closes, so it is not awaited
    this.worker.run().catch((error) => {
      this.logger.error(`Worker stopped: ${error.message}`);
    });
  }

  async process(job: Job<NewsJobPayload, NewsJobResult>): Promise<NewsJobResult> {
    const startTime = Date.now();
    this.logger.log(`${this.logPrefix(job)} status=started`);

    try {
      const payload = this.validatePayload(job.data);
      await this.updateProgress(job, JOB_PROGRESS.VALIDATED);

      // A new read-only object for every run, so one job can never touch another job's data
      const input: WorkflowRunInput = Object.freeze({ ...payload, attempt: job.attemptsMade + 1 });
      await this.updateProgress(job, JOB_PROGRESS.CONTEXT_CREATED);

      await this.updateProgress(job, JOB_PROGRESS.WORKFLOW_STARTED);
      const output = await this.runWorkflow(job, input);
      await this.updateProgress(job, JOB_PROGRESS.FINISHED);

      const durationMs = Date.now() - startTime;
      this.logger.log(`${this.logPrefix(job)} status=completed durationMs=${durationMs}`);

      return {
        workflowId: payload.workflowId,
        batchId: payload.batchId,
        newsId: payload.newsId,
        completedAt: new Date().toISOString(),
        durationMs,
        output,
      };
    } catch (error) {
      throw this.handleFailure(job, error, Date.now() - startTime);
    }
  }

  private validatePayload(data: NewsJobPayload): NewsJobPayload {
    const result = newsJobPayloadSchema.safeParse(data);

    if (!result.success) {
      const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      throw new LLMError('INVALID_REQUEST', `Invalid job payload: ${problems.join('; ')}`);
    }

    return result.data;
  }

  // Runs the workflow with a time limit.
  // On timeout the signal cancels the real work, including running LLM requests.
  // The race only makes sure the job still ends if a workflow ignores the signal.
  private async runWorkflow(job: Job<NewsJobPayload, NewsJobResult>, input: WorkflowRunInput): Promise<unknown> {
    const controller = new AbortController();

    const work = this.workflowHandler.run(input, {
      signal: controller.signal,
      onProgress: async (percent) => {
        if (!controller.signal.aborted) {
          await this.updateProgress(job, percent);
        }
      },
    });

    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), this.jobTimeout);
    });

    let outcome: unknown;

    try {
      outcome = await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }

    if (outcome !== TIMED_OUT) {
      return outcome;
    }

    controller.abort();

    if (!(await this.stopsInTime(work))) {
      this.logger.error(`${this.logPrefix(job)} workflow did not stop after the timeout and may still be running`);
    }

    throw new JobTimeoutError(`Job timed out after ${this.jobTimeout}ms`);
  }

  // Gives a cancelled workflow a short time to finish stopping
  private async stopsInTime(work: Promise<unknown>): Promise<boolean> {
    const stopped = work.then(
      () => true,
      () => true,
    );

    let timer: NodeJS.Timeout | undefined;

    const gracePeriod = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), JOB_CANCEL_GRACE_PERIOD);
    });

    try {
      return await Promise.race([stopped, gracePeriod]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Logs the failure and returns the error BullMQ should get.
  // UnrecoverableError tells BullMQ not to retry. Any other error uses a delayed retry.
  private handleFailure(job: Job<NewsJobPayload, NewsJobResult>, error: unknown, durationMs: number): Error {
    const decision = classifyJobError(error);
    const details = describeError(error);
    const maxAttempts = job.opts.attempts || 1;

    if (!decision.retryable) {
      this.logger.error(`${this.logPrefix(job)} status=failed_permanent durationMs=${durationMs} ${details}`);
      const message = error instanceof Error ? error.message : String(error);
      return new UnrecoverableError(message);
    }

    const status = job.attemptsMade + 1 < maxAttempts ? 'will_retry' : 'failed_attempts_used';
    this.logger.warn(
      `${this.logPrefix(job)} status=${status} durationMs=${durationMs} ` +
        `retryAfterMs=${decision.retryAfterMs ?? 'backoff'} ${details}`,
    );

    return error as Error;
  }

  // A failed progress update must not fail the news item
  private async updateProgress(job: Job<NewsJobPayload, NewsJobResult>, percent: number): Promise<void> {
    try {
      await job.updateProgress(percent);
    } catch (error) {
      this.logger.warn(`${this.logPrefix(job)} could not update progress: ${describeError(error)}`);
    }
  }

  private logPrefix(job: Job<NewsJobPayload, NewsJobResult>): string {
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts || 1;

    return (
      `job=${job.id} workflow=${job.data?.workflowId} news=${job.data?.newsId} ` +
      `batch=${job.data?.batchId} attempt=${attempt}/${maxAttempts}`
    );
  }
}
