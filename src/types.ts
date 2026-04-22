// Shared types across webhook, queue, worker, and roles.

export type JobKind = 'architect' | 'coder';

export interface ArchitectPayload {
  repo: string;
  issueNumber: number;
  issueUrl: string;
}

export interface CoderPayload {
  repo: string;
  issueNumber: number;
  issueUrl: string;
}

export type JobPayload = ArchitectPayload | CoderPayload;

export interface Job {
  id: string;
  kind: JobKind;
  payload: JobPayload;
  status: 'pending' | 'running' | 'done' | 'failed';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}
