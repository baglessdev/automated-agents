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
};
