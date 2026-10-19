// Smart feature: "Compose commit". Headless claude reads the staged changes, writes the message
// and commits. Runs in the detail worker; ccdb then checks the commit is exactly what was staged.
import { git, gitOk, runClaude, tryGit, whyFailed, withLock } from './smart.mjs';

const TIMEOUT_MS = 4 * 60_000;

/** Read-only git plus `git commit`: claude can look and commit, but not edit, stage or push. */
const ALLOWED = ['Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(git show:*)', 'Bash(git commit:*)'];

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
export function composeCommit({ path, hint }) {
  return withLock(path, 'a compose', async () => {
    // What "exactly what was staged" means: the index as a tree, on top of the current HEAD.
    if (await gitOk(path, 'diff', '--cached', '--quiet')) throw new Error('Nothing is staged');
    const before = await tryGit(path, 'rev-parse', '-q', '--verify', 'HEAD');
    const tree = await git(path, 'write-tree');

    const run = await runClaude(path, prompt(hint), { tools: ['Bash'], allowed: ALLOWED, timeoutMs: TIMEOUT_MS });
    if (run.timedOut) throw new Error('Claude took too long; nothing was committed');

    const after = await tryGit(path, 'rev-parse', '-q', '--verify', 'HEAD');
    if (!after || after === before) throw new Error(`Claude didn't commit: ${whyFailed(run)}`);

    const [subject, parent, newTree] = await Promise.all([
      git(path, 'log', '-1', '--format=%s'),
      tryGit(path, 'rev-parse', '-q', '--verify', 'HEAD^'),
      git(path, 'rev-parse', 'HEAD^{tree}'),
    ]);
    const exact = newTree === tree && parent === before;
    return {
      commit: { h: after, short: after.slice(0, 7), subject },
      warning: exact ? null : 'This commit is not exactly what was staged (Claude changed the index, amended, or committed more). Review it in the graph.',
      costUsd: run.result?.total_cost_usd ?? null,
      ms: run.result?.duration_ms ?? null,
    };
  });
}
