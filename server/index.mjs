// ccdb backend: joins git worktrees with Claude Code sessions and serves them as JSON.
// The main thread only does HTTP, WebSockets and terminals; scanning lives in scanner.mjs (a worker).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { attachPtySocket, closeTerm, findTerm, killAllTerms, listTerms, startTerm } from './pty.mjs';

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
  return { ...snap, terms: listTerms() };
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

async function termAction({ action, path, sessionId }) {
  // Closing only needs a running terminal; its worktree may have been removed out from under it.
  if (action === 'close' && path && findTerm(path)) return closeTerm(findTerm(path).path), { terms: listTerms() };
  const wt = await knownTarget(path);
  if (!wt) throw Object.assign(new Error('unknown worktree'), { status: 400 });
  if (sessionId && !UUID.test(sessionId)) throw Object.assign(new Error('bad session id'), { status: 400 });
  // Both return the full terminal list so the UI can update without waiting for a snapshot.
  if (action === 'start') return startTerm(wt.path, sessionId), { terms: listTerms() };
  if (action === 'close') return closeTerm(wt.path), { terms: listTerms() };
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
    if (req.method === 'GET' && req.url === '/api/projects/candidates') {
      return send(res, 200, { root: CODE_ROOT, candidates: await detail('projectCandidates', CODE_ROOT) });
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
      if (req.url === '/api/projects/create') {
        const { mode, name, gitignore } = await readJson(req);
        const result = await detail('createProject', { codeRoot: CODE_ROOT, mode, name, gitignore: gitignore === true })
          .catch((e) => { throw httpError(400, e.message); }); // bad name, already exists, ...
        await scan('invalidateRepo', result.path).catch(() => {}); // so the next snapshot has its tile
        await snapshot();
        return send(res, 200, result);
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
server.listen(PORT, '127.0.0.1', () => console.log(`ccdb api on http://127.0.0.1:${PORT} (root ${CODE_ROOT})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (killAllTerms(), process.exit(0)));
// node-pty's Windows agent throws from async callbacks; one bad terminal shouldn't take the dashboard down.
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
