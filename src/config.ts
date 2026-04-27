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

  // SQS FIFO queue for jobs. Required. The Pulumi stack injects this
  // into /etc/automated-agents.env. Local dev points at ElasticMQ.
  sqsQueueUrl: must('SQS_QUEUE_URL'),

  // AWS region the queue lives in. Picked up by the SDK if unset, but
  // we default explicitly so the worker fails fast on misconfiguration
  // instead of silently signing requests for the wrong region.
  awsRegion: optional('AWS_REGION', 'us-east-1'),

  // SQS message visibility timeout. Roles run minutes; if the worker
  // crashes mid-job the message reappears after this window. Heartbeat
  // (below) extends it while the job is genuinely in flight.
  sqsVisibilityTimeoutSeconds: Number(
    optional('SQS_VISIBILITY_TIMEOUT', '900'),
  ),

  // Long-polling wait. Replaces the old setTimeout poll loop.
  sqsWaitTimeSeconds: Number(optional('SQS_WAIT_TIME', '20')),

  // How often the worker calls ChangeMessageVisibility for the in-flight
  // job. Must be < sqsVisibilityTimeoutSeconds so we always extend
  // before the message becomes visible to other receivers.
  sqsHeartbeatIntervalMs: Number(
    optional('SQS_HEARTBEAT_INTERVAL_MS', '300000'),
  ),

  // Optional endpoint override for local dev (ElasticMQ at
  // http://localhost:9324). Unset on EC2 so the SDK uses the real
  // SQS service for the configured region.
  sqsEndpoint: process.env.SQS_ENDPOINT || undefined,

  // Label on the target repo that triggers the architect.
  archLabel: optional('ARCH_LABEL', 'agent:arch'),

  // Per-role model overrides. Defaults to haiku-4-5 for POC cost.
  // Override at runtime with ARCHITECT_MODEL, CODER_MODEL, REVIEWER_MODEL.
  architectModel: optional('ARCHITECT_MODEL', 'claude-haiku-4-5'),
  coderModel: optional('CODER_MODEL', 'claude-haiku-4-5'),
  reviewerModel: optional('REVIEWER_MODEL', 'claude-haiku-4-5'),

  // Extended-thinking budgets per judgment-heavy role. 0 disables
  // thinking; positive values let the model reason internally before
  // emitting a response. Coder + coder-iterate intentionally not given
  // a budget — they translate plans to code, not reason about them.
  //
  // Note: extended thinking requires a Sonnet 3.7+ or Opus 4 model.
  // Haiku does not support thinking; the SDK silently drops the
  // parameter on unsupported models, so a non-zero budget is safe but
  // ineffective unless the role is on a capable model.
  architectThinkingBudget: Number(optional('ARCHITECT_THINKING_BUDGET', '5000')),
  reviewerThinkingBudget: Number(optional('REVIEWER_THINKING_BUDGET', '5000')),

  // Terseness toggle. When true, prepends a "caveman-style" output
  // discipline block to every role's system prompt to cut output tokens
  // by ~50-65% without losing substance. Default on for POC.
  terseOutputs: optional('TERSE_OUTPUTS', '1') === '1',

  // Cap on how many /iterate cycles a single PR can consume. Each coder
  // push to the same branch counts as one iteration (detected by the
  // coder-commit marker). Exists to stop infinite feedback loops when
  // the reviewer keeps finding issues the coder can't fix.
  maxIterations: Number(optional('ITERATE_MAX', '3')),

  // Git author identity used when the coder + coder-iterate roles
  // commit. Configurable so the frame deployment can present commits
  // under a frame-owned identity. Defaults preserve baglessdev for
  // backward compatibility. Once the GitHub App migration lands
  // (Theme F), the App's installation token will provide the canonical
  // identity per role and these values become a fallback.
  gitAuthorName: optional('GIT_AUTHOR_NAME', 'agent'),
  gitAuthorEmail: optional('GIT_AUTHOR_EMAIL', 'agent@baglessdev'),
};
