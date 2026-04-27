// Run the target repo's declared `task verify` (or equivalent) and
// return a tail of the output along with the exit code. Used by the
// coder role's Stop hook as ground truth — independent of whatever
// the coder Claude session claimed via its structured output.
//
// Timeout caps a runaway verify (an `npm test` waiting on stdin, etc).
// We treat timeout the same as a non-zero exit: failed.

import { spawn } from 'node:child_process';

export interface VerifyResult {
  exitCode: number; // -1 if timed out
  passed: boolean; // exitCode === 0
  output: string; // last 5KB / ~30 lines, combined stdout+stderr
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — verify shouldn't take longer
const TAIL_BYTES = 5 * 1024;

export async function runVerify(
  cwd: string,
  command: string = 'task verify',
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<VerifyResult> {
  const started = Date.now();
  return new Promise<VerifyResult>((resolve) => {
    const [bin, ...args] = command.split(/\s+/);
    const proc = spawn(bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' }, // CI=1 hints `task` etc. to skip prompts
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;

    const onData = (b: Buffer): void => {
      chunks.push(b);
      totalBytes += b.length;
      // Cap retained bytes so a chatty test suite can't OOM the worker.
      // Keep last ~64KB; we trim to 5KB tail at the end.
      while (totalBytes > 64 * 1024 && chunks.length > 1) {
        const dropped = chunks.shift();
        totalBytes -= dropped?.length ?? 0;
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({
        exitCode: -1,
        passed: false,
        output: tailOutput(chunks) + '\n[verify timed out]',
        durationMs: Date.now() - started,
      });
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        passed: false,
        output: `[verify spawn error: ${err.message}]`,
        durationMs: Date.now() - started,
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      resolve({
        exitCode,
        passed: exitCode === 0,
        output: tailOutput(chunks),
        durationMs: Date.now() - started,
      });
    });
  });
}

function tailOutput(chunks: Buffer[]): string {
  const buf = Buffer.concat(chunks);
  const tail = buf.length > TAIL_BYTES ? buf.subarray(buf.length - TAIL_BYTES) : buf;
  return tail.toString('utf8');
}
