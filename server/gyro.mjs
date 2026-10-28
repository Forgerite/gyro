// Gyro conversion: bring a project onto Gyro's conventions (dev command, git, no orphaned sessions,
// per-worktree port leases wired into Gyro's machine-wide blocks). Gyro does the mechanical steps;
// a Claude session does the rest in a worktree made for it and reports each step back here.
// Progress lives in SQLite (~/.claude/gyro/gyro.db) so it outlasts restarts and terminals.
import { db } from './db.mjs';

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** In the order the conversion does them. `by`: who does it. */
export const GYRO_STEPS = [
  { key: 'dev', label: 'Dev command', by: 'claude' },
  { key: 'git', label: 'Git repository', by: 'gyro' },
  { key: 'prune', label: 'Orphaned sessions', by: 'gyro' },
  { key: 'lease', label: 'Port leasing', by: 'claude' },
  { key: 'gyro', label: 'Wired into Gyro ports', by: 'claude' },
];
const STEP_KEYS = new Set(GYRO_STEPS.map((s) => s.key));
const STEP_STATUS = new Set(['done', 'skipped', 'failed']);

db.exec(`
  CREATE TABLE IF NOT EXISTS gyro_projects (
    key TEXT PRIMARY KEY,          -- normalized project path
    path TEXT NOT NULL,
    status TEXT NOT NULL,          -- running | done | failed
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    worktree TEXT,                 -- where the Claude session works
    session_id TEXT,
    summary TEXT,
    changed INTEGER                -- 1 if the session changed the repo, 0 if it was already in shape
  );
  CREATE TABLE IF NOT EXISTS gyro_steps (
    key TEXT NOT NULL,
    step TEXT NOT NULL,
    status TEXT NOT NULL,          -- done | skipped | failed
    detail TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (key, step)
  );
`);
// Databases from before `changed` existed.
if (!db.prepare('PRAGMA table_info(gyro_projects)').all().some((c) => c.name === 'changed')) db.exec('ALTER TABLE gyro_projects ADD COLUMN changed INTEGER');
// The "gyro" step was called "ccdb" before the rename.
db.exec("UPDATE gyro_steps SET step = 'gyro' WHERE step = 'ccdb'");

const q = {
  project: db.prepare('SELECT * FROM gyro_projects WHERE key = ?'),
  all: db.prepare('SELECT * FROM gyro_projects'),
  steps: db.prepare('SELECT * FROM gyro_steps WHERE key = ?'),
  allSteps: db.prepare('SELECT * FROM gyro_steps'),
  start: db.prepare(`INSERT INTO gyro_projects (key, path, status, started_at, worktree, session_id)
    VALUES (?, ?, 'running', ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET path = excluded.path, status = 'running', started_at = excluded.started_at,
      finished_at = NULL, worktree = excluded.worktree, session_id = excluded.session_id, summary = NULL, changed = NULL`),
  clearSteps: db.prepare('DELETE FROM gyro_steps WHERE key = ?'),
  step: db.prepare(`INSERT INTO gyro_steps (key, step, status, detail, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (key, step) DO UPDATE SET status = excluded.status, detail = excluded.detail, at = excluded.at`),
  finish: db.prepare('UPDATE gyro_projects SET status = ?, finished_at = ?, summary = ?, changed = ? WHERE key = ?'),
  note: db.prepare("UPDATE gyro_projects SET summary = coalesce(summary || ' ', '') || ? WHERE key = ?"),
};

function shape(row, steps) {
  if (!row) return null;
  return {
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    worktree: row.worktree ?? null,
    sessionId: row.session_id ?? null,
    summary: row.summary ?? null,
    changed: row.changed === null || row.changed === undefined ? null : !!row.changed,
    steps: GYRO_STEPS.map(({ key, label, by }) => {
      const s = steps.find((x) => x.step === key);
      return { key, label, by, status: s?.status ?? 'pending', detail: s?.detail ?? null, at: s?.at ?? null };
    }),
  };
}

/** Every project's conversion, by normalized path: one query each, for the snapshot. */
export function allGyro() {
  const steps = q.allSteps.all();
  return new Map(q.all.all().map((row) => [row.key, shape(row, steps.filter((s) => s.key === row.key))]));
}

export function gyroOf(path) {
  const key = norm(path);
  return shape(q.project.get(key), q.steps.all(key));
}

/** A new run (or a re-run): forgets the previous run's steps. */
export function startGyro(path, { worktree, sessionId }) {
  const key = norm(path);
  q.start.run(key, path, Date.now(), worktree, sessionId);
  q.clearSteps.run(key);
}

export function reportStep(path, step, status, detail) {
  if (step === 'ccdb') step = 'gyro'; // sessions briefed before the rename
  if (!STEP_KEYS.has(step)) throw Object.assign(new Error(`unknown step; use one of ${[...STEP_KEYS].join(', ')}`), { status: 400 });
  if (!STEP_STATUS.has(status)) throw Object.assign(new Error('status must be done, skipped or failed'), { status: 400 });
  if (!q.project.get(norm(path))) throw Object.assign(new Error('No Gyro conversion is running for this project'), { status: 409 });
  q.step.run(norm(path), step, status, typeof detail === 'string' ? detail.slice(0, 1000) : null, Date.now());
}

/** The run is over: done only if every step was done or skipped. `changed`: false when everything was already in shape. */
export function finishGyro(path, ok, summary, changed) {
  const g = gyroOf(path);
  if (!g) throw Object.assign(new Error('No Gyro conversion is running for this project'), { status: 409 });
  const complete = g.steps.every((s) => s.status === 'done' || s.status === 'skipped');
  const status = ok && complete ? 'done' : 'failed';
  const note = ok && !complete ? `Not finished: ${g.steps.filter((s) => s.status === 'pending' || s.status === 'failed').map((s) => s.label).join(', ')}. ` : '';
  q.finish.run(status, Date.now(), (note + (typeof summary === 'string' ? summary : '')).slice(0, 2000) || null, changed === false ? 0 : 1, norm(path));
  return gyroOf(path);
}

/** A conversion Gyro completed itself, with no session: a project created as a Gyro project. */
export function recordGyro(path, steps, summary) {
  const key = norm(path);
  const now = Date.now();
  q.start.run(key, path, now, path, null);
  q.clearSteps.run(key);
  for (const [step, status, detail] of steps) q.step.run(key, step, status, detail, now);
  q.finish.run('done', now, summary, 1, key);
}

/** Append a sentence to the run's summary (e.g. what Gyro did after it finished). */
export function noteGyro(path, text) {
  q.note.run(text, norm(path));
}

/** The first message of the conversion session. */
export function gyroBrief({ project, worktree, branch, gyroUrl, done, examples, dev }) {
  const report = (body) => `curl -s -X POST ${gyroUrl}/api/gyro/report -H "content-type: application/json" -d '${JSON.stringify({ path: worktree.replace(/\\/g, '/'), ...body })}'`;
  return `Convert ${project.name} into a Gyro project.

Gyro (running at ${gyroUrl}) is the dashboard that runs Claude sessions and dev servers for every git worktree on this machine. A Gyro project runs side by side in any number of worktrees without port collisions.

${branch ? `You're in ${worktree}, a worktree on branch \`${branch}\` made for this conversion. Make all changes here, not in the main checkout (${project.path}), and commit here at the end.` : `This repository has no commits yet, so you're in the main checkout (${worktree}). Don't commit; leave the changes for review.`}

Already checked by Gyro:
${done.map((d) => `- ${d}`).join('\n')}

Many projects are already partly or fully in shape. For each step below, first check whether the project already meets it. If it does, change nothing for that step and report it done with a detail that starts "Already in place:". Only act on what's missing or wrong, and keep those changes as small as the gap.

Do the steps in order. After each one, report it to Gyro with status "done", "skipped" (not applicable here) or "failed", and a one-line detail, e.g.:
  ${report({ step: 'dev', status: 'done', detail: 'npm run dev (Vite web app)', devCommand: 'npm run dev' })}

1. Dev command (step "dev"). Gyro currently runs ${dev.command !== null && dev.command !== undefined ? (dev.command ? `\`${dev.command}\`, set in Gyro by the user` : 'nothing (the user turned the dev server off in Gyro)') : dev.detected ? `\`${dev.detected}\`, detected from package.json` : 'nothing (none set and no dev or start script found)'}. If that's right, report it already in place and leave "devCommand" out of the report. Otherwise work out the one command that runs this project's main app for local development. Gyro runs it in each worktree beside its Claude session (through cmd.exe on Windows), with PORT set to the worktree's first port, and opens the first http://localhost URL it prints in a preview. Prefer a plain package script such as \`npm run dev\`; make the app pick its own port (step 3) rather than putting ports in the command. Put it in the report as "devCommand" ("" if the project has nothing to run), and say in the detail why the current one was wrong.

2. Port leasing (step "lease"). Every service the project starts locally (dev servers, APIs, databases or emulators it launches, e2e and test stacks) must get its port from one module instead of a hardcoded number, so two worktrees can run at once. If the repo already has such a module (a worktree-ports script, a ports config) and nothing bypasses it, this step is already in place. If it has one but some ports bypass it, route those through it. Otherwise create one, modelled on what these projects do (read one first):
${examples.map((e) => `   - ${e}`).join('\n')}
   That means: one table naming each service and its port, a resolver everything imports, and a small CLI or env-file writer for tools that can't import JavaScript (docker compose, .env files, shell scripts). Then route every hardcoded port through it: listen() calls, the Vite or Angular dev server config (with strictPort, so a taken port fails loudly instead of drifting to the next one), dev proxies, Playwright config and baseURL, e2e fixtures, .env files and compose files. Search the repo for port numbers and localhost URLs to find them all.

3. Gyro's ports (step "gyro"). Gyro leases each worktree a block of 100 ports, unique across every project on this machine, and puts it in the environment of everything it starts there: GYRO_PORT_BASE (first port), GYRO_PORT_COUNT (100) and GYRO_PORT_SLOT; the dev server also gets PORT, equal to GYRO_PORT_BASE. Your shell has them now. Gyro also sets them under their old names (CCDB_PORT_*), so a resolver that reads CCDB_PORT_BASE still works; use the GYRO_ names in anything you write. The resolver takes its ports from, in order:
   a. GYRO_PORT_BASE in the environment (or the older CCDB_PORT_BASE);
   b. a running Gyro: GET ${gyroUrl}/api/ports?path=<the worktree's git toplevel> returns {"base","count","slot"} (404 for folders Gyro doesn't know; give up after about 1.5 s);
   c. what the project did before (its own slot registry, or today's fixed ports), so CI and machines without Gyro keep working unchanged.
   If the resolver already does all of that, this step is already in place; check the CLAUDE.md note too. Inside the block each service has a fixed offset: 0 is the main app the dev command serves (the preview shows it), 1–49 other dev services, 50–99 test and e2e services.
   Add a short "Ports" section to the project's CLAUDE.md (create the file if there isn't one): the variables, the offset table, and how scripts get their ports.

4. Verify. Run the dev command here and check the app answers on GYRO_PORT_BASE, and that its other services use their offsets. If you changed code, also run the unit tests, and the e2e suite if it's reasonably quick. Stop everything you started.

5. ${branch ? 'If you changed anything, commit it on this branch with a clear message. Then report' : 'Report'} that you've finished, with two or three sentences on what changed and anything left to do. Set "changed" to false if you changed nothing in the repo${branch ? ' (Gyro then removes this worktree and its branch once you go idle)' : ''}:
  ${report({ done: true, changed: true, summary: '...' })}
   If you couldn't finish, report "done": false and say why in the summary.

Ask me before anything destructive or anything outside this worktree. Start now.`;
}
