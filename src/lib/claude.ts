import { query } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeRunOptions {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  allowedTools?: string[];
  model?: string;
  maxTurns?: number;
}

export interface ClaudeRunResult {
  text: string; // final assistant message text
  sessionId?: string;
  tokensIn?: number;
  tokensOut?: number;
  turns?: number;
  durationMs: number;
}

// Run one Claude Agent SDK query. Aggregates streamed messages, returns
// the final assistant text + usage metadata. Throws on error messages.
export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const started = Date.now();
  let finalText = '';
  let sessionId: string | undefined;
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  let turns: number | undefined;

  const stream = query({
    prompt: opts.userPrompt,
    options: {
      systemPrompt: opts.systemPrompt,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools ?? ['Read', 'Grep', 'Bash'],
      model: opts.model ?? 'claude-haiku-4-5',
      maxTurns: opts.maxTurns ?? 20,
      permissionMode: 'bypassPermissions',
    },
  });

  for await (const msg of stream) {
    // Message types in @anthropic-ai/claude-agent-sdk:
    //   - system   (init, tool_use, etc.)
    //   - assistant (text, thinking)
    //   - user     (tool_result)
    //   - result   (final — contains aggregated `result` string and usage)
    const m = msg as {
      type?: string;
      subtype?: string;
      session_id?: string;
      result?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      num_turns?: number;
      is_error?: boolean;
    };

    if (m.session_id && !sessionId) sessionId = m.session_id;

    if (m.type === 'result') {
      if (m.is_error) {
        throw new Error(`claude returned error result: ${m.result ?? '(no detail)'}`);
      }
      if (typeof m.result === 'string') finalText = m.result;
      if (m.usage?.input_tokens) tokensIn = m.usage.input_tokens;
      if (m.usage?.output_tokens) tokensOut = m.usage.output_tokens;
      if (typeof m.num_turns === 'number') turns = m.num_turns;
    }
  }

  if (!finalText) {
    throw new Error('claude produced no final result text');
  }

  return {
    text: finalText,
    sessionId,
    tokensIn,
    tokensOut,
    turns,
    durationMs: Date.now() - started,
  };
}
