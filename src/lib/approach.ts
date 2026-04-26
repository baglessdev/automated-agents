// Parse approach.md bodies posted by the architect. Extracts the "Files to
// change" list for scope-enforcement at commit time, plus the triage tier
// (B13) so coder + reviewer + iterate can route their own model selection.
// Tolerates minor formatting variations (whitespace, missing em-dash)
// since the architect's output is LLM-generated markdown, not strict.

import type { TriageComplexity, TriageRisk } from '../prompts/schemas';

export interface ParsedApproach {
  filesToChange: string[];
  approachBody: string; // the full markdown body without the HTML marker/trailer
  triageComplexity?: TriageComplexity;
  triageRisk?: TriageRisk;
}

const MARKER_RE = /<!--\s*agent-approach[^-]*-->/;
const TRAILER_RE = /\n*---\n+_Posted by architect agent[\s\S]*$/;
const NEXT_LINE_RE = /\n+\*\*Next:\*\*[\s\S]*$/;

// Extract { filesToChange, approachBody, triageComplexity, triageRisk } from
// a raw issue comment body or PR-body-embedded approach.
export function parseApproach(raw: string): ParsedApproach {
  let body = raw.replace(MARKER_RE, '').trim();
  body = body.replace(TRAILER_RE, '').trim();
  body = body.replace(NEXT_LINE_RE, '').trim();

  const result: ParsedApproach = { filesToChange: [], approachBody: body };

  // Triage section, format produced by renderApproachMarkdown:
  //   ## Triage
  //
  //   **Complexity:** standard · **Risk:** medium
  //
  // Tolerant: optional whitespace, optional separator, case-insensitive.
  const triageSection = extractSection(body, 'Triage');
  if (triageSection) {
    const cm = /\*\*Complexity:\*\*\s*(trivial|standard|complex)/i.exec(triageSection);
    const rm = /\*\*Risk:\*\*\s*(low|medium|high)/i.exec(triageSection);
    if (cm) result.triageComplexity = cm[1].toLowerCase() as TriageComplexity;
    if (rm) result.triageRisk = rm[1].toLowerCase() as TriageRisk;
  }

  const section = extractSection(body, 'Files to change');
  if (!section) return result;

  const re = /^\s*-\s*`([^`\n]+)`/gm;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    const p = m[1].trim();
    if (p && !paths.includes(p)) paths.push(p);
  }
  result.filesToChange = paths;
  return result;
}

function extractSection(body: string, heading: string): string | null {
  const re = new RegExp(
    `##\\s+${escape(heading)}\\s*\\n([\\s\\S]*?)(?:\\n##\\s+|\\n---\\s*\\n|$)`,
  );
  const m = body.match(re);
  return m ? m[1] : null;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
