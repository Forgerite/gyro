// Scanner worker: git status + Claude session logs, off the main thread.
// Spawning git on Windows blocks the calling event loop; here that can't stall terminal keystrokes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat, open, rename, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const exec = promisify(execFile);
const CODE_ROOT = workerData.codeRoot;
const CLAUDE_DIR = join(homedir(), '.claude');
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 64 * 1024;

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// ---------- git ----------

// Spawning ~150 git processes at once is slow on Windows; a small pool finishes sooner.
const GIT_CONCURRENCY = 8;
let gitRunning = 0;
const gitQueue = [];
// Background status must not take index.lock: a scan landing mid-click made `git add` fail with
// "index.lock exists", and a scan killed mid-refresh can leave a stale lock behind.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

async function git(cwd, ...args) {
  if (gitRunning >= GIT_CONCURRENCY) await new Promise((r) => gitQueue.push(r));
  gitRunning++;
  try {
    const { stdout } = await exec('git', args, { cwd, windowsHide: true, maxBuffer: 8 << 20, env: GIT_ENV });
    return stdout;
  } finally {
    gitRunning--;
    gitQueue.shift()?.();
  }
}

async function findRepos() {
  const entries = await readdir(CODE_ROOT, { withFileTypes: true });
  const repos = [];
  await Promise.all(entries.filter((e) => e.isDirectory()).map(async (e) => {
    const dir = join(CODE_ROOT, e.name);
    try {
      if ((await stat(join(dir, '.git'))).isDirectory()) repos.push(dir);
    } catch { /* not a repo */ }
  }));
  return repos.sort((a, b) => a.localeCompare(b));
}

function parseWorktrees(out) {
  return out.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const wt = { path: '', head: '', branch: null, detached: false, bare: false, prunable: false };
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(' ');
      const val = rest.join(' ');
      if (key === 'worktree') wt.path = resolve(val);
      else if (key === 'HEAD') wt.head = val.slice(0, 7);
      else if (key === 'branch') wt.branch = val.replace('refs/heads/', '');
      else if (key === 'detached') wt.detached = true;
      else if (key === 'bare') wt.bare = true;
      else if (key === 'prunable') wt.prunable = true;
    }
    return wt;
  }).filter((wt) => !wt.bare);
}

/** The repo's trunk ref: a remote's HEAD, else <remote>/main|master, else local main|master. */
async function findTrunk(repo, remotes) {
  for (const r of remotes) {
    const head = (await git(repo, 'symbolic-ref', '--short', `refs/remotes/${r}/HEAD`).catch(() => '')).trim();
    if (head) return head;
  }
  for (const ref of [...remotes.flatMap((r) => [`${r}/main`, `${r}/master`]), 'main', 'master']) {
    if (await git(repo, 'rev-parse', '--verify', '--quiet', ref).then(() => true, () => false)) return ref;
  }
  return null;
}

/** norm(path) of worktrees being torn down: a git process inside one would keep it from being deleted. */
const removing = new Set();

/** norm(worktree path) -> base ref its work session rebases onto; pushed by the main thread
 * (the DB stays out of this worker), falling back to the repo's trunk until it arrives. */
let sessionBaseMap = new Map();

function sessionBases(list) {
  const next = new Map(list.map(({ path, base }) => [norm(path), base]));
  // A changed base must show in the next scan, not after the status TTL.
  for (const [key, base] of next) if (sessionBaseMap.get(key) !== base) statusCache.delete(key);
  sessionBaseMap = next;
}

/** The branch a rebase in progress here is replaying (HEAD is detached meanwhile), else null. Plain file reads, no git spawn. */
async function rebasingBranch(path) {
  try {
    const dotGit = join(path, '.git');
    // A linked worktree's .git is a file pointing at its git dir; the main worktree's is the dir itself.
    const gitDir = (await stat(dotGit)).isDirectory()
      ? dotGit
      : resolve(path, (await readFile(dotGit, 'utf8')).match(/^gitdir:\s*(.+)$/m)?.[1].trim() ?? '');
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const head = await readFile(join(gitDir, dir, 'head-name'), 'utf8').catch(() => null);
      if (head) return head.trim().replace(/^refs\/heads\//, '');
    }
  } catch { /* no git dir: not rebasing */ }
  return null;
}

async function worktreeStatus(path, trunk) {
  if (removing.has(norm(path))) return statusCache.get(norm(path))?.git ?? { missing: true };
  try {
    const files = (await git(path, 'status', '--porcelain=v1')).split(/\r?\n/).filter(Boolean);
    // Commits on HEAD that trunk doesn't contain. Note: squash-merged branches still count as unmerged.
    const unmerged = trunk
      ? Number((await git(path, 'rev-list', '--count', `${trunk}..HEAD`).catch(() => '0')).trim())
      : 0;
    // How far HEAD is behind the work session's base (vs local refs as of the last fetch).
    // null: the base ref doesn't resolve here — the plan shows that, never a silent "up to date".
    const baseRef = sessionBaseMap.get(norm(path)) ?? trunk;
    const behindBase = baseRef
      ? await git(path, 'rev-list', '--count', `HEAD..${baseRef}`).then((out) => Number(out.trim()), () => null)
      : null;
    // The branch's upstream, for push-ness (same counts as gitdetail's branchSync, trimmed).
    let upstream = null;
    if (await git(path, 'rev-parse', '--verify', '--quiet', '@{u}').then(() => true, () => false)) {
      const counts = (await git(path, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').catch(() => '')).trim().split(/\s+/);
      upstream = { exists: true, ahead: Number(counts[0]) || 0, behind: Number(counts[1]) || 0 };
    }
    // A brand-new repo has no commits yet (unborn HEAD): that's not "missing".
    const lastCommit = (await git(path, 'log', '-1', '--format=%ct%x09%s').catch(() => '')).trim().split('\t');
    return {
      dirty: files.length,
      unmerged,
      trunk,
      baseRef,
      behindBase,
      upstream,
      rebasing: await rebasingBranch(path),
      lastCommitAt: Number(lastCommit[0]) * 1000 || null,
      lastCommitSubject: lastCommit[1] || null,
    };
  } catch {
    return { missing: true };
  }
}

// ---------- claude sessions ----------

const sessionCache = new Map(); // file -> { mtimeMs, size, data }

async function readSlice(file, start, length) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function parseLines(text, dropFirst) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift(); // partial line from mid-file read
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial */ }
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

/** "<task-notification> … <tool-use-id>toolu_…</tool-use-id>": a background task finished (or was stopped). */
const NOTIFIED = /<tool-use-id>(toolu_[A-Za-z0-9_-]+)<\/tool-use-id>/g;
const OUTPUT_FILE = /written to: (.+?\.output)\b/;

/**
 * Background work a session started and hasn't heard back from: shells run in the background,
 * monitors, async subagents and workflows. Claude marks a session idle when its turn ends, even while these run.
 */
function trackBackground(r, s) {
  // Finished: the notification is queued (and later delivered as a user message) with the launch's tool-use id.
  // A monitor's per-event notifications carry only its task id, so they don't end it here.
  const note = r.type === 'queue-operation' ? r.content
    : r.type === 'user' && typeof r.message?.content === 'string' ? r.message.content : null;
  if (typeof note === 'string' && note.includes('<task-notification>')) {
    for (const [, id] of note.matchAll(NOTIFIED)) s.background?.delete(id);
    return;
  }
  const res = r.toolUseResult;
  if (r.type !== 'user' || !res || typeof res !== 'object' || !Array.isArray(r.message?.content)) return;
  // TaskStop: the stopped task is over even if its own notice never lands in the log.
  if (res.task_id && typeof res.message === 'string' && res.message.startsWith('Successfully stopped')) {
    for (const [id, t] of s.background ?? []) if (t.taskId === res.task_id) s.background.delete(id);
    return;
  }
  const kind = res.backgroundTaskId ? 'shell' : res.isAsync ? 'agent'
    : res.taskId && 'timeoutMs' in res ? 'monitor' : res.taskId && res.status ? 'workflow' : null;
  const id = kind && r.message.content.find((c) => c.type === 'tool_result')?.tool_use_id;
  if (!id) return;
  const text = textOf(r.message.content.find((c) => c.type === 'tool_result').content);
  const at = Date.parse(r.timestamp) || 0;
  s.background ??= new Map();
  s.background.set(id, {
    kind, at,
    taskId: res.backgroundTaskId ?? res.taskId ?? null,
    // A monitor is killed at its timeout; a persistent one lasts until the session ends.
    expiresAt: kind === 'monitor' && !res.persistent && res.timeoutMs ? at + res.timeoutMs : null,
    persistent: kind === 'monitor' && !!res.persistent,
    output: res.outputFile ?? text.match(OUTPUT_FILE)?.[1] ?? null,
  });
}

function summarize(records, s) {
  for (const r of records) {
    if (!r.isSidechain) trackBackground(r, s);
    if (r.cwd) s.cwd = r.cwd;
    if (r.type === 'relocated' && r.relocatedCwd) s.cwd = r.relocatedCwd;
    if (r.gitBranch) s.branch = r.gitBranch;
    if (r.timestamp) {
      const t = Date.parse(r.timestamp);
      if (t > (s.lastActivity ?? 0)) s.lastActivity = t;
      if (!s.startedAt || t < s.startedAt) s.startedAt = t;
    }
    if (r.entrypoint) s.entrypoint = r.entrypoint;
    if (r.message?.model) s.model = r.message.model;
    if (r.type === 'custom-title') s.customTitle = r.customTitle;
    if (r.type === 'ai-title') s.aiTitle = r.aiTitle;
    if (r.type === 'last-prompt') s.lastPrompt = r.lastPrompt;
    if (r.type === 'pr-link') s.pr = { number: r.prNumber, url: r.prUrl };
    if (r.isSidechain) continue;
    if (r.type === 'assistant') {
      const t = textOf(r.message?.content);
      if (t.trim()) { s.lastAssistant = t; s.lastRole = 'assistant'; }
      else if (r.message?.content?.some?.((c) => c.type === 'tool_use')) {
        const tool = r.message.content.find((c) => c.type === 'tool_use');
        s.lastTool = tool.name;
        s.lastRole = 'tool';
      }
    }
    if (r.type === 'user' && r.origin?.kind === 'human') {
      const t = textOf(r.message?.content);
      if (t.trim()) { s.lastUser = t; s.lastRole = 'user'; }
    }
  }
}

async function readSession(file) {
  const st = await stat(file);
  const cached = sessionCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data;

  const s = { id: basename(file, '.jsonl'), file, sizeBytes: st.size };
  const big = st.size > TAIL_BYTES + HEAD_BYTES;
  // Head gives start time, first cwd and early titles; tail gives everything recent.
  if (big) summarize(parseLines(await readSlice(file, 0, HEAD_BYTES), false), s);
  const start = big ? st.size - TAIL_BYTES : 0;
  summarize(parseLines(await readSlice(file, start, st.size - start), big), s);
  s.lastActivity ??= st.mtimeMs;
  s.title = s.customTitle ?? s.aiTitle ?? s.lastPrompt?.slice(0, 80) ?? null;
  s.background = s.background?.size ? [...s.background.values()] : null;
  for (const [k, max] of [['lastAssistant', 4000], ['lastUser', 1200], ['lastPrompt', 300]]) {
    if (s[k]?.length > max) s[k] = s[k].slice(0, max) + '…';
  }

  sessionCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data: s });
  return s;
}

async function readAllSessions() {
  const projectsDir = join(CLAUDE_DIR, 'projects');
  const dirs = await readdir(projectsDir, { withFileTypes: true });
  const files = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    for (const f of await readdir(join(projectsDir, d.name))) {
      if (f.endsWith('.jsonl')) files.push(join(projectsDir, d.name, f));
    }
  }
  const results = await Promise.allSettled(files.map(readSession));
  return results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function readLiveSessions() {
  const dir = join(CLAUDE_DIR, 'sessions');
  const live = new Map();
  let names = [];
  try { names = await readdir(dir); } catch { return live; }
  await Promise.all(names.filter((n) => n.endsWith('.json')).map(async (n) => {
    try {
      const j = JSON.parse(await readFile(join(dir, n), 'utf8'));
      if (!isAlive(j.pid)) return;
      live.set(j.sessionId, {
        pid: j.pid, status: j.status, name: j.name, entrypoint: j.entrypoint,
        cwd: j.cwd, statusUpdatedAt: j.statusUpdatedAt, kind: j.kind, startedAt: j.startedAt,
      });
    } catch { /* torn write */ }
  }));
  return live;
}

// ---------- snapshot ----------

const WORKTREE_TTL = 15_000;
const TRUNK_TTL = 10 * 60_000;
let worktreeCache = { at: 0, data: null };
let scanning = null; // in-flight scan, shared by all callers
const trunkCache = new Map(); // repo -> { at, trunk }

// Every git launch risks a ~400ms process-creation stall on this machine, so quiet worktrees are
// re-checked rarely and only active ones (recent session, live session, or uncommitted work) often.
const HOT_TTL = 15_000;
const COLD_TTL = 5 * 60_000;
const LIST_TTL = 60_000;
const listCache = new Map(); // repo -> { at, worktrees }
const statusCache = new Map(); // norm(worktree path) -> { at, git }
let hotPaths = new Set(); // norm(path) of active worktrees, from the last snapshot

/**
 * Stale-while-revalidate: callers get the last scan immediately and a refresh runs in the
 * background (one at a time). Only the very first call, or `fresh`, waits for a scan.
 */
async function loadWorkspaces({ fresh = false } = {}) {
  const stale = Date.now() - worktreeCache.at >= WORKTREE_TTL;
  if ((stale || fresh) && !scanning) {
    scanning = scanWorkspaces()
      .then((data) => (worktreeCache = { at: Date.now(), data }))
      .catch((e) => console.error('git scan failed', e))
      .finally(() => (scanning = null));
  }
  if (!worktreeCache.data || fresh) await scanning;
  return worktreeCache.data ?? [];
}

/** norm(repo) -> base branch set for the project in Gyro; pushed by the main thread (state.json stays there). */
let projectBaseMap = new Map();

async function projectBases(map) {
  const next = new Map(Object.entries(map ?? {}));
  let changed = false;
  for (const repo of new Set([...projectBaseMap.keys(), ...next.keys()])) {
    if (projectBaseMap.get(repo) === next.get(repo)) continue;
    changed = true;
    // A changed base must show at once: re-resolve the trunk and recount every worktree against it.
    for (const key of trunkCache.keys()) if (norm(key) === repo) trunkCache.delete(key);
    for (const key of statusCache.keys()) if (key.startsWith(repo)) statusCache.delete(key);
  }
  projectBaseMap = next;
  if (!changed || !worktreeCache.data) return; // nothing scanned yet: the first scan uses it
  if (scanning) await scanning; // a scan already running started before the change
  await loadWorkspaces({ fresh: true });
}

/** The repo's trunk: the base branch set in Gyro while it still resolves, else the detected one. */
async function cachedTrunk(repo) {
  const hit = trunkCache.get(repo);
  if (hit && Date.now() - hit.at < TRUNK_TTL) return hit;
  const remotes = (await git(repo, 'remote').catch(() => '')).split(/\r?\n/).filter(Boolean);
  const detected = await findTrunk(repo, remotes);
  const set = projectBaseMap.get(norm(repo));
  const ok = set && await git(repo, 'rev-parse', '--verify', '--quiet', `${set}^{commit}`).then(() => true, () => false);
  const entry = { at: Date.now(), trunk: ok ? set : detected, detected, missing: set && !ok ? set : null, remotes };
  trunkCache.set(repo, entry);
  return entry;
}

async function scanWorkspaces() {
  const repos = await findRepos();
  const data = await Promise.all(repos.map(async (repo) => {
    let worktrees = [];
    const listed = listCache.get(repo);
    if (listed && Date.now() - listed.at < LIST_TTL) worktrees = listed.worktrees.map((wt) => ({ ...wt }));
    else {
      try { worktrees = parseWorktrees(await git(repo, 'worktree', 'list', '--porcelain')); } catch { /* broken repo */ }
      listCache.set(repo, { at: Date.now(), worktrees: worktrees.map((wt) => ({ ...wt })) });
    }
    const { trunk, detected, missing, remotes } = await cachedTrunk(repo);
    await Promise.all(worktrees.map(async (wt) => {
      wt.isMain = norm(wt.path) === norm(repo);
      wt.name = wt.isMain ? '(main)' : basename(wt.path);
      const key = norm(wt.path);
      const cached = statusCache.get(key);
      const ttl = hotPaths.has(key) || cached?.git.dirty ? HOT_TTL : COLD_TTL;
      // HEAD detaching or reattaching (a rebase starting or ending) makes the cached status stale.
      if (cached && Date.now() - cached.at < ttl && cached.detached === wt.detached) wt.git = cached.git;
      else {
        wt.git = await worktreeStatus(wt.path, trunk);
        statusCache.set(key, { at: Date.now(), git: wt.git, detached: wt.detached });
      }
    }));
    // trunk: what work branches from and PRs into. detectedTrunk: what git alone says. baseMissing: a set base that no longer resolves.
    return { name: basename(repo), path: repo, trunk, detectedTrunk: detected, baseMissing: missing, remotes, worktrees };
  }));
  return data;
}

/** Per project, at most this many loose sessions (newest first). */
const LOOSE_LIMIT = 40;
/** Where worktree tools put a repo's worktrees, relative to the repo: repo.worktrees/x, repo/.claude/worktrees/x, ... */
const WORKTREE_HOMES = ['.worktrees/', '-worktrees/', '/.claude/worktrees/', '/.worktrees/'];

/**
 * A session started in one of a project's worktree folders that isn't a current worktree (it was
 * removed, or left behind as a plain folder): returns that project and where the worktree's
 * folder name starts in the path, else null.
 */
function worktreeHome(workspaces, cwd) {
  for (const ws of workspaces) {
    const root = norm(ws.path);
    const home = WORKTREE_HOMES.find((h) => cwd.startsWith(root + h));
    if (!home) continue;
    const current = ws.worktrees.some((wt) => cwd === norm(wt.path) || cwd.startsWith(norm(wt.path) + '/') && !wt.isMain);
    return current ? null : { ws, start: root.length + home.length };
  }
  return null;
}

/** A background shell that's gone quiet this long counts as left running (a dev server), not as work. */
const QUIET_SHELL_MS = 10 * 60_000;
/** Subagents and workflows always report back; past this, assume the notification was lost. */
const STALE_TASK_MS = 12 * 3600_000;
/** Slack past a monitor's timeout before assuming its expiry notice was lost. */
const MONITOR_GRACE_MS = 60_000;

/** Background tasks of this live session still running: launched by this process, not yet reported back. */
function runningBackground(s, live) {
  const now = Date.now();
  let n = 0;
  for (const t of s.background ?? []) {
    if (live.startedAt && t.at < live.startedAt) continue;
    if (t.expiresAt && now > t.expiresAt + MONITOR_GRACE_MS) continue;
    if (!t.persistent && now - t.at > STALE_TASK_MS) continue;
    if (t.kind === 'shell' && now - t.at > QUIET_SHELL_MS) {
      let written = 0;
      try { written = statSync(t.output).mtimeMs; } catch { /* no output file: gone */ }
      if (now - written > QUIET_SHELL_MS) continue;
    }
    n++;
  }
  return n;
}

async function snapshot() {
  const [workspaces, sessions, live] = await Promise.all([loadWorkspaces(), readAllSessions(), readLiveSessions()]);

  // Longest worktree path wins, so sessions in nested worktrees (repo/.claude/worktrees/x) land correctly.
  const index = workspaces.flatMap((ws) => ws.worktrees.map((wt) => ({ key: norm(wt.path), wt })))
    .sort((a, b) => b.key.length - a.key.length);
  const out = workspaces.map((ws) => ({
    ...ws,
    worktrees: ws.worktrees.map((wt) => ({ ...wt, sessions: [] })),
  }));
  const byPath = new Map(out.flatMap((ws) => ws.worktrees.map((wt) => [norm(wt.path), wt])));
  const unmatched = [];
  const looseBy = new Map(out.map((ws) => [ws, []]));

  for (const s of sessions) {
    const l = live.get(s.id);
    const session = { ...s, file: undefined, background: undefined, live: l ? { ...l, background: runningBackground(s, l) } : null };
    if (l?.name && !s.customTitle) session.title = l.name;
    const cwd = norm(l?.cwd ?? s.cwd ?? '');
    const owner = worktreeHome(out, cwd);
    if (owner) {
      const raw = l?.cwd ?? s.cwd;
      session.folderExists = existsSync(raw);
      session.worktreeName = raw.slice(owner.start).split(/[\\/]/)[0];
      looseBy.get(owner.ws).push(session);
      continue;
    }
    const hit = index.find(({ key }) => cwd === key || cwd.startsWith(key + '/'));
    if (hit) byPath.get(hit.key).sessions.push(session);
    else unmatched.push(session);
  }
  orphaned = new Map();
  for (const [ws, list] of looseBy) {
    list.sort((a, b) => b.lastActivity - a.lastActivity);
    ws.loose = list.slice(0, LOOSE_LIMIT);
    orphaned.set(norm(ws.path), list.filter((x) => !x.folderExists && !x.live).map((x) => x.id));
  }
  const rank = (s) => (s.live?.status === 'busy' || s.live?.status === 'shell' || s.live?.background ? 2 : s.live ? 1 : 0);
  const hot = new Set();
  for (const [key, wt] of byPath) {
    wt.sessions.sort((a, b) => rank(b) - rank(a) || b.lastActivity - a.lastActivity);
    wt.lastActivity = Math.max(wt.sessions[0]?.lastActivity ?? 0, wt.git.lastCommitAt ?? 0);
    if (wt.sessions.some((s) => s.live) || Date.now() - wt.lastActivity < 86_400_000) hot.add(key);
  }
  hotPaths = hot;
  for (const ws of out) {
    ws.worktrees.sort((a, b) => (b.isMain - a.isMain) || b.lastActivity - a.lastActivity);
    ws.lastActivity = Math.max(0, ...ws.worktrees.map((w) => w.lastActivity), ...ws.loose.filter((x) => x.live).map((x) => x.lastActivity));
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  unmatched.sort((a, b) => b.lastActivity - a.lastActivity);
  return { generatedAt: Date.now(), root: CODE_ROOT, workspaces: out, unmatched: unmatched.slice(0, 50) };
}


/** Per project (norm path): ids of sessions whose worktree folder is gone and that aren't running, from the last snapshot. */
let orphaned = new Map();

/** Every orphaned session of a project, not just the newest LOOSE_LIMIT the snapshot shows. */
async function orphans(repo) {
  await snapshot();
  return orphaned.get(norm(repo ?? '')) ?? [];
}

/** The worktree at `path`, from the cached scan; waits for a fresh scan only if it isn't there. */
async function findWorktree(path) {
  // With its project (`repo`), like the main thread's index: per-project settings such as the dev command key on it.
  const find = (ws) => ws.flatMap((w) => w.worktrees.map((wt) => ({ ...wt, repo: w.path }))).find((wt) => norm(wt.path) === norm(path ?? ''));
  return find(await loadWorkspaces()) ?? find(await loadWorkspaces({ fresh: true })) ?? null;
}

/** Someone is looking at this worktree: treat it as active and re-check it on the next scan. */
function touch(path) {
  const key = norm(path ?? '');
  hotPaths.add(key);
  statusCache.delete(key);
  worktreeCache.at = 0; // next snapshot triggers a background scan
}

// Same folder as data-dir.mjs's ARCHIVE_DIR (this runs in a worker, which mustn't run its migration).
const ARCHIVE_DIR = join(CLAUDE_DIR, 'gyro-archive');

/**
 * Archive sessions by id, for a worktree that may already be gone (teardown removes it first).
 * The caller has checked the ids belong to it; live sessions are still refused here.
 */
async function archiveByIds(ids) {
  const live = await readLiveSessions();
  const archived = [];
  const skipped = [];
  for (const id of ids ?? []) {
    const file = [...sessionCache.keys()].find((f) => basename(f, '.jsonl') === id);
    if (!file || live.has(id)) {
      skipped.push(id);
      continue;
    }
    const projectDir = join(file, '..');
    const dest = join(ARCHIVE_DIR, basename(projectDir));
    await mkdir(dest, { recursive: true });
    for (const name of await readdir(projectDir)) {
      if (name === id || name.startsWith(id + '.')) await rename(join(projectDir, name), join(dest, name));
    }
    sessionCache.delete(file);
    archived.push(id);
  }
  worktreeCache.at = 0;
  return { archived, skipped };
}

/** A worktree was added or removed in this repo: rescan its worktree list on the next snapshot. */
async function invalidateRepo(repo) {
  // Compare normalized: git reports C:/x/y while the scan keys are C:\x\y.
  for (const key of listCache.keys()) if (norm(key) === norm(repo)) listCache.delete(key);
  for (const key of statusCache.keys()) if (key.startsWith(norm(repo))) statusCache.delete(key);
  await loadWorkspaces({ fresh: true }); // other repos stay cached, so this is quick
}

/** Archive is about to delete (or has finished with) this worktree: stop or resume checking its status. */
function removingWorktree({ path, on }) {
  if (on) removing.add(norm(path));
  else removing.delete(norm(path));
}

const ops = { snapshot, findWorktree, touch, archiveByIds, invalidateRepo, orphans, removingWorktree, sessionBases, projectBases };

parentPort.on('message', async ({ id, op, arg }) => {
  try {
    parentPort.postMessage({ id, result: await ops[op](arg) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});

// Warm the caches so the first page load doesn't wait on a cold scan.
snapshot().catch(() => {});
