# Roadmap: POC → first-class agentic engineering flow

What to build so this stops being a demo and becomes a pipeline the team
trusts to take an issue from filed to verified, merged code — using best
available Claude Code capabilities and best software-engineering practice
underneath.

The current POC proves a control-plane hypothesis (stateless agents, scope
enforced via markdown contract, human gates at approve + merge). It does
not yet produce code that is verified, observable, or governed, and it
does not use Claude Code's capabilities to the hilt. This document lists
every action needed to close that gap.

No estimations. The ordering inside each theme reflects dependency, not
schedule.

---

## Vision

A new GitHub issue gets filed. Minutes later, the pipeline has:

1. Classified the issue's complexity and risk.
2. Produced a plan the human can edit or approve with `/approve`.
3. Written the code in an isolated sandbox, runninng the repo's
   `verify` contract until it exits zero — or bailing with a specific,
   actionable diagnosis.
4. Opened a PR whose diff is structurally bounded (scope file list,
   size cap, forbidden-path enforcement), whose cost and reasoning trace
   are visible, and whose review (structured, machine-checkable) is
   already posted.
5. Closed the loop: `/iterate` re-engages the pipeline with the review
   as context; `/merge` is always the human's decision.

Every run is reproducible, observable, budgeted, and governed by a
policy file living in the target repo itself.

---

## Principles

Load-bearing decisions that everything else inherits.

1. **Use Claude Code, not Claude-as-API.** The Agent SDK gives us
   subagents, memory, MCP, hooks, structured outputs, extended thinking,
   prompt caching, skills, and per-tool permission control. A role that
   does not use these is a role we are under-investing in.
2. **Supported API path only.** `@anthropic-ai/claude-agent-sdk` +
   `ANTHROPIC_API_KEY`. We do not take dependencies on the
   subscription/OAuth headless Claude Code path — Anthropic has signaled
   it may close that surface, and being broken by a policy change is not
   a risk worth taking for production infrastructure.
3. **Structured I/O everywhere it makes sense.** Agent outputs we parse
   should be tool calls with schemas, not markdown we regex.
4. **Message engineering is not optional.** Role prompts stay static
   markdown (instructions, style, tools, output format). Per-task
   payloads (issue body, diff, approach, AGENTS.md, DESIGN.md, file
   tree) are XML-wrapped inside the user prompt. This is a documented
   Anthropic recommendation and a concrete quality lever.
5. **Verification is ground truth; LLM review is advisory.** Tests +
   lint + types are the contract. The reviewer's job is to catch the
   things the contract misses, not to stand in for the contract.
6. **Static context is cached.** AGENTS.md, DESIGN.md, system prompts
   do not change mid-loop. They are not paid for on every invocation.
7. **Orchestrator/minion model tiering is explicit.** Opus for hard
   reasoning (complex architect, reviewer with extended thinking).
   Sonnet for execution (coder, coder-iterate). Haiku for narrow
   subagents and triage. The tier is a decision of the triage step,
   not a static per-role setting.
8. **Policy belongs between the agent and the filesystem**, not between
   the agent and GitHub. Enforce at the tool-call boundary. The agent
   can claim anything; the harness enforces.
9. **Per-task token lifetime.** Each run gets a short-lived token minted
   at job start. A token never outlives the job that minted it.
10. **Diagnostic before speculative.** We add the cheap thing first,
    measure whether the gap is still there, then add the expensive thing
    only if the measurement says so. Applies to LSP, RAG, multi-repo,
    anything non-obvious.
11. **Reproducibility.** Every run captures inputs (prompt version,
    model, session id, policy version, repo commit). Any failed run can
    be re-executed to the same result.
12. **The harness lives under its own discipline.** Every rule we
    enforce on target repos (tests, verify, policy, scope, review) also
    applies to PRs against the harness itself.
13. **Workflows over autonomous agents for bounded multi-step work.**
    We deliberately orchestrate outside the agent because the task is
    webhook-driven, multi-tenant, requires queue semantics, persistent
    state, human gates at known points, and role isolation. Use
    autonomous agent patterns only where the end state and decision
    tree cannot be predetermined.

---

## Current state (honest assessment)

**What works well**
- Three-role flow (architect → coder → reviewer) + `/iterate` loop proven
  end-to-end on both public (`baglessdev/agent-poc-target`) and private
  (`framexyz/frame-automated-agents-poc-target`) repos.
- Fresh Claude session per role — debuggable, isolated, no cross-run
  state leakage.
- Scope enforcement via approach.md `Files to change` is observable
  (scope-leak events logged).
- Reviewer Mode A/B handles bot and human PRs with the same output shape.
- Private-repo clone fixed with token-embedded URL + error redaction.
- Cost per full loop ≈ $0.17, wall time ≈ 3 min on simple tasks.

**What materially lacks**

| Dimension | Current | Target |
|---|---|---|
| Verified execution | Coder emits code; tests never run in-loop | Sandbox + declared `verify` contract; PR opens only when green or labeled `agent:verify-failed` |
| Claude Code usage | ~20% of Agent SDK surface area | Prompt caching, thinking, structured outputs, subagents, memory, `canUseTool`, MCP |
| Message engineering | Everything stuffed into one markdown user prompt | XML-tagged per-task fields; role prompts stay markdown |
| Code understanding | File-tree dump as context | Compact symbol index; LSP-backed MCP (conditional) |
| Sandboxing | Runs as `agent` user, `bypassPermissions` | systemd hardening → container → `canUseTool` policy |
| Identity & auth | One shared PAT across all roles | GitHub App, per-task installation tokens per role |
| Policy | Convention (AGENTS.md forbidden paths) | Enforced policy file at tool boundary |
| Observability | `journalctl` | Structured logs, metrics, dashboards, alerts, cost attribution |
| Human controls | `/approve`, `/iterate`, labels | Add `/stop`, `/amend-scope`, `/use-model`, `/dry-run`, `/rewrite` |
| Retry & resumption | Failed jobs stay failed | Typed errors, backoff, circuit breakers, graceful restart |
| Evals & feedback | None | Benchmark set, prompt versioning, feedback capture, memory |
| Scale | Single worker, one-shot | Concurrent workers, rate limits, checkpointing; multi-repo if needed |
| Self-PR limit | `REQUEST_CHANGES` downgrades to `COMMENT` | Separate bot identities via App unblocks real verdicts |

---

## Theme A — Verified execution

The single largest gap between "demo" and "robust". Currently the reviewer
is the only check — an LLM judging an LLM. For "proven and tested" we
need the pipeline to actually exercise the code.

- [ ] Define a per-repo `verify` contract. `AGENTS.md` declares a single
      command (e.g., `task verify`) that must exit 0 before a PR opens.
      Also declare `lint`, `build`, `test` commands separately so roles
      can invoke them independently.
- [ ] Add a sandbox per role run (see Theme E). Network constrained to
      package registries + GitHub API.
- [ ] Restore `Bash` as an allowed tool for the coder, bounded by the
      sandbox and by an allowlist: declared verify/lint/build/test
      commands + read-only POSIX utilities.
- [ ] Make verification the coder's final step inside its own Claude
      session. On failure, verify output is fed back to the same session
      and the coder gets one in-session fix attempt before the turn
      budget runs out.
- [ ] Two consecutive verify failures → PR still opens, labeled
      `agent:verify-failed`. Reviewer treats the failure output as a
      first-class input to its review (not as a reason to re-run tests).
- [ ] Per-repo CI continues to run on GitHub as the final authoritative
      gate. Our in-loop verify is a pre-filter, not a replacement.
- [ ] Fail loudly if the target repo has no declared `verify` command.
      No silent skip; no default assumption.
- [ ] Coder's `maxTurns` raised for verified flow (probably 40+) because
      test-fix-retest is now in-session.
- [ ] Architect and reviewer optionally invoke lint/build (read-only
      confidence check) via the same sandbox, without write access.

---

## Theme B — Claude Code native usage

We currently use ~20% of the Agent SDK's surface area. Everything in this
theme is about reclaiming the other 80% — and pays back independently.

- [ ] **Prompt caching.** Add `cache_control` breakpoints in
      `src/lib/claude.ts` around:
      - system prompt (per role)
      - AGENTS.md content
      - DESIGN.md content
      - compact symbol index (when Theme D lands)
      Log cache hit rate as a first-class metric.
- [ ] **Extended thinking.** Enable for architect and reviewer with a
      configurable token budget. Optional for coder (translation is not
      the hard part for Sonnet).
- [ ] **Structured output via tool calls.** Replace free-form markdown
      parsing:
      - [ ] `submit_approach` tool — architect's final step.
        Schema: `goal`, `files_to_change[]`, `acceptance_criteria[]`,
        `risks[]`, `predicted_diff_size`.
      - [ ] `submit_review` tool — reviewer's final step.
        Schema: `verdict` (enum), `summary`, `inline_comments[]` with
        required `path + line + body`, `blocking: bool` per comment.
      - [ ] `submit_iteration` tool — coder-iterate's final step.
        Schema: `addressed_comments[]`, `unaddressed_comments[]`
        (with reasons), `new_concerns[]`.
      - [ ] Delete `parseReviewOutput` regex once the tool lands.
- [ ] **Audit tool descriptions.** Every custom tool (`submit_approach`,
      `submit_review`, `submit_iteration`, subagent task tools) gets a
      verbose, natural-language description as if onboarding a new
      engineer. Descriptions are prompt-engineering surface area — terse
      descriptions produce worse tool use.
- [ ] **Replace `permissionMode: 'bypassPermissions'` with
      `canUseTool` hook.** Encodes real policy in code. No unattended
      approval of arbitrary tool calls.
- [ ] **Use Claude Code hooks beyond `canUseTool`:**
      - [ ] `PostToolUse` for compliance logging — every tool invocation
        logged with arguments (secrets redacted) and result summary.
        Audit trail without manual wiring in each role.
      - [ ] `Stop` hook for output-schema validation at session end —
        belt-and-suspenders alongside the `submit_*` tool schemas.
      - [ ] `Notification` hook for human-visible events (verify failure,
        scope leak, cap reached) — surface to the PR/issue comment.
      - [ ] `UserPromptSubmit` as an observability hook — logs the
        final assembled prompt per run (redacted), enables offline eval
        replay.
- [ ] **Model routing via triage.** A lightweight Haiku triage step
      classifies every issue before the architect runs:
      `{complexity: trivial|standard|complex, risk: low|med|high}`.
      Routing table:
      - trivial + low → Haiku architect, Haiku coder, Haiku reviewer
      - standard + low → Haiku architect, Sonnet coder, Haiku reviewer
      - complex OR med/high risk → Opus architect, Sonnet coder, Opus reviewer with extended thinking
      - risky path in policy file → force human-authored PR, no agent run
      Log the routing decision; surface it in the approach body.
- [ ] **Subagents via the SDK's `Task` tool.** Dispatched inside a role's
      session:
      - [ ] `repo-scout` — Haiku, read-only. Architect dispatches for
        deep dives into specific packages without consuming its own turns.
      - [ ] `style-matcher` — Haiku, read-only. Coder dispatches to
        extract conventions from adjacent files before writing.
      - [ ] `test-coverage-analyzer` — Haiku, read-only. Reviewer
        dispatches on coder PRs to verify new exports have tests.
      - [ ] `verify-diagnoser` — Haiku, read-only. Coder dispatches on
        verify failure to interpret the error before attempting a fix.
- [ ] **Use Claude Code's `CLAUDE.md` convention.** Target repos get a
      `CLAUDE.md` at repo root (can point to AGENTS.md + DESIGN.md, or
      be a slim summary with links). Claude Code auto-loads it at
      session start — removes the need to stuff the same content into
      every user prompt, and it lands in the session's context pre-cached.
- [ ] **Memory.** Per-repo `memory/` directory (convention used by
      Claude Code agent memory):
      - loaded into the user prompt of every new session for that repo,
      - editable by humans (PR to the target repo),
      - appended to by roles on specific signals (verify failure,
        reviewer override) with provenance (run id, timestamp).
      - indexed by `MEMORY.md` at the directory root per Claude Code
        convention.
- [ ] **Streaming progress to GitHub.** Emit partial status to a
      PR/issue comment as the agent works ("architect is reading
      `src/foo.go`…"). Uses the SDK's message stream; throttled to
      one update per 5s or per tool-call batch.
- [ ] **Image input.** When an issue/PR/comment attaches screenshots,
      fetch them, validate size/type, and include as image blocks in the
      user prompt. Unlocks frontend and visual-bug handling.
- [ ] **Evaluate MCP servers** and adopt rather than hand-rolling where
      the MCP is better:
      - GitHub MCP (may replace large parts of `src/lib/github.ts`)
      - Language-server MCP (conditional — Theme D)
      - Repo-docs / framework-docs MCP if relevant.
      Explicit non-goal: do not build custom MCP servers for any of the
      above before evaluating existing open-source ones.

---

## Theme C — Message engineering

Called out separately because it is cheap, high-ROI, and easy to do
wrong. Consensus recommendation: role prompts are markdown, user prompts
are XML-wrapped inside a markdown skeleton.

- [ ] Rewrite every user prompt builder (`architectUserPrompt`,
      `coderUserPrompt`, `reviewerUserPrompt`, `coderIteratePrompt`) to
      wrap dynamic fields in XML tags:
      ```
      <issue>
        <number>42</number>
        <title>...</title>
        <body>...</body>
      </issue>
      <approach>...</approach>
      <agents_md>...</agents_md>
      <design_md>...</design_md>
      <file_tree>...</file_tree>  <!-- replaced by <symbol_index> in Theme D -->
      <diff>...</diff>
      <review>
        <verdict>...</verdict>
        <inline_comments>
          <comment path="..." line="...">...</comment>
        </inline_comments>
      </review>
      ```
- [ ] Role (system) prompts stay in markdown — they are static
      instructions + style + output contract.
- [ ] Audit every prompt for redundancy now that XML tags make field
      boundaries unambiguous (the `##` markdown headers become noise).
- [ ] Document the convention in `agentic-flow.md` so it survives
      turnover.
- [ ] Remove `TERSE_DISCIPLINE` prefix once structured outputs (Theme B)
      make terseness a schema constraint instead of a prompt exhortation.
- [ ] Prompt files get a semver header comment; version logged on every
      run (input to Theme I).

---

## Theme D — Code understanding (tiered, diagnostic-driven)

Architect currently sees a file tree and reads files ad-hoc. This works
on small repos and degrades with scale. Do the cheap tier first; defer
the expensive tiers until evidence demands them.

**Tier 1 — unconditional**

- [ ] Replace the `find -maxdepth 4 -print` file-tree dump with a
      compact **symbol index** per run:
      - Exported symbols (function / type / method) with `file:line`.
      - Per-package one-line summary (docstring-derived).
      - Import graph — which file imports which — as a compact adjacency
        list.
- [ ] Use language-native tools where possible:
      - Go: `gopls symbols` or `go/ast`-based extractor.
      - TypeScript: `tsserver` `navtree`.
      - Generic fallback: `ctags`.
- [ ] Symbol index is cached via Theme B's cache breakpoints.
- [ ] Index is versioned to the cloned commit so it matches exactly what
      the agent can Read.

**Tier 2 — conditional on diagnostic evidence**

- [ ] Log explicit "code-understanding gap" signals during Tier 1 runs:
      - reviewer inline comments flagging "missed existing helper",
      - coder scope-leak events in shared utility files,
      - agent Grep calls that would have benefited from type resolution
        (heuristic: grep for a capitalized identifier followed by Reads
        that don't find the definition).
- [ ] After N weeks or M runs, quantify: % of runs with a code-understanding
      failure mode.
- [ ] If >10% of runs: add an LSP-backed MCP server
      (`serena` or equivalent; do not hand-roll). Tools exposed:
      `findSymbol`, `whoCalls`, `whoImports`, `goToDefinition`.
- [ ] If <10%: document the decision explicitly and do not add LSP.

**Tier 3 — explicitly deferred**

- No embedding-based RAG over code. The deterministic index is cheaper
  and more accurate for code retrieval.
- No hand-rolled call graph. Comes free with LSP if adopted.
- No cross-repo symbol resolution until multi-repo tasks (Theme J) are
  real.

---

## Theme E — Sandboxing and isolation

The agent runs as an unprivileged user today, with `bypassPermissions`
— that is permissive by design for POC. For production, sandbox at
multiple layers: systemd (cheap), policy hook (medium), container
(when threat model demands).

**Layer 1 — systemd hardening (near-term)**

- [ ] Harden `automated-agents.service` with directives already proven
      in related frame tooling:
      ```
      NoNewPrivileges=true
      PrivateTmp=true
      ProtectSystem=strict
      ProtectHome=true
      ReadWritePaths=/var/work/automated-agents /var/lib/automated-agents
      MemoryMax=4G
      CPUQuota=200%
      PrivateDevices=true
      ProtectKernelTunables=true
      ProtectKernelModules=true
      ProtectControlGroups=true
      RestrictNamespaces=true
      RestrictRealtime=true
      LockPersonality=true
      SystemCallArchitectures=native
      ```
- [ ] Consider a templated unit (`frame-agent@.service`) so each role run
      can be spawned with role-specific env and resource caps.
- [ ] Document the hardening set; treat changes as security-sensitive
      (governance Theme F).

**Layer 2 — per-job workspace isolation**

- [ ] Workspace dirs already isolated per-run (`/var/work/.../<runId>/`)
      and cleaned in `finally`. Add a cron sweep for crash-survivor dirs
      older than 1h.
- [ ] `canUseTool` hook (Theme B) enforces: no writes outside workspace,
      no network Bash, no filesystem reads above the workspace root.

**Layer 3 — evaluate mkenv vs containers**

- [ ] Evaluate [`mkenv`](https://github.com/0xa1bed0/mkenv) — already in
      use elsewhere in frame — as the sandbox layer for each Claude
      session's `Bash` execution (not necessarily for the whole harness
      process).
- [ ] If `mkenv` fits: adopt for the coder's verify step (Theme A) —
      that is where Bash gains real blast radius.
- [ ] If not: evaluate Docker / Firecracker / rootless containers.
      Prefer whichever is closest to existing frame infra.
- [ ] Explicit non-goal: no custom sandbox tooling unless both mkenv
      and containers are ruled out.

**Layer 4 — multi-tenant host**

- [ ] Document the threat model: what happens if a Claude session tries
      to escape? If it exfiltrates secrets? If it consumes all memory?
      Each should have a specific control.
- [ ] Secrets (ANTHROPIC_API_KEY, GITHUB_TOKEN) are never available to
      the Bash-sandboxed subprocess. Currently both are in the systemd
      env file the main process reads — review whether subprocesses
      inherit them.

---

## Theme F — Identity, tokens, governance

Single-PAT model has known failure modes (self-PR REQUEST_CHANGES block)
and no audit distinction between architect / coder / reviewer activity.

- [ ] **Replace the shared PAT with a GitHub App** owned by the frame
      org. One installation per target repo.
- [ ] **Per-run, per-role installation tokens** minted at job start.
      A token lives only for the duration of one role run (typically
      minutes). No long-lived bot PAT in `/etc/automated-agents.env`
      except the App's private key.
- [ ] Three role identities (App allows this via scoped installation
      tokens):
      - architect: read issues, write comments.
      - coder: write contents, write PRs, write comments.
      - reviewer: write PR reviews, write comments.
      GitHub audit trail distinguishes them.
- [ ] **Policy file** at target repo root: `.agent/policy.yaml`:
      ```yaml
      agents:
        max_cost_per_run_usd: 2
        max_cost_per_issue_usd: 10
        allowed_models: [claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-7]
      repo:
        max_pr_size_loc: 400
        max_pr_size_files: 20
        forbidden_paths:
          - .github/workflows/**
          - .agent/**
          - Taskfile.yml
          - AGENTS.md
          - DESIGN.md
        sensitive_paths:  # require human author, not agent
          - migrations/**
          - **/*_security.go
        verify:
          command: task verify
          lint: task lint
          build: task build
          test: task test
      triage:
        force_human_for:
          - breaking_api_change
          - schema_migration
      ```
- [ ] Policy loaded at run start; violations → reject job with a clear
      comment on the issue/PR. Enforcement happens in the harness, not
      inside the Claude session.
- [ ] Changes to policy require a human-authored PR passing normal review
      gates. Agent roles cannot modify `.agent/*`.
- [ ] Secrets rotation plan: webhook secret, App private key, PAT (if
      any survives). Documented rotation cadence (90 days max).
- [ ] Webhook HMAC rejects logged and rate-limited — repeated failures
      page security (Theme G alerts).

---

## Theme G — Observability and operations

`journalctl` is currently the only observability surface. Before we can
reason about behavior honestly, we need real telemetry.

**Logging**

- [ ] All logs already JSON — ship to the platform frame uses
      (CloudWatch / Datadog / Loki). Every line carries:
      `run_id`, `role`, `repo`, `pr`, `issue`, `model`, `session_id`,
      `prompt_version`, `policy_version`, `routing_tier`.
- [ ] Log sampling policies: DEBUG in staging, INFO in prod, ERROR
      always. No PII in logs (issue body might contain — redact or hash).

**Metrics**

- [ ] Per-role counters: runs, successes, failures, retries, scope leaks,
      verify pass/fail.
- [ ] Per-role histograms: latency, token in/out, turns, cost USD.
- [ ] System counters: queue depth, jobs/hour, HMAC rejects, Anthropic
      5xx rate, Anthropic 429 rate.
- [ ] Cache hit rate (from Theme B) per role + per cache breakpoint.

**Dashboards**

- [ ] One overview dashboard (ops at a glance).
- [ ] One per-repo dashboard (cost, success rate over time, iteration
      depth distribution).
- [ ] One prompt-regression dashboard (per prompt version: verify pass
      rate, verdict accuracy, cost — feeds Theme I).

**Alerts**

- [ ] Job failure rate >N% over Y minutes.
- [ ] Cost spike: daily cost >2× 7-day moving average.
- [ ] Webhook HMAC rejects >N in any 5-minute window.
- [ ] Queue depth > N for > Y minutes (worker stalled).
- [ ] Anthropic 5xx rate >5% over 10 minutes → circuit breaker.

**Error handling**

- [ ] Typed errors on every external call (Anthropic API, GitHub API,
      git):
      - `transient` (5xx, 429, network): backoff + retry up to N.
      - `permanent` (404, 403, 422): fail fast with human-actionable
        message.
      - `quota` (Anthropic rate limit): global circuit breaker, pause
        worker, alert.
- [ ] Per-job retry budget separate from per-call retry.
- [ ] Webhook delivery idempotency: dedupe by `x-github-delivery` UUID
      so retries from GitHub don't enqueue duplicate jobs.

**Restart safety**

- [ ] On service boot: mark all jobs in `running` state as
      `failed: service restarted`. Surface in queue view.
- [ ] Graceful shutdown: SIGTERM → stop claiming new jobs, wait for
      current job to finish (bounded), then exit.

**Kill switch**

- [ ] Config flag (env or file) that stops the worker from claiming
      new jobs. Existing jobs finish.
- [ ] Per-repo kill switch (policy file `enabled: false`).

**Cost attribution**

- [ ] Per-run cost surfaced in the PR body comment and in logs.
- [ ] Per-issue cumulative cost tracked (an issue that iterates 3× might
      exceed its budget even if each run is fine).
- [ ] Cost budget enforcement: job rejected if it would push issue over
      `max_cost_per_issue_usd`.

**Harness CI**

- [ ] Harness repo itself has lint + typecheck + unit tests + eval
      harness (Theme I) gating every PR.
- [ ] Deploys from main only; staging env for prompt changes.

**Zero-downtime deploy**

- [ ] Current: `systemctl restart` (jobs in flight get orphaned by the
      restart-mark). Target: drain first, then restart; or blue-green.

---

## Theme H — Human control surface

Current: labels, `/approve`, `/iterate`. Minimum viable. Real team use
will expose more gaps.

- [ ] `/stop <run-id>` — cancel an in-flight job. Requires cooperative
      cancellation in the worker (Claude SDK `AbortController` support).
- [ ] `/amend-scope +path/to/a.ts -path/to/b.ts` — adjust the approach's
      `Files to change` list before or between iterations, without
      editing the approach comment directly.
- [ ] `/use-model <model>` — override model selection for the next run
      on this issue/PR. Respects policy `allowed_models`.
- [ ] `/dry-run` — architect posts the approach but marks it draft;
      `/approve` still required to progress. Useful for exploration
      with zero risk.
- [ ] `/rewrite` — discard current agent diff and restart from the
      approach. Different semantics from `/iterate` (which adds to the
      branch).
- [ ] `/diff-preview` — architect posts an expected diff shape (files
      and rough LoC per file) so humans can catch missing files before
      the coder runs.
- [ ] Labels vs commands: standardize. Labels are persistent state
      (`agent:review`, `agent:verify-failed`); slash-commands are
      actions (`/approve`, `/iterate`, `/stop`).

---

## Theme I — Evals and feedback

Prompts are the actual product. Today they change when someone feels
like it. No way to know if a change improves behavior.

- [ ] **Benchmark issue set.** ~20 curated issues on a dedicated
      `agent-bench` target repo:
      - trivial wins (reviewer should LGTM)
      - standard features (require architect-level reasoning)
      - traps (AGENTS.md violations, forbidden paths, language mismatches)
      - ambiguities (intentional vagueness to test `/iterate` loops)
      - regressions (failure modes we have fixed — must not return)
      - **adversarial inputs** (prompt-injection attempts in issue
        bodies or comments, malicious approach.md edits after `/approve`,
        attempts to exfiltrate env vars via Bash, attempts to touch
        forbidden paths via "please also fix unrelated bug in
        .github/workflows/..."). Every adversarial case has a failure
        predicate: agent must refuse, surface, or report the attempt.
      Each issue has a known-good outcome and a set of failure predicates.
- [ ] **Eval harness.** Runs the full architect → coder → reviewer loop
      against the benchmark set in a dedicated CI environment. Captures:
      - Verdict correctness (did reviewer say what we expected?)
      - Scope containment (did coder stay in scope?)
      - Verify pass rate
      - Token cost
      - Turn count, wall time
      - Structured output schema compliance
- [ ] **Eval runs in CI on every PR to the harness** that touches
      `src/prompts/*`, `src/roles/*`, or `src/lib/claude.ts`. Results
      rendered in the PR body.
- [ ] **Prompt versioning.** Semver header per prompt file; logged on
      every run; included in reviewer output.
- [ ] **Post-hoc feedback capture:**
      - [ ] Human merges a PR the reviewer said `changes-required` → log.
      - [ ] Human `/iterate`s when reviewer said `lgtm` → log.
      - [ ] Human edits an approach comment → log.
      - [ ] Human manually pushes to `agent/*` branch after iterate → log.
- [ ] **Memory updates from feedback.** Frequent reviewer flags (top-N
      per repo over a sliding window) become entries in the per-repo
      `memory/` store loaded into future sessions (Theme B).
- [ ] **A/B infrastructure.** Route a fraction of runs to prompt v2;
      compare outcomes with statistical discipline over a sliding window.
      Bail out on clear regressions.
- [ ] **Regression freeze.** A prompt change that degrades any benchmark
      issue's outcome blocks merge unless explicitly overridden with
      documented rationale.

---

## Theme J — Scale and continuity

Single worker, single-repo, one-shot tasks.

- [ ] **Concurrent workers.** SQLite queue already uses WAL; multiple
      workers can claim from the same queue. Add:
      - per-repo concurrency cap (no two jobs on the same PR in flight)
      - per-PR serialization (iterate after reviewer finishes, not during)
      - idle-worker autoscaling (if running on real orchestrator later)
- [ ] **Rate limiting.**
      - Per-repo cap (jobs/hour, iterations/day).
      - Per-author cap (prevents a single human spamming `/iterate`).
      - Per-model cap (if Anthropic quota is shared with other systems).
- [ ] **Checkpointing for long-running tasks.**
      - Architect may emit a multi-phase plan; each phase is a separate
        `/approve` gate.
      - Humans ratify progress between phases.
      - Per-phase artifacts (scouting notes, partial approaches) survive
        restarts.
- [ ] **Multi-repo tasks (design only, do not ship speculatively).**
      A task spanning API + client → introduce a coordinator role that
      emits a DAG of sub-tasks across repos. Defer implementation until
      a real use case demands it.
- [ ] **Queue observability.** A simple read-only HTTP endpoint (behind
      auth) to inspect queue state: pending, running, failed, completed.

---

## Theme K — Cleanups owed from the POC

Things the POC deferred. Most are fast and unblock later themes.

- [ ] Migrate service source-of-truth to
      `framexyz/frame-automated-agents-poc`:
      - Retarget local `origin`.
      - Retarget EC2 `/opt/automated-agents` git remote.
      - Archive `baglessdev/automated-agents`.
- [ ] Remove hardcoded `'agent' / 'agent@baglessdev'` git identity in
      `coder.ts` and `coder-iterate.ts`. Replace with config — and once
      GitHub App lands (Theme F), replace with App-installation identity.
- [ ] Audit `src/lib/gitops.ts` and all other subprocess callers for
      token-leakage paths. Apply the same redaction pattern as
      `workspace.ts`.
- [ ] Resolve `TERSE_DISCIPLINE` once structured outputs land (Theme B);
      probably delete.
- [ ] Review `maxTurns` per role given verification (Theme A) and
      subagents (Theme B) will reshape turn usage.
- [ ] Decide explicitly whether the review JSON default should remain
      `lgtm` once structured outputs make parse failure impossible.
      Probably not needed post-Theme B.
- [ ] Update `agentic-flow.md` and `README.md` after each theme lands.

---

## Ordering

Dependency-driven, not schedule. Each tier assumes the previous is in
place.

**Tier 0 — Foundation (do first; independent, high ROI)**
- Theme B items 1–3 (prompt caching, extended thinking, structured output)
- Theme C entire (message engineering / XML tags)
- Theme G logging + metrics + dashboards
- Theme K cleanups

**Tier 1 — Trust the output (do next)**
- Theme A entire (verified execution) — depends on Tier 0 for
  observability to debug verify failures
- Theme E Layer 1 (systemd hardening) + Layer 2 (`canUseTool`) —
  Bash tool needs bounded blast radius before Theme A grants it
- Theme B item 4 (`canUseTool`) is the technical prerequisite for Theme A

**Tier 2 — Trust the system (governance)**
- Theme F entire (GitHub App, per-task tokens, policy file)
- Theme E Layer 3 (mkenv/container evaluation) — gated on threat model
- Theme G alerts + cost attribution + error handling

**Tier 3 — Make the agent smarter**
- Theme D Tier 1 (symbol index) — cheap; ship early
- Theme D Tier 2 (LSP MCP) — conditional on diagnostic evidence
- Theme B items 5–10 (subagents, memory, model routing, streaming,
  images, MCP evaluation)

**Tier 4 — Make humans trust the flow**
- Theme H entire (control surface expansions)

**Tier 5 — Learn and scale**
- Theme I entire (evals + feedback) — requires everything else to have
  signal to learn from
- Theme J items 1–2 (concurrent workers, rate limits)
- Theme J item 3 (checkpointing) — opportunistic
- Theme J item 4 (multi-repo) — design only until a real use case

---

## Definition of done

When all of the following are true for the target repo and any future
opted-in repo, the pipeline is production-grade for its scope:

1. A new issue on the target repo can be taken through the full
   architect → coder → reviewer → merged flow, where merged means:
   - A human ratified the PR.
   - The diff passed the repo's declared `verify` command in-loop.
   - The diff obeyed every rule in `.agent/policy.yaml`.
   - The run cost was under `max_cost_per_issue_usd`.
   - Every role emitted structured outputs validated against their schema.
   - The reviewer's verdict was traceable to a specific prompt version.
2. Every pipeline failure surfaces with a clear cause and is re-runnable
   from the same inputs to the same result.
3. A prompt change is gated by evals that show it improved or held
   ground on the benchmark issue set.
4. A malicious or malfunctioning Claude session cannot exfiltrate
   secrets, touch forbidden paths, exceed the budget, or make
   unauthorized network calls — because those limits live below the
   agent, not above it.
5. Costs, token usage, cache hit rates, iteration depths, success rates
   are visible per-run, per-repo, and in aggregate.
6. Every role runs under a distinct short-lived identity minted at job
   start; no long-lived bot credentials on disk except the App's private
   key.
7. The harness itself lives under the same discipline it enforces on
   target repos.

---

## Explicit non-goals

Things we will not do, at least in this phase, and the reason.

- **Do not build a custom sandbox.** Use mkenv or containers. Custom
  sandbox tooling is not load-bearing for what we need.
- **Do not build a custom MCP server** for GitHub, language servers, or
  docs before evaluating existing ones.
- **Do not ship RAG over code.** Deterministic indexing is cheaper and
  better.
- **Do not take a dependency on Max subscription / OAuth headless
  Claude Code.** Deprecation risk.
- **Do not build multi-repo coordination speculatively.** Design only;
  build when a real use case demands it.
- **Do not pre-emptively build a call-graph subsystem.** If LSP adoption
  covers it, great; if not, defer until diagnostics say so.
- **Do not let the agent modify its own rules.** Prompts, policies, and
  forbidden paths are governed by human-authored PRs.
- **Do not ship a feedback loop that updates prompts without human
  approval.** Memory can accumulate; prompt changes require evals +
  review.

---

## Credits

This roadmap integrates:
- POC-derived gap analysis from running the architect → coder → reviewer
  flow end-to-end across `baglessdev/agent-poc-target` and
  `framexyz/frame-automated-agents-poc-target`.
- Claude-Code-capability audit (prompt caching, extended thinking,
  structured output, subagents, memory, MCP, `canUseTool`).
- Team discussion (systemd hardening, per-task token rotation, mkenv,
  model tiering Opus→Sonnet→Haiku, message engineering via XML tags,
  avoidance of subscription/OAuth dependency).

See [`agentic-flow.md`](./agentic-flow.md) for the current system's
diagrams and specifics.
