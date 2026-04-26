import { query } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeRunOptions {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  allowedTools?: string[];
  model?: string;
  maxTurns?: number;
  // Extended thinking budget — max tokens the model may spend reasoning
  // internally before producing a response. Off by default. Worth
  // enabling on judgment-heavy roles (architect, reviewer); not worth
  // it on translation-heavy roles (coder).
  maxThinkingTokens?: number;
  // Structured output schema. When set, the SDK requires the final
  // response to validate against the schema and exposes the parsed
  // object as result.structured. If validation fails the SDK retries
  // internally; persistent failure surfaces as an error result.
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
}

export interface ClaudeRunResult {
  text: string; // final assistant message text (empty when outputFormat is used)
  structured?: unknown; // present when outputFormat was set
  sessionId?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  turns?: number;
  durationMs: number;
}

// Run one Claude Agent SDK query. Aggregates streamed messages, returns
// the final assistant text + usage metadata. Throws on error messages.
//
// Cache metrics: the Agent SDK does not let callers place explicit
// `cache_control` breakpoints — caching is handled inside the CLI
// subprocess. What we CAN do is observe whether caching took effect via
// `cacheReadTokens` / `cacheCreationTokens` in the result message. Roles
// log these so we can tell at a glance whether the cache is being used.
// `costUsd` comes straight from the SDK (precomputed across all turns).
export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const started = Date.now();
  let finalText = '';
  let structured: unknown;
  let sessionId: string | undefined;
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let costUsd: number | undefined;
  let turns: number | undefined;

  const stderrLines: string[] = [];
  // Diagnostic capture: structured-output failures surface as tool_result
  // content on user messages (the SDK doesn't put them in `errors`/`result`).
  // We snapshot StructuredOutput tool_use inputs + their tool_result errors
  // so we can see exactly which Ajv rule the model tripped on.
  const structuredAttempts: Array<{
    inputPreview: string;
    error?: string;
  }> = [];
  const pendingStructuredCalls = new Map<string, string>();

  // Workaround: when given a structured-output schema directly, the model
  // (observed on Claude Sonnet 4.5) consistently wraps its tool_use input
  // as `{ "parameter": <actual_object> }`. The SDK's Ajv validator then
  // rejects every retry because the schema expects the fields at root,
  // not under `parameter`. Wrap the schema so the validator agrees with
  // the model, then unwrap the result.structured below before returning.
  const wrappedSchema = opts.outputFormat
    ? {
        type: 'object',
        properties: { parameter: opts.outputFormat.schema },
        required: ['parameter'],
      }
    : undefined;

  const stream = query({
    prompt: opts.userPrompt,
    options: {
      systemPrompt: opts.systemPrompt,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools ?? ['Read', 'Grep', 'Bash'],
      model: opts.model ?? 'claude-haiku-4-5',
      maxTurns: opts.maxTurns ?? 20,
      permissionMode: 'bypassPermissions',
      stderr: (data: string) => {
        stderrLines.push(data);
      },
      ...(opts.maxThinkingTokens ? { maxThinkingTokens: opts.maxThinkingTokens } : {}),
      ...(wrappedSchema
        ? { outputFormat: { type: 'json_schema' as const, schema: wrappedSchema } }
        : {}),
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
      structured_output?: unknown;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      total_cost_usd?: number;
      num_turns?: number;
      is_error?: boolean;
    };

    if (m.session_id && !sessionId) sessionId = m.session_id;

    // Capture StructuredOutput tool_use inputs + their tool_result errors.
    // This is the only place we get the actual Ajv validation error text.
    if (opts.outputFormat) {
      const am = msg as {
        type?: string;
        message?: { content?: unknown };
      };
      if (am.type === 'assistant' && Array.isArray(am.message?.content)) {
        for (const block of am.message.content as Array<{
          type?: string;
          name?: string;
          id?: string;
          input?: unknown;
        }>) {
          if (block.type === 'tool_use' && block.name === 'StructuredOutput') {
            const preview = JSON.stringify(block.input).slice(0, 800);
            pendingStructuredCalls.set(block.id ?? '', preview);
          }
        }
      }
      if (am.type === 'user' && Array.isArray(am.message?.content)) {
        for (const block of am.message.content as Array<{
          type?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }>) {
          if (block.type === 'tool_result' && pendingStructuredCalls.has(block.tool_use_id ?? '')) {
            const inputPreview = pendingStructuredCalls.get(block.tool_use_id ?? '') ?? '';
            const errText =
              typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content);
            if (block.is_error) {
              structuredAttempts.push({ inputPreview, error: errText.slice(0, 500) });
            }
            pendingStructuredCalls.delete(block.tool_use_id ?? '');
          }
        }
      }
    }

    if (m.type === 'result') {
      // The SDK can set is_error: false even when the subtype indicates
      // a failure (e.g., 'error_max_structured_output_retries'). Treat any
      // error_* subtype as a hard failure regardless of is_error.
      const subtypeIsError =
        typeof m.subtype === 'string' && m.subtype.startsWith('error_');
      if (m.is_error || subtypeIsError) {
        const errs =
          (m as { errors?: string[] }).errors?.join('; ') ?? '';
        const detail = errs || m.result || m.subtype || '(no detail)';
        // Dump captured StructuredOutput attempts so we can see which Ajv
        // rule each retry tripped on. Only present when outputFormat is set.
        if (structuredAttempts.length > 0) {
          console.warn(
            JSON.stringify({
              level: 'debug',
              event: 'structured_output_attempts',
              count: structuredAttempts.length,
              attempts: structuredAttempts,
            }),
          );
        }
        throw new Error(`claude returned error result (${m.subtype}): ${detail}`);
      }
      if (typeof m.result === 'string') finalText = m.result;
      // Unwrap the `parameter` envelope (see wrappedSchema comment above).
      if (m.structured_output !== undefined) {
        const so = m.structured_output as { parameter?: unknown };
        structured = so && typeof so === 'object' && 'parameter' in so
          ? so.parameter
          : m.structured_output;
      }
      if (m.usage?.input_tokens) tokensIn = m.usage.input_tokens;
      if (m.usage?.output_tokens) tokensOut = m.usage.output_tokens;
      if (typeof m.usage?.cache_read_input_tokens === 'number') {
        cacheReadTokens = m.usage.cache_read_input_tokens;
      }
      if (typeof m.usage?.cache_creation_input_tokens === 'number') {
        cacheCreationTokens = m.usage.cache_creation_input_tokens;
      }
      if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
      if (typeof m.num_turns === 'number') turns = m.num_turns;
    }
  }

  // When outputFormat is set, the SDK returns the parsed object via
  // structured_output; the text result may be empty. Otherwise the text
  // result is the model's final markdown response and must be present.
  if (!opts.outputFormat && !finalText) {
    throw new Error('claude produced no final result text');
  }
  if (opts.outputFormat && structured === undefined) {
    throw new Error('claude produced no structured output despite outputFormat being set');
  }

  return {
    text: finalText,
    structured,
    sessionId,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    turns,
    durationMs: Date.now() - started,
  };
}
