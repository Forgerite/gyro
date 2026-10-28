// Work sessions: the persistent unit of work that owns a worktree, its branch, base, board
// issue, PR and Claude conversations ("Session" in the UI; WorkSession in code, since the
// dashboard already calls Claude conversations sessions). Only identity links and macro
// history live here — step done-ness is recomputed from git/gh every snapshot (plan.mjs).
import { db } from './db.mjs';

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Lifecycle steps, in the order Ship it / Land it run them. Ship ends at `pr` by design. */
export const WORK_STEPS = [
  { key: 'commit', label: 'Commit changes' },
  { key: 'sync', label: 'Rebase onto base' },
  { key: 'push', label: 'Push' },
  { key: 'pr', label: 'Create PR' },
  { key: 'merge', label: 'Merge PR' },
  { key: 'teardown', label: 'Remove worktree' },
  { key: 'archive', label: 'Archive session' },
];
export const STEP_KEYS = new Set(WORK_STEPS.map((s) => s.key));
const MACRO_STEP_STATUS = new Set(['running', 'done', 'skipped', 'failed']);
const SESSION_STATUS = new Set(['active', 'done']);

db.exec(`
  CREATE TABLE IF NOT EXISTS work_sessions (
    key TEXT PRIMARY KEY,          -- normalized worktree path
    path TEXT NOT NULL,            -- worktree path as scanned
    repo TEXT NOT NULL,            -- main checkout path
    branch TEXT NOT NULL,
    base TEXT NOT NULL,            -- base ref, e.g. origin/main
    entry_id TEXT,                 -- board entry picked in New session
    issue INTEGER,
    pr INTEGER,                    -- PR number once known; kept after merge/close
    conversation_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of Claude session uuids
    status TEXT NOT NULL DEFAULT 'active',        -- active | done
    origin TEXT NOT NULL,          -- wizard | backfill
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_macros (
    key TEXT PRIMARY KEY,          -- one run (the latest) per worktree
    macro TEXT NOT NULL,           -- ship | land | step:<step>
    status TEXT NOT NULL,          -- running | done | failed
    step TEXT,                     -- step being run, or the one that failed
    error TEXT,
    needs_ack INTEGER,             -- teardown refused without ack
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS work_macro_steps (
    key TEXT NOT NULL,
    step TEXT NOT NULL,
    status TEXT NOT NULL,          -- running | done | skipped | failed
    detail TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (key, step)
  );
`);
// The process died mid-run: the in-memory lock is gone, so the row must not stay running.
db.exec("UPDATE work_macros SET status = 'failed', error = 'Gyro restarted mid-run', finished_at = unixepoch('subsec') * 1000 WHERE status = 'running'");
// "parked" was dropped as a status.
db.exec("UPDATE work_sessions SET status = 'active' WHERE status = 'parked'");

const q = {
  session: db.prepare('SELECT * FROM work_sessions WHERE key = ?'),
  allSessions: db.prepare('SELECT * FROM work_sessions'),
  create: db.prepare(`INSERT INTO work_sessions (key, path, repo, branch, base, entry_id, issue, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`),
  setPr: db.prepare('UPDATE work_sessions SET pr = ?, updated_at = ? WHERE key = ?'),
  setIssue: db.prepare('UPDATE work_sessions SET issue = ?, updated_at = ? WHERE key = ? AND issue IS NULL'),
  setConversations: db.prepare('UPDATE work_sessions SET conversation_ids = ?, updated_at = ? WHERE key = ?'),
  setStatus: db.prepare('UPDATE work_sessions SET status = ?, updated_at = ? WHERE key = ?'),
  macro: db.prepare('SELECT * FROM work_macros WHERE key = ?'),
  allMacros: db.prepare('SELECT * FROM work_macros'),
  startMacro: db.prepare(`INSERT INTO work_macros (key, macro, status, started_at) VALUES (?, ?, 'running', ?)
    ON CONFLICT (key) DO UPDATE SET macro = excluded.macro, status = 'running', step = NULL, error = NULL,
      needs_ack = NULL, started_at = excluded.started_at, finished_at = NULL`),
  macroStep: db.prepare('UPDATE work_macros SET step = ? WHERE key = ?'),
  finishMacro: db.prepare('UPDATE work_macros SET status = ?, step = ?, error = ?, needs_ack = ?, finished_at = ? WHERE key = ?'),
  steps: db.prepare('SELECT * FROM work_macro_steps WHERE key = ?'),
  allSteps: db.prepare('SELECT * FROM work_macro_steps'),
  clearSteps: db.prepare('DELETE FROM work_macro_steps WHERE key = ?'),
  step: db.prepare(`INSERT INTO work_macro_steps (key, step, status, detail, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (key, step) DO UPDATE SET status = excluded.status, detail = excluded.detail, at = excluded.at`),
};

function shapeSession(row) {
  if (!row) return null;
  let conversations = [];
  try { conversations = JSON.parse(row.conversation_ids); } catch { /* keep [] */ }
  return {
    path: row.path,
    repo: row.repo,
    branch: row.branch,
    base: row.base,
    entryId: row.entry_id ?? null,
    issue: row.issue ?? null,
    pr: row.pr ?? null,
    conversations,
    status: row.status,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeMacro(row, steps) {
  if (!row) return null;
  const order = WORK_STEPS.map((s) => s.key);
  return {
    macro: row.macro,
    status: row.status,
    step: row.step ?? null,
    error: row.error ?? null,
    needsAck: !!row.needs_ack,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    steps: steps
      .sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step))
      .map((s) => ({ key: s.step, label: WORK_STEPS.find((w) => w.key === s.step)?.label ?? s.step, status: s.status, detail: s.detail ?? null, at: s.at })),
  };
}

/** Every work session (+ its latest macro run), by normalized worktree path: for the snapshot. */
export function allWork() {
  const macros = new Map(q.allMacros.all().map((m) => [m.key, m]));
  const steps = q.allSteps.all();
  return new Map(
    q.allSessions.all().map((row) => [
      row.key,
      { session: shapeSession(row), macro: shapeMacro(macros.get(row.key), steps.filter((s) => s.key === row.key)) },
    ]),
  );
}

export function workOf(path) {
  const key = norm(path);
  return { session: shapeSession(q.session.get(key)), macro: shapeMacro(q.macro.get(key), q.steps.all(key)) };
}

/** Idempotent: an existing row (same worktree) wins, so backfill can race the wizard safely. */
export function createWork({ path, repo, branch, base, entryId = null, issue = null, origin }) {
  const now = Date.now();
  q.create.run(norm(path), path, repo, branch, base, entryId, issue, origin, now, now);
  return shapeSession(q.session.get(norm(path)));
}

export function setPr(path, number) {
  q.setPr.run(number, Date.now(), norm(path));
}

/** Fill the issue in only if none was ever linked (backfill from a PR's Closes #N). */
export function setIssueIfEmpty(path, issue) {
  q.setIssue.run(issue, Date.now(), norm(path));
}

/** Record the Claude conversations seen in this worktree (newest kept, capped). */
export function addConversations(path, ids) {
  const key = norm(path);
  const row = q.session.get(key);
  if (!row || !ids.length) return;
  let have = [];
  try { have = JSON.parse(row.conversation_ids); } catch { /* keep [] */ }
  const merged = [...new Set([...ids, ...have])].slice(0, 20);
  if (merged.length === have.length && merged.every((id, i) => id === have[i])) return;
  q.setConversations.run(JSON.stringify(merged), Date.now(), key);
}

export function setWorkStatus(path, status) {
  if (!SESSION_STATUS.has(status)) throw Object.assign(new Error('status must be active or done'), { status: 400 });
  q.setStatus.run(status, Date.now(), norm(path));
}

/** A new macro run; forgets the previous run's steps. */
export function startMacro(path, macro) {
  const key = norm(path);
  q.startMacro.run(key, macro, Date.now());
  q.clearSteps.run(key);
}

export function reportMacroStep(path, step, status, detail) {
  if (!STEP_KEYS.has(step)) throw Object.assign(new Error(`unknown step; use one of ${[...STEP_KEYS].join(', ')}`), { status: 400 });
  if (!MACRO_STEP_STATUS.has(status)) throw Object.assign(new Error('bad step status'), { status: 400 });
  const key = norm(path);
  q.macroStep.run(status === 'running' ? step : null, key);
  q.step.run(key, step, status, typeof detail === 'string' ? detail.slice(0, 1000) : null, Date.now());
}

export function finishMacro(path, ok, { step = null, error = null, needsAck = false } = {}) {
  q.finishMacro.run(ok ? 'done' : 'failed', step, error ? String(error).slice(0, 1000) : null, needsAck ? 1 : 0, Date.now(), norm(path));
}
