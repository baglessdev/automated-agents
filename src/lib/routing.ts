// Per-role model + thinking-budget routing driven by triage.
//
// Decision matrix:
//
//   complexity / risk →   architect              coder              reviewer
//   ─────────────────────────────────────────────────────────────────────────
//   trivial    / low      Haiku, no thinking     Haiku              Haiku, no thinking
//   standard   / low      Haiku, no thinking     Sonnet             Haiku, no thinking
//   standard   / medium   Sonnet + thinking      Sonnet             Sonnet + thinking
//   complex    / *        Sonnet + thinking      Sonnet             Sonnet + thinking
//   *          / high     REFUSE (return early; require human-authored PR)
//
// Rationale: Haiku is sufficient for trivial issues across the board.
// Sonnet for the coder on anything but trivial — Haiku underperforms
// on multi-file edits. Thinking on the judgment-heavy roles only when
// the task warrants the latency cost.

import type { Triage, TriageComplexity, TriageRisk } from '../prompts/schemas';

export type AgentRole = 'architect' | 'coder' | 'reviewer';

const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-4-5';

export interface RouteDecision {
  model: string;
  // 0 = thinking off. Positive number = thinking budget in tokens.
  thinkingBudget: number;
}

export function routeRole(role: AgentRole, triage: Triage): RouteDecision {
  if (isHighRisk(triage)) {
    // Defensive: caller should have refused before reaching here. Pick a
    // safe-but-conservative tier so we don't accidentally run Haiku on
    // something the harness should not have routed at all.
    return { model: SONNET, thinkingBudget: 5000 };
  }

  const upgradedToSonnet =
    triage.complexity === 'complex' || triage.risk === 'medium';

  if (role === 'coder') {
    // Coder: Haiku only for trivial. Sonnet otherwise — multi-file edits
    // are where Haiku starts producing partial work. Coder doesn't use
    // thinking (translation work, not reasoning).
    return {
      model: triage.complexity === 'trivial' ? HAIKU : SONNET,
      thinkingBudget: 0,
    };
  }

  // architect + reviewer: same routing — both are judgment roles.
  if (upgradedToSonnet) {
    return { model: SONNET, thinkingBudget: 5000 };
  }
  return { model: HAIKU, thinkingBudget: 0 };
}

export function isHighRisk(triage: Triage): boolean {
  return triage.risk === 'high';
}

export function refuseReason(triage: Triage): string {
  if (triage.risk !== 'high') return '';
  return (
    `This issue was triaged as **high risk** ` +
    `(complexity: ${triage.complexity}, risk: ${triage.risk}).\n\n` +
    `**Reasoning:** ${triage.reasoning}\n\n` +
    `High-risk changes (security-sensitive code, schema migrations, ` +
    `breaking API changes, anything in AGENTS.md Forbidden paths) ` +
    `require a human-authored PR. The agent will not propose an approach ` +
    `for this issue.\n\n` +
    `If you believe this triage is wrong, edit the issue body for clearer ` +
    `scope and re-label \`agent:arch\`, or open a PR yourself and add the ` +
    `\`agent:review\` label to get an automated review.`
  );
}

// Default fallback when triage is unavailable (e.g., parsed from an old
// approach that predates B13). Same behavior as pre-B13: Sonnet-everywhere
// with thinking on the judgment roles.
export function defaultRoute(role: AgentRole): RouteDecision {
  if (role === 'coder') return { model: SONNET, thinkingBudget: 0 };
  return { model: SONNET, thinkingBudget: 5000 };
}

// Build a triage value with the same semantics as defaultRoute — used
// when coder/reviewer/iterate parse an old approach with no triage tier.
export function fallbackTriage(): Triage {
  return {
    complexity: 'standard' as TriageComplexity,
    risk: 'medium' as TriageRisk,
    reasoning: '(no triage in approach — treated as standard/medium)',
  };
}
