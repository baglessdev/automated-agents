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

// Roles that are permitted to invoke Bash, gated by isAllowedBashCommand.
// Architect already has Bash in its allowedTools (auto-allowed) so it
// does not flow through this hook. Coder + coder_iterate get Bash via
// canUseTool (PR 3, A3) so the harness can check each invocation's
// command argument against the verify-only allowlist.
const ROLES_WITH_BASH = new Set<AgentRole>(['coder', 'coder_iterate']);

// Allowlist of Bash command prefixes the coder may run. Anything that
// chains commands, redirects, or substitutes is denied — keep this
// strict; it's easier to widen than to narrow once the model has
// learned habits around what works.
//
// The set is small on purpose: declared verify subcommands plus Go
// build/test tooling plus a handful of read-only POSIX utilities for
// inspecting state. No write operations beyond Edit/Write tools.
function isAllowedBashCommand(command: string): boolean {
  const trimmed = command.trim();

  // Reject any shell metacharacter that could chain commands, redirect,
  // or substitute. Single/double quotes are OK (needed for arg quoting).
  if (/[|&;`$<>(){}]/.test(trimmed)) return false;

  // task <verify|lint|build|test> [args...]
  if (/^task\s+(verify|lint|build|test)(\s|$)/.test(trimmed)) return true;

  // go <build|test|vet|mod|version> [args...]
  if (/^go\s+(build|test|vet|mod|version)(\s|$)/.test(trimmed)) return true;

  // gofmt [args...]
  if (/^gofmt(\s|$)/.test(trimmed)) return true;

  // Read-only POSIX utilities for repo inspection.
  if (/^(cat|head|tail|ls|find|wc|which|pwd|stat|file|tree|grep|rg|du)(\s|$)/.test(trimmed)) {
    return true;
  }

  return false;
}

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

    // Bash for coder + coder_iterate — gate by command prefix.
    if (toolName === 'Bash' && ROLES_WITH_BASH.has(role)) {
      const command = typeof input.command === 'string' ? input.command : '';
      if (isAllowedBashCommand(command)) {
        logDecision(runId, role, toolName, 'allow', `bash command: ${command.slice(0, 60)}`);
        return { behavior: 'allow', updatedInput: input };
      }
      logDecision(runId, role, toolName, 'deny', `bash command not on allowlist: ${command.slice(0, 60)}`);
      return {
        behavior: 'deny',
        message:
          `Bash command not permitted: '${command.slice(0, 80)}'. ` +
          `Allowed: 'task verify|lint|build|test', 'go build|test|vet|mod', ` +
          `'gofmt', or read-only utilities (cat, head, tail, ls, find, wc, ` +
          `grep, rg, etc.). No pipes, redirects, or command chaining.`,
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
