// Renderers that turn a role's structured output into the markdown shape
// downstream consumers expect (GitHub comments, PR review bodies, embedded
// approach blocks).
//
// Important: renderApproachMarkdown's output MUST remain compatible with
// `parseApproach` (src/lib/approach.ts) — it is read back by coder-iterate
// out of the embedded `<!-- agent-approach-embed -->` block in PR bodies.
// In particular, the `## Files to change` heading and the
// `- \`path\` — rationale` line shape are load-bearing. Same for the
// `## Triage` line — coder + reviewer + iterate read the triage tier
// from there to drive their own model routing.

import type { Approach, Iteration, Review } from './schemas';

export function renderApproachMarkdown(approach: Approach, issueNumber: number, issueTitle: string): string {
  const filesSection = approach.files_to_change.length > 0
    ? approach.files_to_change.map((f) => `- \`${f.path}\` — ${f.rationale}`).join('\n')
    : '- (none)';

  const acceptanceSection = approach.acceptance_criteria.length > 0
    ? approach.acceptance_criteria.map((c) => `- [ ] ${c}`).join('\n')
    : '- [ ] (none stated)';

  const risksSection = approach.risks.length > 0
    ? approach.risks.map((r) => `- ${r}`).join('\n')
    : '_None._';

  return `# Approach for #${issueNumber}: ${issueTitle}

## Triage

**Complexity:** ${approach.triage_complexity} · **Risk:** ${approach.triage_risk}

## Goal

${approach.goal}

## Implementation approach

${approach.implementation_approach}

## Files to change

${filesSection}

## Acceptance

${acceptanceSection}

## Risks / assumptions

${risksSection}`;
}

export function renderReviewMarkdown(review: Review): string {
  const verdictLine = review.verdict === 'changes-required'
    ? '**Verdict: Changes required**'
    : '**Verdict: LGTM**';

  const closingLine = review.verdict === 'changes-required'
    ? 'Reviewer: changes required — see inline comments.'
    : 'Reviewer: LGTM — human decides.';

  return `${verdictLine}

${review.summary}

${closingLine}`;
}

export function renderIterationSummary(iteration: Iteration): string {
  const parts: string[] = [`**Summary:** ${iteration.summary}`];

  if (iteration.addressed_comments.length > 0) {
    const items = iteration.addressed_comments
      .map((c) => {
        const loc = c.path ? `\`${c.path}\`${c.line != null ? `:${c.line}` : ''}` : '';
        return loc ? `- ${loc} — ${c.what_was_fixed}` : `- ${c.what_was_fixed}`;
      })
      .join('\n');
    parts.push(`### Addressed (${iteration.addressed_comments.length})\n\n${items}`);
  }

  if (iteration.unaddressed_comments.length > 0) {
    const items = iteration.unaddressed_comments
      .map((c) => {
        const loc = c.path ? `\`${c.path}\`${c.line != null ? `:${c.line}` : ''}` : '';
        return loc ? `- ${loc} — ${c.reason}` : `- ${c.reason}`;
      })
      .join('\n');
    parts.push(`### Unaddressed (${iteration.unaddressed_comments.length})\n\n${items}`);
  }

  if (iteration.new_concerns.length > 0) {
    const items = iteration.new_concerns.map((c) => `- ${c}`).join('\n');
    parts.push(`### New concerns\n\n${items}`);
  }

  return parts.join('\n\n');
}
