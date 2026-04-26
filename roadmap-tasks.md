# Roadmap — actionable tasks

Punch list of concrete deliverables derived from [`roadmap.md`](./roadmap.md).
Each item is intended to be one PR-sized unit of work. Rationale and
tradeoffs live in the main roadmap; this file is pure "what to do".

---

## First ten (do these before anything else)

1. Add prompt caching breakpoints in `src/lib/claude.ts`.
2. Enable extended thinking for architect and reviewer roles.
3. Define `submit_approach` / `submit_review` / `submit_iteration` tools
   with JSON schemas.
4. Rewrite user-prompt builders to use XML-tagged fields inside markdown.
5. Ship structured logs to a platform (CloudWatch / Datadog / Loki).
6. Instrument per-role metrics (latency, cost, tokens, success rate,
   cache hit rate).
7. Apply systemd hardening directives to the `automated-agents` unit.
8. Retarget local `origin` and EC2 `/opt/automated-agents` remote to
   `framexyz/frame-automated-agents-poc`; archive `baglessdev/automated-agents`.
9. Remove hardcoded `'agent' / 'agent@baglessdev'` git identity.
10. Add harness CI (lint + typecheck + unit tests) on the service repo.

---

## A. Verified execution

- [ ] A1. Declare `verify`, `lint`, `build`, `test` commands in target
      repo's `AGENTS.md`.
- [ ] A2. Add a sandbox layer for role runs (see Theme E).
- [ ] A3. Restore `Bash` for coder with allowlist (verify commands +
      read-only POSIX utilities).
- [ ] A4. Implement in-session verify step for coder; on failure feed
      output back for one fix attempt.
- [ ] A5. Add `agent:verify-failed` label + reviewer awareness.
- [ ] A6. Pass verify result (green/red + output) as first-class input
      to reviewer.
- [ ] A7. Raise coder `maxTurns` to accommodate verify-integrated flow.
- [ ] A8. Add optional read-only lint/build for architect and reviewer.
- [ ] A9. Fail-fast when target repo has no declared `verify` command.

---

## B. Claude Code native usage

- [ ] B1. Add `cache_control` breakpoints around system prompt,
      AGENTS.md, DESIGN.md, symbol index.
- [ ] B2. Enable extended thinking for architect + reviewer with
      configurable budget.
- [ ] B3. Define `submit_approach` tool + schema.
- [ ] B4. Define `submit_review` tool + schema.
- [ ] B5. Define `submit_iteration` tool + schema.
- [ ] B6. Delete `parseReviewOutput` regex after B3–B5 land.
- [ ] B7. Audit all custom tool descriptions for verbose, natural
      language.
- [ ] B8. Replace `permissionMode: 'bypassPermissions'` with
      `canUseTool` hook.
- [ ] B9. Add `PostToolUse` hook for compliance logging.
- [ ] B10. Add `Stop` hook for output-schema validation at session end.
- [ ] B11. Add `Notification` hook for human-visible events
      (verify failure, scope leak, cap reached).
- [ ] B12. Add `UserPromptSubmit` hook for offline eval replay.
- [ ] B13. Add Haiku triage step; implement model-routing table
      (Opus/Sonnet/Haiku by complexity + risk).
- [ ] B14. Implement `repo-scout` subagent (architect-dispatchable).
- [ ] B15. Implement `style-matcher` subagent (coder-dispatchable).
- [ ] B16. Implement `test-coverage-analyzer` subagent (reviewer-dispatchable).
- [ ] B17. Implement `verify-diagnoser` subagent (coder-dispatchable on verify failure).
- [ ] B18. Adopt `CLAUDE.md` convention at target repo root
      (auto-loaded by Claude Code).
- [ ] B19. Implement per-repo `memory/` directory with `MEMORY.md` index.
- [ ] B20. Stream partial progress to PR/issue comments via SDK message
      stream.
- [ ] B21. Add image-input support for issues/PRs/comments with
      screenshot attachments.
- [ ] B22. Evaluate and adopt GitHub MCP server; retire hand-rolled
      Octokit wrappers where MCP is better.
- [ ] B23. Evaluate language-server MCP (conditional on Theme D Tier 2
      trigger).

---

## C. Message engineering

- [ ] C1. Rewrite `architectUserPrompt` builder with XML-tagged fields.
- [ ] C2. Rewrite `coderUserPrompt` builder with XML-tagged fields.
- [ ] C3. Rewrite `reviewerUserPrompt` builder with XML-tagged fields.
- [ ] C4. Rewrite `coderIteratePrompt` builder with XML-tagged fields.
- [ ] C5. Audit role prompts for redundancy post-XML.
- [ ] C6. Document XML-tag convention in `agentic-flow.md`.
- [ ] C7. Add semver header to each prompt file.
- [ ] C8. Log prompt version on every run.
- [ ] C9. Remove `TERSE_DISCIPLINE` after B3–B5 land.

---

## D. Code understanding

- [ ] D1. Build symbol-index extractor for Go (`gopls symbols` or AST).
- [ ] D2. Build symbol-index extractor for TypeScript (`tsserver navtree`).
- [ ] D3. Add `ctags`-based generic fallback.
- [ ] D4. Replace `find -maxdepth 4` file-tree context with symbol index.
- [ ] D5. Add diagnostic logging for code-understanding gap signals
      (missed helpers, failed grep-then-read patterns).
- [ ] D6. Quantify diagnostic after N weeks; decide on LSP MCP adoption.
- [ ] D7. (Conditional on D6) Adopt `serena` or equivalent LSP MCP.

---

## E. Sandboxing and isolation

- [ ] E1. Apply systemd hardening directives (`NoNewPrivileges`,
      `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=true`,
      `ReadWritePaths=/var/work/...`, `MemoryMax=4G`, `CPUQuota=200%`,
      and related kernel/namespace protections).
- [ ] E2. Consider templated `frame-agent@.service` for per-role spawns.
- [ ] E3. Add cron sweep for crash-survivor workspace dirs older than 1h.
- [ ] E4. Evaluate `mkenv` as the sandbox layer for coder's Bash step.
- [ ] E5. If mkenv unsuitable, evaluate Docker / Firecracker / rootless
      containers.
- [ ] E6. Document threat model + secret-isolation review
      (ensure `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` do not leak to
      Bash-sandboxed subprocesses).

---

## F. Identity, tokens, governance

- [ ] F1. Create GitHub App under the frame org.
- [ ] F2. Install App on target repos.
- [ ] F3. Implement per-role, per-run installation token minting at
      job start.
- [ ] F4. Use architect / coder / reviewer identities for their
      respective API calls.
- [ ] F5. Define `.agent/policy.yaml` schema.
- [ ] F6. Implement policy loader in harness.
- [ ] F7. Implement policy enforcement at tool boundary (via
      `canUseTool`).
- [ ] F8. Add `forbidden_paths` enforcement (scope leak → reject).
- [ ] F9. Add `sensitive_paths` enforcement (require human-authored PR).
- [ ] F10. Add `max_pr_size_loc` / `max_pr_size_files` enforcement.
- [ ] F11. Add `max_cost_per_run_usd` / `max_cost_per_issue_usd`
      enforcement.
- [ ] F12. Add `allowed_models` enforcement against router.
- [ ] F13. Document secrets rotation cadence (webhook secret, App key).

---

## G. Observability and operations

- [ ] G1. Ship JSON logs to platform with `run_id`, `role`, `repo`, `pr`,
      `model`, `session_id`, `prompt_version`, `policy_version`,
      `routing_tier`.
- [ ] G2. Redact PII from logged issue/PR bodies.
- [ ] G3. Instrument per-role counters (runs, successes, failures,
      retries, scope leaks, verify pass/fail).
- [ ] G4. Instrument per-role histograms (latency, tokens, turns, cost).
- [ ] G5. Instrument system counters (queue depth, jobs/hour, HMAC
      rejects, Anthropic 5xx/429 rate, cache hit rate).
- [ ] G6. Build overview dashboard.
- [ ] G7. Build per-repo dashboard.
- [ ] G8. Build prompt-regression dashboard.
- [ ] G9. Alert on job failure rate.
- [ ] G10. Alert on cost spikes.
- [ ] G11. Alert on HMAC rejects.
- [ ] G12. Alert on queue stall.
- [ ] G13. Alert on Anthropic API degradation; implement circuit breaker.
- [ ] G14. Add typed errors + retry policies on all external calls.
- [ ] G15. Dedupe webhook deliveries by `x-github-delivery` UUID.
- [ ] G16. Mark stuck-running jobs failed on service boot.
- [ ] G17. Add graceful SIGTERM handler that drains in-flight jobs.
- [ ] G18. Add global kill-switch config flag.
- [ ] G19. Add per-repo `enabled: false` kill-switch in policy.
- [ ] G20. Surface per-run cost in PR body comment.
- [ ] G21. Track per-issue cumulative cost across iterations.
- [ ] G22. Reject jobs that would exceed `max_cost_per_issue_usd`.
- [ ] G23. Add lint + typecheck + unit-test CI to harness repo.
- [ ] G24. Design zero-downtime deploy path (drain + restart or
      blue-green).

---

## H. Human control surface

- [ ] H1. `/stop <run-id>` — cooperative cancellation.
- [ ] H2. `/amend-scope +path -path` — adjust Files-to-change mid-flow.
- [ ] H3. `/use-model <model>` — override model selection (policy-gated).
- [ ] H4. `/dry-run` — architect posts draft approach; `/approve`
      required to progress.
- [ ] H5. `/rewrite` — discard current diff, restart from approach.
- [ ] H6. `/diff-preview` — architect posts expected diff shape before
      coder runs.
- [ ] H7. Standardize label-vs-command semantics (labels = state;
      slash = action).

---

## I. Evals and feedback

- [ ] I1. Create `agent-bench` target repo with curated issue set.
- [ ] I2. Add trivial, standard, complex, ambiguous issue cases.
- [ ] I3. Add trap cases (AGENTS.md violations, forbidden paths,
      language mismatches).
- [ ] I4. Add regression cases (captured historical failure modes).
- [ ] I5. Add adversarial cases (prompt injection, approach tampering,
      exfiltration attempts).
- [ ] I6. Define failure predicates per benchmark issue.
- [ ] I7. Build eval harness runner that executes full loop against
      benchmark.
- [ ] I8. Capture per-issue metrics: verdict correctness, scope
      containment, verify pass rate, cost, turns, latency.
- [ ] I9. Integrate eval into harness CI; gate PRs touching prompts /
      roles / claude.ts.
- [ ] I10. Render eval results in PR body.
- [ ] I11. Capture human-override events (merge despite
      `changes-required`, `/iterate` despite `lgtm`, approach edits,
      manual pushes to agent branches).
- [ ] I12. Wire feedback signals into per-repo `memory/` updates
      (human-reviewed PR).
- [ ] I13. Build A/B routing infrastructure for prompt variants.
- [ ] I14. Add regression-freeze gate (eval failure blocks merge).

---

## J. Scale and continuity

- [ ] J1. Support concurrent workers with per-repo concurrency caps.
- [ ] J2. Add per-PR serialization (no two jobs on same PR).
- [ ] J3. Add per-repo rate limits (jobs/hour, iterations/day).
- [ ] J4. Add per-author rate limits.
- [ ] J5. Design multi-phase architect plans with per-phase `/approve`
      gates.
- [ ] J6. Implement per-phase artifact checkpointing.
- [ ] J7. Add read-only HTTP queue-inspection endpoint (authed).
- [ ] J8. (Design only) multi-repo coordinator with cross-repo DAG.

---

## K. Cleanups from POC

- [ ] K1. Retarget local `origin` to `framexyz/frame-automated-agents-poc`.
- [ ] K2. Retarget EC2 `/opt/automated-agents` git remote + pull path.
- [ ] K3. Archive `baglessdev/automated-agents`.
- [ ] K4. Remove hardcoded `agent` / `agent@baglessdev` identity in
      coder + coder-iterate.
- [ ] K5. Audit all subprocess callers for token-leakage paths; apply
      redaction.
- [ ] K6. Revisit per-role `maxTurns` values after verify lands.
- [ ] K7. Revisit `lgtm` default in review parsing after structured
      output lands.
- [ ] K8. Update `README.md` + `agentic-flow.md` after each theme.

---

## Ordering

By tier (see `roadmap.md` for dependency rationale):

**Tier 0 — Foundation**
B1 B2 B3 B4 B5 B6 · C1 C2 C3 C4 C7 · G1 G3 G4 G6 · K1 K2 K3 K4 K5

**Tier 1 — Trust output**
A1 A2 A3 A4 A5 A6 · B8 · E1 E3

**Tier 2 — Trust system**
F1 F2 F3 F4 F5 F6 F7 F8 F11 · G9 G10 G14 G15 · E4

**Tier 3 — Smarter agent**
B7 B13 B14 B15 B16 B17 B18 B19 B20 · D1 D2 D4 D5

**Tier 4 — Human trust**
H1 H2 H3 H4 · B21 · G20 G21 G22

**Tier 5 — Learn and scale**
I1 I2 I3 I4 I5 I7 I9 I11 · J1 J2 J3

**Conditional / opportunistic**
B22 B23 · D6 D7 · E5 · J5–J8 · H5 H6 · I13 I14
