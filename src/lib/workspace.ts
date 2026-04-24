import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config';

export interface Workspace {
  runId: string;
  dir: string;
  repoDir: string;
  cleanup: () => void;
}

// Create a fresh per-run workspace directory and shallow-clone the target
// repo's default branch into it. Uses the token-embedded URL so private
// repos work. The URL is never written to disk (no remote added, --depth 1
// clone only), and any git error is re-thrown with the token redacted so
// it doesn't leak into logs.
export function newWorkspace(repoFullName: string, ref = 'main'): Workspace {
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dir = join(config.workspaceRoot, runId);
  const repoDir = join(dir, 'workspace');

  mkdirSync(dir, { recursive: true });

  const cloneUrl = `https://x-access-token:${config.githubToken}@github.com/${repoFullName}.git`;
  try {
    execFileSync(
      'git',
      ['clone', '--quiet', '--depth', '1', '--branch', ref, cloneUrl, repoDir],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const redacted = msg.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
    throw new Error(redacted);
  }

  return {
    runId,
    dir,
    repoDir,
    cleanup: () => {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
