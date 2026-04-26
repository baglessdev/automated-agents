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
import { buildSymbolIndex } from '../lib/symbol-index';
import {
  REVIEWER_PROMPT_VERSION,
  REVIEWER_SYSTEM,
  reviewerUserPrompt,
} from '../prompts/reviewer';
import { TERSE_DISCIPLINE } from '../prompts/architect';
import { REVIEW_SCHEMA, type Review } from '../prompts/schemas';
import { renderReviewMarkdown } from '../prompts/render';
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
    const symbolIndex = buildSymbolIndex(ws.repoDir);

    const userPrompt = reviewerUserPrompt({
      prNumber,
      prTitle: pull.title,
      prBody: pull.body,
      approachBody,
      linkedIssues,
      diff,
      agentsMd,
      designMd,
      symbolIndex,
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
      outputFormat: { type: 'json_schema', schema: REVIEW_SCHEMA as Record<string, unknown> },
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

    const review = result.structured as Review;
    const lineComments: LineComment[] = review.inline_comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      body: c.body,
    }));

    const body =
      renderReviewMarkdown(review) +
      `\n\n---\n` +
      `_Posted by reviewer agent. Run: \`${runId}\` · ` +
      `Verdict: \`${review.verdict}\` · ` +
      `Inline: ${lineComments.length} · ` +
      `Tokens: ${result.tokensIn ?? '?'} in / ${result.tokensOut ?? '?'} out · ` +
      `Cost: $${result.costUsd?.toFixed(4) ?? '?'} · ` +
      `Turns: ${result.turns ?? '?'}._`;

    const posted = await postPullReview({
      repoFull: repo,
      prNumber,
      commitId: pull.headSha,
      body,
      event: review.verdict === 'changes-required' ? 'REQUEST_CHANGES' : 'COMMENT',
      comments: lineComments,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'reviewer',
        event: 'review_posted',
        url: posted.url,
        verdict: review.verdict,
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
