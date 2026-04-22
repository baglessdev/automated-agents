// Shared types across webhook, queue, worker, and roles.

export type JobKind = 'architect'; // coder/reviewer added in later phases.

export interface ArchitectPayload {
  repo: string;      // "owner/repo"
  issueNumber: number;
  issueUrl: string;
}

export interface Job {
  id: string;
  kind: JobKind;
  payload: ArchitectPayload;
  status: 'pending' | 'running' | 'done' | 'failed';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}
