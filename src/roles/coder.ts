import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getIssue,
  listIssueComments,
  openPullRequest,
  postIssueComment,
} from '../lib/github';
import { newWorkspace } from '../lib/workspace';
import { runClaude } from '../lib/claude';
import { parseApproach } from '../lib/approach';
import {
  configIdentity,
  checkoutNewBranch,
  stageTargets,
  hasStagedChanges,
  commit,
  push,
  listUntrackedModified,
  statDiff,
} from '../lib/gitops';
import { CODER_PROMPT_VERSION, CODER_SYSTEM, coderUserPrompt } from '../prompts/coder';
import { TERSE_DISCIPLINE } from '../prompts/architect';
import { config } from '../config';
import type { CoderPayload, Job } from '../types';

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

// Locate the latest /approve comment and the most recent
// agent-approach comment that preceded it.
async function findApproval(
  repo: string,
  issueNumber: number,
): Promise<{ approachBody: string } | null> {
  const comments = await listIssueComments(repo, issueNumber);
  // Sort ascending by createdAt.
  const sorted = [...comments].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  let approveIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const body = sorted[i].body.trim();
    if (/^\/approve\b/i.test(body)) {
      approveIdx = i;
      break;
    }
  }
  if (approveIdx < 0) return null;
  for (let i = approveIdx - 1; i >= 0; i--) {
    if (/<!--\s*agent-approach/.test(sorted[i].body)) {
      return { approachBody: sorted[i].body };
    }
  }
  return null;
}

export async function runCoder(job: Job & { payload: CoderPayload }): Promise<void> {
  const { repo, issueNumber } = job.payload;
  const runId = job.id.slice(0, 8);

  console.log(
    JSON.stringify({
      level: 'info',
      run: job.id,
      role: 'coder',
      repo,
      issue: issueNumber,
      event: 'start',
    }),
  );

  // 1. Find the approved approach
  const approval = await findApproval(repo, issueNumber);
  if (!approval) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        run: job.id,
        event: 'no_approval',
        repo,
        issue: issueNumber,
      }),
    );
    await postIssueComment(
      repo,
      issueNumber,
      `Coder triggered but no architect approach + \`/approve\` found. ` +
        `Label the issue \`agent:arch\` to generate an approach, then ` +
        `\`/approve\` it, then re-trigger with another \`/approve\` comment.`,
    );
    return;
  }

  const parsed = parseApproach(approval.approachBody);
  if (parsed.filesToChange.length === 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        run: job.id,
        event: 'empty_scope',
        repo,
        issue: issueNumber,
      }),
    );
    await postIssueComment(
      repo,
      issueNumber,
      `Coder: approach lists no files to change — nothing to implement. ` +
        `If this is wrong, edit the approach and re-\`/approve\`.`,
    );
    return;
  }

  // 2. Fetch issue metadata for PR title/body
  const issue = await getIssue(repo, issueNumber);

  // 3. Fresh workspace
  const ws = newWorkspace(repo);
  try {
    configIdentity(ws.repoDir, 'agent', 'agent@baglessdev');
    const branch = `agent/${runId}-issue${issueNumber}`;
    checkoutNewBranch(ws.repoDir, branch);

    // 4. Context for Claude
    const agentsMd = readOptional(join(ws.repoDir, 'AGENTS.md')) || '(AGENTS.md missing)';
    const designMd = readOptional(join(ws.repoDir, 'DESIGN.md')) || '(DESIGN.md missing)';
    const fileTree = buildTree(ws.repoDir);

    const userPrompt = coderUserPrompt({
      issueNumber,
      issueTitle: issue.title,
      issueBody: issue.body,
      approachBody: parsed.approachBody,
      filesToChange: parsed.filesToChange,
      agentsMd,
      designMd,
      fileTree,
    });

    const systemPrompt = config.terseOutputs
      ? `${TERSE_DISCIPLINE}\n\n${CODER_SYSTEM}`
      : CODER_SYSTEM;

    // 5. Run Claude — one-shot: just edit files, no verify loop.
    // Bash intentionally NOT in allowedTools — Claude shouldn't run tests
    // or iterate. CI on GitHub validates the diff after PR open.
    const result = await runClaude({
      systemPrompt,
      userPrompt,
      cwd: ws.repoDir,
      allowedTools: ['Read', 'Edit', 'Write', 'Grep'],
      model: config.coderModel,
      maxTurns: 25,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'coder',
        event: 'claude_done',
        promptVersion: CODER_PROMPT_VERSION,
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

    // 6. Stage only the files from approach's "Files to change" list
    const staging = stageTargets(ws.repoDir, parsed.filesToChange);
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

    // 7. Surface any leakage (files Claude touched that weren't targets)
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
        issueNumber,
        `Coder ran but produced no staged changes for run \`${runId}\`. ` +
          `Session: \`${result.sessionId ?? '-'}\`.\n\n` +
          (leaked.length > 0
            ? `Files Claude touched outside the approach's scope (NOT committed):\n` +
              leaked.map((f) => `- \`${f}\``).join('\n')
            : `No files were modified.`),
      );
      return;
    }

    // 8. Commit
    const diff = statDiff(ws.repoDir);
    const sha = commit(
      ws.repoDir,
      `agent: ${issue.title}\n\nCloses #${issueNumber}\nRun: ${runId}\n`,
    );

    // 9. Push
    push(ws.repoDir, branch, repo, config.githubToken);

    // 10. Open PR with embedded approach so reviewer can find it
    const prBody =
      `Closes #${issueNumber}\n\n` +
      `Run: \`${runId}\` · Session: \`${result.sessionId ?? '-'}\`\n` +
      `Tokens: ${result.tokensIn ?? '?'} in / ${result.tokensOut ?? '?'} out · Turns: ${result.turns ?? '?'}\n\n` +
      `### Diff stat\n\n\`\`\`\n${diff}\n\`\`\`\n\n` +
      `### Approach (embedded for reviewer)\n\n` +
      `<!-- agent-approach-embed -->\n${parsed.approachBody}\n<!-- /agent-approach-embed -->\n`;

    const prUrl = await openPullRequest({
      repoFull: repo,
      head: branch,
      base: 'main',
      title: `agent: ${issue.title}`,
      body: prBody,
    });

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'coder',
        event: 'pr_opened',
        url: prUrl,
        sha,
      }),
    );
  } finally {
    ws.cleanup();
  }
}
