import type { Job, JobKind, JobPayload } from '../types';

export interface Queue {
  enqueue(kind: JobKind, payload: JobPayload, dedupKey?: string): Promise<Job>;
  claimNext(): Promise<Job | null>;
  markDone(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  heartbeat(id: string, extendSeconds: number): Promise<void>;
  close(): Promise<void>;
}
