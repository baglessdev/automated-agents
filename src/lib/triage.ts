// Triage helper. Classifies an issue's complexity + risk via a single
// cheap Haiku call. Used by the architect role's first step, before
// the architect's main work begins.
//
// Cost: ~$0.001-$0.003 per call. Far less than the routing decisions
// it informs, so we never skip it.

import { runClaude } from './claude';
import { TRIAGE_SCHEMA, type Triage } from '../prompts/schemas';
import { TRIAGE_SYSTEM, triageUserPrompt } from '../prompts/triage';

export async function classifyIssue(args: {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  agentsMd: string;
  symbolIndex: string;
  cwd: string;
}): Promise<Triage> {
  const userPrompt = triageUserPrompt({
    issueNumber: args.issueNumber,
    issueTitle: args.issueTitle,
    issueBody: args.issueBody,
    agentsMd: args.agentsMd,
    symbolIndex: args.symbolIndex,
  });

  const result = await runClaude({
    systemPrompt: TRIAGE_SYSTEM,
    userPrompt,
    cwd: args.cwd,
    allowedTools: [], // triage is a one-shot classification, no exploration
    model: 'claude-haiku-4-5',
    // Structured output uses a synthetic StructuredOutput tool — its
    // call + result consume turns. 5 gives headroom for a one-shot
    // schema retry without masking real iteration loops.
    maxTurns: 5,
    outputFormat: { type: 'json_schema', schema: TRIAGE_SCHEMA as Record<string, unknown> },
  });

  return result.structured as Triage;
}
