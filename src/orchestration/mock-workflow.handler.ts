import { Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'timers/promises';

// The data one workflow run gets. It belongs to one news item only.
export interface WorkflowRunInput {
  readonly workflowId: string;
  readonly batchId: string;
  readonly newsId: string;
  readonly content: string;
  readonly sourceUrl?: string;
  readonly submittedAt: string;
  readonly attempt: number;
}

export interface WorkflowRunOptions {
  // Becomes "aborted" when the job times out. The workflow must stop when this happens,
  // and must pass it to every LLM call (LLMInput.signal) so the requests are cancelled too.
  signal: AbortSignal;
  onProgress: (percent: number) => Promise<void>;
}

// What the processor needs from a workflow. It knows nothing about agents.
export interface WorkflowHandler {
  run(input: WorkflowRunInput, options: WorkflowRunOptions): Promise<unknown>;
}

const MOCK_STEP_MS = 100;

// TEMPORARY: pretends to run the AI workflow until Phase 2 replaces it.
@Injectable()
export class MockWorkflowHandler implements WorkflowHandler {
  async run(input: WorkflowRunInput, options: WorkflowRunOptions): Promise<unknown> {
    await sleep(MOCK_STEP_MS, undefined, { signal: options.signal });
    await options.onProgress(60);

    await sleep(MOCK_STEP_MS, undefined, { signal: options.signal });

    return { mock: true, newsId: input.newsId, contentLength: input.content.length };
  }
}
