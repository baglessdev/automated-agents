import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getPull,
  getPullDiff,
  postPullReview,
} from '../lib/github';
import { newWorkspace } from '../lib/workspace';
import { runClaude } from '../lib/claude';
import { REVIEWER_SYSTEM, reviewerUserPrompt } from '../prompts/reviewer';
import { TERSE_DISCIPLINE } from '../prompts/architect';
import { config } from '../config';
import type { Job, ReviewerPayload } from '../types';

function readOptional(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readAgentDir(root: string): string {
  try {
    const dir = join(root, '.agent');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => `### \`.agent/${f}\`\n\n${readFileSync(join(dir, f), 'utf8')}`)
      .join('\n\n');
  } catch {
    return '';
  }
}

function buildTree(repoDir: string): string {
  const out = execFileSync(
    'find',
    [
      '.',
      '-maxdepth',
      '4',
      '(',
      '-path',
      './.git',
      '-o',
      '-path',
      './node_modules',
      '-o',
      '-path',
      './vendor',
      '-o',
      '-path',
      './target',
      '-o',
      '-path',
      './dist',
      '-o',
      '-path',
      './build',
      ')',
      '-prune',
      '-o',
      '-type',
      'f',
      '-print',
    ],
    { cwd: repoDir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .map((l) => l.replace(/^\.\//, ''))
    .filter(Boolean)
    .sort()
    .join('\n');
}

// Pull the approach body out of the coder's PR embed (between
// <!-- agent-approach-embed --> and <!-- /agent-approach-embed -->).
function extractEmbeddedApproach(prBody: string): string {
  const m = prBody.match(
    /<!--\s*agent-approach-embed\s*-->\s*\n([\s\S]*?)\n\s*<!--\s*\/agent-approach-embed\s*-->/,
  );
  return m ? m[1].trim() : '';
}

export async function runReviewer(job: Job & { payload: ReviewerPayload }): Promise<void> {
  const { repo, prNumber } = job.payload;
  const runId = job.id.slice(0, 8);

  console.log(
    JSON.stringify({
      level: 'info',
      run: job.id,
      role: 'reviewer',
      repo,
      pr: prNumber,
      event: 'start',
    }),
  );

  const pull = await getPull(repo, prNumber);
  const diff = await getPullDiff(repo, prNumber);
  const approachBody = extractEmbeddedApproach(pull.body);

  // Clone at PR head SHA for file reads + tree.
  const ws = newWorkspace(repo, pull.headRef);
  try {
    // Pin to exact head SHA; head ref might move if coder force-pushed.
    execFileSync('git', ['checkout', '-q', pull.headSha], {
      cwd: ws.repoDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    const agentsMd = readOptional(join(ws.repoDir, 'AGENTS.md')) || '(AGENTS.md missing)';
    const designMd = readOptional(join(ws.repoDir, 'DESIGN.md')) || '(DESIGN.md missing)';
    const fileTree = buildTree(ws.repoDir);

    const userPrompt = reviewerUserPrompt({
      prNumber,
      prTitle: pull.title,
      approachBody,
      diff,
      agentsMd,
      designMd,
      fileTree,
    });

    const systemPrompt = config.terseOutputs
      ? `${TERSE_DISCIPLINE}\n\n${REVIEWER_SYSTEM}`
      : REVIEWER_SYSTEM;

    const result = await runClaude({
      systemPrompt,
      userPrompt,
      cwd: ws.repoDir,
      // Reviewer does not write anything — no Edit/Write/Bash.
      allowedTools: ['Read', 'Grep'],
      model: config.reviewerModel,
      maxTurns: 20,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'reviewer',
        event: 'claude_done',
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        turns: result.turns,
        durationMs: result.durationMs,
        sessionId: result.sessionId,
      }),
    );

    const body =
      result.text.trim() +
      `\n\n---\n` +
      `_Posted by reviewer agent. Run: \`${runId}\` · ` +
      `Tokens: ${result.tokensIn ?? '?'} in / ${result.tokensOut ?? '?'} out · ` +
      `Turns: ${result.turns ?? '?'}._`;

    const reviewUrl = await postPullReview({
      repoFull: repo,
      prNumber,
      commitId: pull.headSha,
      body,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'reviewer',
        event: 'review_posted',
        url: reviewUrl,
      }),
    );
  } finally {
    ws.cleanup();
  }
}
