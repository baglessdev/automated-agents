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
- One-job-at-a-time worker; SQLite-backed queue.

Every role spawns a **fresh** Claude subprocess — no `--resume`, no shared
conversation state. See the "Session isolation" section of `agentic-flow.md`.

---

## Architecture at a glance

```
GitHub webhooks
      │
      ▼
 Express /webhook  ──► HMAC verify ──► enqueue job
                                          │
                                          ▼
                                SQLite queue (better-sqlite3)
                                          │
                                          ▼
                                 Worker loop (one job at a time)
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
```

Optional (sensible defaults exist):

| Var | Default | What |
|---|---|---|
| `PORT` | `8080` | Webhook listener |
| `WORKSPACE_ROOT` | `/var/work/automated-agents` | Temp clones per run |
| `QUEUE_PATH` | `/var/lib/automated-agents/queue.db` | SQLite queue file |
| `ARCH_LABEL` | `agent:arch` | Label that fires architect |
| `POLL_INTERVAL_MS` | `2000` | Worker idle poll |
| `ARCHITECT_MODEL` | `claude-haiku-4-5` | |
| `CODER_MODEL` | `claude-haiku-4-5` | (EC2 runs with `claude-sonnet-4-5` — Haiku underperforms on multi-file coder tasks) |
| `REVIEWER_MODEL` | `claude-haiku-4-5` | |
| `TERSE_OUTPUTS` | `1` | Prepends a "caveman-style" discipline block to every role's system prompt |
| `ITERATE_MAX` | `3` | Cap on `/iterate` cycles per PR |

---

## Local dev

```bash
npm install
npm run build
GITHUB_WEBHOOK_SECRET=test \
GITHUB_TOKEN=ghp_xxx \
ANTHROPIC_API_KEY=sk-ant-xxx \
  npm start
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
│   └── sqlite.ts           Job queue (better-sqlite3, WAL)
│
├── lib/
│   ├── claude.ts           runClaude() — one SDK query per call
│   ├── github.ts           Octokit wrappers
│   ├── workspace.ts        Fresh clone + cleanup per run
│   ├── gitops.ts           Thin git wrappers (stage/commit/push)
│   └── approach.ts         Parse approach.md → Files-to-change list
│
├── prompts/
│   ├── architect.ts        System + user prompts, TERSE_DISCIPLINE
│   ├── coder.ts            coder + coder_iterate prompts
│   └── reviewer.ts         Mode A (scope-enforced) + Mode B (general)
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
- **No retries on transient failures.** A failed job stays failed.
- **Architect and reviewer are Haiku.** Coder runs Sonnet — Haiku is
  insufficient on multi-file tasks.
- **Cost per full loop** ≈ $0.17, wall time ≈ 3 min. See the issue tracker
  for optimization plans.

See [`agentic-flow.md`](./agentic-flow.md) for the full design and diagrams.
