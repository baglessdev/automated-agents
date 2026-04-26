import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getIssue, postIssueComment } from '../lib/github';
import { newWorkspace } from '../lib/workspace';
import { runClaude } from '../lib/claude';
import { buildSymbolIndex } from '../lib/symbol-index';
import {
  ARCHITECT_PROMPT_VERSION,
  ARCHITECT_SYSTEM,
  TERSE_DISCIPLINE,
  architectUserPrompt,
} from '../prompts/architect';
import { APPROACH_SCHEMA, type Approach } from '../prompts/schemas';
import { renderApproachMarkdown } from '../prompts/render';
import { config } from '../config';
import type { ArchitectPayload, Job } from '../types';

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

export async function runArchitect(job: Job & { payload: ArchitectPayload }): Promise<void> {
  const { repo, issueNumber } = job.payload;

  console.log(
    JSON.stringify({
      level: 'info',
      run: job.id,
      role: 'architect',
      repo,
      issue: issueNumber,
      event: 'start',
    }),
  );

  // 1. Fetch issue
  const issue = await getIssue(repo, issueNumber);

  // 2. Clone target repo into a fresh workspace
  const ws = newWorkspace(repo);
  try {
    // 3. Read conventions + file tree
    const agentsMd = readOptional(join(ws.repoDir, 'AGENTS.md'));
    const designMd = readOptional(join(ws.repoDir, 'DESIGN.md'));
    const agentDirNotes = readAgentDir(ws.repoDir);
    const symbolIndex = buildSymbolIndex(ws.repoDir);

    // 4. Compose prompt
    const userPrompt = architectUserPrompt({
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueBody: issue.body,
      agentsMd: agentsMd || '(AGENTS.md missing)',
      designMd: designMd || '(DESIGN.md missing)',
      agentDirNotes,
      symbolIndex,
    });

    // 5. Run Claude with Read/Grep/Bash tools, cwd pointed at the clone
    const systemPrompt = config.terseOutputs
      ? `${TERSE_DISCIPLINE}\n\n${ARCHITECT_SYSTEM}`
      : ARCHITECT_SYSTEM;

    const result = await runClaude({
      systemPrompt,
      userPrompt,
      cwd: ws.repoDir,
      allowedTools: ['Read', 'Grep', 'Bash'],
      model: config.architectModel,
      maxTurns: 30,
      maxThinkingTokens: config.architectThinkingBudget || undefined,
      outputFormat: { type: 'json_schema', schema: APPROACH_SCHEMA as Record<string, unknown> },
    });

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'architect',
        event: 'claude_done',
        promptVersion: ARCHITECT_PROMPT_VERSION,
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

    // 6. Post the approach as an issue comment, marked for the coder.
    // The architect emits structured fields; we render the markdown.
    const approach = result.structured as Approach;
    const runId = job.id.slice(0, 8);
    const commentBody =
      `<!-- agent-approach run=${runId} -->\n\n` +
      renderApproachMarkdown(approach, issue.number, issue.title) +
      '\n\n---\n' +
      `_Posted by architect agent. Run: \`${runId}\` · ` +
      `Tokens: ${result.tokensIn ?? '?'} in / ${result.tokensOut ?? '?'} out · ` +
      `Cost: $${result.costUsd?.toFixed(4) ?? '?'} · ` +
      `Turns: ${result.turns ?? '?'}._\n\n` +
      `**Next:** comment \`/approve\` on this issue to proceed to the coder.`;

    const commentUrl = await postIssueComment(repo, issueNumber, commentBody);

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'architect',
        event: 'comment_posted',
        url: commentUrl,
      }),
    );
  } finally {
    ws.cleanup();
  }
}
