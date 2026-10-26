// Per-worktree git detail, fetched on demand by the panel's Git tab. Runs inside the scanner worker.
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname } from 'node:path';

const exec = promisify(execFile);
const GRAPH_LIMIT = 300;
const DIFF_LIMIT = 200 * 1024;
const FS = '\x1f'; // field separator in --format output
const RS = '\x1e'; // record separator
/** git's well-known empty tree, for diffing a root commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Skip git's optional index refresh, so polling status/diff never holds index.lock against a stage or commit. */
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** norm(path) of worktrees being torn down: no git may start inside them (see removeWorktree). */
const removing = new Set();

/** Interactive requests skip the scan's git queue so a background scan can't delay them. */
async function git(cwd, ...args) {
  if (removing.size && [...removing].some((p) => norm(cwd) === p || norm(cwd).startsWith(p + '/'))) {
    throw new Error('This worktree is being removed');
  }
  const { stdout } = await exec('git', args, { cwd, windowsHide: true, maxBuffer: 16 << 20, env: GIT_ENV });
  return stdout;
}

/**
 * `git worktree remove --force`, made to finish. On Windows a folder can't be deleted while any
 * process uses it as its working directory or holds a file open in it: a git status from a poll, a
 * dev server still dying, the virus scanner. git then stops with "failed to delete '<path>':
 * Permission denied", usually after it has emptied the folder and unregistered the worktree.
 * Here the rest gets deleted with retries (those handles close within a second or so), then pruned.
 */
async function removeWorktree(repo, path) {
  if (norm(repo) === norm(path)) throw new Error("Won't remove the main checkout");
  removing.add(norm(path));
  try {
    for (let attempt = 1; ; attempt++) {
      let failure;
      try {
        await git(repo, 'worktree', 'remove', '--force', path);
        return;
      } catch (e) {
        failure = e;
      }
      try {
        await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        await git(repo, 'worktree', 'prune');
        const listed = (await git(repo, 'worktree', 'list', '--porcelain')).split(/\r?\n/)
          .some((l) => l.startsWith('worktree ') && norm(l.slice(9)) === norm(path));
        if (!listed) return;
      } catch { /* still in use: try again below */ }
      if (attempt === 3) throw failure;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  } finally {
    removing.delete(norm(path));
  }
}

/** Network git (fetch/pull/push): never prompt on a terminal nobody can see, and give up eventually. */
async function gitNet(cwd, ...args) {
  const { stdout, stderr } = await exec('git', args, {
    cwd, windowsHide: true, maxBuffer: 16 << 20, timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout + stderr;
}

/** A git failure as a short message: its fatal:/error: lines (the cause), else the last few lines. */
const gitError = (e) => {
  const ls = (e.stderr || e.message || '').trim().split(/\r?\n/);
  const cause = ls.filter((l) => /^(fatal|error):/.test(l));
  return (cause.length ? cause : ls.slice(-3)).join('\n');
};

const lines = (s) => s.split(/\r?\n/).filter(Boolean);

/** Run git with `input` on stdin (git apply reads the patch from "-"). */
function gitInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 << 20, env: GIT_ENV }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

/** False for a new repo whose first commit hasn't been made (unborn HEAD). */
const hasCommits = (cwd) => git(cwd, 'rev-parse', '-q', '--verify', 'HEAD').then(() => true, () => false);

/** `findWorktree(path)` resolves a known worktree (with `.git.trunk`) or null. */
export function gitDetail(findWorktree) {
  async function requireWorktree(path) {
    const wt = await findWorktree(path);
    if (!wt) throw new Error('unknown worktree');
    return wt;
  }

  /**
   * Recent history in topo order plus the commits only this worktree has. By default just this
   * worktree's HEAD and trunk; `all` adds every branch, remote and tag.
   */
  async function gitGraph({ path, all }) {
    const wt = await requireWorktree(path);
    const trunk = wt.git?.trunk ?? null;
    if (!(await hasCommits(wt.path))) {
      return { head: null, trunk, commits: [], unique: [], truncated: false, sync: await branchSync(wt) };
    }
    const revs = all ? ['--branches', '--exclude=*/HEAD', '--remotes', '--tags', 'HEAD'] : ['HEAD', ...(trunk ? [trunk] : [])];
    const out = await git(wt.path, 'log', ...revs, '--topo-order',
      `-n${GRAPH_LIMIT}`, `--format=%H${FS}%P${FS}%D${FS}%an${FS}%ct${FS}%s${RS}`);
    const commits = out.split(RS).map((r) => r.trim()).filter(Boolean).map((r) => {
      const [h, p, d, author, ct, subject] = r.split(FS);
      const refs = d
        ? d.split(', ').map((x) => x.replace(/^HEAD -> /, '').replace(/^tag: /, '🏷 ')).filter((x) => x !== 'HEAD' && !x.endsWith('/HEAD'))
        : [];
      return { h, parents: p ? p.split(' ') : [], refs, author, at: Number(ct) * 1000, subject };
    });
    const head = (await git(wt.path, 'rev-parse', 'HEAD')).trim();
    const unique = trunk ? lines(await git(wt.path, 'rev-list', '-n', '500', `${trunk}..HEAD`).catch(() => '')) : [];
    return { head, trunk, commits, unique, truncated: commits.length >= GRAPH_LIMIT, sync: await branchSync(wt) };
  }

  /**
   * This worktree's branch and where it pushes/pulls: its upstream if one is set (and still exists),
   * otherwise the remote a first push would publish to.
   */
  async function branchSync(wt) {
    const branch = (await git(wt.path, 'symbolic-ref', '--short', '-q', 'HEAD').catch(() => '')).trim() || null;
    const remotes = lines(await git(wt.path, 'remote').catch(() => ''));
    const base = { branch, remote: remotes.includes('origin') ? 'origin' : (remotes[0] ?? null), upstream: null, merge: null, upstreamSha: null, ahead: 0, behind: 0 };
    if (!branch) return base;
    const upstream = (await git(wt.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').catch(() => '')).trim();
    if (!upstream) return base;
    const remote = (await git(wt.path, 'config', `branch.${branch}.remote`).catch(() => '')).trim();
    const merge = (await git(wt.path, 'config', `branch.${branch}.merge`).catch(() => '')).trim();
    // A local upstream (remote ".") is just another branch; push/pull to it isn't what these buttons mean.
    if (!remote || remote === '.' || !merge) return base;
    // Tracking a branch with another name (e.g. a worktree branched from origin/main, which git tracks by
    // default) means it isn't published yet. Pushing to it would land this branch's commits on main.
    if (merge !== `refs/heads/${branch}`) return { ...base, remote };
    const [ahead, behind] = (await git(wt.path, 'rev-list', '--left-right', '--count', 'HEAD...@{u}')).trim().split(/\s+/).map(Number);
    const upstreamSha = (await git(wt.path, 'rev-parse', '@{u}')).trim();
    return { branch, remote, upstream, merge, upstreamSha, ahead, behind };
  }

  /**
   * Fetch, pull (fast-forward only), push or force-push this worktree's branch. Returns a one-line note.
   * forcePush takes `expect`: the upstream commit the user saw. The push is leased to it, so anything
   * pushed (or fetched) since then makes it fail instead of being overwritten.
   */
  async function syncAction(wt, action, expect) {
    const s = await branchSync(wt);
    if (!s.branch) throw new Error('HEAD is detached; check out a branch first');
    if (!s.remote) throw new Error('This repository has no remote');
    const run = (...args) =>
      gitNet(wt.path, ...args).catch((e) => {
        if (e.killed) throw new Error(`git ${args[0]} timed out`);
        // A corrupt remote-HEAD pointer (e.g. zero-filled by a crash) breaks every fetch; it's a cache git can rebuild.
        const bad = /bad object refs\/remotes\/(.+)\/HEAD/.exec(e.stderr ?? '');
        if (bad) throw new Error(`refs/remotes/${bad[1]}/HEAD is corrupt. It only records ${bad[1]}'s default branch; repair it with: git remote set-head ${bad[1]} --auto`);
        // "Your local changes to the following files would be overwritten by merge:\n\tA\n\tB\nPlease commit..."
        const files = /would be overwritten by merge:\r?\n((?:[ \t]+\S.*\r?\n)+)/.exec(e.stderr ?? '')?.[1].trim().split(/\s*\n\s*/);
        if (files) throw new Error(`Pulling would overwrite uncommitted changes in ${files.join(', ')}; commit or discard them first`);
        throw new Error((e.stderr || e.message || '').trim().split('\n').filter((l) => !/^(hint|To |From )/.test(l)).slice(-3).join('\n'));
      });
    const n = (k, what) => `${k} commit${k === 1 ? '' : 's'} ${what}`;

    if (action === 'fetch') {
      await run('fetch', s.remote);
      const after = await branchSync(wt);
      if (!after.upstream) return `Fetched ${s.remote}`;
      return after.behind ? `${n(after.behind, 'to pull')} from ${after.upstream}` : `Up to date with ${after.upstream}`;
    }
    if (action === 'pull') {
      if (!s.upstream) throw new Error(`${s.branch} isn't on ${s.remote} yet; push it first`);
      await run('fetch', s.remote);
      const before = await branchSync(wt);
      if (!before.behind) return `Already up to date with ${before.upstream}`;
      if (before.ahead) throw new Error(`${s.branch} and ${before.upstream} have diverged (${before.ahead} ahead, ${before.behind} behind); rebase or merge in the terminal`);
      await run('merge', '--ff-only', '@{u}');
      return `Pulled ${n(before.behind, `from ${before.upstream}`)}`;
    }
    if (action === 'push') {
      if (!s.upstream) {
        await run('push', '--set-upstream', s.remote, `refs/heads/${s.branch}:refs/heads/${s.branch}`);
        return `Published ${s.branch} to ${s.remote}`;
      }
      if (!s.ahead) return `Nothing to push; ${s.upstream} already has these commits`;
      await run('push', s.remote, `refs/heads/${s.branch}:${s.merge}`).catch((e) => {
        if (!/rejected|non-fast-forward|fetch first/.test(e.message)) throw e;
        throw new Error(s.behind
          ? `${s.upstream} has ${n(s.behind, "this branch doesn't")}; pull or rebase, then push, or force push to replace them`
          : `${s.upstream} has commits this branch doesn't; pull (or rebase in the terminal), then push`);
      });
      return `Pushed ${n(s.ahead, `to ${s.upstream}`)}`;
    }
    if (action === 'forcePush') {
      if (!s.upstream) throw new Error(`${s.branch} isn't on ${s.remote} yet; publish it instead`);
      if (!expect || expect !== s.upstreamSha) throw new Error(`${s.upstream} has moved since you looked; review it, then try again`);
      if (!s.behind) return s.ahead ? 'Nothing to overwrite; use Push' : `Nothing to push; ${s.upstream} already has these commits`;
      await run('push', `--force-with-lease=${s.merge}:${expect}`, s.remote, `refs/heads/${s.branch}:${s.merge}`).catch((e) => {
        if (!/stale info|rejected/.test(e.message)) throw e;
        throw new Error(`${s.upstream} has commits you haven't fetched; fetch and review them, then try again`);
      });
      return `Force-pushed ${s.branch} to ${s.upstream}, replacing ${n(s.behind, 'there')}`;
    }
    throw new Error('unknown action');
  }

  /** Uncommitted files with line counts. */
  async function gitChanges(path) {
    const wt = await requireWorktree(path);
    const trunk = wt.git?.trunk ?? null;

    // -z: NUL-separated, unquoted paths; a rename/copy is followed by an extra entry with the old path.
    const raw = (await git(wt.path, 'status', '--porcelain=v1', '--untracked-files=all', '-z')).split('\0');
    const files = [];
    for (let i = 0; i < raw.length; i++) {
      const e = raw[i];
      if (!e) continue;
      const file = { x: e[0], y: e[1], path: e.slice(3), from: null, added: null, removed: null };
      if (file.x === 'R' || file.x === 'C') file.from = raw[++i];
      files.push(file);
    }

    // numstat -z: "added\tremoved\tpath\0", or "added\tremoved\t\0old\0new\0" for renames. "-" = binary.
    const parts = (await git(wt.path, 'diff', 'HEAD', '-M', '--numstat', '-z').catch(() => '')).split('\0');
    for (let i = 0; i < parts.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
      if (!m) continue;
      let target = m[3];
      if (!target) target = parts[(i += 2)];
      const f = files.find((x) => x.path === target);
      if (f) {
        f.added = m[1] === '-' ? null : Number(m[1]);
        f.removed = m[2] === '-' ? null : Number(m[2]);
      }
    }

    return { trunk, files };
  }

  /**
   * Raw diff text for one changed file. view: 'staged' (index vs HEAD), 'unstaged' (working copy vs
   * index), or omitted (working copy vs HEAD, both combined).
   */
  async function rawDiff(wt, f, view) {
    const names = ['--', ...(f.from ? [f.from] : []), f.path];
    if (f.x === '?') {
      if (view === 'staged') return '';
      // Untracked: diff against nothing. --no-index exits 1 when the files differ, which is the point.
      return git(wt.path, 'diff', '--no-index', '--', '/dev/null', f.path).catch((e) => e.stdout ?? '');
    }
    if (view === 'staged') return git(wt.path, 'diff', '--cached', '-M', ...names);
    if (view === 'unstaged') return git(wt.path, 'diff', '--', f.path);
    return git(wt.path, 'diff', 'HEAD', '-M', ...names);
  }

  async function changedFile(wt, file) {
    const { files } = await gitChanges(wt);
    const f = files.find((x) => x.path === file);
    if (!f) throw new Error('file is not changed in this worktree');
    return f;
  }

  /** Diff of one uncommitted file. Only files git currently reports as changed are accepted. */
  async function gitDiff({ path, file, view }) {
    const wt = await requireWorktree(path);
    const diff = await rawDiff(wt, await changedFile(wt, file), view);
    const truncated = diff.length > DIFF_LIMIT;
    return { diff: truncated ? diff.slice(0, DIFF_LIMIT) : diff, truncated };
  }

  /**
   * Stage (from the unstaged view) or unstage (from the staged view) a single hunk. The patch is
   * rebuilt here from git's own diff — the client only names file, view and hunk index.
   */
  async function applyHunk(wt, file, view, hunk) {
    const f = await changedFile(wt, file);
    const diff = await rawDiff(wt, f, view);
    const all = diff.split('\n');
    const starts = all.flatMap((l, i) => (l.startsWith('@@') ? [i] : []));
    if (!Number.isInteger(hunk) || hunk < 0 || hunk >= starts.length) throw new Error('That hunk no longer exists; refresh');
    const header = all.slice(0, starts[0]);
    const body = all.slice(starts[hunk], starts[hunk + 1] ?? all.length);
    while (body.length && body.at(-1) === '') body.pop();
    const patch = [...header, ...body, ''].join('\n');
    const args = ['apply', '--cached', '--whitespace=nowarn', ...(view === 'staged' ? ['--reverse'] : []), '-'];
    await gitInput(wt.path, args, patch);
  }

  /**
   * Stage / unstage / discard / commit in the working tree. File names must be among the files git
   * currently reports as changed. Returns the fresh change list.
   *  - discard: tracked files are restored from the index (staged work survives); untracked files
   *    are deleted. The UI confirms first.
   */
  async function gitAction({ path, action, files, all, message, file, view, hunk, expect }) {
    const wt = await requireWorktree(path);
    if (action === 'fetch' || action === 'pull' || action === 'push' || action === 'forcePush') {
      const note = await syncAction(wt, action, expect);
      return { ...(await gitChanges(wt)), note };
    }
    if (action === 'stageHunk' || action === 'unstageHunk') {
      const v = action === 'stageHunk' ? 'unstaged' : 'staged';
      if (view && view !== v) throw new Error('Hunk action does not match the view');
      await applyHunk(wt, file, v, hunk).catch((e) => {
        throw new Error(gitError(e));
      });
      return gitChanges(wt);
    }
    const { files: changed } = await gitChanges(wt);
    const pick = all ? changed : changed.filter((f) => (files ?? []).includes(f.path));
    const paths = (fs) => fs.flatMap((f) => (f.from ? [f.from, f.path] : [f.path]));
    const isStaged = (f) => f.x !== ' ' && f.x !== '?';
    const run = (...args) =>
      git(wt.path, ...args).catch((e) => {
        throw new Error(gitError(e));
      });

    if (action === 'commit') {
      if (!message?.trim()) throw new Error('Write a commit message first');
      if (!changed.some(isStaged)) throw new Error('Nothing is staged');
      await run('commit', '-m', message.trim());
    } else {
      if (!pick.length) throw new Error('None of those files are changed');
      if (action === 'stage') await run('add', '-A', '--', ...paths(pick));
      else if (action === 'unstage') {
        const staged = pick.filter(isStaged);
        // Before the first commit there's no HEAD to restore from: just drop the files from the index.
        if (staged.length && (await hasCommits(wt.path))) await run('restore', '--staged', '--', ...paths(staged));
        else if (staged.length) await run('rm', '-r', '--cached', '--quiet', '--', ...paths(staged));
      } else if (action === 'discard') {
        const tracked = pick.filter((f) => f.x !== '?' && f.y !== ' ');
        const untracked = pick.filter((f) => f.x === '?');
        if (tracked.length) await run('restore', '--', ...tracked.map((f) => f.path));
        if (untracked.length) await run('clean', '-f', '--', ...untracked.map((f) => f.path));
      } else throw new Error('unknown action');
    }
    return gitChanges(wt);
  }

  /** A commit hash we'll pass to git: hex only, and it must name a commit in this repo. */
  async function requireCommit(wt, h) {
    if (!/^[0-9a-f]{7,40}$/i.test(h ?? '')) throw new Error('bad commit');
    const type = (await git(wt.path, 'cat-file', '-t', h).catch(() => '')).trim();
    if (type !== 'commit') throw new Error('unknown commit');
    const parents = (await git(wt.path, 'rev-list', '--parents', '-n', '1', h)).trim().split(' ').slice(1);
    // Merges diff against their first parent; the root commit against the empty tree.
    return { h, base: parents[0] ?? EMPTY_TREE, parents };
  }

  /** Files changed by a commit (vs its first parent), shaped like working-tree changes. */
  async function commitFiles({ path, h }) {
    const wt = await requireWorktree(path);
    const c = await requireCommit(wt, h);
    const [meta, nameStatus, numstat] = await Promise.all([
      git(wt.path, 'show', '-s', `--format=%H${FS}%an${FS}%ct${FS}%s${FS}%b`, h),
      git(wt.path, 'diff', '--name-status', '-M', '-z', c.base, h),
      git(wt.path, 'diff', '--numstat', '-M', '-z', c.base, h),
    ]);
    const [full, author, ct, subject, body] = meta.trim().split(FS);

    // name-status -z: "S\0path\0", or "R100\0old\0new\0" for renames/copies.
    const parts = nameStatus.split('\0');
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const st = parts[i];
      if (!st) continue;
      const letter = st[0];
      const f = { x: letter, y: ' ', path: '', from: null, added: null, removed: null };
      if (letter === 'R' || letter === 'C') {
        f.from = parts[++i];
        f.path = parts[++i];
      } else f.path = parts[++i];
      files.push(f);
    }
    const ns = numstat.split('\0');
    for (let i = 0; i < ns.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(ns[i]);
      if (!m) continue;
      let target = m[3];
      if (!target) target = ns[(i += 2)];
      const f = files.find((x) => x.path === target);
      if (f) {
        f.added = m[1] === '-' ? null : Number(m[1]);
        f.removed = m[2] === '-' ? null : Number(m[2]);
      }
    }
    return {
      commit: { h: full, short: full.slice(0, 7), author, at: Number(ct) * 1000, subject, body: (body ?? '').trim(), parents: c.parents },
      files,
    };
  }

  /** One file's diff within a commit. */
  async function commitDiff({ path, h, file }) {
    const wt = await requireWorktree(path);
    const c = await requireCommit(wt, h);
    const { files } = await commitFiles({ path, h });
    const f = files.find((x) => x.path === file);
    if (!f) throw new Error('file is not part of this commit');
    const diff = await git(wt.path, 'diff', '-M', c.base, h, '--', ...(f.from ? [f.from] : []), f.path);
    const truncated = diff.length > DIFF_LIMIT;
    return { diff: truncated ? diff.slice(0, DIFF_LIMIT) : diff, truncated };
  }

  /** What tearing this worktree down would lose, measured fresh (never from the scan cache). */
  async function teardownCheck(path) {
    const wt = await requireWorktree(path);
    const trunk = wt.git?.trunk ?? null;
    const status = (await git(wt.path, 'status', '--porcelain=v1', '--untracked-files=all', '-z')).split('\0').filter(Boolean);
    const files = status.filter((e) => e.length > 3 && e[2] === ' ').map((e) => e.slice(3));
    const branch = (await git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => 'HEAD')).trim();
    // What deleting the branch actually loses: commits no other branch, remote or tag reaches.
    // (Independent of trunk detection, so a stale or missing trunk can't hide anything.)
    const others = branch !== 'HEAD' ? [`--exclude=${branch}`, '--branches'] : ['--branches'];
    const commits = lines(
      await git(wt.path, 'log', '-n', '200', `--format=%h${FS}%s`, 'HEAD', '--not', ...others, '--remotes', '--tags').catch(() => ''),
    ).map((l) => {
      const [h, subject] = l.split(FS);
      return { h, subject };
    });
    // The main checkout is the parent of the shared .git dir; ask git rather than trust any cache.
    const commonDir = (await git(wt.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
    const repo = dirname(commonDir);
    const remoteBranch = branch !== 'HEAD' ? await publishedBranch(wt.path, branch, trunk) : null;
    return { repo, branch: branch === 'HEAD' ? null : branch, trunk, dirty: files.length, files: files.slice(0, 8), unmerged: commits.length, commits: commits.slice(0, 5), remoteBranch };
  }

  /**
   * The remote branch this branch was pushed to, if any: same name, tracked as its upstream, never
   * trunk. `unmerged`/`commits` are what deleting it along with the local branch would lose (commits
   * on either that nothing else reaches), since a pushed branch's commits otherwise count as safe.
   */
  async function publishedBranch(path, branch, trunk) {
    const remote = (await git(path, 'config', `branch.${branch}.remote`).catch(() => '')).trim();
    const merge = (await git(path, 'config', `branch.${branch}.merge`).catch(() => '')).trim();
    if (!remote || remote === '.' || merge !== `refs/heads/${branch}`) return null;
    if (trunk && (trunk === `${remote}/${branch}` || trunk === branch)) return null;
    const ref = `refs/remotes/${remote}/${branch}`;
    const sha = (await git(path, 'rev-parse', '--verify', '--quiet', ref).catch(() => '')).trim();
    if (!sha) return null;
    const commits = lines(
      await git(path, 'log', '-n', '200', `--format=%h${FS}%s`, 'HEAD', ref, '--not',
        `--exclude=${branch}`, '--branches', `--exclude=${remote}/${branch}`, '--remotes', '--tags').catch(() => ''),
    ).map((l) => {
      const [h, subject] = l.split(FS);
      return { h, subject };
    });
    return { remote, name: branch, sha, unmerged: commits.length, commits: commits.slice(0, 5) };
  }

  /**
   * Delete `name` on `remote`, but only while it still points at `sha` (what the check showed):
   * commits pushed there since must not vanish unseen. Already gone counts as done.
   */
  async function deleteRemoteBranch({ repo, remote, name, sha }) {
    const net = (...args) => gitNet(repo, ...args).catch((e) => {
      if (e.killed) throw new Error(`git ${args[0]} timed out`);
      throw new Error(gitError(e));
    });
    const listed = (await net('ls-remote', remote, `refs/heads/${name}`)).trim().split(/\s+/)[0] ?? '';
    if (!listed) {
      // Deleted there already (e.g. GitHub's delete-on-merge): drop the stale tracking ref too.
      await git(repo, 'update-ref', '-d', `refs/remotes/${remote}/${name}`).catch(() => {});
      return { alreadyGone: true };
    }
    if (listed !== sha) throw new Error(`${remote}/${name} has commits you haven't fetched; fetch and review them, or leave it on ${remote}`);
    await net('push', `--force-with-lease=refs/heads/${name}:${sha}`, remote, '--delete', `refs/heads/${name}`);
    return { alreadyGone: false };
  }

  /** Remove the worktree (see removeWorktree), then delete the branch. Runs from the main checkout. */
  async function teardown({ repo, path, branch }) {
    await removeWorktree(repo, path);
    let branchDeleted = false;
    let branchError = null;
    if (branch) {
      try {
        await git(repo, 'branch', '-D', branch);
        branchDeleted = true;
      } catch (e) {
        branchError = (e.stderr || e.message || '').trim();
      }
    }
    return { branchDeleted, branchError };
  }

  return { gitGraph, gitChanges, gitDiff, gitAction, commitFiles, commitDiff, teardownCheck, teardown, deleteRemoteBranch };
}
