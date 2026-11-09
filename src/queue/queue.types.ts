// Contracts for the news queue.
// Main rule: 10 news items = 10 independent jobs = 10 independent workflows.

// How urgent a job is
export type JobPriority = 'high' | 'normal' | 'low';

// Where a news job is right now
export type NewsJobStatus =
  | 'waiting' // in the queue, no worker has taken it yet
  | 'active' // a worker is processing it
  | 'delayed' // waiting for a retry (for example after a rate limit)
  | 'completed'
  | 'failed' // all attempts are used, or a permanent error happened
  | 'not_found'; // no job with this ID

// One news item as the user submits it (for example from Telegram)
export interface NewsItemInput {
  content: string;
  sourceUrl?: string;
}

// The data of ONE job. It holds one news item only.
// Never put another news item's context in here.
// readonly: a worker can read this data but cannot change it.
export interface NewsJobPayload {
  readonly workflowId: string;
  readonly batchId: string; // shared by all news submitted together
  readonly newsId: string; // unique for every news item
  readonly content: string;
  readonly sourceUrl?: string;
  readonly submittedAt: string; // ISO date, like 2026-11-08T10:30:00.000Z
}

// Job details used in logs and tracing. This is separate from the news data.
export interface NewsJobMetadata {
  jobId: string;
  workflowId: string;
  batchId: string;
  newsId: string;
  priority: JobPriority;
  attempt: number; // 1 for the first try, 2 for the first retry
  maxAttempts: number;
}

// What a worker returns when a job finishes successfully.
// A failed job throws an error instead of returning this.
export interface NewsJobResult {
  workflowId: string;
  batchId: string;
  newsId: string;
  completedAt: string; // ISO date
  durationMs: number;
  output?: unknown; // the workflow's result, its real type comes in Phase 2
}

// A submission of many news items.
// This goes to the batch service only. It is never one queue job:
// the batch service splits it into one NewsJobPayload per item.
export interface BatchJobPayload {
  items: NewsItemInput[];
  idempotencyKey?: string; // the same key means the same submission, so no duplicate jobs
  priority?: JobPriority; // 'normal' if not set
}

// A news item that was accepted and added to the queue
export interface AcceptedNewsItem {
  index: number; // position in the submitted items array
  jobId: string;
  newsId: string;
  workflowId: string;
  isDuplicate: boolean; // true if this item was already queued by an earlier submission
}

// A news item that failed validation. The other items are not affected.
export interface RejectedNewsItem {
  index: number; // position in the submitted items array
  reason: string;
}

// What the batch service returns after a submission
export interface BatchJobResult {
  batchId: string;
  totalItems: number;
  acceptedCount: number;
  rejectedCount: number;
  accepted: AcceptedNewsItem[];
  rejected: RejectedNewsItem[];
  submittedAt: string; // ISO date
}

// One job to add to the queue
export interface NewsJobRequest {
  payload: NewsJobPayload;
  jobId?: string; // stable ID for duplicate prevention. Uses newsId if not set. Must not contain ':'
  priority?: JobPriority; // 'normal' if not set
}

// What we get back after adding a job
export interface QueuedNewsJob {
  jobId: string;
  isDuplicate: boolean; // true if a job with this ID already existed, so nothing new was added
}

// How far a batch has come
export interface BatchProgress {
  batchId: string;
  total: number; // 0 means no batch with this ID is known
  counts: Record<NewsJobStatus, number>; // how many jobs are in each status
  isFinished: boolean; // true when no job is waiting, active or delayed
}
