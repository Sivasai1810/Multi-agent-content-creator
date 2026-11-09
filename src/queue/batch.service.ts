import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { InvalidBatchError } from '../common/exceptions/queue.exception';
import { NewsQueueService } from './news-queue.service';
import { DEFAULT_JOB_PRIORITY, JOB_PRIORITIES, MAX_BATCH_SIZE, MAX_NEWS_CONTENT_LENGTH } from './queue.constants';
import {
  AcceptedNewsItem,
  BatchJobPayload,
  BatchJobResult,
  JobPriority,
  NewsItemInput,
  NewsJobRequest,
  RejectedNewsItem,
} from './queue.types';

// The rules for one news item. trim() removes spaces around the text.
const newsItemSchema = z.object(
  {
    content: z
      .string('content must be text')
      .trim()
      .min(1, 'content must not be empty')
      .max(MAX_NEWS_CONTENT_LENGTH, `content must be at most ${MAX_NEWS_CONTENT_LENGTH} characters`),
    sourceUrl: z
      .string('sourceUrl must be text')
      .trim()
      .url('sourceUrl must be a valid URL')
      .refine((url) => /^https?:\/\//i.test(url), 'sourceUrl must start with http:// or https://')
      .optional(),
  },
  'news item must be an object',
);

// Turns any text into a fixed-length ID.
// The same text always gives the same ID, and it never contains ':' (BullMQ does not allow it).
function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

// Splits one submission into independent jobs: 10 news items = 10 jobs = 10 workflows.
@Injectable()
export class BatchService {
  private readonly logger = new Logger(BatchService.name);

  constructor(private readonly newsQueue: NewsQueueService) {}

  async submitBatch(batch: BatchJobPayload): Promise<BatchJobResult> {
    this.checkBatch(batch);

    const idempotencyKey = batch.idempotencyKey?.trim();
    const priority: JobPriority = batch.priority || DEFAULT_JOB_PRIORITY;
    const submittedAt = new Date().toISOString();

    // With a key, the same submission always gets the same batch ID
    const batchId = idempotencyKey ? `batch-${hash(idempotencyKey)}` : `batch-${randomUUID()}`;

    const rejected: RejectedNewsItem[] = [];
    const requests: NewsJobRequest[] = [];
    const indexes: number[] = []; // the submitted position of each request

    batch.items.forEach((item, index) => {
      if (index >= MAX_BATCH_SIZE) {
        rejected.push({ index, reason: `batch can have at most ${MAX_BATCH_SIZE} items` });
        return;
      }

      const result = newsItemSchema.safeParse(item);

      // A bad item is rejected on its own. The other items carry on.
      if (!result.success) {
        const reason = result.error.issues.map((issue) => issue.message).join('; ');
        rejected.push({ index, reason });
        return;
      }

      const { newsId, workflowId } = this.createItemIds(result.data, idempotencyKey);

      // A new object per item, holding only this item's data
      requests.push({
        payload: {
          workflowId,
          batchId,
          newsId,
          content: result.data.content,
          sourceUrl: result.data.sourceUrl,
          submittedAt,
        },
        priority,
      });
      indexes.push(index);
    });

    // If Redis is down this throws QueueUnavailableError and nothing is accepted.
    // The same submission can then be sent again.
    const queued = await this.newsQueue.addNewsJobs(requests);

    const accepted: AcceptedNewsItem[] = queued.map((job, i) => ({
      index: indexes[i],
      jobId: job.jobId,
      newsId: requests[i].payload.newsId,
      workflowId: requests[i].payload.workflowId,
      isDuplicate: job.isDuplicate,
    }));

    this.logger.log(`Batch ${batchId}: ${accepted.length} accepted, ${rejected.length} rejected`);

    return {
      batchId,
      totalItems: batch.items.length,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      accepted,
      rejected,
      submittedAt,
    };
  }

  // Checks only the submission as a whole. Items are checked one by one later.
  private checkBatch(batch: BatchJobPayload): void {
    if (!batch || !Array.isArray(batch.items)) {
      throw new InvalidBatchError('items must be an array');
    }

    if (batch.priority !== undefined && !Object.keys(JOB_PRIORITIES).includes(batch.priority)) {
      throw new InvalidBatchError(`priority must be one of: ${Object.keys(JOB_PRIORITIES).join(', ')}`);
    }

    const key = batch.idempotencyKey;

    if (key !== undefined && (typeof key !== 'string' || key.trim() === '')) {
      throw new InvalidBatchError('idempotencyKey must be non-empty text');
    }
  }

  // With a key, the IDs come from the key and the item's content, so sending the
  // same item again gives the same IDs. The position is not used, so the order can change.
  // Without a key, every item gets new random IDs.
  private createItemIds(item: NewsItemInput, idempotencyKey?: string) {
    const suffix = idempotencyKey
      ? hash(JSON.stringify([idempotencyKey, item.content, item.sourceUrl]))
      : randomUUID();

    return { newsId: `news-${suffix}`, workflowId: `wf-${suffix}` };
  }
}
