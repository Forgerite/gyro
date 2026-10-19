// Shared plumbing for smart features (headless claude runs inside a worktree).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLAUDE, childEnv } from './claude-env.mjs';

const exec = promisify(execFile);

/** Worktree path → the smart feature running there. One at a time: they'd fight over the index. */
const running = new Map();

export async function withLock(path, label, fn) {
  const busy = running.get(path);
  if (busy) throw new Error(`Already running ${busy} here`);
  running.set(path, label);
  try {
    return await fn();
  } finally {
    running.delete(path);
  }
}

export async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, windowsHide: true, maxBuffer: 16 << 20 })).stdout.trim();
}
export const tryGit = (cwd, ...args) => git(cwd, ...args).catch(() => null);
/** Exit status as a boolean, for `git diff --quiet` and friends. */
export const gitOk = (cwd, ...args) => exec('git', args, { cwd, windowsHide: true }).then(() => true, () => false);

/**
 * Run `claude -p` headless in `cwd`. Never persisted as a session (it shouldn't show on the tiles),
 * no MCP servers. Returns claude's JSON result (or null) plus stderr; never throws for claude's own
 * failures, since callers judge success by what happened in the repo.
 */
export async function runClaude(cwd, prompt, { tools, allowed, disallowed = [], timeoutMs, env = {} }) {
  let out;
  try {
    out = await exec(CLAUDE, [
      '-p', prompt,
      '--output-format', 'json',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--tools', ...tools,
      '--allowedTools', ...allowed,
      ...(disallowed.length ? ['--disallowedTools', ...disallowed] : []),
    ], { cwd, env: { ...childEnv(), ...env }, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 << 20 });
  } catch (e) {
    if (e.killed) return { timedOut: true, result: null, stderr: e.stderr ?? '' };
    out = e; // non-zero exit still prints the JSON result
  }
  let result = null;
  try { result = JSON.parse(out.stdout); } catch { /* claude failed to start */ }
  return { timedOut: false, result, stderr: out.stderr ?? '' };
}

/** Best one-line explanation of a failed run. */
export function whyFailed({ result, stderr }) {
  return result?.result?.trim() || stderr.trim().split('\n').slice(-2).join('\n') || 'unknown error';
}
