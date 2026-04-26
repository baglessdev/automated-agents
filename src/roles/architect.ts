import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getIssue, postIssueComment } from '../lib/github';
import { newWorkspace } from '../lib/workspace';
import { runClaude } from '../lib/claude';
import { buildSymbolIndex } from '../lib/symbol-index';
import { classifyIssue } from '../lib/triage';
import { isHighRisk, refuseReason, routeRole } from '../lib/routing';
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
    // 3. Read conventions + symbol index
    const agentsMd = readOptional(join(ws.repoDir, 'AGENTS.md'));
    const designMd = readOptional(join(ws.repoDir, 'DESIGN.md'));
    const agentDirNotes = readAgentDir(ws.repoDir);
    const symbolIndex = buildSymbolIndex(ws.repoDir);

    // 4. Triage — classifies the issue's complexity + risk so we can
    // route this and downstream roles to a model that fits the task.
    // Cheap (Haiku, single call). Hard-failing here would block the
    // entire pipeline so we'd rather try and fall back than skip.
    const triage = await classifyIssue({
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueBody: issue.body,
      agentsMd: agentsMd || '(AGENTS.md missing)',
      symbolIndex,
      cwd: ws.repoDir,
    });
    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'architect',
        event: 'triage_done',
        complexity: triage.complexity,
        risk: triage.risk,
        reasoning: triage.reasoning,
      }),
    );

    // 4a. High-risk → refuse. Post a comment explaining why and return
    // before any further model spend.
    if (isHighRisk(triage)) {
      const runId = job.id.slice(0, 8);
      const refuseBody =
        `<!-- agent-approach run=${runId} refused=high-risk -->\n\n` +
        `# Architect refused — high-risk issue\n\n` +
        refuseReason(triage) +
        `\n\n---\n_Posted by architect agent. Run: \`${runId}\`._`;
      const commentUrl = await postIssueComment(repo, issueNumber, refuseBody);
      console.log(
        JSON.stringify({
          level: 'info',
          run: job.id,
          role: 'architect',
          event: 'refused_high_risk',
          url: commentUrl,
        }),
      );
      return;
    }

    // 5. Compose prompt
    const userPrompt = architectUserPrompt({
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueBody: issue.body,
      agentsMd: agentsMd || '(AGENTS.md missing)',
      designMd: designMd || '(DESIGN.md missing)',
      agentDirNotes,
      symbolIndex,
      triageComplexity: triage.complexity,
      triageRisk: triage.risk,
      triageReasoning: triage.reasoning,
    });

    // 6. Route + run Claude. Routing picks model + thinking budget per
    // the triage tier; falls through to env-overridable defaults.
    const route = routeRole('architect', triage);
    const systemPrompt = config.terseOutputs
      ? `${TERSE_DISCIPLINE}\n\n${ARCHITECT_SYSTEM}`
      : ARCHITECT_SYSTEM;

    const result = await runClaude({
      systemPrompt,
      userPrompt,
      cwd: ws.repoDir,
      allowedTools: ['Read', 'Grep', 'Bash'],
      model: route.model,
      maxTurns: 30,
      maxThinkingTokens: route.thinkingBudget || undefined,
      outputFormat: { type: 'json_schema', schema: APPROACH_SCHEMA as Record<string, unknown> },
    });

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'architect',
        event: 'claude_done',
        promptVersion: ARCHITECT_PROMPT_VERSION,
        triageComplexity: triage.complexity,
        triageRisk: triage.risk,
        routedModel: route.model,
        routedThinkingBudget: route.thinkingBudget,
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
