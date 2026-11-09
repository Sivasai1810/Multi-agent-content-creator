import { RETRYABLE_ERRORS } from '../common/exceptions/llm.exception';
import { JobPriority } from './queue.types';

// The default values for the queue.
// configuration.ts uses these as defaults, and the .env file can override them.
// Always read these settings from ConfigService, so there is one source of truth.

// Queue name. Always use this constant, never type the name again.
export const NEWS_QUEUE_NAME = 'news-processing';

// Job name for processing ONE news item.
// There is no batch job name on purpose: a batch never becomes a processing job.
export const PROCESS_NEWS_JOB_NAME = 'process-news';

// ---------- Retry ----------

export const DEFAULT_MAX_ATTEMPTS = 3; // 1 first try + 2 retries

// Our own backoff type, calculated in news.processor.ts. It is exponential (30 seconds,
// then 60 seconds), but never shorter than the wait time a provider asked for.
export const BACKOFF_TYPE = 'exponential-with-provider-delay';
export const DEFAULT_BACKOFF_DELAY = 30000;

// Jobs are retried only for temporary failures: rate limit, timeout, network, provider 5xx.
// Every other error is permanent (for example invalid input or a wrong API key).
// This is the same list the LLM layer uses, so the two can never disagree.
export const RETRYABLE_JOB_ERRORS = RETRYABLE_ERRORS;

// ---------- Timeout ----------

export const DEFAULT_JOB_TIMEOUT = 300000; // 5 minutes, in ms

// After a timeout, how long the workflow gets to stop before we log that it did not, in ms
export const JOB_CANCEL_GRACE_PERIOD = 5000;

// Job progress in percent at each stage
export const JOB_PROGRESS = {
  VALIDATED: 10,
  CONTEXT_CREATED: 20,
  WORKFLOW_STARTED: 30,
  FINISHED: 100,
};

// ---------- Worker ----------

// How many jobs one worker processes at the same time.
// This is not the same as the provider requests-per-minute limit:
// concurrency = how many at once, requests per minute = how often.
export const DEFAULT_WORKER_CONCURRENCY = 2;

// ---------- Redis connection ----------

// When Redis is down, wait a little longer before each reconnect try:
// 1 second, 2 seconds, 3 seconds... but never more than 30 seconds.
export const REDIS_RETRY_STEP = 1000;
export const REDIS_MAX_RETRY_DELAY = 30000;

// ---------- Job retention ----------

// BullMQ reads age in SECONDS (most other values in this project are in ms)
const ONE_DAY_IN_SECONDS = 24 * 60 * 60;

// A job is removed when it is too old OR when there are too many jobs.
// Both limits together stop Redis memory from growing forever.
export const COMPLETED_JOB_RETENTION = {
  age: ONE_DAY_IN_SECONDS, // keep for 24 hours
  count: 1000, // keep at most the newest 1000
};

// Failed jobs are kept longer for debugging
export const FAILED_JOB_RETENTION = {
  age: 7 * ONE_DAY_IN_SECONDS, // keep for 7 days
  count: 5000, // keep at most the newest 5000
};

// ---------- Batch index ----------

// For each batch, Redis keeps a small set of its job IDs under this key prefix.
// Batch progress reads this set, so it never has to scan every job.
export const BATCH_INDEX_KEY_PREFIX = 'news-batch';

// The index lives as long as the longest job retention. The value is in seconds.
export const BATCH_INDEX_TTL = FAILED_JOB_RETENTION.age;

// ---------- Waiting limits ----------

// Longest wait for Redis to answer a health check, in ms
export const QUEUE_AVAILABILITY_TIMEOUT = 2000;

// Longest wait for a queue operation, in ms
export const QUEUE_OPERATION_TIMEOUT = 5000;

// ---------- Batch limits ----------

export const MAX_BATCH_SIZE = 100; // items after this are rejected one by one
export const MAX_NEWS_CONTENT_LENGTH = 20000; // characters in one news item

// ---------- Priority ----------

// In BullMQ, a SMALLER number means a HIGHER priority
export const JOB_PRIORITIES: Record<JobPriority, number> = {
  high: 1,
  normal: 5,
  low: 10,
};

export const DEFAULT_JOB_PRIORITY: JobPriority = 'normal';
