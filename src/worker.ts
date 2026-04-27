// Background worker. Long-polls the SQS queue; dispatches jobs to role
// handlers. One job at a time in a single process — simple and sufficient
// for POC throughput.

import { SqsQueue } from './queue/sqs';
import { runArchitect } from './roles/architect';
import { runCoder } from './roles/coder';
import { runCoderIterate } from './roles/coder-iterate';
import { runReviewer } from './roles/reviewer';
import { config } from './config';
import type {
  ArchitectPayload,
  CoderPayload,
  IteratePayload,
  Job,
  ReviewerPayload,
} from './types';

const queue = new SqsQueue({
  queueUrl: config.sqsQueueUrl,
  region: config.awsRegion,
  visibilityTimeoutSec: config.sqsVisibilityTimeoutSeconds,
  waitTimeSec: config.sqsWaitTimeSeconds,
  endpoint: config.sqsEndpoint,
});

async function runOne(job: Job): Promise<void> {
  console.log(
    JSON.stringify({
      level: 'info',
      run: job.id,
      event: 'claim',
      kind: job.kind,
    }),
  );
  // Heartbeat: extend the SQS visibility timeout while the job runs so
  // the message doesn't redeliver under us mid-flight. Cleared in finally.
  const hb = setInterval(() => {
    queue.heartbeat(job.id, config.sqsVisibilityTimeoutSeconds).catch(() => {
      // Heartbeat errors are non-fatal; if the receipt handle has expired
      // the visibility timeout itself will let SQS redeliver, which is
      // the recovery path we want.
    });
  }, config.sqsHeartbeatIntervalMs);
  try {
    switch (job.kind) {
      case 'architect':
        await runArchitect(job as Job & { payload: ArchitectPayload });
        break;
      case 'coder':
        await runCoder(job as Job & { payload: CoderPayload });
        break;
      case 'coder_iterate':
        await runCoderIterate(job as Job & { payload: IteratePayload });
        break;
      case 'reviewer':
        await runReviewer(job as Job & { payload: ReviewerPayload });
        break;
      default: {
        const _exhaust: never = job.kind;
        throw new Error(`unknown job kind: ${_exhaust}`);
      }
    }
    await queue.markDone(job.id);
    console.log(JSON.stringify({ level: 'info', run: job.id, event: 'done' }));
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    await queue.markFailed(job.id, msg);
    console.error(
      JSON.stringify({ level: 'error', run: job.id, event: 'failed', error: msg }),
    );
  } finally {
    clearInterval(hb);
  }
}

export function startWorker(): void {
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const job = await queue.claimNext();
    if (job) {
      inFlight = runOne(job).finally(() => {
        inFlight = null;
      });
      await inFlight;
    }
    setImmediate(tick);
  };

  setImmediate(tick);

  const onSignal = async (): Promise<void> => {
    stopped = true;
    if (inFlight) {
      // Wait for the in-flight job, capped at 60s so a wedged job
      // can't block deploys indefinitely. Combined with SQS's
      // visibility-timeout redelivery, a wedged job that exceeds the
      // cap will be reclaimed by the next worker.
      try {
        await Promise.race([
          inFlight,
          new Promise((resolve) => setTimeout(resolve, 60_000)),
        ]);
      } catch {
        // ignore; runOne already logs failures
      }
    }
    await queue.close();
    process.exit(0);
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'worker_started',
      queueUrl: config.sqsQueueUrl,
      region: config.awsRegion,
      visibilityTimeoutSec: config.sqsVisibilityTimeoutSeconds,
      waitTimeSec: config.sqsWaitTimeSeconds,
    }),
  );
}

export { queue };
