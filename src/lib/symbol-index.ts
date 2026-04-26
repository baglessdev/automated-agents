// Build a compact symbol index for a target repo. Replaces the older
// `find -maxdepth 4` file-tree dump that every role was passing into
// the model — same context volume, much higher signal density.
//
// Strategy:
//   1. Try `ctags -R --output-format=json` (universal-ctags, language-aware).
//      Each line becomes "<path>:<line> <kind> <name>".
//   2. Fall back to a flat file listing if ctags is unavailable or
//      produces nothing (so the harness never breaks if EC2 is mid-upgrade).
//
// `apt-get install -y universal-ctags` is required on the host to get
// the symbol-index path; without it, runs use the fallback path which
// matches pre-D1 behavior.

import { execFileSync } from 'node:child_process';

const EXCLUDED_DIRS = ['.git', 'node_modules', 'vendor', 'target', 'dist', 'build'];

export function buildSymbolIndex(repoDir: string): string {
  try {
    const args = [
      '-R',
      '--output-format=json',
      '--quiet=yes',
      '--fields=+l',
      '-f', '-',
      ...EXCLUDED_DIRS.flatMap((d) => ['--exclude', d]),
      '.',
    ];
    const out = execFileSync('ctags', args, {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const tag = JSON.parse(line) as {
            _type?: string;
            name?: string;
            path?: string;
            line?: number;
            kind?: string;
          };
          if (
            tag._type !== 'tag' ||
            !tag.name ||
            !tag.path ||
            typeof tag.line !== 'number' ||
            !tag.kind
          ) {
            return null;
          }
          const cleanPath = tag.path.replace(/^\.\//, '');
          return `${cleanPath}:${tag.line} ${tag.kind} ${tag.name}`;
        } catch {
          return null;
        }
      })
      .filter((l): l is string => l !== null)
      .sort();

    if (lines.length > 0) {
      return lines.join('\n');
    }
  } catch {
    // ctags not installed or errored — fall through to file-tree fallback.
  }

  return buildFileTreeFallback(repoDir);
}

function buildFileTreeFallback(repoDir: string): string {
  const findArgs = [
    '.',
    '-maxdepth', '4',
    '(',
    ...EXCLUDED_DIRS.flatMap((d) => ['-path', `./${d}`, '-o']).slice(0, -1),
    ')',
    '-prune',
    '-o',
    '-type', 'f',
    '-print',
  ];
  const out = execFileSync('find', findArgs, {
    cwd: repoDir,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((l) => l.replace(/^\.\//, ''))
    .filter(Boolean)
    .sort()
    .join('\n');
}
