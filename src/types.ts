// Shared types across webhook, queue, worker, and roles.

export type JobKind = 'architect' | 'coder' | 'reviewer';

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

export interface ReviewerPayload {
  repo: string;
  prNumber: number;
  prUrl: string;
}

export type JobPayload = ArchitectPayload | CoderPayload | ReviewerPayload;

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
