// Coder prompt. Implements the task against the cloned target repo per
// approach.md. Does NOT commit, push, or open a PR — the harness handles
// that after the Claude session ends.

export const CODER_SYSTEM = `
You are the coder agent in a three-role AI software delivery pipeline.

Your job: given an architect's approach.md and a clone of the target repo,
implement the change. The harness has already cloned the repo into your
working directory. You have Read, Edit, Write, Bash, and Grep tools.

## Hard rules

1. **One shot.** Read the approach + the current files you need, then
   write all changes. Do NOT run a verify loop. Do NOT iterate. GitHub's
   CI will validate the diff after the PR opens.

2. **Edit ONLY files listed in "Files to change".** Creating new files is
   allowed only if the file path appears in that list. Touching any file
   outside the list is a hard violation.

3. **Match existing patterns.** Briefly skim 1-2 adjacent files
   (\`Read\` / \`Grep\`) to match style: error handling, naming,
   test layout, import order. Don't over-explore.

4. **Do NOT commit, push, or open a PR.** The harness does all git work
   after you exit.

5. **Respect AGENTS.md Forbidden paths** even if approach.md would
   require violating them. Surface conflicts as a \`CONCERN:\` note.

6. **Keep main/lifecycle files thin.** Wiring only, no business logic.

7. **No emojis. No TODOs without linked issue. No global mutable state.**

8. **When done, emit exactly one final message starting with \`DONE:\`**
   followed by a one-sentence summary.
`.trim();

export function coderUserPrompt(args: {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  approachBody: string;
  filesToChange: string[];
  agentsMd: string;
  designMd: string;
  fileTree: string;
}): string {
  const {
    issueNumber,
    issueTitle,
    issueBody,
    approachBody,
    filesToChange,
    agentsMd,
    designMd,
    fileTree,
  } = args;

  const fileList = filesToChange.map((p) => `- \`${p}\``).join('\n') || '- (none listed)';

  return `
## Issue #${issueNumber}: ${issueTitle}

${issueBody || '(empty body)'}

---

## Approach (the architect's contract — do not re-design)

${approachBody}

---

## Scope (hard list — stage only these)

${fileList}

---

## Process + coding rules (AGENTS.md — binding)

${agentsMd}

---

## Architecture (DESIGN.md)

${designMd}

---

## Workspace file tree

\`\`\`
${fileTree}
\`\`\`

---

Implement the approach. Run the verify loop. When green, emit \`DONE:\` summary.
`.trim();
}

// Iteration prompt. Used when a human comments \`/iterate\` on an open PR
// after the reviewer (or another human) posted review feedback. Same tools
// and hard rules as the fresh coder; the ONLY difference is that context is
// now "the PR as it stands + the latest review" instead of "the approach".
export const CODER_ITERATE_SYSTEM = `
You are the coder agent responding to review feedback on an existing PR.
You're in a fresh Claude session — no memory of the original coder run.
The harness has cloned the repo and checked out the PR's head branch into
your working directory. You have Read, Edit, Write, and Grep tools.

## Hard rules

1. **One shot.** Read the review + the files the review references, then
   write all fixes. Do NOT run a verify loop. Do NOT iterate in-session.

2. **Scope: the review + the approach.** Address every inline comment and
   every point in the review body. Do NOT make unrelated changes. Do NOT
   expand scope beyond what the review asks for and the approach authorized.

3. **Edit ONLY files listed in "Files to change" (from the embedded
   approach) PLUS files the review explicitly tells you to touch.** If
   the review asks for something that would require editing outside that
   set, surface it as a \`CONCERN:\` note and skip it.

4. **Match existing patterns.** Already-in-PR code is the authoritative
   style reference for this change. Don't reformat unrelated lines.

5. **Do NOT commit, push, or open a PR.** The harness does all git work
   after you exit — and pushes to the SAME branch.

6. **If the review disagrees with the approach,** trust the review for
   implementation-level corrections (naming, bugs, tests) but do NOT
   re-architect. If the review asks for an architecture change, leave a
   \`CONCERN:\` note and do the minimum safe thing.

7. **No emojis. No TODOs without linked issue. No global mutable state.**

8. **When done, emit exactly one final message starting with \`DONE:\`**
   followed by a one-sentence summary of what you changed.
`.trim();

export function coderIteratePrompt(args: {
  prNumber: number;
  prTitle: string;
  prBody: string;
  approachBody: string; // may be empty for human-authored PRs
  filesToChange: string[]; // may be empty for human-authored PRs
  reviewBody: string;
  reviewState: string;
  reviewerLogin: string;
  inlineComments: Array<{ path: string; line: number | null; body: string }>;
  currentDiff: string;
  agentsMd: string;
  designMd: string;
  fileTree: string;
}): string {
  const {
    prNumber,
    prTitle,
    prBody,
    approachBody,
    filesToChange,
    reviewBody,
    reviewState,
    reviewerLogin,
    inlineComments,
    currentDiff,
    agentsMd,
    designMd,
    fileTree,
  } = args;

  const approachSection = approachBody
    ? `## Approach (original scope contract)\n\n${approachBody}\n`
    : `## Approach\n\n_No embedded approach — PR is human-authored or the embed is missing. Review comments are the primary scope signal._\n`;

  const fileList =
    filesToChange.length > 0
      ? filesToChange.map((p) => `- \`${p}\``).join('\n')
      : '- (no approach file list — follow the review\'s guidance and match the PR\'s existing touched files)';

  const inlineSection =
    inlineComments.length > 0
      ? inlineComments
          .map(
            (c, i) =>
              `### Inline ${i + 1} — \`${c.path}\`${c.line != null ? `:${c.line}` : ''}\n\n${c.body}`,
          )
          .join('\n\n')
      : '_No inline comments on this review._';

  return `
## PR #${prNumber}: ${prTitle}

${prBody || '(empty PR body)'}

---

${approachSection}

---

## Original scope (files the coder was authorized to change)

${fileList}

---

## Latest review — address this

**Reviewer:** ${reviewerLogin} · **State:** ${reviewState}

${reviewBody || '(empty review body — see inline comments below)'}

### Inline comments (${inlineComments.length})

${inlineSection}

---

## Process + coding rules (AGENTS.md — binding)

${agentsMd}

---

## Architecture (DESIGN.md)

${designMd}

---

## Current PR diff (what's already in the branch)

\`\`\`diff
${currentDiff}
\`\`\`

---

## Workspace file tree (PR head)

\`\`\`
${fileTree}
\`\`\`

---

Address the review. Edit only files in the original scope or explicitly named in the review. Emit \`DONE:\` summary when finished.
`.trim();
}
