// Parse approach.md bodies posted by the architect. Extracts the "Files to
// change" list for scope-enforcement at commit time. Tolerates minor
// formatting variations (whitespace, missing em-dash) since the architect's
// output is LLM-generated markdown, not strict.

export interface ParsedApproach {
  filesToChange: string[];
  approachBody: string; // the full markdown body without the HTML marker/trailer
}

const MARKER_RE = /<!--\s*agent-approach[^-]*-->/;
const TRAILER_RE = /\n*---\n+_Posted by architect agent[\s\S]*$/;
const NEXT_LINE_RE = /\n+\*\*Next:\*\*[\s\S]*$/;

// Extract { filesToChange, approachBody } from a raw issue comment body.
export function parseApproach(raw: string): ParsedApproach {
  let body = raw.replace(MARKER_RE, '').trim();
  body = body.replace(TRAILER_RE, '').trim();
  body = body.replace(NEXT_LINE_RE, '').trim();

  // Find "## Files to change" section. Section runs until next "## " heading
  // or end-of-string.
  const section = extractSection(body, 'Files to change');
  if (!section) return { filesToChange: [], approachBody: body };

  // Each target line is expected to be like:
  //   - `path/to/file.ext` — rationale
  // Tolerant regex: backtick-wrapped path on a list-item line.
  const re = /^\s*-\s*`([^`\n]+)`/gm;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    const p = m[1].trim();
    if (p && !paths.includes(p)) paths.push(p);
  }

  return { filesToChange: paths, approachBody: body };
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
