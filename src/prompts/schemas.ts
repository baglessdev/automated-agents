// JSON Schemas for the structured-output contract each role emits as its
// final response. Passed to runClaude via opts.outputFormat. The Agent SDK
// validates the model's output against the schema and exposes the parsed
// object as result.structured.
//
// Descriptions are intentionally verbose — they're prompt-engineering
// surface area. Each property's `description` should read like a
// docstring an engineer would understand without external context.
//
// Schemas are strict (every meaningful field required, additionalProperties
// disabled where it matters). Caught early > silently malformed.

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
        additionalProperties: false,
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
  },
  required: ['goal', 'implementation_approach', 'files_to_change', 'acceptance_criteria', 'risks'],
  additionalProperties: false,
} as const;

export interface Approach {
  goal: string;
  implementation_approach: string;
  files_to_change: { path: string; rationale: string }[];
  acceptance_criteria: string[];
  risks: string[];
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
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'summary', 'inline_comments'],
  additionalProperties: false,
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
        additionalProperties: false,
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
        additionalProperties: false,
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
  additionalProperties: false,
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
