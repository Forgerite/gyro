// New worktrees for new sessions: <repo>.worktrees/<name>, on a new branch of the same name.
// Runs in the detail worker (spawning git blocks the event loop on Windows).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Folder and branch name: no slashes (it's a folder too), nothing git rejects in a ref. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

async function git(cwd, ...args) {
  try {
    return (await exec('git', args, { cwd, windowsHide: true })).stdout;
  } catch (e) {
    throw new Error((e.stderr || e.message || '').trim().split('\n').slice(-2).join('\n'));
  }
}

/** Branches a worktree can start from, newest commit first, with the trunk to default to. */
export async function worktreeBases({ repo, trunk }) {
  const out = await git(repo, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)\t%(refname:short)\t%(committerdate:unix)', 'refs/heads', 'refs/remotes');
  const branches = [];
  for (const line of out.split('\n')) {
    const [ref, name, at] = line.split('\t');
    if (!ref || ref.endsWith('/HEAD')) continue;
    branches.push({ name, remote: ref.startsWith('refs/remotes/'), at: Number(at) * 1000 });
  }
  return { trunk: trunk && branches.some((b) => b.name === trunk) ? trunk : (branches[0]?.name ?? null), branches };
}

/** Where a repo's worktrees go: beside it, in <repo>.worktrees/ (the layout the other worktrees here use). */
export const worktreeHome = (repo) => join(dirname(repo), `${basename(repo)}.worktrees`);

/** Create <repo>.worktrees/<name> on a new branch <name>, started from `base`. Returns its path (and a note if it pushed the trunk). */
export async function createWorktree({ repo, name, base }) {
  if (!NAME.test(name ?? '') || name.endsWith('.') || name.endsWith('.lock') || name.includes('..')) {
    throw new Error('Use letters, numbers, dot, dash or underscore (starting with a letter or number)');
  }
  const refs = await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes');
  const known = new Set(refs.split('\n').filter(Boolean));
  if (!known.has(base)) throw new Error(`No branch named ${base}`);
  if (known.has(name)) throw new Error(`A branch named ${name} already exists`);
  const home = worktreeHome(repo);
  const path = join(home, name);
  if (existsSync(path)) throw new Error(`${path} already exists`);

  // Starting from a remote branch: bring it up to date first, so the work starts from what's on GitHub now.
  const remote = (await git(repo, 'remote')).split('\n').filter(Boolean).find((r) => base.startsWith(`${r}/`));
  if (remote) await git(repo, 'fetch', remote, base.slice(remote.length + 1)).catch(() => {}); // offline: use what we have

  const note = await publishTrunk(repo);
  await mkdir(home, { recursive: true });
  // --no-track: the new branch isn't the base's; it gets its own upstream when it's first pushed.
  await git(repo, 'worktree', 'add', '--no-track', '-b', name, path, base);
  return { path, note };
}

/**
 * GitHub makes the first branch pushed to an empty repo its default, and PRs go there. So before a
 * session starts, push the trunk to a remote that has no branches yet. Never blocks the session:
 * offline or refused, it's skipped. Returns a note when it pushed.
 */
async function publishTrunk(repo) {
  try {
    const remotes = (await git(repo, 'remote')).split(/\r?\n/).filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
    if (!remote) return null;
    // Anything fetched from it means it has branches already; only an untouched remote needs asking.
    if ((await git(repo, 'for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/${remote}/`)).trim()) return null;
    const heads = (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split(/\r?\n/).filter(Boolean);
    const current = (await git(repo, 'symbolic-ref', '--short', '-q', 'HEAD').catch(() => '')).trim();
    const trunk = ['main', 'master', current].find((b) => b && heads.includes(b));
    if (!trunk) return null;
    const net = { cwd: repo, windowsHide: true, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
    if ((await exec('git', ['ls-remote', '--heads', remote], net)).stdout.trim()) return null;
    await exec('git', ['push', '-q', '--set-upstream', remote, `refs/heads/${trunk}:refs/heads/${trunk}`], net);
    return `Pushed ${trunk} to ${remote} first, so it's the repo's default branch`;
  } catch {
    return null;
  }
}
