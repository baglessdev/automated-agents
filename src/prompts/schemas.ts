// JSON Schemas for the structured-output contract each role emits as its
// final response. Passed to runClaude via opts.outputFormat. The Agent SDK
// validates the model's output against the schema and exposes the parsed
// object as result.structured.
//
// Descriptions are intentionally verbose — they're prompt-engineering
// surface area. Each property's `description` should read like a
// docstring an engineer would understand without external context.
//
// Schemas mark every meaningful field as required. We deliberately do NOT
// set `additionalProperties: false` — Anthropic's structured-output
// validator burns retries on strict schemas in practice. Accepting extra
// fields silently is cheaper than failing 5×.

// Triage classification — produced by a cheap Haiku call before the
// architect runs. Drives per-role model + thinking-budget routing for
// the rest of the loop. Persisted in the architect's approach so coder,
// reviewer, and coder-iterate can all read the same classification.
export const TRIAGE_SCHEMA = {
  type: 'object',
  description:
    'Quick classification of a GitHub issue\'s complexity and risk. Used by the harness to route each role to a model + thinking budget that fits the task. Be conservative: prefer "complex" over "standard" when in doubt; prefer "medium" risk over "low" when the change touches anything load-bearing.',
  properties: {
    complexity: {
      type: 'string',
      enum: ['trivial', 'standard', 'complex'],
      description:
        '"trivial" = single small function, no design choices, well-specified inputs (e.g., add a Clamp helper). "standard" = a feature or endpoint with some design decisions (e.g., add a request-ID middleware). "complex" = touches multiple subsystems, requires real architectural reasoning (e.g., a new auth flow, a schema migration).',
    },
    risk: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description:
        '"low" = isolated change, easy to revert, no shared state. "medium" = touches request/response shape, public APIs, or commonly-used helpers. "high" = security-sensitive (auth, crypto, secrets), data migrations, breaking changes, or anything that could affect production users on rollout. High-risk issues are refused — they require human-authored PRs.',
    },
    reasoning: {
      type: 'string',
      description:
        'One sentence explaining the classification. The harness logs this and surfaces it in the approach comment so humans can override if needed.',
    },
  },
  required: ['complexity', 'risk', 'reasoning'],
} as const;

export type TriageComplexity = 'trivial' | 'standard' | 'complex';
export type TriageRisk = 'low' | 'medium' | 'high';

export interface Triage {
  complexity: TriageComplexity;
  risk: TriageRisk;
  reasoning: string;
}

export const APPROACH_SCHEMA = {
  type: 'object',
  description:
    'Architect-produced approach for a GitHub issue. The harness builds the human-readable markdown comment from these fields and posts it on the issue. The downstream coder reads files_to_change as the binding scope contract.',
  properties: {
    goal: {
      type: 'string',
      description:
        'One paragraph rephrasing the issue body in clear, concrete terms. The reader should know what success looks like after this paragraph.',
    },
    implementation_approach: {
      type: 'string',
      description:
        'Several sentences to one paragraph describing how the coder should solve the task: which existing patterns to follow, which helpers to extract or reuse, which edge cases matter, which pitfalls to avoid. This is the architect\'s value-add — the design thinking the coder would otherwise reinvent. Do not include the actual code.',
    },
    files_to_change: {
      type: 'array',
      description:
        'Hard list of paths the coder is authorized to edit (or create). The harness\'s scope enforcement will discard any change outside this list. Include every file the task requires touching, paired source-with-test where applicable, and exclude any path the project\'s AGENTS.md declares Forbidden.',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Repo-relative path. Use forward slashes regardless of host OS. New files are allowed if their path appears here.',
          },
          rationale: {
            type: 'string',
            description: 'One short sentence explaining why this file needs to change.',
          },
        },
        required: ['path', 'rationale'],
      },
    },
    acceptance_criteria: {
      type: 'array',
      description:
        'Concrete, testable criteria the human will use to decide whether to merge. Phrase each as a checkable statement (e.g., "Returns 400 with body \\"missing param\\" when ?msg is empty"). Avoid vague phrasing like "good test coverage" — replace with specific scenarios.',
      items: { type: 'string' },
    },
    risks: {
      type: 'array',
      description:
        'Anything the human should know before approving. Ambiguities you resolved, design choices you made, things you couldn\'t verify in the repo. Empty array is fine if there are no risks worth flagging.',
      items: { type: 'string' },
    },
    triage_complexity: {
      type: 'string',
      enum: ['trivial', 'standard', 'complex'],
      description:
        'The complexity tier the harness classified this issue at before invoking the architect. Echo it back unchanged so downstream roles (coder, reviewer, iterate) read the same classification from your embedded approach.',
    },
    triage_risk: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description:
        'Same — echo the risk tier back unchanged.',
    },
  },
  required: [
    'goal',
    'implementation_approach',
    'files_to_change',
    'acceptance_criteria',
    'risks',
    'triage_complexity',
    'triage_risk',
  ],
} as const;

export interface Approach {
  goal: string;
  implementation_approach: string;
  files_to_change: { path: string; rationale: string }[];
  acceptance_criteria: string[];
  risks: string[];
  triage_complexity: TriageComplexity;
  triage_risk: TriageRisk;
}

// Coder structured output (B/A4). Lets the harness know whether the
// coder actually ran the repo's `verify` command in-session and what
// the result was, so failed-verify PRs can be labeled honestly and the
// reviewer can adjust its review.
export const CODER_SCHEMA = {
  type: 'object',
  description:
    'Coder\'s structured report after editing files. Tells the harness whether the changes pass the repo\'s declared verify command, so the PR can open with an honest verify status (verified-green or agent:verify-failed) for the human and the reviewer to act on.',
  properties: {
    summary: {
      type: 'string',
      description: 'One short sentence describing the change you made.',
    },
    files_modified: {
      type: 'array',
      description:
        'Paths you edited or created. Self-reported; the harness cross-checks against actual git staging and surfaces any drift.',
      items: { type: 'string' },
    },
    verify_attempted: {
      type: 'boolean',
      description:
        'True if you ran `task verify` (or the repo\'s declared verify command) at any point in this session. Always set this honestly — the harness uses it to distinguish "I forgot to verify" from "I ran verify and it failed".',
    },
    verify_passed: {
      type: 'boolean',
      description:
        'True only if your most recent verify run exited successfully. False if it failed or if you never ran verify. Do not set this true unless you actually saw a clean exit.',
    },
    verify_output_tail: {
      type: 'string',
      description:
        'When verify_passed is false, paste the last ~30 lines / 5KB of verify output so the human and the reviewer can see what failed. Empty string when verify passed or was not attempted.',
    },
    concerns: {
      type: 'array',
      description:
        'Free-form CONCERN: notes — things you noticed while implementing that the human should know about (architecture mismatch with the approach, surprising existing code, etc.). Empty array is fine.',
      items: { type: 'string' },
    },
  },
  required: [
    'summary',
    'files_modified',
    'verify_attempted',
    'verify_passed',
    'verify_output_tail',
    'concerns',
  ],
} as const;

export interface Coder {
  summary: string;
  files_modified: string[];
  verify_attempted: boolean;
  verify_passed: boolean;
  verify_output_tail: string;
  concerns: string[];
}

export const REVIEW_SCHEMA = {
  type: 'object',
  description:
    'Reviewer\'s verdict on a PR. The harness posts the summary as the review body and submits inline_comments as line-level comments on the PR diff. The agent never APPROVES — verdict is advisory only.',
  properties: {
    verdict: {
      type: 'string',
      enum: ['lgtm', 'changes-required'],
      description:
        '"lgtm" means no blocking concerns — the human decides. "changes-required" means at least one inline comment or summary point must be fixed before merge. Pick changes-required when: scope drift (Mode A), mismatch between PR claim and diff (Mode B), AGENTS.md violation, missing test for a new exported symbol, or a concrete bug.',
    },
    summary: {
      type: 'string',
      description:
        'Overall review body. 2–4 sentences. Lead with the verdict in plain words. One sentence on what the PR does and whether it matches expectations. Optionally one sentence naming the class of inline concerns. No preamble, no "Here is the review".',
    },
    inline_comments: {
      type: 'array',
      description:
        'Line-level comments on specific file:line locations in the diff. Up to 5 — prefer highest-signal. Each comment must be focused and actionable; avoid vague "could be improved" wording. Empty array is valid (e.g., LGTM with no nits).',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Repo-relative path matching a file in the diff exactly.',
          },
          line: {
            type: 'integer',
            description:
              'Line number from the diff hunk. For added/modified lines use the new-file line number (RIGHT side); for removed lines use the old-file line number (LEFT side).',
          },
          side: {
            type: 'string',
            enum: ['LEFT', 'RIGHT'],
            description:
              'RIGHT for added/modified lines (default); LEFT for removed lines.',
          },
          body: {
            type: 'string',
            description:
              '1–2 sentences. Be specific and actionable. Bad: "could be improved". Good: "Prefer errors.Is(err, io.EOF) so wrapped errors still match."',
          },
        },
        required: ['path', 'line', 'body'],
      },
    },
  },
  required: ['verdict', 'summary', 'inline_comments'],
} as const;

export interface ReviewLineComment {
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  body: string;
}

export interface Review {
  verdict: 'lgtm' | 'changes-required';
  summary: string;
  inline_comments: ReviewLineComment[];
}

export const ITERATION_SCHEMA = {
  type: 'object',
  description:
    'Coder-iterate agent\'s structured report on what it did in response to review feedback. The harness uses this to post a richer summary comment and to track unaddressed review concerns over iterations.',
  properties: {
    summary: {
      type: 'string',
      description:
        'One short sentence describing the overall change you made in this iteration.',
    },
    addressed_comments: {
      type: 'array',
      description:
        'Inline review comments you actually fixed. Reference the comment\'s path/line where applicable. Empty array if you addressed only the review body or no inline comments existed.',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path of the comment that was addressed (matches the review comment).',
          },
          line: {
            type: 'integer',
            description: 'Line number of the comment that was addressed.',
          },
          what_was_fixed: {
            type: 'string',
            description: 'One sentence: what the fix was.',
          },
        },
        required: ['what_was_fixed'],
      },
    },
    unaddressed_comments: {
      type: 'array',
      description:
        'Inline review comments you did NOT address, with a reason. Use this when a comment requested something out of scope, contradicted the approach, was unclear, or needed a human decision. Surfacing these is important — silent skips are a worse failure than honest "couldn\'t do it".',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path of the unaddressed comment.',
          },
          line: {
            type: 'integer',
            description: 'Line number of the unaddressed comment.',
          },
          reason: {
            type: 'string',
            description:
              'One sentence: why you skipped it (e.g., "out of approach scope", "would require touching forbidden path", "ambiguous — needs human clarification").',
          },
        },
        required: ['reason'],
      },
    },
    new_concerns: {
      type: 'array',
      description:
        'Free-form CONCERN: notes — things you noticed while iterating that the human should know about (architecture mismatch with the review, deeper bug surfaced, etc.). Empty array is fine.',
      items: { type: 'string' },
    },
  },
  required: ['summary', 'addressed_comments', 'unaddressed_comments', 'new_concerns'],
} as const;

export interface AddressedComment {
  path?: string;
  line?: number;
  what_was_fixed: string;
}

export interface UnaddressedComment {
  path?: string;
  line?: number;
  reason: string;
}

export interface Iteration {
  summary: string;
  addressed_comments: AddressedComment[];
  unaddressed_comments: UnaddressedComment[];
  new_concerns: string[];
}
