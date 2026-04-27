import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Job, JobKind, JobPayload } from '../types';
import type { Queue } from './queue';

interface SqsQueueOptions {
  queueUrl: string;
  region: string;
  visibilityTimeoutSec: number;
  waitTimeSec: number;
  endpoint?: string;
}

interface MessageBody {
  id: string;
  kind: JobKind;
  payload: JobPayload;
  createdAt: number;
}

// FIFO queue requires both MessageGroupId (for ordering) and either
// contentBasedDeduplication or an explicit MessageDeduplicationId.
// We pass MessageDeduplicationId from main.ts (x-github-delivery), so the
// queue is provisioned with contentBasedDeduplication=false.
export class SqsQueue implements Queue {
  private client: SQSClient;
  private queueUrl: string;
  private visibilityTimeoutSec: number;
  private waitTimeSec: number;
  // job.id → SQS receipt handle. Receipt handles change every receive,
  // so this map is the only way for markDone/markFailed/heartbeat to
  // reach the right message after claimNext returns.
  private receipts = new Map<string, string>();

  constructor(opts: SqsQueueOptions) {
    this.client = new SQSClient({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    });
    this.queueUrl = opts.queueUrl;
    this.visibilityTimeoutSec = opts.visibilityTimeoutSec;
    this.waitTimeSec = opts.waitTimeSec;
  }

  async enqueue(
    kind: JobKind,
    payload: JobPayload,
    dedupKey?: string,
  ): Promise<Job> {
    const job: Job = {
      id: randomUUID(),
      kind,
      payload,
      status: 'pending',
      createdAt: Date.now(),
    };
    const body: MessageBody = {
      id: job.id,
      kind: job.kind,
      payload: job.payload,
      createdAt: job.createdAt,
    };
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(body),
        MessageGroupId: payload.repo,
        MessageDeduplicationId: dedupKey ?? job.id,
      }),
    );
    return job;
  }

  async claimNext(): Promise<Job | null> {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.waitTimeSec,
        VisibilityTimeout: this.visibilityTimeoutSec,
      }),
    );
    const msg = res.Messages?.[0];
    if (!msg || !msg.Body || !msg.ReceiptHandle) return null;

    let body: MessageBody;
    try {
      body = JSON.parse(msg.Body) as MessageBody;
    } catch (err) {
      // Malformed body — delete so it can't crash-loop. The receive
      // count will eventually push it to the DLQ if we leave it, but a
      // parse error is unrecoverable so we drop it now and log loudly.
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'queue_parse_failed',
          messageId: msg.MessageId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        }),
      );
      return null;
    }

    this.receipts.set(body.id, msg.ReceiptHandle);
    return {
      id: body.id,
      kind: body.kind,
      payload: body.payload,
      status: 'running',
      createdAt: body.createdAt,
      startedAt: Date.now(),
    };
  }

  async markDone(id: string): Promise<void> {
    const handle = this.receipts.get(id);
    if (!handle) return;
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: handle,
      }),
    );
    this.receipts.delete(id);
  }

  async markFailed(id: string, error: string): Promise<void> {
    // Per the migration plan: logic failures delete immediately; only
    // crashes (visibility-timeout expiry) get one redelivery via the
    // DLQ's redrive policy. Log the error so journalctl preserves it.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'job_failed',
        jobId: id,
        error,
      }),
    );
    const handle = this.receipts.get(id);
    if (!handle) return;
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: handle,
      }),
    );
    this.receipts.delete(id);
  }

  async heartbeat(id: string, extendSeconds: number): Promise<void> {
    const handle = this.receipts.get(id);
    if (!handle) return;
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: handle,
        VisibilityTimeout: extendSeconds,
      }),
    );
  }

  async close(): Promise<void> {
    this.receipts.clear();
    this.client.destroy();
  }
}
