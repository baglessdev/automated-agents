import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  addLabels,
  getIssue,
  listIssueComments,
  openPullRequest,
  postIssueComment,
} from '../lib/github';
import { newWorkspace } from '../lib/workspace';
import { runClaude } from '../lib/claude';
import { buildSymbolIndex } from '../lib/symbol-index';
import { buildCanUseTool } from '../lib/permissions';
import { parseApproach } from '../lib/approach';
import { fallbackTriage, routeRole } from '../lib/routing';
import { CODER_SCHEMA, type Coder, type Triage } from '../prompts/schemas';
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
    configIdentity(ws.repoDir, config.gitAuthorName, config.gitAuthorEmail);
    const branch = `agent/${runId}-issue${issueNumber}`;
    checkoutNewBranch(ws.repoDir, branch);

    // 4. Context for Claude
    const agentsMd = readOptional(join(ws.repoDir, 'AGENTS.md')) || '(AGENTS.md missing)';
    const designMd = readOptional(join(ws.repoDir, 'DESIGN.md')) || '(DESIGN.md missing)';
    const symbolIndex = buildSymbolIndex(ws.repoDir);

    const userPrompt = coderUserPrompt({
      issueNumber,
      issueTitle: issue.title,
      issueBody: issue.body,
      approachBody: parsed.approachBody,
      filesToChange: parsed.filesToChange,
      agentsMd,
      designMd,
      symbolIndex,
    });

    const systemPrompt = config.terseOutputs
      ? `${TERSE_DISCIPLINE}\n\n${CODER_SYSTEM}`
      : CODER_SYSTEM;

    // 5. Resolve routing from the approach's triage tier (B13). Fall
    // back to the pre-B13 default (Sonnet, no thinking) when the
    // approach lacks the tier — i.e. it was authored before B13 landed.
    const triage: Triage =
      parsed.triageComplexity && parsed.triageRisk
        ? {
            complexity: parsed.triageComplexity,
            risk: parsed.triageRisk,
            reasoning: '(read from embedded approach)',
          }
        : fallbackTriage();
    const route = routeRole('coder', triage);

    // 6. Run Claude. The coder edits files AND runs the repo's verify
    // command in-session (Bash gated to verify-only commands via
    // canUseTool). One retry permitted; structured output reports the
    // verify outcome to the harness.
    const result = await runClaude({
      systemPrompt,
      userPrompt,
      cwd: ws.repoDir,
      // Bash is intentionally NOT in allowedTools — every Bash call goes
      // through canUseTool where the command-level allowlist gates it
      // (see src/lib/permissions.ts). Read/Edit/Write/Grep auto-allow.
      allowedTools: ['Read', 'Edit', 'Write', 'Grep'],
      canUseTool: buildCanUseTool('coder', job.id),
      model: route.model,
      // Raised from 25 to 40 to accommodate edit → verify → fix → re-verify
      // within a single session.
      maxTurns: 40,
      outputFormat: { type: 'json_schema', schema: CODER_SCHEMA as Record<string, unknown> },
    });

    const coderResult = result.structured as Coder;

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'coder',
        event: 'claude_done',
        promptVersion: CODER_PROMPT_VERSION,
        triageComplexity: triage.complexity,
        triageRisk: triage.risk,
        routedModel: route.model,
        verifyAttempted: coderResult.verify_attempted,
        verifyPassed: coderResult.verify_passed,
        concernsCount: coderResult.concerns.length,
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

    // 10. Build the verify status section + machine-readable embed.
    // Reviewer parses the embed (analogous to <!-- agent-approach-embed -->)
    // to know whether to weight verify failures in its review.
    const verifyHeading = !coderResult.verify_attempted
      ? '⚠ Not attempted'
      : coderResult.verify_passed
        ? '✓ Passed'
        : '✗ Failed';

    const verifyBlock =
      `### Verify status\n\n${verifyHeading}\n\n` +
      (coderResult.verify_attempted && !coderResult.verify_passed && coderResult.verify_output_tail
        ? `<details><summary>Verify output (last 30 lines)</summary>\n\n\`\`\`\n${coderResult.verify_output_tail}\n\`\`\`\n\n</details>\n\n`
        : '') +
      (coderResult.concerns.length > 0
        ? `### Concerns\n\n${coderResult.concerns.map((c) => `- ${c}`).join('\n')}\n\n`
        : '');

    const verifyEmbed =
      `<!-- agent-verify-status -->\n` +
      JSON.stringify({
        attempted: coderResult.verify_attempted,
        passed: coderResult.verify_passed,
        output_tail: coderResult.verify_output_tail.slice(0, 5000),
      }) +
      `\n<!-- /agent-verify-status -->`;

    // 11. Open PR with embedded approach so reviewer can find it
    const titlePrefix =
      coderResult.verify_attempted && !coderResult.verify_passed ? '[verify-failed] ' : '';
    const prBody =
      `Closes #${issueNumber}\n\n` +
      `Run: \`${runId}\` · Session: \`${result.sessionId ?? '-'}\`\n` +
      `Tokens: ${result.tokensIn ?? '?'} in / ${result.tokensOut ?? '?'} out · ` +
      `Cost: $${result.costUsd?.toFixed(4) ?? '?'} · Turns: ${result.turns ?? '?'}\n\n` +
      verifyBlock +
      `### Diff stat\n\n\`\`\`\n${diff}\n\`\`\`\n\n` +
      `### Approach (embedded for reviewer)\n\n` +
      `<!-- agent-approach-embed -->\n${parsed.approachBody}\n<!-- /agent-approach-embed -->\n\n` +
      verifyEmbed;

    const prUrl = await openPullRequest({
      repoFull: repo,
      head: branch,
      base: 'main',
      title: `${titlePrefix}agent: ${issue.title}`,
      body: prBody,
    });

    // 12. If verify didn't pass (or wasn't attempted), label the PR so
    // humans + reviewer agent both see the status at a glance. PR number
    // is parsed from the URL (octokit doesn't return it from create).
    const verifyOk = coderResult.verify_attempted && coderResult.verify_passed;
    if (!verifyOk) {
      const prNumber = Number(prUrl.split('/').pop());
      if (Number.isFinite(prNumber)) {
        try {
          await addLabels(repo, prNumber, ['agent:verify-failed']);
        } catch (err) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              run: job.id,
              event: 'label_add_failed',
              prNumber,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    }

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'coder',
        event: 'pr_opened',
        url: prUrl,
        sha,
        verifyOk,
      }),
    );
  } finally {
    ws.cleanup();
  }
}
