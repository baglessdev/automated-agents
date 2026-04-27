// Per-role permission hooks. Replace the SDK's `bypassPermissions`
// blanket auto-approve with a function that decides allow/deny per
// (role, tool) and logs every decision.
//
// Today (B8): the function gates tools NOT in a role's `allowedTools`
// list — i.e. the implicit denylist. Tools the role does auto-allow
// (via the existing `allowedTools` array) bypass this hook entirely;
// adding logging on every allowed call would multiply log volume.
//
// Tomorrow (PR 3): the coder's Bash tool will move OUT of `allowedTools`
// so every invocation flows through this hook, where we'll gate by
// `command` against a verify-only allowlist.

import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

export type AgentRole = 'architect' | 'coder' | 'reviewer' | 'coder_iterate';

// Tools we never permit for any role, regardless of allowedTools.
// Belt-and-suspenders for cases where the model invents a tool name
// or where the SDK changes its built-in tool set.
const GLOBALLY_DENIED = new Set([
  'Task', // subagents — deferred to a future sprint
  'WebFetch',
  'WebSearch',
]);

export function buildCanUseTool(role: AgentRole, runId: string): CanUseTool {
  return async (toolName, input) => {
    // The synthetic StructuredOutput tool is added by the SDK when
    // outputFormat is set. It must always be allowed; denying it breaks
    // structured-output flows entirely.
    if (toolName === 'StructuredOutput') {
      return { behavior: 'allow', updatedInput: input };
    }

    if (GLOBALLY_DENIED.has(toolName)) {
      logDecision(runId, role, toolName, 'deny', 'globally denied tool');
      return {
        behavior: 'deny',
        message: `Tool '${toolName}' is not enabled for this pipeline.`,
      };
    }

    // Tools allowed for the role (passed via allowedTools in the SDK
    // call) auto-execute and do not invoke canUseTool. So if we reach
    // this branch, the model is invoking a tool the role didn't pre-list.
    // Default-deny with a useful message — the model gets to retry with
    // a different approach instead of failing the whole turn.
    logDecision(runId, role, toolName, 'deny', 'not in role allowlist');
    return {
      behavior: 'deny',
      message:
        `Tool '${toolName}' is not permitted for the ${role} role. ` +
        `Use only the tools listed in your system prompt's Inputs section.`,
    };
  };
}

function logDecision(
  runId: string,
  role: AgentRole,
  tool: string,
  decision: 'allow' | 'deny',
  reason: string,
): void {
  console.log(
    JSON.stringify({
      level: decision === 'deny' ? 'warn' : 'debug',
      run: runId,
      event: 'permission_check',
      role,
      tool,
      decision,
      reason,
    }),
  );
}
