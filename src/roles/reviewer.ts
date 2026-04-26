import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getIssue,
  getPull,
  getPullDiff,
  parseClosedIssues,
  postPullReview,
  type LineComment,
} from '../lib/github';
import { newWorkspace } from '../lib/workspace';
import { runClaude } from '../lib/claude';
import {
  REVIEWER_PROMPT_VERSION,
  REVIEWER_SYSTEM,
  reviewerUserPrompt,
} from '../prompts/reviewer';
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
    // No JSON block — rely on explicit markdown verdict phrasing.
    // "Verdict: Changes required" / "Verdict: LGTM" are the specified
    // forms; anything else defaults to lgtm (don't block on parser noise).
    const verdict: 'lgtm' | 'changes-required' =
      /\*\*Verdict:\s*Changes required\*\*/i.test(raw)
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
    // Invalid JSON — default to lgtm. Blocking defaults cause false
    // positives on self-PRs (REQUEST_CHANGES fails with 422).
    return { markdownBody, verdict: 'lgtm', lineComments: [] };
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

  // Linked issues via Closes / Fixes / Resolves — used in Mode B (general
  // review) when no approach is embedded, but always included as context.
  const linkedNumbers = parseClosedIssues(pull.body);
  const linkedIssues = await Promise.all(
    linkedNumbers.map(async (n) => {
      try {
        const iss = await getIssue(repo, n);
        return { number: iss.number, title: iss.title, body: iss.body };
      } catch {
        return { number: n, title: '(could not fetch)', body: '' };
      }
    }),
  );

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
      prBody: pull.body,
      approachBody,
      linkedIssues,
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
      maxThinkingTokens: config.reviewerThinkingBudget || undefined,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'reviewer',
        event: 'claude_done',
        promptVersion: REVIEWER_PROMPT_VERSION,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        cacheRead: result.cacheReadTokens,
        cacheCreation: result.cacheCreationTokens,
        costUsd: result.costUsd,
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

    const posted = await postPullReview({
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
        url: posted.url,
        verdict,
        eventPosted: posted.eventFinal,
        downgradedToComment: posted.downgradedToComment,
        inlineComments: lineComments.length,
        inlineCommentsDropped: posted.inlineCommentsDropped,
      }),
    );
  } finally {
    ws.cleanup();
  }
}
