import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getIssue, postIssueComment } from '../lib/github';
import { newWorkspace } from '../lib/workspace';
import { runClaude } from '../lib/claude';
import { ARCHITECT_SYSTEM, TERSE_DISCIPLINE, architectUserPrompt } from '../prompts/architect';
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

function buildTree(repoDir: string): string {
  // Language-agnostic: include common source + config files, 4 levels deep.
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
      '(',
      '-name',
      '*.go',
      '-o',
      '-name',
      '*.ts',
      '-o',
      '-name',
      '*.tsx',
      '-o',
      '-name',
      '*.js',
      '-o',
      '-name',
      '*.jsx',
      '-o',
      '-name',
      '*.py',
      '-o',
      '-name',
      '*.java',
      '-o',
      '-name',
      '*.kt',
      '-o',
      '-name',
      '*.rs',
      '-o',
      '-name',
      '*.rb',
      '-o',
      '-name',
      '*.md',
      '-o',
      '-name',
      '*.yml',
      '-o',
      '-name',
      '*.yaml',
      '-o',
      '-name',
      '*.toml',
      '-o',
      '-name',
      '*.json',
      '-o',
      '-name',
      'Taskfile*',
      '-o',
      '-name',
      'Makefile*',
      '-o',
      '-name',
      'go.mod',
      '-o',
      '-name',
      'go.sum',
      '-o',
      '-name',
      'package.json',
      '-o',
      '-name',
      'pom.xml',
      '-o',
      '-name',
      'Cargo.toml',
      '-o',
      '-name',
      'pyproject.toml',
      ')',
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
    const fileTree = buildTree(ws.repoDir);

    // 4. Compose prompt
    const userPrompt = architectUserPrompt({
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueBody: issue.body,
      agentsMd: agentsMd || '(AGENTS.md missing)',
      designMd: designMd || '(DESIGN.md missing)',
      agentDirNotes,
      fileTree,
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
    });

    console.log(
      JSON.stringify({
        level: 'info',
        run: job.id,
        role: 'architect',
        event: 'claude_done',
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        turns: result.turns,
        durationMs: result.durationMs,
        sessionId: result.sessionId,
      }),
    );

    // 6. Post the approach as an issue comment, marked for the coder
    const runId = job.id.slice(0, 8);
    const commentBody =
      `<!-- agent-approach run=${runId} -->\n\n` +
      result.text.trim() +
      '\n\n---\n' +
      `_Posted by architect agent. Run: \`${runId}\` · ` +
      `Tokens: ${result.tokensIn ?? '?'} in / ${result.tokensOut ?? '?'} out · ` +
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
