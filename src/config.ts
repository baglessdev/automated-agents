// Env-var loader. Fail fast on startup if required secrets are missing.
// systemd loads these from /etc/automated-agents.env on the server.

function must(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(`missing required env var: ${key}`);
  }
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  port: Number(optional('PORT', '8080')),

  githubWebhookSecret: must('GITHUB_WEBHOOK_SECRET'),
  githubToken: must('GITHUB_TOKEN'),

  // ANTHROPIC_API_KEY is read by the Agent SDK itself from the env,
  // but we validate its presence at startup so we fail fast instead of
  // deep inside a job.
  _anthropicApiKeyCheck: must('ANTHROPIC_API_KEY'),

  // Where session workspaces live. One subdir per run, cleaned after.
  workspaceRoot: optional('WORKSPACE_ROOT', '/var/work/automated-agents'),

  // Where the SQLite queue + state lives.
  queuePath: optional('QUEUE_PATH', '/var/lib/automated-agents/queue.db'),

  // Label on the target repo that triggers the architect.
  archLabel: optional('ARCH_LABEL', 'agent:arch'),

  // How often the worker polls the queue when idle (ms).
  pollIntervalMs: Number(optional('POLL_INTERVAL_MS', '2000')),
};
