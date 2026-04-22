// Background worker. Polls the SQLite queue; dispatches jobs to role
// handlers. One job at a time in a single process — simple and sufficient
// for POC throughput.

import { SqliteQueue } from './queue/sqlite';
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

const queue = new SqliteQueue(config.queuePath);

async function runOne(job: Job): Promise<void> {
  console.log(
    JSON.stringify({
      level: 'info',
      run: job.id,
      event: 'claim',
      kind: job.kind,
    }),
  );
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
    queue.markDone(job.id);
    console.log(JSON.stringify({ level: 'info', run: job.id, event: 'done' }));
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    queue.markFailed(job.id, msg);
    console.error(
      JSON.stringify({ level: 'error', run: job.id, event: 'failed', error: msg }),
    );
  }
}

export function startWorker(): void {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const job = queue.claimNext();
    if (job) {
      await runOne(job);
      setImmediate(tick);
    } else {
      setTimeout(tick, config.pollIntervalMs);
    }
  };

  setImmediate(tick);

  process.on('SIGTERM', () => {
    stopped = true;
    queue.close();
  });
  process.on('SIGINT', () => {
    stopped = true;
    queue.close();
  });

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'worker_started',
      queuePath: config.queuePath,
      pollIntervalMs: config.pollIntervalMs,
    }),
  );
}

export { queue };
