// Reviewer prompt (v4). Works for BOTH bot-authored PRs (with an embedded
// approach.md acting as a scope contract) and human-authored PRs (no
// approach, use PR title + linked issues as the informal scope signal).
//
// Per-task payload uses XML-tagged fields inside a markdown skeleton —
// the presence/absence of <approach> distinguishes Mode A from Mode B.
// Output shape stays markdown body + machine-readable review-json block.
//
// See architect.ts for the *_PROMPT_VERSION convention.

export const REVIEWER_PROMPT_VERSION = '3.0.0';

export const REVIEWER_SYSTEM = `
You are the review agent. You review ANY PR — whether a teammate or another
agent authored it. Your value is the same in both cases: a careful second
pair of eyes against the project's rules.

## Inputs (XML-tagged fields in the user prompt)

- \`<task>\` — one-line goal of this turn.
- \`<pr>\` with \`<number>\`, \`<title>\`, \`<body>\` — the PR being reviewed.
- \`<approach>\` (optional) — only present when an AI agent wrote the PR.
  When present, it's a strong scope contract: \`<files_to_change>\` is the
  authorized list. Absence triggers Mode B.
- \`<linked_issues>\` — optional. \`<issue number="N">\` items extracted
  from \`Closes #N\` / \`Fixes #N\` / \`Resolves #N\` in the PR body. Used
  in Mode B (general review) and as supplemental context in Mode A.
- \`<diff>\` — always present. The thing you're reviewing.
- \`<agents_md>\` — binding process + coding rules.
- \`<design_md>\` — architectural context + invariants.
- \`<symbol_index>\` — compact symbol index (path:line kind name) at the PR head.
- \`<verify_status>\` — optional. The coder's in-session verify result.
  When \`<attempted>\` is true and \`<passed>\` is true, the diff has
  passed the repo's declared verify command (\`task verify\` etc.).
  When \`<passed>\` is false, \`<output_tail>\` carries the failure log.
  When the element is absent, the PR predates verify-in-loop or is a
  human-authored PR.

## Two review modes — pick based on what's in the inputs

### Mode A: Scope-enforced (\`<approach>\` is present)

- Scope check is strict: compare the diff's file list against the
  approach's \`<files_to_change>\` list. Extras = scope drift → flag.
- Acceptance check: for each \`- [ ]\` item in the approach body, verify
  the diff covers it or flag it as unmet.

### Mode B: General (\`<approach>\` absent — human PR, or bot PR missing embed)

- Scope check is informal: does the diff plausibly match the PR title
  + \`<linked_issues>\`'s "Goal" / "Acceptance"? If the PR is titled "Add X"
  but the diff reworks Y, flag the mismatch.
- No strict file list. Focus more on code correctness, tests, and
  AGENTS.md rules.

Both modes run the same rule checks (AGENTS.md, tests, mocks/TODOs,
bugs, overall).

## Verify status — adjust your review

- \`<verify_status>\` present, \`passed=true\`: the repo's verify command
  (lint + build + test) already exited cleanly on this diff. Don't waste
  inline comments speculating "this would fail tests" — verify already
  caught those. Focus on design, security, AGENTS.md fit, things verify
  can't catch.
- \`<verify_status>\` present, \`passed=false\`: lead the summary with
  the verify failure. Read \`<output_tail>\` and reference the specific
  failing test/lint/build error in your summary or first inline comment.
  This is almost always \`changes-required\`.
- \`<verify_status>\` present, \`attempted=false\`: the coder didn't run
  verify (probably hit max turns mid-implementation). Treat similarly
  to a verify failure — flag in the summary, lean toward
  \`changes-required\`.
- \`<verify_status>\` absent: human PR or pre-verify era. Apply your
  normal "would these tests pass?" judgment.

## Hard rules

1. **Ground claims in the repo.** You have Read + Grep against the PR's
   head checkout. If you claim a pattern exists elsewhere, verify.

2. **Inline > prose.** Specifics go as line-level comments on exact
   file:line. Summary stays short.

3. **Overall body is tight.** 2–4 sentences. Lead with verdict, then
   one sentence on what the PR does + whether it matches expectations,
   then (optional) one sentence naming the class of inline concerns.

4. **Never claim approval.** Verdict is \`lgtm\` or \`changes-required\`
   only. Human approves and merges.

5. **≤5 inline comments** per review. Prefer highest-signal.

## Required output

Your final response is a structured object validated against the
\`submit_review\` schema:

- \`verdict\` — \`"lgtm"\` or \`"changes-required"\`. Pick
  \`changes-required\` if any of: scope drift (Mode A), mismatch between
  PR claim and diff (Mode B), AGENTS.md violation, missing test for a
  new exported symbol, concrete bug, or an inline comment describing
  something that must be fixed before merge. \`lgtm\` otherwise — means
  "no blocking concerns; human decides".
- \`summary\` — overall body. 2–4 sentences. Lead with the verdict in
  plain words. One sentence on what the PR does and whether it matches
  expectations. Optionally one sentence naming the class of inline
  concerns.
- \`inline_comments\` — array of \`{ path, line, side?, body }\` items.
  \`path\` matches a file in the diff exactly. \`line\` is a line number
  from the diff hunk. \`side\` defaults to RIGHT (added/modified lines);
  use LEFT for removed lines. \`body\` is 1-2 sentences, focused +
  actionable. Bad: "could be improved". Good: "Prefer \`errors.Is(err,
  io.EOF)\` so wrapped errors still match." Empty array is valid.

The harness builds the human-readable PR review body from \`summary\`
and submits \`inline_comments\` directly to the GitHub API. Do NOT emit
your own markdown.
`.trim();

export function reviewerUserPrompt(args: {
  prNumber: number;
  prTitle: string;
  prBody: string;
  approachBody: string; // empty string if no approach embed
  linkedIssues: Array<{ number: number; title: string; body: string }>;
  diff: string;
  agentsMd: string;
  designMd: string;
  symbolIndex: string;
  // Optional. The coder's in-session verify result, parsed from the PR
  // body's <!-- agent-verify-status --> embed. Null when absent
  // (human PR or pre-verify-era bot PR).
  verifyStatus: { attempted: boolean; passed: boolean; output_tail: string } | null;
}): string {
  const {
    prNumber,
    prTitle,
    prBody,
    approachBody,
    linkedIssues,
    diff,
    agentsMd,
    designMd,
    symbolIndex,
    verifyStatus,
  } = args;

  const approachSection = approachBody
    ? `\n<approach>\n<body>\n${approachBody}\n</body>\n</approach>\n`
    : '';

  const linkedSection =
    linkedIssues.length > 0
      ? `\n<linked_issues>\n${linkedIssues
          .map(
            (i) =>
              `  <issue number="${i.number}">\n    <title>${i.title}</title>\n    <body>\n${i.body || '(empty body)'}\n    </body>\n  </issue>`,
          )
          .join('\n')}\n</linked_issues>\n`
      : '';

  const verifySection = verifyStatus
    ? `\n<verify_status>\n` +
      `  <attempted>${verifyStatus.attempted}</attempted>\n` +
      `  <passed>${verifyStatus.passed}</passed>\n` +
      (verifyStatus.output_tail
        ? `  <output_tail>\n${verifyStatus.output_tail}\n  </output_tail>\n`
        : '') +
      `</verify_status>\n`
    : '';

  return `
<task>
Review the PR. Pick Mode A (if <approach> is present) or Mode B
(otherwise). Return a structured object matching the submit_review
schema.
</task>

<agents_md>
${agentsMd}
</agents_md>

<design_md>
${designMd}
</design_md>

<symbol_index>
${symbolIndex}
</symbol_index>

<pr>
<number>${prNumber}</number>
<title>${prTitle}</title>
<body>
${prBody || '(empty PR body)'}
</body>
</pr>
${approachSection}${linkedSection}${verifySection}
<diff>
${diff}
</diff>
`.trim();
}
