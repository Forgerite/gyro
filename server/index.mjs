// Gyro backend: joins git worktrees with Claude Code sessions and serves them as JSON.
// The main thread only does HTTP, WebSockets and terminals; scanning lives in scanner.mjs (a worker).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { allBases, getBase, getDev, getGithub, isClosed, setBase, setClosed, setDev, setGithub } from './state.mjs';
import { createRepo, entryBrief, githubOptions, githubOwners, mergePr, moveEntry, openPulls, prDetail, prForBranch, projectBoard, projectEntry, repoInfo, resolveLink, whyNotMergeable } from './github.mjs';
import { findReports, serveReport } from './reports.mjs';
import { attachLiveSocket } from './live.mjs';
import { listRecordings, readFrame, recordingIndex } from './recordings.mjs';
import { leasePorts, loadExcludedPorts, portsOf, releasePorts } from './ports.mjs';
import { allGyro, finishGyro, gyroBrief, gyroOf, noteGyro, recordGyro, reportStep, startGyro } from './gyro.mjs';
import { STEP_KEYS, addConversations, allWork, createWork, finishMacro, reportMacroStep, setIssueIfEmpty, setPr, setWorkStatus, startMacro, workOf } from './work.mjs';
import { evaluatePlan } from './plan.mjs';
import { worktreeHome } from './worktrees.mjs';
import { attachPtySocket, closeShell, closeTerm, detectDev, findTerm, hasTerms, killAllTerms, listTerms, sendPrompt, startDev, startShell, startTerm, stopDev } from './pty.mjs';
import { resolvePorts } from '../scripts/worktree-ports.mjs';

const ports = await resolvePorts();
const PORT = Number(process.env.GYRO_PORT ?? ports.api);
const CODE_ROOT = resolve(process.env.GYRO_ROOT ?? join(homedir(), 'Documents', 'code'));
// Browsers send Origin on cross-site POSTs and WebSocket upgrades; anything else is refused.
const ALLOWED_ORIGINS = new Set(
  (process.env.GYRO_ORIGINS ?? `http://localhost:${ports.web},http://127.0.0.1:${ports.web}`).split(','),
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
// Before the first scan, so each project's trunk is its set base branch from the start.
scan('projectBases', allBases()).catch((e) => console.error('projectBases push failed', e));
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
  const work = allWork();
  const workspaces = snap.workspaces.map((ws) => {
    const g = withGithub({ ...ws, gyro: gyro.get(norm(ws.path)) ?? null, worktrees: ws.worktrees.map((wt) => ({ ...wt, ports: portsOf(wt.path) })), closed: isClosed(ws.path), dev: { command: getDev(ws.path) ?? null, detected: detectDev(ws.path) }, base: baseSetting(ws) });
    return { ...g, worktrees: g.worktrees.map((wt) => ({ ...wt, work: workView(wt, g, work) })) };
  });
  pushSessionBases();
  return { ...snap, workspaces, terms: listTerms() };
}

/** The project's base branch: set here (ref), else the detected trunk; missing is a set one that no longer resolves. */
function baseSetting(ws) {
  return { ref: getBase(ws.path) ?? null, detected: ws.detectedTrunk ?? null, missing: ws.baseMissing ?? null };
}

/** Tell the scanner each work session's base ref (it can't read the DB itself); only on change. */
let pushedBases = '';
function pushSessionBases() {
  const list = [...allWork().values()]
    .filter((w) => w.session.status !== 'done')
    .map((w) => ({ path: w.session.path, base: w.session.base }));
  const sig = JSON.stringify(list);
  if (sig === pushedBases) return;
  pushedBases = sig;
  scan('sessionBases', list).catch((e) => console.error('sessionBases push failed', e));
}

/**
 * The worktree's work session for the snapshot, backfilling a row for worktrees from before
 * the ledger (or made outside Gyro) and keeping its PR/issue/conversation links current.
 * DB access stays on the main thread (the scanner must not touch it).
 */
function workView(wt, ws, work) {
  if (wt.isMain || wt.detached || wt.prunable || !wt.branch) return null;
  let entry = work.get(norm(wt.path)) ?? null;
  if (!entry && wt.git?.trunk) {
    const session = createWork({ path: wt.path, repo: ws.path, branch: wt.branch, base: wt.git.trunk, origin: 'backfill' });
    entry = { session, macro: null };
  }
  if (!entry) return null;
  if (wt.pr && entry.session.pr !== wt.pr.number) {
    setPr(wt.path, wt.pr.number);
    entry.session.pr = wt.pr.number;
    const issue = wt.pr.closes?.[0];
    if (issue && entry.session.issue == null) {
      setIssueIfEmpty(wt.path, issue);
      entry.session.issue = issue;
    }
  }
  addConversations(wt.path, wt.sessions.map((s) => s.id));
  // The stored PR left the open list (merged? closed?): its last known state, fetched in the background.
  const prState = !wt.pr && entry.session.pr && ws.github?.repo ? prStateFor(ws.github.repo, entry.session.pr) : null;
  return { ...entry, plan: evaluatePlan({ wt, session: entry.session, prState, macro: entry.macro }) };
}

const PR_STATE_TTL = 60_000;
/** "repo#number" -> { at, state, pending }; pullsFor-style stale-while-refetch, so a gh call never holds up a snapshot. */
const prStateCache = new Map();
function prStateFor(repo, number) {
  const key = `${repo.toLowerCase()}#${number}`;
  const c = prStateCache.get(key) ?? { at: 0, state: null, pending: null };
  prStateCache.set(key, c);
  if (Date.now() - c.at > PR_STATE_TTL && !c.pending) {
    c.pending = prDetail(repo, number)
      .then((d) => (c.state = { state: d.state, notMergeable: whyNotMergeable(d), headSha: d.headSha, mergedAt: d.mergedAt }))
      .catch(() => {}) // keep the last known state
      .finally(() => Object.assign(c, { at: Date.now(), pending: null }));
  }
  return c.state;
}

// ---------- GitHub (cached; gh calls never hold up a snapshot) ----------

const PULLS_TTL = 2 * 60_000;
/**
 * While a PR's checks are running, the list drives the tile colour (green until they finish), the
 * Land gate and the "checks went green" chime, so it's refetched this often instead: at the
 * 2-minute pace, a finished run could sit unnoticed for about as long as it took to run.
 */
const PULLS_CHECKS_TTL = 15_000;
const BOARD_TTL = 60_000;
/** repo (lowercase) -> { at, list, error, pending } */
const pullsCache = new Map();
/** "owner/number" -> { at, board, pending } */
const boardCache = new Map();

/**
 * Cached open PRs of `repo`, kicking off a refetch in the background when they're stale. The refetch
 * also reads the repo's default branch, which changes after linking (an empty repo has none yet).
 */
function pullsFor(repo, force = false) {
  const key = repo.toLowerCase();
  const c = pullsCache.get(key) ?? { at: 0, list: null, error: null, pending: null, defaultBranch: undefined };
  pullsCache.set(key, c);
  const stale = force || Date.now() - c.at > PULLS_TTL;
  if ((stale || (Date.now() - c.at > PULLS_CHECKS_TTL && c.list?.some((p) => p.checksRunning))) && !c.pending) {
    // The default branch changes rarely: no need to re-ask on the quick check-watching refetches.
    if (stale) repoInfo(repo).then((info) => (c.defaultBranch = info.defaultBranch), () => {}); // unknown: keep the saved one
    c.pending = openPulls(repo)
      .then((list) => Object.assign(c, { list, error: null }))
      .catch((e) => (c.error = e.message)) // keep the last good list
      .finally(() => Object.assign(c, { at: Date.now(), pending: null }));
  }
  return c;
}

/** Attach the GitHub link, the open PRs, and each worktree's PR (by branch) to a project. */
function withGithub(ws) {
  let github = getGithub(ws.path);
  if (!github || ws.closed) return { ...ws, github };
  const c = pullsFor(github.repo);
  // Keep the saved link's default branch current, so Create PR targets what GitHub has now.
  if (c.defaultBranch !== undefined && c.defaultBranch !== (github.defaultBranch || null)) {
    github = { ...github, defaultBranch: c.defaultBranch };
    setGithub(ws.path, github);
  }
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

/** A live session mid-turn, or waiting on background work it started. */
const isWorkingLive = (live) => !!live && (live.status === 'busy' || live.status === 'shell' || !!live.background);

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * End a claude process running outside Gyro (e.g. in Windows Terminal), with its children: a shell
 * or MCP server it started would otherwise keep the worktree folder locked. Resolves once it's gone.
 */
async function closeSessionProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('no process id');
  if (!pidAlive(pid)) return;
  await new Promise((resolve) => {
    const kill = process.platform === 'win32'
      ? spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      : (process.kill(pid, 'SIGTERM'), null);
    if (!kill) return resolve();
    kill.on('exit', resolve);
    kill.on('error', resolve); // judged by whether it's gone, below
  });
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (pidAlive(pid)) throw new Error('it is still running');
}

/** Everything archiving this worktree would do or lose, checked fresh against git. */
async function teardownPlan(path) {
  // Sessions come from the snapshot index; refresh it once if this worktree isn't there yet.
  if (!worktreeIndex.has(norm(path ?? ''))) await snapshot();
  const wt = worktreeIndex.get(norm(path ?? '')) ?? (await knownWorktree(path));
  if (!wt) throw httpError(400, 'unknown worktree');
  const check = await detail('teardownCheck', { path: wt.path, git: { trunk: wt.git?.trunk ?? null } });
  const repo = check.repo;
  const dockSession = findTermSession(wt.path);
  // Open in Claude Desktop or another terminal. A terminal's claude is its own process, so Land can
  // close it; Claude Desktop's isn't safely ours to kill (its app is Claude.exe too).
  const liveElsewhere = (wt.sessions ?? [])
    .filter((s) => s.live && s.id !== dockSession)
    .map((s) => {
      const desktop = s.live.entrypoint === 'claude-desktop';
      return { title: s.title, where: desktop ? 'Claude Desktop' : 'a terminal', closable: !desktop, pid: s.live.pid, working: isWorkingLive(s.live) };
    });
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
    remoteBranch: wt.isMain ? null : check.remoteBranch,
  };
}

/**
 * Archive every session of the worktree and, unless it's the main checkout, remove the worktree
 * and delete its branch; with `deleteRemote`, the branch it was pushed to as well. Lost work
 * (uncommitted files, commits nothing else has) requires `ack`. The remote branch goes first and
 * the worktree next, so a failure in either leaves the rest as it was.
 */
async function archiveWorktree(path, ack, deleteRemote = false, closeElsewhere = false) {
  const plan = await teardownPlan(path);
  const blocking = plan.liveElsewhere.filter((s) => !(closeElsewhere && s.closable));
  if (blocking.length) {
    throw httpError(409, `Close the session open in ${blocking[0].where} first`);
  }
  const remote = deleteRemote && !plan.isMain ? plan.remoteBranch : null;
  if (deleteRemote && !plan.isMain && !remote) throw httpError(409, 'This branch has no remote branch to delete', { needsAck: true });
  if ((plan.dirty || (remote ? remote.unmerged : plan.unmerged)) && !ack) {
    throw httpError(409, 'This worktree has work that would be lost; acknowledge it first', { needsAck: true });
  }
  let remoteDeleted = false;
  if (remote) {
    try {
      await detail('deleteRemoteBranch', { repo: plan.repo, remote: remote.remote, name: remote.name, sha: remote.sha });
      remoteDeleted = true;
    } catch (e) {
      throw httpError(502, `Couldn't delete ${remote.remote}/${remote.name}, so nothing was archived: ${e.message}`);
    }
  }
  // Wait for what we kill to exit: on Windows a running process keeps the folder from being deleted.
  // A worktree that's going away loses its dev server and shells too, even once its claude has exited.
  if (plan.dockTerminal || (!plan.isMain && hasTerms(plan.path))) await closeTerm(plan.path);
  if (closeElsewhere) {
    for (const s of plan.liveElsewhere) {
      await closeSessionProcess(s.pid).catch((e) => { throw httpError(409, `Couldn't close the session open in ${s.where}: ${e.message}`); });
    }
  }
  let teardown = null;
  if (!plan.isMain) {
    // Stop the scanner starting git status inside the folder while it's being deleted.
    await scan('removingWorktree', { path: plan.path, on: true });
    try {
      teardown = await detail('teardown', { repo: plan.repo, path: plan.path, branch: plan.branch });
    } catch (e) {
      throw httpError(500, `Couldn't remove the worktree: ${e.message.split('\n').slice(-2).join(' ').trim()}`);
    } finally {
      await scan('removingWorktree', { path: plan.path, on: false }).catch(() => {});
      if (teardown) releasePorts(plan.path); // its port block goes back to the pool
      // Wait for the rescan so the reply (and the next snapshot) no longer lists the worktree.
      await scan('invalidateRepo', plan.repo).catch(() => {});
    }
  }
  // Ids were collected before removal; the worktree may no longer be in the scan.
  const sessions = await scan('archiveByIds', plan.sessionIds);
  worktreeIndex.delete(norm(plan.path));
  return { removed: !plan.isMain, ...teardown, remoteDeleted, archived: sessions.archived.length, skipped: sessions.skipped.length };
}

// ---------- work sessions: single steps and the Ship it / Land it macros ----------

const SHIP_STEPS = ['commit', 'sync', 'push', 'pr'];
const LAND_STEPS = ['merge', 'teardown', 'archive'];
/** What a running step shows while it works (the slow, Claude-driven ones). */
const RUNNING_DETAIL = {
  commit: 'Claude is writing the commit message…',
  sync: 'Claude is stashing, rebasing, resolving any conflicts and reapplying your changes…',
  pr: 'Claude is writing the PR…',
};

/** Claude is mid-turn in this worktree (or waiting on background work it started): its edits aren't done. */
const claudeWorking = (wt) => (wt.sessions ?? []).some((s) => isWorkingLive(s.live));
/** Steps that capture the worktree's contents, so they mustn't run under a working Claude. */
const CAPTURE_STEPS = new Set(['commit', 'sync', 'push', 'pr']);

/** norm(path) -> running macro kind: one run per worktree (the detail worker's lock guards each op too). */
const macroRunning = new Map();

/**
 * Kick off a macro (ship, land, or a single step as `step:<key>`) and return at once; the run
 * reports its steps to the DB and the UI watches them through the snapshot, like Gyro conversions.
 * Idempotent by construction: each step re-checks ground truth and skips itself when already done,
 * so re-pressing Ship after the base moved runs only sync and push.
 */
function startWorkMacro(found, kind, opts = {}) {
  const key = norm(found.path);
  if (macroRunning.has(key)) throw httpError(409, `Already running ${macroRunning.get(key)} here`);
  const { session } = workOf(found.path);
  if (!session) throw httpError(400, 'No work session for this worktree');
  const steps = kind === 'ship' ? SHIP_STEPS : kind === 'land' ? LAND_STEPS : [kind.slice('step:'.length)];
  macroRunning.set(key, kind);
  startMacro(found.path, kind);
  void (async () => {
    let failed = null;
    for (const step of steps) {
      reportMacroStep(found.path, step, 'running', RUNNING_DETAIL[step] ?? null);
      try {
        const r = await runWorkStep(found, session, step, opts);
        reportMacroStep(found.path, step, r?.skipped ? 'skipped' : 'done', r?.note ?? null);
      } catch (e) {
        reportMacroStep(found.path, step, 'failed', e.message);
        failed = { step, error: e.message, needsAck: !!e.needsAck };
        break;
      }
    }
    finishMacro(found.path, !failed, failed ?? {});
  })()
    .catch((e) => console.error(`work macro ${kind} in ${found.path}`, e))
    .finally(() => {
      macroRunning.delete(key);
      scan('touch', found.path).catch(() => {});
    });
  return workOf(found.path);
}

/** One lifecycle step, from fresh ground truth. Returns { skipped?, note? }; throws to fail the run. */
async function runWorkStep(found, session, step, opts) {
  const wt = { path: found.path, git: { trunk: found.git?.trunk ?? null } };
  const github = getGithub(found.repo ?? found.path);

  if (step === 'commit') {
    const { files } = await detail('gitChanges', wt).catch((e) => { throw httpError(409, e.message); });
    if (!files.length) return { skipped: true, note: 'tree is clean' };
    // Shipping takes all the work, not a hand-picked selection: stage everything (as the Git tab's stage all does).
    await detail('gitAction', { path: wt, action: 'stage', all: true }).catch((e) => { throw httpError(409, e.message); });
    const r = await detail('composeCommit', { path: found.path, hint: '' }).catch((e) => { throw httpError(409, e.message); });
    return { note: r.commit ? `${r.commit.short} ${r.commit.subject}` : (r.warning ?? null) };
  }
  if (step === 'sync') {
    const r = await detail('autoRebase', { path: found.path, trunk: session.base }).catch((e) => { throw httpError(409, e.message); });
    if (r.problems?.length) {
      // Nothing is lost: say where the old tip (and any uncommitted work) were saved.
      const saved = r.backup ? ` Nothing is lost: the old tip is saved as ${r.backup.head}${r.backup.wip ? ` and your uncommitted work as ${r.backup.wip}` : ''}.` : '';
      throw httpError(409, `${r.problems.join('; ')}. Open the session terminal to finish the rebase.${saved}`);
    }
    if (r.upToDate) return { skipped: true, note: `already on top of ${session.base}` };
    const fetched = r.fetchNote ? ` (${r.fetchNote})` : '';
    return { note: `rebased ${r.commits} commit${r.commits === 1 ? '' : 's'} onto ${session.base}${fetched}` };
  }
  if (step === 'push') {
    const note = await detail('gitAction', { path: wt, action: 'push' }).catch((e) => { throw httpError(409, e.message); });
    return { note: typeof note === 'string' ? note : null };
  }
  if (step === 'pr') {
    if (!github) throw httpError(400, 'This project is not linked to GitHub');
    const open = await prForBranch(github.repo, found.branch).catch(() => null);
    if (open) {
      setPr(found.path, open.number);
      return { skipped: true, note: `PR #${open.number} already open` };
    }
    const r = await createPrFor(found, github);
    if (r.pr?.number) setPr(found.path, r.pr.number);
    return { note: r.pr?.number ? `PR #${r.pr.number}` : (r.warning ?? null) };
  }
  if (step === 'merge') {
    if (!github) throw httpError(400, 'This project is not linked to GitHub');
    const number = session.pr ?? (await prForBranch(github.repo, found.branch).catch(() => null))?.number;
    if (!number) throw httpError(409, 'No PR to merge; ship first');
    const pr = await prDetail(github.repo, number).catch((e) => { throw httpError(502, e.message); });
    if (pr.state === 'MERGED') return { skipped: true, note: `PR #${number} is already merged` };
    const why = whyNotMergeable(pr);
    if (why) throw httpError(409, why);
    // The strict gate, checked fresh: Land only lands a head that's current with its base.
    const gap = await detail('baseGap', { path: wt, base: session.base }).catch((e) => { throw httpError(409, e.message); });
    if (gap.behind === null) throw httpError(409, `base ${session.base} not found`);
    if (gap.behind > 0) throw httpError(409, `${found.branch} is ${gap.behind} commit${gap.behind === 1 ? '' : 's'} behind ${session.base}; ship again to rebase`);
    await mergePr(github.repo, number, pr.headSha).catch((e) => { throw httpError(409, e.message); });
    prStateCache.set(`${github.repo.toLowerCase()}#${number}`, { at: Date.now(), state: { state: 'MERGED', notMergeable: `PR #${number} is merged`, headSha: pr.headSha, mergedAt: Date.now() }, pending: null });
    await pullsFor(github.repo, true).pending; // the open-PR cache drops it
    return { note: `merged PR #${number}` };
  }
  if (step === 'teardown') {
    // Landing means you're done here: sessions open in a terminal are closed rather than blocking.
    const r = await archiveWorktree(found.path, opts.ack === true, opts.deleteRemote === true, true);
    return { note: r.removed ? `worktree removed${r.remoteDeleted ? ', remote branch deleted' : ''}` : null };
  }
  if (step === 'archive') {
    setWorkStatus(found.path, 'done');
    let note = null;
    if (github?.project && session.entryId) {
      // Best effort: a board hiccup shouldn't fail the landing.
      note = await projectEntry(github.project, session.entryId)
        .then(async (e) => {
          const doneCol = e.options.find((o) => o.done);
          if (!doneCol) return 'board has no Done column';
          await moveEntry(github.project, session.entryId, doneCol.id);
          boardCache.delete(`${github.project.owner}/${github.project.number}`.toLowerCase());
          return `board entry moved to ${doneCol.name}`;
        })
        .catch((e) => `couldn't move the board entry: ${e.message}`);
    }
    return { note };
  }
  throw httpError(400, 'unknown step');
}

/**
 * Create the PR for this worktree (headless claude writes title and body; pushes first). It merges
 * into the branch the work started from (its session's base), else the project's base branch, else
 * GitHub's default. createPr turns a remote ref like origin/develop into the branch name.
 */
async function createPrFor(found, github) {
  const base = workOf(found.path)?.session?.base || found.git?.trunk || github.defaultBranch || null;
  // The board's open issues, so Claude can link the one this branch addresses. Optional.
  let project = null;
  let issues = [];
  if (github.project) {
    const board = await boardFor(github).catch(() => null);
    project = board?.title ?? `${github.project.owner}/${github.project.number}`;
    const repo = github.repo.toLowerCase();
    issues = (board?.columns ?? []).flatMap((c) => c.items)
      .filter((it) => it.kind === 'issue' && !it.done && it.number !== null && it.repo?.toLowerCase() === repo)
      .map((it) => ({ number: it.number, title: it.title, status: it.status }));
  }
  try {
    return await detail('createPr', { path: found.path, repo: github.repo, base, project, issues })
      .catch((e) => { throw httpError(409, e.message); });
  } finally {
    await pullsFor(github.repo, true).pending; // the tile and panel show the new PR on the next snapshot
    scan('touch', found.path).catch(() => {});
  }
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
 * Start converting a project: Gyro checks git and archives orphaned sessions, makes a worktree for
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
      ? `Archived ${pruned.archived.length} orphaned session${pruned.archived.length === 1 ? '' : 's'} (their worktrees are gone) to ~/.claude/gyro-archive`
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
    project: ws, worktree, branch, gyroUrl: `http://127.0.0.1:${PORT}`,
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
  if (!target) throw httpError(404, 'Not inside a project Gyro knows');
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
      if (s?.live && (s.live.status === 'busy' || s.live.status === 'shell' || s.live.background) && Date.now() < until) return void setTimeout(tick, 5000);
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

/** What a session is told when its PR's checks fail. One paragraph, so it reads as typed, not pasted. */
function fixPrompt(pr) {
  const failing = pr.checks.filter((c) => c.result === 'fail').map((c) => (c.workflow ? `${c.workflow} / ${c.name}` : c.name));
  return [
    `CI failed on PR #${pr.number} (${pr.url}): ${failing.join(', ')} ${failing.length === 1 ? 'is' : 'are'} failing.`,
    `Look up the failed jobs (\`gh pr checks ${pr.number}\`, then \`gh run view <run-id> --log-failed\` for each failed run) and work out why they failed.`,
    'Fix the causes, check the fix locally where you can, then commit and push to this branch to update the PR, and confirm the checks run again.',
  ].join(' ');
}

/**
 * "Fix in session": hand the PR's failing checks to the worktree's Claude. A running dock session gets
 * the message typed in; otherwise its latest session is resumed (or a new one started) opening on it.
 */
async function fixPr(wt, number) {
  if (!Number.isInteger(number) || number < 1) throw httpError(400, 'bad PR number');
  const github = getGithub(wt.repo ?? wt.path);
  if (!github) throw httpError(400, 'This project is not linked to GitHub');
  const pr = await prDetail(github.repo, number).catch((e) => { throw httpError(502, e.message); });
  if (pr.state !== 'OPEN') throw httpError(409, `PR #${number} is ${pr.state.toLowerCase()}`);
  if (!pr.checks.some((c) => c.result === 'fail')) throw httpError(409, `No checks are failing on PR #${number}`);
  const prompt = fixPrompt(pr);
  if (findTermSession(wt.path)) return sendPrompt(wt.path, prompt), { terms: listTerms(), how: 'sent' };
  const top = wt.sessions?.[0];
  // Open elsewhere (e.g. Claude Desktop): resuming it here would fork it.
  if (top?.live) {
    const where = top.live.entrypoint === 'claude-desktop' ? 'Claude Desktop' : 'another terminal';
    throw httpError(409, `This worktree's session is open in ${where}; tell it there, or close it first`);
  }
  startTerm(wt.path, top?.id, devFor(wt), prompt);
  return { terms: listTerms(), how: top ? 'resumed' : 'started' };
}

async function termAction({ action, path, sessionId, prompt, entry, number, id }) {
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
  if (action === 'fix-pr') return fixPr(wt, number);
  // The dev server beside a dock session: restart it after it stops, or stop it.
  if (action === 'dev-start' && findTerm(wt.path)) return startDev(wt.path, devFor(wt)), { terms: listTerms() };
  if (action === 'dev-stop') return stopDev(wt.path), { terms: listTerms() };
  // Extra shells (Git Bash) beside a dock session.
  if (action === 'shell-start' && findTerm(wt.path)) return startShell(wt.path), { terms: listTerms() };
  if (action === 'shell-close' && typeof id === 'string') return closeShell(wt.path, id), { terms: listTerms() };
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
    // Playwright reports are served on their own origin (127.0.0.1, not the dashboard's), so their scripts can't reach Gyro's page.
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url.startsWith('/report/') && (await serveReport(req, res))) return;
    if (req.method === 'GET' && req.url.startsWith('/api/ports?')) {
      // For a repo's own scripts started outside Gyro: the port block of the worktree holding `path`
      // (any folder inside it), leased now if it has none. 404 for folders that aren't in a worktree.
      let p = new URL(req.url, 'http://localhost').searchParams.get('path') ?? '';
      let wt = null;
      for (let i = 0; i < 12 && p && !wt; i++, p = p.replace(/[\\/][^\\/]*$/, '')) wt = await knownTarget(p);
      if (!wt) return send(res, 404, { error: 'Not inside a worktree Gyro knows' });
      return send(res, 200, { path: wt.path, ...leasePorts(wt.path) });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/reports?')) {
      const wt = await knownTarget(new URL(req.url, 'http://localhost').searchParams.get('path'));
      if (!wt) throw httpError(400, 'unknown worktree');
      const base = `http://127.0.0.1:${PORT}/report`;
      return send(res, 200, { reports: (await findReports(wt.path)).map((r) => ({ ...r, url: `${base}/${r.id}/` })) });
    }
    if (req.method === 'GET' && req.url.startsWith('/api/recordings')) {
      // Recorded live runs (see recordings.mjs): the list, one run's index, and its frames.
      const url = new URL(req.url, 'http://localhost');
      const wt = await knownTarget(url.searchParams.get('path'));
      if (!wt) throw httpError(400, 'unknown worktree');
      const id = url.searchParams.get('id');
      if (url.pathname === '/api/recordings') return send(res, 200, { recordings: await listRecordings(wt.path) });
      if (url.pathname === '/api/recordings/index') {
        const idx = await recordingIndex(wt.path, id);
        return idx ? send(res, 200, idx) : send(res, 404, { error: 'Recording not found' });
      }
      if (url.pathname === '/api/recordings/frame') {
        const buf = await readFrame(wt.path, id, Number(url.searchParams.get('o')), Number(url.searchParams.get('n')));
        if (!buf) return send(res, 404, { error: 'Frame not found' });
        // A finished recording never changes, so the browser can keep every frame it has seen.
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'private, max-age=86400, immutable' });
        return res.end(buf);
      }
    }
    if (req.method === 'GET' && req.url.startsWith('/api/worktrees/bases?')) {
      const ws = await knownProject(new URL(req.url, 'http://localhost').searchParams.get('path'));
      return send(res, 200, await detail('worktreeBases', { repo: ws.path, trunk: ws.trunk ?? null }).catch((e) => { throw httpError(400, e.message); }));
    }
    if (req.method === 'GET' && req.url === '/api/github/owners') {
      // Not cached: it's asked once per New project panel, and a fresh gh sign-in should show up.
      return send(res, 200, await githubOwners().then((owners) => ({ owners, error: null }), (e) => ({ owners: [], error: e.message })));
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
    if (req.method === 'GET' && req.url.startsWith('/api/github/pr?')) {
      const url = new URL(req.url, 'http://localhost');
      const found = await knownWorktree(url.searchParams.get('path'));
      if (!found) return send(res, 400, { error: 'unknown worktree' });
      const github = getGithub(found.repo ?? found.path);
      if (!github) return send(res, 400, { error: 'This project is not linked to GitHub' });
      const number = Number(url.searchParams.get('number'));
      if (!Number.isInteger(number) || number < 1) return send(res, 400, { error: 'bad PR number' });
      return send(res, 200, await prDetail(github.repo, number).catch((e) => { throw httpError(502, e.message); }));
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
        const { path, action, files, all, message, file, view, hunk, expect } = await readJson(req);
        const found = await knownWorktree(path);
        if (!found) return send(res, 400, { error: 'unknown worktree' });
        const wt = { path: found.path, git: { trunk: found.git?.trunk ?? null } };
        try {
          const result = await detail('gitAction', { path: wt, action, files, all, message, file, view, hunk, expect });
          return send(res, 200, result);
        } finally {
          scan('touch', wt.path).catch(() => {}); // tiles' ●/◆ flags catch up on the next scan
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
      if (req.url === '/api/github/pr') {
        const { path } = await readJson(req);
        const found = await knownWorktree(path);
        if (!found) return send(res, 400, { error: 'unknown worktree' });
        const github = getGithub(found.repo ?? found.path);
        if (!github) return send(res, 400, { error: 'This project is not linked to GitHub' });
        const result = await createPrFor(found, github);
        if (result.pr?.number) setPr(found.path, result.pr.number);
        return send(res, 200, result);
      }
      if (req.url === '/api/work/step') {
        const { path, step, ack, deleteRemote } = await readJson(req);
        if (!STEP_KEYS.has(step)) return send(res, 400, { error: `unknown step; use one of ${[...STEP_KEYS].join(', ')}` });
        const found = await knownWorktree(path);
        if (!found) return send(res, 400, { error: 'unknown worktree' });
        // A push or PR without commits would publish an empty branch / PR nothing. (Inside Ship the
        // commit step runs first, so the macro checks nothing here; this guards the lone knob.)
        if ((step === 'push' || step === 'pr') && !found.git?.unmerged) {
          return send(res, 409, { error: step === 'push' ? 'No commits to push yet' : 'No commits to open a PR for yet' });
        }
        if (CAPTURE_STEPS.has(step) && claudeWorking(found)) return send(res, 409, { error: 'Claude is still working here; wait until it finishes' });
        return send(res, 200, startWorkMacro(found, `step:${step}`, { ack, deleteRemote }));
      }
      if (req.url === '/api/work/ship') {
        const found = await knownWorktree((await readJson(req)).path);
        if (!found) return send(res, 400, { error: 'unknown worktree' });
        // An untouched worktree would ship an empty branch; there's nothing to review in a PR of nothing.
        if (!found.git?.dirty && !found.git?.unmerged) return send(res, 409, { error: 'Nothing to ship yet: no changes or commits in this worktree' });
        if (claudeWorking(found)) return send(res, 409, { error: 'Claude is still working here; wait until it finishes' });
        return send(res, 200, startWorkMacro(found, 'ship'));
      }
      if (req.url === '/api/work/land') {
        const { path, ack, deleteRemote } = await readJson(req);
        const found = await knownWorktree(path);
        if (!found) return send(res, 400, { error: 'unknown worktree' });
        // Refuse before merging, not after: teardown can't close a Claude Desktop session itself.
        const stuck = (await teardownPlan(found.path)).liveElsewhere.find((s) => !s.closable);
        if (stuck) return send(res, 409, { error: `Close the session open in ${stuck.where} first` });
        return send(res, 200, startWorkMacro(found, 'land', { ack, deleteRemote }));
      }
      if (req.url === '/api/github/pr/merge') {
        const { path, number } = await readJson(req);
        const found = await knownWorktree(path);
        if (!found) return send(res, 400, { error: 'unknown worktree' });
        const github = getGithub(found.repo ?? found.path);
        if (!github) return send(res, 400, { error: 'This project is not linked to GitHub' });
        if (!Number.isInteger(number) || number < 1) return send(res, 400, { error: 'bad PR number' });
        // Judge by a fresh read, not by what the page last saw.
        const pr = await prDetail(github.repo, number).catch((e) => { throw httpError(502, e.message); });
        const why = whyNotMergeable(pr);
        if (why) return send(res, 409, { error: why });
        try {
          await mergePr(github.repo, number, pr.headSha).catch((e) => { throw httpError(409, e.message); });
          return send(res, 200, await prDetail(github.repo, number).catch(() => ({ ...pr, state: 'MERGED' })));
        } finally {
          await pullsFor(github.repo, true).pending; // the tile drops the PR on the next snapshot
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
        const { path, name, base, entry, issue } = await readJson(req);
        const ws = await knownProject(path);
        const created = await detail('createWorktree', { repo: ws.path, name, base }).catch((e) => { throw httpError(400, e.message); });
        // The work session owns this worktree from birth: branch, base and the board issue it's for.
        createWork({
          path: created.path, repo: ws.path, branch: name, base,
          entryId: typeof entry === 'string' ? entry : null,
          issue: Number.isInteger(issue) ? issue : null,
          origin: 'wizard',
        });
        pushSessionBases();
        await scan('invalidateRepo', ws.path).catch(() => {}); // so the next snapshot has it
        // Best effort: the picked board entry moves to an "in progress" column, if the board has one.
        const github = getGithub(ws.path);
        if (typeof entry === 'string' && github?.project) {
          projectEntry(github.project, entry)
            .then(async (e) => {
              const col = e.options.find((o) => /in.?progress|doing|started/i.test(o.name) && !o.done);
              if (col && e.statusId !== col.id) {
                await moveEntry(github.project, entry, col.id);
                boardCache.delete(`${github.project.owner}/${github.project.number}`.toLowerCase());
              }
            })
            .catch((e) => console.error('board move failed', e.message));
        }
        return send(res, 200, created);
      }
      if (req.url === '/api/projects/dev') {
        const { path, command } = await readJson(req);
        const ws = await knownProject(path);
        if (command !== null && (typeof command !== 'string' || command.length > 500 || /[\r\n]/.test(command))) throw httpError(400, 'bad dev command');
        setDev(ws.path, command === null ? null : command.trim());
        return send(res, 200, { dev: { command: getDev(ws.path) ?? null, detected: detectDev(ws.path) } });
      }
      if (req.url === '/api/projects/base') {
        const { path, ref } = await readJson(req);
        const ws = await knownProject(path);
        if (ref !== null) {
          if (typeof ref !== 'string' || !ref.trim()) throw httpError(400, 'bad base branch');
          const { branches } = await detail('worktreeBases', { repo: ws.path, trunk: null }).catch((e) => { throw httpError(400, e.message); });
          if (!branches.some((b) => b.name === ref.trim())) throw httpError(400, `No branch named ${ref.trim()}`);
        }
        setBase(ws.path, ref === null ? null : ref.trim());
        await scan('projectBases', allBases()); // rescans, so the reply already counts against the new base
        const fresh = await knownProject(ws.path);
        return send(res, 200, { base: fresh.base, trunk: fresh.trunk ?? null });
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
        const { mode, name, gitignore, gyro, github } = await readJson(req);
        // GitHub first: a taken name or a gh problem stops here, before anything exists locally.
        let remote = null;
        if (github) {
          if (typeof github.owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(github.owner)) throw httpError(400, 'Bad GitHub owner');
          await detail('checkProject', { codeRoot: CODE_ROOT, mode, name }).catch((e) => { throw httpError(400, e.message); });
          remote = await createRepo({ repo: `${github.owner}/${name}`, isPrivate: github.private !== false })
            .catch((e) => { throw httpError(400, `GitHub: ${e.message}`); });
        }
        const result = await detail('createProject', { codeRoot: CODE_ROOT, mode, name, gitignore: gitignore === true, gyro: gyro === true, remote: remote?.url ?? null })
          .catch((e) => { throw httpError(400, remote ? `${e.message} (the GitHub repo ${remote.repo} was created and is empty)` : e.message); });
        if (remote) {
          await resolveLink({ repo: remote.repo }).then(
            (link) => { setGithub(result.path, link); result.notes.push(`Linked to ${remote.repo}`); },
            (e) => result.notes.push(`Couldn't link ${remote.repo}: ${e.message}`),
          );
        }
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
            ['gyro', 'done', 'ports.mjs reads GYRO_PORT_BASE, then a running Gyro; CLAUDE.md has the Ports section'],
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
        const { path, ack, deleteRemote } = await readJson(req);
        return send(res, 200, await archiveWorktree(path, ack === true, deleteRemote === true));
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, e.status ?? 500, { error: e.message, ...(e.needsAck ? { needsAck: true } : {}) });
  }
});
attachPtySocket(server, originOk);
attachLiveSocket(server, originOk, PORT);
// Each attach above takes only its own paths; refuse the rest.
const SOCKETS = new Set(['/api/pty', '/api/live', '/api/live/push']);
server.on('upgrade', (req, socket) => {
  if (!SOCKETS.has(new URL(req.url, 'http://localhost').pathname)) socket.destroy();
});
loadExcludedPorts();
server.listen(PORT, '127.0.0.1', () => console.log(`Gyro api on http://127.0.0.1:${PORT} (root ${CODE_ROOT})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (killAllTerms(), process.exit(0)));
// node-pty's Windows agent throws from async callbacks; one bad terminal shouldn't take the dashboard down.
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
