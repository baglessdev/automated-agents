# automated-agents

Webhook-driven coding-agent service. One Node/TypeScript process handles
GitHub webhooks from a target repo and dispatches three roles —
**architect**, **coder**, **reviewer** — plus an iteration loop, each
running as a fresh Claude Code session via
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

For flow diagrams and per-component detail, see
[**agentic-flow.md**](./agentic-flow.md).

---

## What it does

| Event on target repo | Role fired | Outcome |
|---|---|---|
| Label `agent:arch` on issue | architect | Posts an `approach.md` comment (`Files to change` + acceptance criteria) |
| `/approve` comment on issue | coder | New `agent/*` branch, PR opened with embedded approach |
| Bot PR opened / synchronized | reviewer | Verdict + up to 5 inline comments |
| Label `agent:review` on human PR | reviewer | Same output shape, "general mode" (no approach required) |
| `/iterate` comment on a PR | coder_iterate | Fresh session addresses latest review, pushes to same branch |

Hard caps:
- `ITERATE_MAX` — default 3 (counted via `agent-iterate:` commit trailer).
- `maxTurns` per Claude session — 20–25 depending on role.
- One-job-at-a-time worker; SQS FIFO-backed queue with DLQ.

Every role spawns a **fresh** Claude subprocess — no `--resume`, no shared
conversation state. See the "Session isolation" section of `agentic-flow.md`.

---

## Recent improvements (Phase 5)

The Phase 5 sprint reclaimed ~80% of the Agent SDK's surface area we
weren't using. Each item is a separate commit on `main`; see
[`roadmap.md`](./roadmap.md) for the full multi-phase plan.

| Tag | Change |
|---|---|
| **B1** | Cache + cost metrics per run. Logs `cacheRead`, `cacheCreation`, `costUsd` from the SDK's result message. Verified live: post-warm runs ~65% cheaper than cold. |
| **B2** | Extended thinking enabled on architect + reviewer (configurable budget). Roughly doubles wall time on judgment-heavy roles in exchange for better plans / reviews. |
| **C1–C4** | All four user-prompt builders rewritten with XML-tagged dynamic fields (`<issue>`, `<approach>`, `<diff>`, …) inside a markdown skeleton. Stable prefix → cleaner cache reuse + ~11% steady-state cost reduction. |
| **C7+C8** | Each prompt file carries a semver `*_PROMPT_VERSION`; logged on every `claude_done` event for eval / regression attribution. |
| **B3–B6** | Structured output via JSON schema. Architect, reviewer, coder-iterate emit machine-validated objects (`Approach`, `Review`, `Iteration`); harness builds the markdown artifacts via dedicated renderers. `parseReviewOutput` regex deleted. |
| **K4** | Git author identity (`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`) is now configurable instead of hardcoded. |

### Notable workaround — `parameter` envelope

Sonnet 4.5 consistently wraps its `StructuredOutput` tool_use input as
`{ "parameter": <actual_object> }` regardless of the schema we pass.
The SDK's Ajv validator checks against the unwrapped schema and every
retry fails identically, exhausting the 5-attempt budget
(`error_max_structured_output_retries`). We work around this in
`src/lib/claude.ts` by wrapping the schema with a `parameter` envelope
before sending and unwrapping on receive. Roles see no change. If the
model behavior shifts in a future Claude version, the wrap/unwrap can
be deleted.

---

## Architecture at a glance

```
GitHub webhooks
      │
      ▼
 Express /webhook  ──► HMAC verify ──► SendMessage (FIFO, dedup on
                                          │           x-github-delivery)
                                          ▼
                                SQS FIFO queue (+ DLQ)
                                          │
                                          ▼
                                 Worker loop (one job at a time,
                                              long-poll receive,
                                              heartbeat-extend visibility)
                                          │
                       ┌──────────────────┼──────────────────┐
                       ▼                  ▼                  ▼
                  runArchitect        runCoder          runReviewer
                                  runCoderIterate
                       │
                       ▼
              Fresh per-run workspace
              (clone → Claude session → GitHub API → cleanup)
```

---

## Environment

Required `.env` (loaded from `/etc/automated-agents.env` under systemd):

```
GITHUB_WEBHOOK_SECRET=<hex secret>
GITHUB_TOKEN=<PAT with repo scope on the target>
ANTHROPIC_API_KEY=<key>
SQS_QUEUE_URL=<FIFO queue URL — Pulumi outputs `queueUrl`>
```

Optional (sensible defaults exist):

| Var | Default | What |
|---|---|---|
| `PORT` | `8080` | Webhook listener |
| `WORKSPACE_ROOT` | `/var/work/automated-agents` | Temp clones per run |
| `AWS_REGION` | `us-east-1` | Region the SQS queue lives in |
| `SQS_VISIBILITY_TIMEOUT` | `900` | Initial visibility timeout (s); worker heartbeat extends it for jobs that run longer |
| `SQS_WAIT_TIME` | `20` | Long-poll receive wait (s) |
| `SQS_HEARTBEAT_INTERVAL_MS` | `300000` | How often worker calls `ChangeMessageVisibility` for the in-flight job |
| `SQS_ENDPOINT` | _(unset)_ | Override for local dev (`http://localhost:9324` for ElasticMQ) |
| `ARCH_LABEL` | `agent:arch` | Label that fires architect |
| `ARCHITECT_MODEL` | `claude-haiku-4-5` | EC2 overrides to `claude-sonnet-4-5` so extended thinking + structured output engage |
| `CODER_MODEL` | `claude-haiku-4-5` | EC2 overrides to `claude-sonnet-4-5` — Haiku underperforms on multi-file tasks |
| `REVIEWER_MODEL` | `claude-haiku-4-5` | EC2 overrides to `claude-sonnet-4-5` — same reasoning as architect |
| `ARCHITECT_THINKING_BUDGET` | `5000` | Extended-thinking budget (tokens) for architect. Set 0 to disable. Requires Sonnet/Opus. |
| `REVIEWER_THINKING_BUDGET` | `5000` | Same for reviewer. Coder + coder-iterate intentionally have no thinking — translation work, not reasoning. |
| `TERSE_OUTPUTS` | `1` | Prepends a "caveman-style" discipline block to every role's system prompt |
| `ITERATE_MAX` | `3` | Cap on `/iterate` cycles per PR |
| `GIT_AUTHOR_NAME` | `agent` | Git author identity used by coder + coder-iterate when committing |
| `GIT_AUTHOR_EMAIL` | `agent@baglessdev` | Same |

---

## Local dev

The worker needs a FIFO queue. For local dev we run
[ElasticMQ](https://github.com/softwaremill/elasticmq) in Docker (no AWS
credentials needed):

```bash
docker compose up -d                       # ElasticMQ on :9324, queues created from elasticmq.conf
npm install
npm run build
GITHUB_WEBHOOK_SECRET=test \
GITHUB_TOKEN=ghp_xxx \
ANTHROPIC_API_KEY=sk-ant-xxx \
SQS_ENDPOINT=http://localhost:9324 \
SQS_QUEUE_URL=http://localhost:9324/000000000000/automated-agents-dev.fifo \
AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x \
  npm start
```

The FIFO queue and DLQ are pre-declared in `elasticmq.conf` and created
by ElasticMQ at boot. Verify with:

```bash
curl -s "http://localhost:9324/?Action=ListQueues"
```

Use `ngrok http 8080` or similar to expose `/webhook` to GitHub for
signature-verification testing without touching AWS.

`npm run dev` runs with `tsx watch` for iteration.
`npm run lint` is `tsc --noEmit`.

---

## Deploy

Single-file Pulumi stack at [`infra/index.ts`](./infra/index.ts) provisions:

- `t3.small` EC2, Ubuntu 24.04, EIP.
- Security group: 22 / 80 / 443 open to 0.0.0.0/0.
- IAM role with SSM core (so you don't need SSH keys).
- User-data installs Node 20, Caddy, and the systemd unit that runs the
  service as the `agent` user (non-root — `bypassPermissions` refuses under
  root).
- Caddy auto-provisions a Let's Encrypt cert for the instance's
  `<ip-dashed>.nip.io` hostname.

Secrets are set via `pulumi config --secret`:

```bash
pulumi config set --secret anthropicApiKey <key>
pulumi config set --secret githubWebhookSecret <hex>
pulumi config set --secret githubToken <pat>
pulumi up
```

To deploy code changes, push to `main`; the service pulls + rebuilds via
SSM (no CI yet):

```bash
aws ssm start-session --target <instance-id>
# inside:
cd /opt/automated-agents
sudo -u agent git fetch --quiet origin main
sudo -u agent git reset --hard origin/main
sudo -u agent npm ci
sudo -u agent npm run build
sudo systemctl restart automated-agents
```

---

## Target repo setup (one-time, per repo opted in)

1. Create labels: `agent:arch`, `agent:review`.
2. Add a webhook at `https://<ip-dashed>.nip.io/webhook` — content type
   `application/json`, same secret as `GITHUB_WEBHOOK_SECRET`, events:
   **Issues**, **Issue comments**, **Pull requests**.
3. Commit `AGENTS.md` + `DESIGN.md` at repo root (reviewer and coder both
   feed these into every Claude session as binding context).
4. Ensure `GITHUB_TOKEN` has Contents/Issues/PullRequests: write on the repo.

---

## Layout

```
src/
├── main.ts                 Express webhook + routes
├── worker.ts               Queue polling + role dispatch
├── config.ts               Env-var loader
├── types.ts                JobKind, payloads
├── webhook.ts              HMAC-SHA256 verification
│
├── queue/
│   ├── queue.ts            Queue interface (async)
│   └── sqs.ts              SQS FIFO impl (@aws-sdk/client-sqs)
│
├── lib/
│   ├── claude.ts           runClaude() — one SDK query per call
│   ├── github.ts           Octokit wrappers
│   ├── workspace.ts        Fresh clone + cleanup per run
│   ├── gitops.ts           Thin git wrappers (stage/commit/push)
│   └── approach.ts         Parse approach.md → Files-to-change list
│
├── prompts/
│   ├── architect.ts        System + user prompts, TERSE_DISCIPLINE, ARCHITECT_PROMPT_VERSION
│   ├── coder.ts            coder + coder_iterate prompts + versions
│   ├── reviewer.ts         Mode A (scope-enforced) + Mode B (general) + version
│   ├── schemas.ts          JSON schemas for structured outputs (B3–B5)
│   └── render.ts           Markdown renderers from structured outputs
│
└── roles/
    ├── architect.ts
    ├── coder.ts            Fresh branch → new PR
    ├── coder-iterate.ts    Same branch → new commit
    └── reviewer.ts         Mode A/B routing

infra/
└── index.ts                Single-file Pulumi stack
```

---

## Known limitations (POC)

- **Single GitHub identity for all roles.** Triggers GitHub's
  "can't REQUEST_CHANGES on your own PR" limitation — reviewer auto-downgrades
  to COMMENT and preserves the verdict in the body. Proper fix is a GitHub
  App or separate bot accounts per role.
- **No retries on logic failures.** `markFailed` deletes the SQS message
  immediately. Crashes (visibility-timeout expiry) get exactly one
  redelivery via the DLQ's `maxReceiveCount=2` redrive policy.
- **All three roles run on Sonnet 4.5** in the live deployment (env-overridden
  from the Haiku defaults). Required for extended thinking + structured
  output. Cost-per-full-loop went from ~$0.17 (Haiku-mostly era) to
  ~$0.89 with Sonnet across the board on a meatier issue. Triage-driven
  model routing (roadmap B13) will tier this back down.
- **Sonnet 4.5 wraps structured-output inputs in a `parameter` envelope.**
  Worked around in `claude.ts`; see "Notable workaround" above.

See [`agentic-flow.md`](./agentic-flow.md) for the full design and
diagrams, and [`roadmap.md`](./roadmap.md) for the next-phase plan.
