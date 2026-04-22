import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Job, JobKind } from '../types';
import type { Queue } from './queue';

export class SqliteQueue implements Queue {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // WAL for concurrent reads during writes.
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
    `);
  }

  enqueue(kind: JobKind, payload: Job['payload']): Job {
    const job: Job = {
      id: randomUUID(),
      kind,
      payload,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, payload, status, created_at)
         VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(job.id, job.kind, JSON.stringify(job.payload), job.createdAt);
    return job;
  }

  claimNext(): Job | null {
    const row = this.db.transaction(() => {
      const r = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get() as
        | {
            id: string;
            kind: JobKind;
            payload: string;
            status: Job['status'];
            created_at: number;
          }
        | undefined;
      if (!r) return null;
      this.db
        .prepare(
          `UPDATE jobs SET status = 'running', started_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), r.id);
      return r;
    })();
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      payload: JSON.parse(row.payload),
      status: 'running',
      createdAt: row.created_at,
      startedAt: Date.now(),
    };
  }

  markDone(id: string): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', finished_at = ?, error = ?
         WHERE id = ?`,
      )
      .run(Date.now(), error, id);
  }

  close(): void {
    this.db.close();
  }
}
