// Thin git wrappers used by the coder role. All operations run against a
// workspace dir cloned by lib/workspace.ts. Pushes use a token-embedded URL
// (built once at push time, never written to .git/config).

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

function git(cwd: string, args: string[], opts: { inheritStderr?: boolean } = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', opts.inheritStderr ? 'inherit' : 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function configIdentity(repoDir: string, name: string, email: string): void {
  git(repoDir, ['config', 'user.name', name]);
  git(repoDir, ['config', 'user.email', email]);
}

export function checkoutNewBranch(repoDir: string, branch: string): void {
  git(repoDir, ['checkout', '-q', '-b', branch]);
}

// Stage exactly the paths in `targets`. If a file exists in the workspace,
// `git add`; if it was previously tracked but removed, `git rm`; otherwise
// skip with a warning.
export function stageTargets(repoDir: string, targets: string[]): { staged: string[]; removed: string[]; skipped: string[] } {
  const staged: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const t of targets) {
    const abs = join(repoDir, t);
    let exists = false;
    try {
      statSync(abs);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      git(repoDir, ['add', '--', t]);
      staged.push(t);
    } else {
      // If git knew about it, stage the deletion.
      try {
        git(repoDir, ['ls-files', '--error-unmatch', '--', t], { inheritStderr: false });
        git(repoDir, ['rm', '-q', '--', t]);
        removed.push(t);
      } catch {
        skipped.push(t);
      }
    }
  }
  return { staged, removed, skipped };
}

export function hasStagedChanges(repoDir: string): boolean {
  try {
    git(repoDir, ['diff', '--cached', '--quiet']);
    return false;
  } catch {
    return true;
  }
}

export function commit(repoDir: string, message: string): string {
  git(repoDir, ['commit', '-q', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']).trim();
}

export function push(repoDir: string, branch: string, repoFull: string, token: string): void {
  const url = `https://x-access-token:${token}@github.com/${repoFull}.git`;
  git(repoDir, ['push', '--quiet', url, branch], { inheritStderr: true });
}

export function listUntrackedModified(repoDir: string): string[] {
  const out = git(repoDir, ['ls-files', '--others', '--modified', '--exclude-standard']);
  return out.split('\n').filter(Boolean);
}

export function statDiff(repoDir: string): string {
  return git(repoDir, ['diff', '--cached', '--stat']);
}
