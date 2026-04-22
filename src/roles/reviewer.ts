import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getPull,
  getPullDiff,
  postPullReview,
  type LineComment,
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

function extractEmbeddedApproach(prBody: string): string {
  const m = prBody.match(
    /<!--\s*agent-approach-embed\s*-->\s*\n([\s\S]*?)\n\s*<!--\s*\/agent-approach-embed\s*-->/,
  );
  return m ? m[1].trim() : '';
}

// Parse the <!-- review-json --> block embedded in Claude's output.
// Returns { markdownBody (without json block), verdict, lineComments }.
function parseReviewOutput(raw: string): {
  markdownBody: string;
  verdict: 'lgtm' | 'changes-required';
  lineComments: LineComment[];
} {
  const jsonBlockRe =
    /<!--\s*review-json\s*-->\s*\n```json\s*\n([\s\S]*?)\n```\s*\n<!--\s*\/review-json\s*-->/;
  const m = raw.match(jsonBlockRe);

  // Strip the JSON block (and markers) from the body regardless of parse outcome.
  const markdownBody = raw.replace(jsonBlockRe, '').trim();

  if (!m) {
    // No JSON block — fall back to heuristic: look for "Changes required" in the
    // markdown. Default to changes-required when uncertain (safer gate).
    const verdict: 'lgtm' | 'changes-required' = /\*\*Changes required\*\*|changes required/i.test(
      raw,
    )
      ? 'changes-required'
      : 'lgtm';
    return { markdownBody, verdict, lineComments: [] };
  }

  try {
    const parsed = JSON.parse(m[1]) as {
      verdict?: string;
      line_comments?: Array<{
        path?: string;
        line?: number;
        side?: string;
        body?: string;
      }>;
    };
    const verdict =
      parsed.verdict === 'changes-required' ? 'changes-required' : 'lgtm';
    const lineComments = (parsed.line_comments ?? [])
      .filter((c) => c.path && typeof c.line === 'number' && c.body)
      .map<LineComment>((c) => ({
        path: c.path as string,
        line: c.line as number,
        side: c.side === 'LEFT' ? 'LEFT' : 'RIGHT',
        body: c.body as string,
      }));
    return { markdownBody, verdict, lineComments };
  } catch {
    // Invalid JSON — fall back to changes-required (safer default).
    return { markdownBody, verdict: 'changes-required', lineComments: [] };
  }
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

  const ws = newWorkspace(repo, pull.headRef);
  try {
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

    const { markdownBody, verdict, lineComments } = parseReviewOutput(result.text);

    const body =
      markdownBody +
      `\n\n---\n` +
      `_Posted by reviewer agent. Run: \`${runId}\` · ` +
      `Verdict: \`${verdict}\` · ` +
      `Inline: ${lineComments.length} · ` +
      `Tokens: ${result.tokensIn ?? '?'} in / ${result.tokensOut ?? '?'} out · ` +
      `Turns: ${result.turns ?? '?'}._`;

    const { url, inlineCommentsDropped } = await postPullReview({
      repoFull: repo,
      prNumber,
      commitId: pull.headSha,
      body,
      event: verdict === 'changes-required' ? 'REQUEST_CHANGES' : 'COMMENT',
      comments: lineComments,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'reviewer',
        event: 'review_posted',
        url,
        verdict,
        inlineComments: lineComments.length,
        inlineCommentsDropped,
      }),
    );
  } finally {
    ws.cleanup();
  }
}
