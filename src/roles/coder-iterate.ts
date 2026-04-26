// Coder iteration. Triggered by a human `/iterate` comment on an open PR
// after the reviewer (or another human) posted review feedback.
//
// Contract:
//   - Fresh Claude session — zero memory of the original coder run.
//   - Clones the PR head branch into a fresh workspace.
//   - Builds context from GitHub artifacts only: PR body, embedded approach
//     (optional), latest review body + inline comments filtered to that
//     review's id, and the current PR diff.
//   - Runs Claude one-shot with Read/Edit/Write/Grep.
//   - Stages, commits with an `agent-iterate:` marker, pushes to the SAME
//     branch. The `pull_request.synchronize` webhook re-fires the reviewer.
//   - Caps iteration count by scanning prior commits for the marker.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getPull,
  getPullDiff,
  listPullCommits,
  listPullReviewComments,
  listPullReviews,
  postIssueComment,
} from '../lib/github';
import { newWorkspace } from '../lib/workspace';
import { runClaude } from '../lib/claude';
import { buildSymbolIndex } from '../lib/symbol-index';
import { parseApproach } from '../lib/approach';
import {
  configIdentity,
  stageTargets,
  hasStagedChanges,
  commit,
  push,
  listUntrackedModified,
  statDiff,
} from '../lib/gitops';
import {
  CODER_ITERATE_PROMPT_VERSION,
  CODER_ITERATE_SYSTEM,
  coderIteratePrompt,
} from '../prompts/coder';
import { TERSE_DISCIPLINE } from '../prompts/architect';
import { ITERATION_SCHEMA, type Iteration } from '../prompts/schemas';
import { renderIterationSummary } from '../prompts/render';
import { config } from '../config';
import type { IteratePayload, Job } from '../types';

const ITERATE_MARKER = 'agent-iterate:';

function readOptional(path: string): string {
  try {
    return readFileSync(path, 'utf8');
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

// Count prior iteration commits by scanning commit messages for the marker.
// Each coder-iterate commit embeds `agent-iterate: <runId>` in the trailer.
function countPriorIterations(commits: { message: string }[]): number {
  return commits.filter((c) => c.message.includes(ITERATE_MARKER)).length;
}

export async function runCoderIterate(
  job: Job & { payload: IteratePayload },
): Promise<void> {
  const { repo, prNumber, requestedBy } = job.payload;
  const runId = job.id.slice(0, 8);

  console.log(
    JSON.stringify({
      level: 'info',
      run: job.id,
      role: 'coder_iterate',
      repo,
      pr: prNumber,
      requestedBy,
      event: 'start',
    }),
  );

  const pull = await getPull(repo, prNumber);

  // Cap check. Each coder-iterate commit carries the marker.
  const commits = await listPullCommits(repo, prNumber);
  const prior = countPriorIterations(commits);
  if (prior >= config.maxIterations) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        run: job.id,
        event: 'iterate_cap_reached',
        prior,
        max: config.maxIterations,
      }),
    );
    await postIssueComment(
      repo,
      prNumber,
      `Coder: iteration cap reached (${prior}/${config.maxIterations}). ` +
        `Further \`/iterate\` comments will be ignored. Push a manual fix ` +
        `or raise \`ITERATE_MAX\` if you need another cycle.`,
    );
    return;
  }

  // Pick the latest review (by submittedAt). Skip if it's APPROVED with no
  // inline comments — nothing to iterate on.
  const reviews = await listPullReviews(repo, prNumber);
  const sortedReviews = [...reviews].sort(
    (a, b) =>
      Date.parse(a.submittedAt ?? '0') - Date.parse(b.submittedAt ?? '0'),
  );
  const latest = sortedReviews[sortedReviews.length - 1];
  if (!latest) {
    await postIssueComment(
      repo,
      prNumber,
      `Coder: \`/iterate\` received but no reviews on this PR yet. ` +
        `Wait for a review, then re-trigger.`,
    );
    return;
  }

  const allInline = await listPullReviewComments(repo, prNumber);
  const inlineForLatest = allInline.filter(
    (c) => c.pullRequestReviewId === latest.id,
  );

  if (
    latest.state === 'APPROVED' &&
    inlineForLatest.length === 0 &&
    !latest.body.trim()
  ) {
    await postIssueComment(
      repo,
      prNumber,
      `Coder: latest review is an approval with no comments — nothing to iterate on.`,
    );
    return;
  }

  const approachBody = extractEmbeddedApproach(pull.body);
  const parsed = approachBody
    ? parseApproach(approachBody)
    : { approachBody: '', filesToChange: [] as string[] };

  const ws = newWorkspace(repo, pull.headRef);
  try {
    configIdentity(ws.repoDir, config.gitAuthorName, config.gitAuthorEmail);

    // Ensure we're at exactly the PR head SHA (workspace clones the branch
    // tip, which matches HEAD unless the PR was pushed between clone and
    // checkout — the extra checkout makes the state deterministic).
    execFileSync('git', ['checkout', '-q', pull.headSha], {
      cwd: ws.repoDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    // Reattach to the branch ref so `git push` has something to push.
    execFileSync('git', ['switch', '-q', '-C', pull.headRef], {
      cwd: ws.repoDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    const agentsMd =
      readOptional(join(ws.repoDir, 'AGENTS.md')) || '(AGENTS.md missing)';
    const designMd =
      readOptional(join(ws.repoDir, 'DESIGN.md')) || '(DESIGN.md missing)';
    const symbolIndex = buildSymbolIndex(ws.repoDir);
    const currentDiff = await getPullDiff(repo, prNumber);

    const userPrompt = coderIteratePrompt({
      prNumber,
      prTitle: pull.title,
      prBody: pull.body,
      approachBody: parsed.approachBody,
      filesToChange: parsed.filesToChange,
      reviewBody: latest.body,
      reviewState: latest.state,
      reviewerLogin: latest.userLogin,
      inlineComments: inlineForLatest.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.body,
      })),
      currentDiff,
      agentsMd,
      designMd,
      symbolIndex,
    });

    const systemPrompt = config.terseOutputs
      ? `${TERSE_DISCIPLINE}\n\n${CODER_ITERATE_SYSTEM}`
      : CODER_ITERATE_SYSTEM;

    const result = await runClaude({
      systemPrompt,
      userPrompt,
      cwd: ws.repoDir,
      allowedTools: ['Read', 'Edit', 'Write', 'Grep'],
      model: config.coderModel,
      maxTurns: 25,
      outputFormat: { type: 'json_schema', schema: ITERATION_SCHEMA as Record<string, unknown> },
    });

    const iteration = result.structured as Iteration;

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'coder_iterate',
        event: 'claude_done',
        promptVersion: CODER_ITERATE_PROMPT_VERSION,
        addressedCount: iteration.addressed_comments.length,
        unaddressedCount: iteration.unaddressed_comments.length,
        newConcernsCount: iteration.new_concerns.length,
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

    // Stage approach-listed files + any file mentioned by an inline comment.
    // Human-authored PRs (no approach) fall back to the inline-comment paths
    // alone; if the reviewer didn't give paths, nothing gets staged.
    const stageSet = new Set<string>(parsed.filesToChange);
    for (const c of inlineForLatest) {
      if (c.path) stageSet.add(c.path);
    }
    const stageList = [...stageSet];

    const staging = stageTargets(ws.repoDir, stageList);
    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        event: 'staged',
        staged: staging.staged,
        removed: staging.removed,
        skipped: staging.skipped,
      }),
    );

    const leaked = listUntrackedModified(ws.repoDir);
    if (leaked.length > 0) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          run: job.id,
          event: 'scope_leak',
          files: leaked,
        }),
      );
    }

    if (!hasStagedChanges(ws.repoDir)) {
      await postIssueComment(
        repo,
        prNumber,
        `Coder (iterate run \`${runId}\`) produced no staged changes. ` +
          `Session: \`${result.sessionId ?? '-'}\`.\n\n` +
          (leaked.length > 0
            ? `Files Claude touched outside the review scope (NOT committed):\n` +
              leaked.map((f) => `- \`${f}\``).join('\n')
            : `No files were modified.`),
      );
      return;
    }

    const diffStat = statDiff(ws.repoDir);
    const sha = commit(
      ws.repoDir,
      `agent(iterate): address review feedback\n\n` +
        `PR: #${prNumber}\n` +
        `Run: ${runId}\n` +
        `Requested-by: ${requestedBy}\n` +
        `${ITERATE_MARKER} ${runId}\n`,
    );

    push(ws.repoDir, pull.headRef, repo, config.githubToken);

    await postIssueComment(
      repo,
      prNumber,
      `Coder iterate run \`${runId}\` pushed \`${sha.slice(0, 7)}\` to ` +
        `\`${pull.headRef}\` (iteration ${prior + 1}/${config.maxIterations}).\n\n` +
        renderIterationSummary(iteration) +
        `\n\n### Diff stat\n\n\`\`\`\n${diffStat}\`\`\`\n\n` +
        `_Session: \`${result.sessionId ?? '-'}\` · ` +
        `Tokens: ${result.tokensIn ?? '?'} in / ${result.tokensOut ?? '?'} out · ` +
        `Cost: $${result.costUsd?.toFixed(4) ?? '?'} · ` +
        `Turns: ${result.turns ?? '?'}_`,
    );

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'coder_iterate',
        event: 'iteration_pushed',
        sha,
        iteration: prior + 1,
        max: config.maxIterations,
      }),
    );
  } finally {
    ws.cleanup();
  }
}
