// Thrown when a job runs longer than the configured job timeout
export class JobTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobTimeoutError';
  }
}

// Thrown when the submission as a whole is wrong (for example items is not an array).
// A single bad news item does not throw this. It is only rejected on its own.
export class InvalidBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBatchError';
  }
}

// Thrown when Redis or the queue cannot be reached in time.
// The caller must treat the submission as NOT accepted and can safely try again
// with the same job IDs, because the same ID never creates a second job.
export class QueueUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueUnavailableError';
  }
}
