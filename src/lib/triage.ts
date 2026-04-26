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
    model: 'claude-haiku-4-5',
    // disableBuiltinTools=true — the model can only call StructuredOutput.
    // Without this Haiku tries to Read /issue and similar nonsense, burning
    // turns on tool errors before classifying.
    disableBuiltinTools: true,
    // 5 leaves room for a one-shot schema validation retry (assistant
    // tool_use → tool_result → assistant retry). Triage shouldn't need more.
    maxTurns: 5,
    outputFormat: { type: 'json_schema', schema: TRIAGE_SCHEMA as Record<string, unknown> },
  });

  return result.structured as Triage;
}
