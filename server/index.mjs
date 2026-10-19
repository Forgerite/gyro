// ccdb backend: joins git worktrees with Claude Code sessions and serves them as JSON.
// The main thread only does HTTP, WebSockets and terminals; scanning lives in scanner.mjs (a worker).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { getDev, getGithub, isClosed, setClosed, setDev, setGithub } from './state.mjs';
import { entryBrief, githubOptions, moveEntry, openPulls, projectBoard, projectEntry, resolveLink } from './github.mjs';
import { findReports, serveReport } from './reports.mjs';
import { leasePorts, loadExcludedPorts, portsOf, releasePorts } from './ports.mjs';
import { allGyro, finishGyro, gyroBrief, gyroOf, noteGyro, recordGyro, reportStep, startGyro } from './gyro.mjs';
import { worktreeHome } from './worktrees.mjs';
import { attachPtySocket, closeTerm, detectDev, findTerm, killAllTerms, listTerms, startDev, startTerm, stopDev } from './pty.mjs';

const PORT = Number(process.env.CCDB_PORT ?? 4317);
const CODE_ROOT = resolve(process.env.CCDB_ROOT ?? join(homedir(), 'Documents', 'code'));
// Browsers send Origin on cross-site POSTs and WebSocket upgrades; anything else is refused.
const ALLOWED_ORIGINS = new Set(
  (process.env.CCDB_ORIGINS ?? 'http://localhost:4200,http://127.0.0.1:4200').split(','),
);

// ---------- workers ----------

/** Request/response over a worker's message port. */
function workerRpc(file, workerData) {
  const worker = new Worker(new URL(file, import.meta.url), { workerData });
  const pending = new Map();
  let nextId = 0;
  worker.on('message', ({ id, result, error }) => {
    const p = pending.get(id);
    pending.delete(id);
    if (error) p?.reject(new Error(error));
    else p?.resolve(result);
  });
  worker.on('error', (e) => console.error(`[${file}]`, e));
  return (op, arg) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, arg });
    });
}

// Background scanning (git status of every worktree, session logs).
const scan = workerRpc('./scanner.mjs', { codeRoot: CODE_ROOT });
// On-demand git detail for the panel's Git tab; separate so a running scan can't delay it.
const detail = workerRpc('./detail-worker.mjs');

/** Worktrees from the last snapshot, so validating a path doesn't have to wait on the scanner. */
let worktreeIndex = new Map();
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

async function snapshot() {
  const snap = await scan('snapshot');
  worktreeIndex = new Map(
    snap.workspaces.flatMap((ws) => ws.worktrees.map((wt) => [norm(wt.path), { ...wt, repo: ws.path }])),
  );
  looseIndex = new Map();
  for (const ws of snap.workspaces) {
    for (const s of ws.loose) {
      looseIds.set(s.id, s);
      // A loose session's folder can still host a terminal (resume needs claude to run where it started).
      if (s.folderExists && s.cwd) looseIndex.set(norm(s.cwd), { path: s.cwd, name: basename(s.cwd), repo: ws.path, loose: true });
    }
  }
  for (const s of snap.unmatched) looseIds.set(s.id, s);
  const gyro = allGyro();
  const workspaces = snap.workspaces.map((ws) =>
    withGithub({ ...ws, gyro: gyro.get(norm(ws.path)) ?? null, worktrees: ws.worktrees.map((wt) => ({ ...wt, ports: portsOf(wt.path) })), closed: isClosed(ws.path), dev: { command: getDev(ws.path) ?? null, detected: detectDev(ws.path) } }),
  );
  return { ...snap, workspaces, terms: listTerms() };
}

// ---------- GitHub (cached; gh calls never hold up a snapshot) ----------

const PULLS_TTL = 2 * 60_000;
const BOARD_TTL = 60_000;
/** repo (lowercase) -> { at, list, error, pending } */
const pullsCache = new Map();
/** "owner/number" -> { at, board, pending } */
const boardCache = new Map();

/** Cached open PRs of `repo`, kicking off a refetch in the background when they're stale. */
function pullsFor(repo, force = false) {
  const key = repo.toLowerCase();
  const c = pullsCache.get(key) ?? { at: 0, list: null, error: null, pending: null };
  pullsCache.set(key, c);
  if ((force || Date.now() - c.at > PULLS_TTL) && !c.pending) {
    c.pending = openPulls(repo)
      .then((list) => Object.assign(c, { list, error: null }))
      .catch((e) => (c.error = e.message)) // keep the last good list
      .finally(() => Object.assign(c, { at: Date.now(), pending: null }));
  }
  return c;
}

/** Attach the GitHub link, the open PRs, and each worktree's PR (by branch) to a project. */
function withGithub(ws) {
  const github = getGithub(ws.path);
  if (!github || ws.closed) return { ...ws, github };
  const c = pullsFor(github.repo);
  const pulls = c.list && { list: c.list, at: c.at, error: c.error };
  const worktrees = ws.worktrees.map((wt) => ({ ...wt, pr: (wt.branch && c.list?.find((p) => p.branch === wt.branch)) || null }));
  return { ...ws, github, pulls, worktrees };
}

/** The linked GitHub Project's board, cached briefly (big boards take seconds). */
async function boardFor(github, force = false) {
  const { owner, number } = github.project;
  const key = `${owner}/${number}`.toLowerCase();
  const c = boardCache.get(key);
  if (c?.pending) return c.pending;
  if (c?.board && !force && Date.now() - c.at < BOARD_TTL) return c.board;
  const pending = projectBoard({ owner, number });
  boardCache.set(key, { ...c, pending });
  try {
    const board = await pending;
    boardCache.set(key, { at: Date.now(), board, pending: null });
    return board;
  } catch (e) {
    boardCache.set(key, { ...c, pending: null });
    throw e;
  }
}

/**
 * Close (or reopen) a project. Closing kills its dock terminals: worktrees and loose-session folders.
 * Sessions open elsewhere (Claude Desktop, another terminal) aren't ours to kill; they're counted.
 */
async function closeProject(path, closed) {
  const ws = await knownProject(path);
  setClosed(ws.path, closed);
  if (!closed) return { closed: false };
  const folders = new Set([...ws.worktrees.map((wt) => norm(wt.path)), ...ws.loose.filter((s) => s.cwd).map((s) => norm(s.cwd))]);
  const mine = listTerms().filter((t) => folders.has(norm(t.path)));
  for (const t of mine) closeTerm(t.path);
  const docked = new Set(mine.map((t) => t.sessionId));
  const liveElsewhere = [...ws.worktrees.flatMap((wt) => wt.sessions), ...ws.loose].filter((s) => s.live && !docked.has(s.id)).length;
  return { closed: true, closedTerms: mine.length, liveElsewhere, terms: listTerms() };
}

/** A project (repo) from the latest snapshot, or a 400. */
async function knownProject(path) {
  const snap = await snapshot();
  const ws = snap.workspaces.find((w) => norm(w.path) === norm(path ?? ''));
  if (!ws) throw httpError(400, 'unknown project');
  return ws;
}

/** Folders of loose sessions that still exist, keyed like worktreeIndex. */
let looseIndex = new Map();
/** Every session shown outside a worktree (loose or "other"), by id: what the session archive accepts. */
const looseIds = new Map();

/** A worktree, or the surviving folder of a loose session: somewhere we may open a terminal or editor. */
async function knownTarget(path) {
  return (await knownWorktree(path)) ?? looseIndex.get(norm(path ?? '')) ?? null;
}

/**
 * Archive sessions that aren't in a worktree (nothing to tear down). Sessions open in a dock
 * terminal or elsewhere are skipped, not fatal, so a bulk archive does what it can.
 */
async function archiveLoose(ids) {
  if (ids.some((id) => !looseIds.has(id))) await snapshot();
  const unknown = ids.filter((id) => !looseIds.has(id));
  if (unknown.length) throw httpError(400, `unknown session${unknown.length > 1 ? 's' : ''}`);
  const busy = ids.filter((id) => { const s = looseIds.get(id); return s.cwd && findTermSession(s.cwd) === id; });
  const r = await scan('archiveByIds', ids.filter((id) => !busy.includes(id)));
  for (const id of r.archived) looseIds.delete(id);
  const skipped = [...busy, ...r.skipped];
  if (!r.archived.length && skipped.length) throw httpError(409, skipped.length > 1 ? 'Those sessions are open; close them first' : 'Session is open somewhere; close it first');
  return { archived: r.archived, skipped };
}

// ---------- actions ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** From the last snapshot; asks the scanner (which may rescan) only for paths it hasn't seen. */
async function knownWorktree(path) {
  return worktreeIndex.get(norm(path ?? '')) ?? (await scan('findWorktree', path));
}

/** Session id of the running dock terminal in this worktree, if any. */
function findTermSession(path) {
  const t = path ? findTerm(path) : null;
  return t && !t.exited ? t.sessionId : null;
}

// ---------- archive = tear the worktree down ----------

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** Everything archiving this worktree would do or lose, checked fresh against git. */
async function teardownPlan(path) {
  // Sessions come from the snapshot index; refresh it once if this worktree isn't there yet.
  if (!worktreeIndex.has(norm(path ?? ''))) await snapshot();
  const wt = worktreeIndex.get(norm(path ?? '')) ?? (await knownWorktree(path));
  if (!wt) throw httpError(400, 'unknown worktree');
  const check = await detail('teardownCheck', { path: wt.path, git: { trunk: wt.git?.trunk ?? null } });
  const repo = check.repo;
  const dockSession = findTermSession(wt.path);
  // Open in Claude Desktop or another terminal: we can't (and shouldn't) close it from here.
  const liveElsewhere = (wt.sessions ?? [])
    .filter((s) => s.live && s.id !== dockSession)
    .map((s) => ({ title: s.title, where: s.live.entrypoint === 'claude-desktop' ? 'Claude Desktop' : 'a terminal' }));
  return {
    path: wt.path,
    name: wt.name,
    repo,
    isMain: !!wt.isMain,
    sessions: wt.sessions?.length ?? 0,
    sessionIds: (wt.sessions ?? []).map((s) => s.id),
    dockTerminal: !!dockSession,
    liveElsewhere,
    ...check,
    // Never delete the main checkout's branch (it's the repo's own checkout, often trunk).
    branch: wt.isMain ? null : check.branch,
  };
}

/**
 * Archive every session of the worktree and, unless it's the main checkout, remove the worktree
 * and delete its branch. Lost work (uncommitted files, commits not in trunk) requires `ack`.
 * Worktree removal happens first, so a failure there leaves everything as it was.
 */
async function archiveWorktree(path, ack) {
  const plan = await teardownPlan(path);
  if (plan.liveElsewhere.length) {
    throw httpError(409, `Close the session open in ${plan.liveElsewhere[0].where} first`);
  }
  if ((plan.dirty || plan.unmerged) && !ack) {
    throw httpError(409, 'This worktree has work that would be lost; acknowledge it first', { needsAck: true });
  }
  if (plan.dockTerminal) {
    closeTerm(plan.path);
    await new Promise((r) => setTimeout(r, 800)); // let claude.exe let go of the folder
  }
  let teardown = null;
  if (!plan.isMain) {
    try {
      teardown = await detail('teardown', { repo: plan.repo, path: plan.path, branch: plan.branch });
    } catch (e) {
      throw httpError(500, `Couldn't remove the worktree: ${e.message.split('\n').slice(-2).join(' ').trim()}`);
    } finally {
      if (teardown) releasePorts(plan.path); // its port block goes back to the pool
      // Wait for the rescan so the reply (and the next snapshot) no longer lists the worktree.
      await scan('invalidateRepo', plan.repo).catch(() => {});
    }
  }
  // Ids were collected before removal; the worktree may no longer be in the scan.
  const sessions = await scan('archiveByIds', plan.sessionIds);
  worktreeIndex.delete(norm(plan.path));
  return { removed: !plan.isMain, ...teardown, archived: sessions.archived.length, skipped: sessions.skipped.length };
}

async function openAction({ action, path, sessionId }) {
  const wt = await knownTarget(path);
  if (!wt) throw Object.assign(new Error('unknown worktree'), { status: 400 });
  if (sessionId && !UUID.test(sessionId)) throw Object.assign(new Error('bad session id'), { status: 400 });

  let cmd, args;
  if (action === 'external') {
    // New Windows Terminal tab in the worktree, resuming the session (or starting fresh).
    cmd = 'wt';
    args = ['-w', '0', 'nt', '-d', wt.path, '--title', wt.name, 'claude', ...(sessionId ? ['--resume', sessionId] : [])];
  } else if (action === 'code') {
    cmd = 'code';
    args = [wt.path];
  } else if (action === 'explorer') {
    cmd = 'explorer';
    args = [wt.path];
  } else {
    throw Object.assign(new Error('unknown action'), { status: 400 });
  }
  spawn(cmd, args, { detached: true, stdio: 'ignore', shell: cmd === 'code', windowsHide: false }).unref();
}

// ---------- Gyro conversion ----------

/** Repos whose worktree-ports scripts the conversion session can learn from. */
const GYRO_EXAMPLES = ['task-management/tools/worktree-ports/worktree-ports.mjs', 'watson-hollow/scripts/worktree-ports.js', 'forgerite/scripts/worktree-ports.mjs'];

/**
 * Start converting a project: ccdb checks git and archives orphaned sessions, makes a worktree for
 * the work, and starts claude there on the brief. Pressing it again while a run's session is still
 * open just returns that worktree.
 */
async function convertToGyro(path) {
  const ws = await knownProject(path);
  if (ws.closed) throw httpError(400, 'Reopen the project first');
  const current = gyroOf(ws.path);
  const open = current?.status === 'running' && current.worktree && findTerm(current.worktree);
  if (open && !open.exited) return { worktree: current.worktree, terms: listTerms(), gyro: current };

  // Projects are git repos by construction (the scanner only lists folders with .git); a repo
  // without commits can't have worktrees yet, so its conversion runs in the main checkout.
  const bases = await detail('worktreeBases', { repo: ws.path, trunk: ws.trunk ?? null });
  const base = bases.trunk;
  const done = [];
  done.push({ step: 'git', detail: base ? `Git repository already (trunk ${base})` : 'Git repository already, with no commits yet' });

  const orphans = await scan('orphans', ws.path);
  const pruned = orphans.length ? await scan('archiveByIds', orphans) : { archived: [], skipped: [] };
  for (const id of pruned.archived) looseIds.delete(id);
  done.push({
    step: 'prune',
    detail: pruned.archived.length
      ? `Archived ${pruned.archived.length} orphaned session${pruned.archived.length === 1 ? '' : 's'} (their worktrees are gone) to ~/.claude/ccdb-archive`
      : 'No orphaned sessions',
  });

  let worktree = ws.path;
  let branch = null;
  if (base) {
    const taken = new Set(bases.branches.map((b) => b.name));
    const name = ['gyro', ...Array.from({ length: 8 }, (_, i) => `gyro-${i + 2}`)]
      .find((n) => !taken.has(n) && !existsSync(join(worktreeHome(ws.path), n)));
    if (!name) throw httpError(409, 'Branches gyro … gyro-9 all exist; remove some first');
    worktree = (await detail('createWorktree', { repo: ws.path, name, base }).catch((e) => { throw httpError(400, e.message); })).path;
    branch = name;
    await scan('invalidateRepo', ws.path).catch(() => {});
  }

  const examples = GYRO_EXAMPLES.map((p) => join(CODE_ROOT, p))
    .filter((p) => existsSync(p) && !norm(p).startsWith(norm(ws.path) + '/'))
    .map((p) => p.replace(/\\/g, '/'));
  const prompt = gyroBrief({
    project: ws, worktree, branch, ccdbUrl: `http://127.0.0.1:${PORT}`,
    done: done.map((d) => d.detail), examples, dev: ws.dev,
  });
  // No dev server yet: working out the right one is the session's first step.
  const term = startTerm(worktree, undefined, null, prompt);
  startGyro(ws.path, { worktree, sessionId: term.sessionId });
  for (const d of done) reportStep(ws.path, d.step, 'done', d.detail);
  return { worktree, terms: listTerms(), gyro: gyroOf(ws.path) };
}

/** A step report from the conversion session (any folder inside its worktree identifies the project). */
async function gyroReport({ path, step, status, detail: note, devCommand, done, summary, changed }) {
  let p = typeof path === 'string' ? path : '';
  let target = null;
  for (let i = 0; i < 12 && p && !target; i++, p = p.replace(/[\\/][^\\/]*$/, '')) target = await knownTarget(p);
  if (!target) throw httpError(404, 'Not inside a project ccdb knows');
  const repo = target.repo ?? target.path;
  if (step !== undefined) {
    if (devCommand !== undefined) {
      if (typeof devCommand !== 'string' || devCommand.length > 500 || /[\r\n]/.test(devCommand)) throw httpError(400, 'bad devCommand');
      // Only a real change: the command that already runs (set here, or detected) stays as it is.
      const current = getDev(repo);
      const cmd = devCommand.trim();
      if (cmd !== (current !== undefined ? current : detectDev(repo) ?? '')) setDev(repo, cmd);
    }
    reportStep(repo, step, status, note);
  }
  if (done !== undefined) {
    const g = finishGyro(repo, done === true, summary, changed);
    // Nothing needed changing: the worktree made for the run has nothing to keep.
    if (g.changed === false && g.worktree && norm(g.worktree) !== norm(repo)) retireWhenIdle(repo, g.worktree, g.sessionId);
  }
  return { gyro: gyroOf(repo) };
}

/**
 * Remove a run's worktree once its session has finished its turn (it reports from inside that turn,
 * so closing at once would cut it off). archiveWorktree refuses if anything was left uncommitted or
 * committed, so a session that changed things after all keeps its worktree.
 */
function retireWhenIdle(repo, worktree, sessionId) {
  const until = Date.now() + 10 * 60_000;
  const tick = async () => {
    try {
      const snap = await snapshot();
      const wt = snap.workspaces.flatMap((w) => w.worktrees).find((w) => norm(w.path) === norm(worktree));
      if (!wt) return;
      const s = wt.sessions.find((x) => x.id === sessionId);
      if (s?.live && (s.live.status === 'busy' || s.live.background) && Date.now() < until) return void setTimeout(tick, 5000);
      await archiveWorktree(worktree, false);
      noteGyro(repo, 'Nothing needed changing, so Gyro removed the gyro worktree and branch.');
    } catch (e) {
      noteGyro(repo, `The gyro worktree was kept: ${e.message}`);
    }
  };
  setTimeout(tick, 5000);
}

// ---------- http ----------

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Terminal keystrokes share this event loop, so stalls here are typing latency.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

function health() {
  const ms = (ns) => Math.round(ns / 1e6);
  const out = { loopDelayMs: { p50: ms(loopDelay.percentile(50)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max) } };
  loopDelay.reset();
  return out;
}

function originOk(req) {
  const origin = req.headers.origin;
  return !origin || ALLOWED_ORIGINS.has(origin);
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw Object.assign(new Error('expected application/json'), { status: 415 });
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
}

/** The dev server to run beside a dock session: the project's own setting, else its package.json script. */
function devFor(target) {
  const set = target.repo ? getDev(target.repo) : undefined;
  return set !== undefined ? set || null : detectDev(target.path);
}

async function termAction({ action, path, sessionId, prompt, entry }) {
  // Closing only needs a running terminal; its worktree may have been removed out from under it.
  if (action === 'close' && path && findTerm(path)) return closeTerm(findTerm(path).path), { terms: listTerms() };
  const wt = await knownTarget(path);
  if (!wt) throw Object.assign(new Error('unknown worktree'), { status: 400 });
  if (sessionId && !UUID.test(sessionId)) throw Object.assign(new Error('bad session id'), { status: 400 });
  // Both return the full terminal list so the UI can update without waiting for a snapshot.
  if (prompt !== undefined && (sessionId || typeof prompt !== 'string' || prompt.length > 2000)) throw httpError(400, 'bad prompt');
  if (entry !== undefined && (sessionId || prompt !== undefined || typeof entry !== 'string')) throw httpError(400, 'bad entry');
  if (action === 'start' && entry) {
    // A session for a board entry opens on the entry itself: description and comments, fetched now.
    const project = getGithub(wt.repo ?? wt.path)?.project;
    if (!project) throw httpError(400, 'No GitHub Project is linked to this project');
    const e = await projectEntry(project, entry).catch((err) => { throw httpError(502, err.message); });
    prompt = entryBrief(e);
  }
  if (action === 'start') return startTerm(wt.path, sessionId, devFor(wt), prompt), { terms: listTerms() };
  if (action === 'close') return closeTerm(wt.path), { terms: listTerms() };
  // The dev server beside a dock session: restart it after it stops, or stop it.
  if (action === 'dev-start' && findTerm(wt.path)) return startDev(wt.path, devFor(wt)), { terms: listTerms() };
  if (action === 'dev-stop') return stopDev(wt.path), { terms: listTerms() };
  throw Object.assign(new Error('unknown action'), { status: 400 });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/snapshot') return send(res, 200, await snapshot());
    if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, health());
    if (req.method === 'GET' && req.url.startsWith('/api/worktree/check?')) {
      const path = new URL(req.url, 'http://localhost').searchParams.get('path');
      return send(res, 200, await teardownPlan(path));
    }
    // Playwright reports are served on their own origin (127.0.0.1, not the dashboard's), so their scripts can't reach ccdb's page.
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url.startsWith('/report/') && (await serveReport(req, res))) return;
    if (req.method === 'GET' && req.url.startsWith('/api/ports?')) {
      // For a repo's own scripts started outside ccdb: the port block of the worktree holding `path`
      // (any folder inside it), leased now if it has none. 404 for folders that aren't in a worktree.
      let p = new URL(req.url, 'http://localhost').searchParams.get('path') ?? '';
      let wt = null;
      for (let i = 0; i < 12 && p && !wt; i++, p = p.replace(/[\\/][^\\/]*$/, '')) wt = await knownTarget(p);
      if (!wt) return send(res, 404, { error: 'Not inside a worktree ccdb knows' });
      return send(res, 200, { path: wt.path, ...leasePorts(wt.path) });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/reports?')) {
      const wt = await knownTarget(new URL(req.url, 'http://localhost').searchParams.get('path'));
      if (!wt) throw httpError(400, 'unknown worktree');
      const base = `http://127.0.0.1:${PORT}/report`;
      return send(res, 200, { reports: (await findReports(wt.path)).map((r) => ({ ...r, url: `${base}/${r.id}/` })) });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/worktrees/bases?')) {
      const ws = await knownProject(new URL(req.url, 'http://localhost').searchParams.get('path'));
      return send(res, 200, await detail('worktreeBases', { repo: ws.path, trunk: ws.trunk ?? null }).catch((e) => { throw httpError(400, e.message); }));
    }
    if (req.method === 'GET' && req.url === '/api/projects/candidates') {
      return send(res, 200, { root: CODE_ROOT, candidates: await detail('projectCandidates', CODE_ROOT) });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/github/options?')) {
      const url = new URL(req.url, 'http://localhost');
      const ws = await knownProject(url.searchParams.get('path'));
      return send(res, 200, await githubOptions(ws.path, { repo: url.searchParams.get('repo')?.trim() || null, current: getGithub(ws.path) })
        .catch((e) => { throw httpError(400, e.message); }));
    }
    if (req.method === 'GET' && req.url.startsWith('/api/github/board?')) {
      const url = new URL(req.url, 'http://localhost');
      const ws = await knownProject(url.searchParams.get('path'));
      const github = getGithub(ws.path);
      if (!github?.project) return send(res, 400, { error: 'No GitHub Project is linked to this project' });
      return send(res, 200, await boardFor(github, url.searchParams.get('fresh') === '1').catch((e) => { throw httpError(502, e.message); }));
    }
    if (req.method === 'GET' && req.url.startsWith('/api/github/entry?')) {
      const url = new URL(req.url, 'http://localhost');
      const github = getGithub((await knownProject(url.searchParams.get('path'))).path);
      if (!github?.project) return send(res, 400, { error: 'No GitHub Project is linked to this project' });
      return send(res, 200, await projectEntry(github.project, url.searchParams.get('id')).catch((e) => { throw httpError(502, e.message); }));
    }
    if (req.method === 'GET' && req.url.startsWith('/api/git/')) {
      const url = new URL(req.url, 'http://localhost');
      const path = url.searchParams.get('path');
      const h = url.searchParams.get('h');
      const op = {
        '/api/git/graph': 'gitGraph',
        '/api/git/changes': 'gitChanges',
        '/api/git/diff': h ? 'commitDiff' : 'gitDiff',
        '/api/git/commit': 'commitFiles',
      }[url.pathname];
      if (!op || !path) return send(res, 400, { error: 'bad request' });
      const found = await knownWorktree(path);
      if (!found) return send(res, 400, { error: 'unknown worktree' });
      const wt = { path: found.path, git: { trunk: found.git?.trunk ?? null } };
      const arg =
        op === 'gitDiff' ? { path: wt, file: url.searchParams.get('file'), view: url.searchParams.get('view') || undefined }
        : op === 'commitDiff' ? { path: wt, h, file: url.searchParams.get('file') }
        : op === 'commitFiles' ? { path: wt, h }
        : op === 'gitGraph' ? { path: wt, all: url.searchParams.get('all') === '1' }
        : wt;
      if (op === 'gitChanges') scan('touch', wt.path).catch(() => {});
      return send(res, 200, await detail(op, arg));
    }
    if (req.method === 'POST') {
      if (!originOk(req)) return send(res, 403, { error: 'origin not allowed' });
      if (req.url === '/api/open') return send(res, 200, (await openAction(await readJson(req)), { ok: true }));
      if (req.url === '/api/terms') return send(res, 200, await termAction(await readJson(req)));
      if (req.url === '/api/gyro/convert') return send(res, 200, await convertToGyro((await readJson(req)).path));
      // From the conversion session's shell (curl sends no Origin, which originOk allows).
      if (req.url === '/api/gyro/report') return send(res, 200, await gyroReport(await readJson(req)));
      if (req.url === '/api/git/action') {
        const { path, action, files, all, message, file, view, hunk } = await readJson(req);
        const found = await knownWorktree(path);
        if (!found) return send(res, 400, { error: 'unknown worktree' });
        const wt = { path: found.path, git: { trunk: found.git?.trunk ?? null } };
        try {
          const result = await detail('gitAction', { path: wt, action, files, all, message, file, view, hunk });
          return send(res, 200, result);
        } finally {
          scan('touch', wt.path).catch(() => {}); // tiles' ●/◆ flags catch up on the next scan
        }
      }
      if (req.url === '/api/git/rebase') {
        const { path } = await readJson(req);
        const found = await knownWorktree(path);
        if (!found) return send(res, 400, { error: 'unknown worktree' });
        try {
          return send(res, 200, await detail('autoRebase', { path: found.path, trunk: found.git?.trunk ?? null })
            .catch((e) => { throw httpError(409, e.message); }));
        } finally {
          scan('touch', found.path).catch(() => {});
        }
      }
      if (req.url === '/api/git/compose') {
        const { path, hint } = await readJson(req);
        const found = await knownWorktree(path);
        if (!found) return send(res, 400, { error: 'unknown worktree' });
        try {
          return send(res, 200, await detail('composeCommit', { path: found.path, hint: typeof hint === 'string' ? hint.slice(0, 2000) : '' })
            .catch((e) => { throw httpError(409, e.message); }));
        } finally {
          scan('touch', found.path).catch(() => {});
        }
      }
      if (req.url === '/api/projects/close') {
        const { path, closed } = await readJson(req);
        return send(res, 200, await closeProject(path, closed !== false));
      }
      if (req.url === '/api/github/entry/move') {
        const { path, id, status } = await readJson(req);
        const github = getGithub((await knownProject(path)).path);
        if (!github?.project) return send(res, 400, { error: 'No GitHub Project is linked to this project' });
        const entry = await moveEntry(github.project, id, status).catch((e) => { throw httpError(502, e.message); });
        boardCache.delete(`${github.project.owner}/${github.project.number}`.toLowerCase());
        return send(res, 200, entry);
      }
      if (req.url === '/api/github/refresh') {
        const ws = await knownProject((await readJson(req)).path);
        const github = getGithub(ws.path);
        if (!github) return send(res, 400, { error: 'Not linked to GitHub' });
        await pullsFor(github.repo, true).pending;
        return send(res, 200, (await knownProject(ws.path)).pulls ?? null);
      }
      if (req.url === '/api/worktrees/create') {
        const { path, name, base } = await readJson(req);
        const ws = await knownProject(path);
        const created = await detail('createWorktree', { repo: ws.path, name, base }).catch((e) => { throw httpError(400, e.message); });
        await scan('invalidateRepo', ws.path).catch(() => {}); // so the next snapshot has it
        return send(res, 200, created);
      }
      if (req.url === '/api/projects/dev') {
        const { path, command } = await readJson(req);
        const ws = await knownProject(path);
        if (command !== null && (typeof command !== 'string' || command.length > 500 || /[\r\n]/.test(command))) throw httpError(400, 'bad dev command');
        setDev(ws.path, command === null ? null : command.trim());
        return send(res, 200, { dev: { command: getDev(ws.path) ?? null, detected: detectDev(ws.path) } });
      }
      if (req.url === '/api/github/link') {
        const { path, repo, project } = await readJson(req);
        const ws = await knownProject(path);
        if (!repo) return (setGithub(ws.path, null), send(res, 200, { github: null }));
        const link = await resolveLink({ repo, project }).catch((e) => { throw httpError(400, e.message); });
        setGithub(ws.path, link);
        return send(res, 200, { github: link });
      }
      if (req.url === '/api/projects/create') {
        const { mode, name, gitignore, gyro } = await readJson(req);
        const result = await detail('createProject', { codeRoot: CODE_ROOT, mode, name, gitignore: gitignore === true, gyro: gyro === true })
          .catch((e) => { throw httpError(400, e.message); }); // bad name, already exists, ...
        await scan('invalidateRepo', result.path).catch(() => {}); // so the next snapshot has its tile
        await snapshot();
        if (gyro !== true) return send(res, 200, result);
        // From scratch there's nothing to audit: the template files are the conversion.
        if (mode === 'scratch') {
          recordGyro(result.path, [
            ['dev', 'skipped', 'Nothing to run yet; a dev or start script is picked up once there is one'],
            ['git', 'done', 'Created with the project'],
            ['prune', 'done', 'New project: no sessions'],
            ['lease', 'done', 'ports.mjs from the Gyro template'],
            ['ccdb', 'done', 'ports.mjs reads CCDB_PORT_BASE, then a running Gyro; CLAUDE.md has the Ports section'],
          ], 'Created as a Gyro project.');
          return send(res, 200, result);
        }
        // An existing folder has code to bring into shape: the usual conversion, in the main checkout (no commits yet).
        const conversion = await convertToGyro(result.path).catch((e) => ({ error: e.message }));
        return send(res, 200, { ...result, ...(conversion.error ? { notes: [...result.notes, `Gyro conversion didn't start: ${conversion.error}`] } : { worktree: conversion.worktree, terms: conversion.terms }) });
      }
      if (req.url === '/api/session/archive') {
        const { id, ids } = await readJson(req);
        const list = [...new Set(ids ?? [id])];
        if (!list.length || list.length > 200 || !list.every((x) => UUID.test(x ?? ''))) return send(res, 400, { error: 'bad session id' });
        return send(res, 200, await archiveLoose(list));
      }
      if (req.url === '/api/worktree/archive') {
        const { path, ack } = await readJson(req);
        return send(res, 200, await archiveWorktree(path, ack === true));
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, e.status ?? 500, { error: e.message, ...(e.needsAck ? { needsAck: true } : {}) });
  }
});
attachPtySocket(server, originOk);
loadExcludedPorts();
server.listen(PORT, '127.0.0.1', () => console.log(`ccdb api on http://127.0.0.1:${PORT} (root ${CODE_ROOT})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (killAllTerms(), process.exit(0)));
// node-pty's Windows agent throws from async callbacks; one bad terminal shouldn't take the dashboard down.
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
