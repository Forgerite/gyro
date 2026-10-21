// Smart feature: "Auto rebase". Headless claude stashes uncommitted work, rebases the worktree's
// branch onto trunk, reapplies the stash and resolves any conflicts along the way. Gyro fetches
// first, keeps backup refs so nothing can be lost, and checks the result afterwards.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { git, gitOk, runClaude, tryGit, whyFailed, withLock } from './smart.mjs';

const exec = promisify(execFile);
const TIMEOUT_MS = 15 * 60_000;

const ALLOWED = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(git stash:*)', 'Bash(git rebase:*)', 'Bash(git add:*)', 'Bash(git rm:*)', 'Bash(git restore:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'Bash(git merge-base:*)', 'Bash(git rev-parse:*)', 'Bash(git ls-files:*)',
];
/** Never: rewrite history interactively, throw stashes away wholesale, move refs by hand, or publish. */
const DISALLOWED = [
  'Bash(git rebase -i:*)', 'Bash(git rebase --interactive:*)', 'Bash(git stash clear:*)',
  'Bash(git reset:*)', 'Bash(git push:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)',
];
/** Rebase steps that would open an editor must not hang a headless run. */
const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' };

function prompt({ branch, trunk, stashMsg, dirty }) {
  return [
    `Rebase this worktree's branch \`${branch}\` onto \`${trunk}\`, keeping its uncommitted changes.`,
    '',
    ...(dirty
      ? [`1. Stash everything uncommitted (staged, unstaged and untracked): \`git stash push --include-untracked -m "${stashMsg}"\`.`]
      : ['1. The working tree is clean, so there is nothing to stash.']),
    `2. Run \`git rebase ${trunk}\`.`,
    '3. Whenever the rebase stops on conflicts, resolve every conflicted file: look at both sides and the commits involved',
    '   (`git log`, `git show`, `git diff`), write the correct combined result that keeps the intent of both this branch\'s',
    '   change and trunk\'s change, remove every conflict marker, `git add` the file, then `git rebase --continue`.',
    '   Repeat until the rebase finishes. Do not `--skip` commits, and only `--abort` if a conflict truly cannot be resolved.',
    ...(dirty
      ? [
        '4. Reapply the stash: try `git stash pop --index` (keeps what was staged); if git refuses, use `git stash pop`.',
        '   If it conflicts, resolve those conflicts the same way, then `git restore --staged` the resolved files so they stay',
        `   uncommitted, and drop that one stash entry (the one named "${stashMsg}") with \`git stash drop <its ref>\`.`,
      ]
      : []),
    '',
    'Rules: do not create new commits beyond what the rebase replays, do not push, reset, or switch branches, and leave',
    'other stash entries alone.',
    '',
    'When done, reply with a short summary: how many commits were replayed, and which conflicts (if any) you resolved and how.',
  ].join('\n');
}

/** Rebase `path`'s branch onto `trunk`. Resolves with what happened, including any problems left behind. */
export function autoRebase({ path, trunk }) {
  return withLock(path, 'a rebase', async () => {
    const branch = await tryGit(path, 'symbolic-ref', '--short', '-q', 'HEAD');
    if (!branch) throw new Error('HEAD is detached; check out a branch first');
    if (!trunk) throw new Error('No trunk branch found for this repository');
    if (trunk === branch) throw new Error(`${branch} is the trunk branch itself`);
    const gitDir = await git(path, 'rev-parse', '--absolute-git-dir');
    if (['rebase-merge', 'rebase-apply', 'MERGE_HEAD'].some((f) => existsSync(join(gitDir, f)))) {
      throw new Error('A rebase or merge is already in progress here; finish or abort it in the terminal first');
    }

    // Rebase onto trunk as the remote has it now, not as of the last fetch.
    let fetchNote = null;
    const remotes = (await tryGit(path, 'remote'))?.split(/\r?\n/).filter(Boolean) ?? [];
    const remote = remotes.find((r) => trunk.startsWith(`${r}/`));
    if (remote) {
      await exec('git', ['fetch', remote], { cwd: path, windowsHide: true, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
        .catch((e) => (fetchNote = `Couldn't fetch ${remote} (${(e.stderr || e.message).trim().split('\n').pop()}); used the last fetched ${trunk}`));
    }
    const trunkSha = await tryGit(path, 'rev-parse', '-q', '--verify', `${trunk}^{commit}`);
    if (!trunkSha) throw new Error(`${trunk} doesn't exist`);
    if (await gitOk(path, 'merge-base', '--is-ancestor', trunkSha, 'HEAD')) {
      return { upToDate: true, branch, trunk, note: `Already on top of ${trunk}`, fetchNote, problems: [] };
    }

    // Backups first: the branch tip, and a snapshot of uncommitted (tracked) work.
    const stamp = Date.now();
    const backup = `refs/gyro/backup/${branch}/${stamp}`;
    const before = await git(path, 'rev-parse', 'HEAD');
    await git(path, 'update-ref', `${backup}/head`, before);
    const wip = await tryGit(path, 'stash', 'create');
    if (wip) await git(path, 'update-ref', `${backup}/wip`, wip);
    const dirty = !!(await git(path, 'status', '--porcelain'));
    const stashMsg = `gyro auto-rebase ${stamp}`;

    const run = await runClaude(path, prompt({ branch, trunk, stashMsg, dirty }), {
      tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
      allowed: ALLOWED,
      disallowed: DISALLOWED,
      timeoutMs: TIMEOUT_MS,
      env: NO_EDITOR,
    });

    // Judge by the repository, not by what claude says.
    const problems = [];
    if (run.timedOut) problems.push('Claude ran out of time');
    if (['rebase-merge', 'rebase-apply'].some((f) => existsSync(join(gitDir, f)))) problems.push('The rebase is still in progress');
    const unmerged = await tryGit(path, 'diff', '--name-only', '--diff-filter=U');
    if (unmerged) problems.push(`Unresolved conflicts: ${unmerged.split(/\r?\n/).join(', ')}`);
    const markers = ((await exec('git', ['diff', trunkSha, '--check'], { cwd: path, windowsHide: true }).catch((e) => e)).stdout ?? '')
      .split(/\r?\n/).filter((l) => l.includes('conflict marker')).map((l) => l.split(':')[0]);
    if (markers.length) problems.push(`Conflict markers left in: ${[...new Set(markers)].join(', ')}`);
    const nowBranch = await tryGit(path, 'symbolic-ref', '--short', '-q', 'HEAD');
    if (nowBranch !== branch && !problems.length) problems.push(`Ended on ${nowBranch ?? 'a detached HEAD'} instead of ${branch}`);
    if (!(await gitOk(path, 'merge-base', '--is-ancestor', trunkSha, 'HEAD'))) problems.push(`${branch} is not on top of ${trunk}`);
    const stashes = (await tryGit(path, 'stash', 'list', '--format=%gd %gs')) ?? '';
    const ours = stashes.split(/\r?\n/).find((l) => l.includes(stashMsg));
    if (ours) problems.push(`Uncommitted changes weren't reapplied; they're still stashed as ${ours.split(' ')[0]}`);

    const after = await git(path, 'rev-parse', 'HEAD');
    const commits = Number(await tryGit(path, 'rev-list', '--count', `${trunkSha}..HEAD`)) || 0;
    return {
      upToDate: false,
      branch,
      trunk,
      commits,
      moved: after !== before,
      summary: run.result?.result?.trim() || (problems.length ? whyFailed(run) : null),
      problems,
      backup: { head: `${backup}/head`, wip: wip ? `${backup}/wip` : null },
      fetchNote,
      costUsd: run.result?.total_cost_usd ?? null,
      ms: run.result?.duration_ms ?? null,
    };
  });
}
