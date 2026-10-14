// Smart feature: "Compose commit". Headless claude reads the staged changes, writes the message
// and commits. Runs in the detail worker; ccdb then checks the commit is exactly what was staged.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLAUDE, childEnv } from './claude-env.mjs';

const exec = promisify(execFile);
const TIMEOUT_MS = 4 * 60_000;

/** Read-only git plus `git commit`: claude can look and commit, but not edit, stage or push. */
const ALLOWED = ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(git show:*)', 'Bash(git commit:*)'];

/** One compose at a time per worktree. */
const running = new Set();

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, windowsHide: true, maxBuffer: 16 << 20 })).stdout.trim();
}
const tryGit = (cwd, ...args) => git(cwd, ...args).catch(() => null);

function prompt(hint) {
  return [
    'Commit the currently staged changes in this git repository.',
    '',
    '1. Inspect them with `git diff --cached` (use `git log -n 15 --format=%s` to see how this repository writes commit messages).',
    '2. Write a commit message that follows this repository\'s conventions and any commit-message instructions you have, such as in CLAUDE.md.',
    '3. Run `git commit` with that message. Commit only what is staged: never use -a, --all, --amend or file paths, and do not stage, unstage, edit or push anything.',
    '',
    'When done, reply with only the commit\'s subject line.',
    ...(hint?.trim() ? ['', 'The author\'s notes on this change (use them to shape the message):', hint.trim()] : []),
  ].join('\n');
}

/** Compose and make the commit. Returns the new commit, or throws with why nothing was committed. */
export async function composeCommit({ path, hint }) {
  if (running.has(path)) throw new Error('Already composing a commit here');
  running.add(path);
  try {
    // What "exactly what was staged" means: the index as a tree, on top of the current HEAD.
    const staged = await exec('git', ['diff', '--cached', '--quiet'], { cwd: path, windowsHide: true }).then(() => false, () => true);
    if (!staged) throw new Error('Nothing is staged');
    const before = await tryGit(path, 'rev-parse', '-q', '--verify', 'HEAD');
    const tree = await git(path, 'write-tree');

    let out;
    try {
      out = await exec(CLAUDE, [
        '-p', prompt(hint),
        '--output-format', 'json',
        '--no-session-persistence', // a background helper, not a session to show on the tiles
        '--strict-mcp-config', // no MCP servers needed; starts faster
        '--tools', 'Bash',
        '--allowedTools', ...ALLOWED,
      ], { cwd: path, env: childEnv(), windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 16 << 20 });
    } catch (e) {
      if (e.killed) throw new Error('Claude took too long; nothing was committed');
      out = e; // claude exits non-zero on errors but still prints its JSON result
    }
    let result = null;
    try { result = JSON.parse(out.stdout); } catch { /* not JSON: claude failed to start */ }

    const after = await tryGit(path, 'rev-parse', '-q', '--verify', 'HEAD');
    if (!after || after === before) {
      const why = result?.result?.trim() || (out.stderr ?? '').trim().split('\n').slice(-2).join('\n') || 'unknown error';
      throw new Error(`Claude didn't commit: ${why}`);
    }

    const [subject, parent, newTree] = await Promise.all([
      git(path, 'log', '-1', '--format=%s'),
      tryGit(path, 'rev-parse', '-q', '--verify', 'HEAD^'),
      git(path, 'rev-parse', 'HEAD^{tree}'),
    ]);
    const exact = newTree === tree && parent === before;
    return {
      commit: { h: after, short: after.slice(0, 7), subject },
      warning: exact ? null : 'This commit is not exactly what was staged (Claude changed the index, amended, or committed more). Review it in the graph.',
      costUsd: result?.total_cost_usd ?? null,
      ms: result?.duration_ms ?? null,
    };
  } finally {
    running.delete(path);
  }
}
