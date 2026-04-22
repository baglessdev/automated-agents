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
// repo's default branch into it. Public repos only for now — the clone URL
// is unauthenticated. Private repos would need the GH_TOKEN injected here.
export function newWorkspace(repoFullName: string, ref = 'main'): Workspace {
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dir = join(config.workspaceRoot, runId);
  const repoDir = join(dir, 'workspace');

  mkdirSync(dir, { recursive: true });

  const cloneUrl = `https://github.com/${repoFullName}.git`;
  execFileSync(
    'git',
    ['clone', '--quiet', '--depth', '1', '--branch', ref, cloneUrl, repoDir],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );

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
