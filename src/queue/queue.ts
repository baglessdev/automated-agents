import type { Job, JobKind } from '../types';

export interface Queue {
  enqueue(kind: JobKind, payload: Job['payload']): Job;
  claimNext(): Job | null;
  markDone(id: string): void;
  markFailed(id: string, error: string): void;
  close(): void;
}
