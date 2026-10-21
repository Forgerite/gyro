// Embedded terminals: per worktree, one claude PTY plus (when the project has one) its dev server
// and any shells the user opens, surviving browser reconnects.
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { CLAUDE, childEnv } from './claude-env.mjs';
import { liveEnv } from './live.mjs';
import { portEnv } from './ports.mjs';

const SCROLLBACK_CHARS = 512 * 1024;

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Gyro's own checkout: its dev script would fight the running dashboard for its ports. */
const SELF = norm(resolve(import.meta.dirname, '..'));

/** norm(path) -> claude Term */
const terms = new Map();
/** norm(path) -> dev server Term */
const devs = new Map();
/** norm(path) -> { next: number, list: shell Term[] } */
const shells = new Map();

/**
 * node-pty 1.1.0's Windows kill() crashes the process (getConsoleProcessList returns undefined),
 * so kill the whole tree ourselves; the PTY then reports exit through onExit as usual.
 */
function killTree(term) {
  if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(term.pid)], () => {});
  else term.proc.kill();
}

export function listTerms() {
  return [...terms.values()].map(({ path, sessionId, resumed, pid, startedAt, exited, exitCode, clients, devCommand }) => {
    const d = devs.get(norm(path));
    return {
      path, sessionId, resumed, pid, startedAt, exited, exitCode, attached: clients.size, devCommand,
      dev: d ? { startedAt: d.startedAt, exited: d.exited, exitCode: d.exitCode, url: d.url } : null,
      shells: (shells.get(norm(path))?.list ?? []).map(({ id, label, startedAt, exited, exitCode }) => ({ id, label, startedAt, exited, exitCode })),
    };
  });
}

export function findTerm(path) {
  return terms.get(norm(path));
}

/** Run a PTY, keeping its scrollback for whoever attaches later. */
function spawnTerm(file, args, cwd, extra, env = {}) {
  const proc = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: { ...childEnv(), ...liveEnv(cwd), ...env } });
  const term = { pid: proc.pid, startedAt: Date.now(), exited: false, exitCode: null, proc, buffer: '', clients: new Set(), ...extra };
  proc.onData((d) => {
    term.buffer = (term.buffer + d).slice(-SCROLLBACK_CHARS);
    term.onData?.(d);
    broadcast(term, { t: 'o', d });
  });
  proc.onExit(({ exitCode }) => {
    term.exited = true;
    term.exitCode = exitCode;
    broadcast(term, { t: 'x', code: exitCode });
  });
  return term;
}

/** A message fit to hand claude, as one argument or one paste: no stray control characters. */
function cleanPrompt(prompt) {
  return prompt?.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim() || null;
}

/**
 * Start claude in `path`, resuming `sessionId` or starting a new session with a known id, optionally
 * opening on `prompt` as the first message. The project's dev server (`devCmd`, if it has one)
 * starts alongside.
 */
export function startTerm(path, sessionId, devCmd = null, prompt = null) {
  const existing = findTerm(path);
  if (existing && !existing.exited) {
    throw Object.assign(new Error('A terminal is already running in this worktree'), { status: 409 });
  }
  const id = sessionId ?? randomUUID();
  // A session can open on a first message (e.g. the issue it's for). claude.exe gets it as one
  // argument (node-pty quotes it), so line breaks and quotes survive; other control characters don't.
  const first = cleanPrompt(prompt);
  const args = [...(sessionId ? ['--resume', sessionId] : ['--session-id', id]), ...(first ? [first] : [])];
  // The worktree's port block: whatever claude starts (tests, a second stack) inherits it.
  const term = spawnTerm(CLAUDE, args, path, { path, sessionId: id, resumed: !!sessionId, devCommand: devCmd }, portEnv(path));
  terms.set(norm(path), term);
  const dev = devs.get(norm(path));
  if (devCmd && (!dev || dev.exited)) startDev(path, devCmd);
  return term;
}

/**
 * Type `prompt` into the running claude in `path` and submit it, as if pasted at its prompt; claude
 * queues it if it's mid-turn. Bracketed paste keeps line breaks from submitting early.
 */
export function sendPrompt(path, prompt) {
  const term = findTerm(path);
  if (!term || term.exited) throw Object.assign(new Error('No session is running in this worktree'), { status: 409 });
  const text = cleanPrompt(prompt);
  if (!text) throw Object.assign(new Error('Nothing to send'), { status: 400 });
  term.proc.write(`\x1b[200~${text}\x1b[201~`);
  // Enter on its own, once the paste has landed, so it submits instead of joining the paste.
  setTimeout(() => { if (!term.exited) term.proc.write('\r'); }, 150);
  return term;
}

/** The project's dev script, as you'd type it: `npm run dev`, else `npm start`. */
export function detectDev(path) {
  if (norm(path) === SELF) return null;
  try {
    const scripts = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).scripts ?? {};
    if (scripts.dev) return 'npm run dev';
    if (scripts.start) return 'npm start';
  } catch { /* no package.json */ }
  return null;
}

/** Local URLs a dev server prints when it's up ("Local: http://localhost:5173/"). */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s'"`<>)\]]*)?/g;
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[@-_]/g;

/** (Re)start the worktree's dev server in its own PTY, and watch its output for the URL it serves. */
export function startDev(path, command) {
  if (!command) throw Object.assign(new Error('This project has no dev command; set one in its panel'), { status: 400 });
  const old = devs.get(norm(path));
  if (old && !old.exited) throw Object.assign(new Error('The dev server is already running'), { status: 409 });
  if (old) for (const ws of old.clients) ws.close();

  // A fresh worktree has no node_modules yet: install first, or the dev script can't run.
  const install = existsSync(join(path, 'package.json')) && !existsSync(join(path, 'node_modules'));
  const line = install ? `npm install && ${command}` : command;
  const [file, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', line]] : ['sh', ['-c', line]];
  let tail = '';
  let answered = false;
  const term = spawnTerm(file, args, path, {
    path, url: null,
    onData(d) {
      tail = (tail + d.replace(ANSI, '')).slice(-4000);
      // Another worktree has the port: Angular asks before moving to the next one. Yes is its default.
      if (!answered && /already in use[\s\S]*use a different port\?/i.test(tail)) {
        answered = true;
        term.proc.write('y\r');
      }
      const urls = [...tail.matchAll(LOCAL_URL)].map((m) => m[0]);
      if (!urls.length) return;
      // Prefer the "Local:" line; otherwise the latest URL printed.
      const local = tail.split(/\r?\n/).filter((l) => /local/i.test(l)).flatMap((l) => l.match(LOCAL_URL) ?? []);
      const url = (local.at(-1) ?? urls.at(-1)).replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, '');
      term.url = url;
    },
  }, portEnv(path, { dev: true }));
  devs.set(norm(path), term);
  const claude = findTerm(path);
  if (claude) claude.devCommand = command;
  return term;
}

export function stopDev(path) {
  const d = devs.get(norm(path));
  if (d && !d.exited) killTree(d);
}

let bashPath;
/** Git Bash on Windows (found through git itself, so any install location works); bash elsewhere. */
function findBash() {
  if (bashPath !== undefined) return bashPath;
  if (process.platform !== 'win32') return (bashPath = process.env.SHELL || 'bash');
  const candidates = [];
  try {
    // e.g. C:/Program Files/Git/mingw64/libexec/git-core -> C:/Program Files/Git/bin/bash.exe
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
    candidates.push(join(dirname(dirname(dirname(exec))), 'bin', 'bash.exe'));
  } catch { /* git not on PATH */ }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(join(base, 'Git', 'bin', 'bash.exe'));
  }
  return (bashPath = candidates.find((c) => existsSync(c)) ?? null);
}

/** Open another interactive shell (Git Bash on Windows) in `path`, beside its claude. */
export function startShell(path) {
  const bash = findBash();
  if (!bash) throw Object.assign(new Error('Git Bash was not found; install Git for Windows'), { status: 400 });
  let group = shells.get(norm(path));
  if (!group) shells.set(norm(path), (group = { next: 1, list: [] }));
  const n = group.next++;
  // CHERE_INVOKING keeps Git Bash's login profile from cd-ing to $HOME.
  const term = spawnTerm(bash, ['--login', '-i'], path, { id: randomUUID(), label: `bash ${n}`, path }, { ...portEnv(path), CHERE_INVOKING: '1' });
  group.list.push(term);
  return term;
}

/** Kill (if running) and forget one shell. */
export function closeShell(path, id) {
  const group = shells.get(norm(path));
  const term = group?.list.find((t) => t.id === id);
  if (!term) return;
  if (!term.exited) killTree(term);
  for (const ws of term.clients) ws.close();
  group.list = group.list.filter((t) => t !== term);
}

/** Kill (if running) and forget the terminals for `path`: claude, its dev server and its shells. */
export function closeTerm(path) {
  for (const map of [terms, devs]) {
    const term = map.get(norm(path));
    if (!term) continue;
    if (!term.exited) killTree(term);
    for (const ws of term.clients) ws.close();
    map.delete(norm(path));
  }
  for (const term of shells.get(norm(path))?.list ?? []) closeShell(path, term.id);
  shells.delete(norm(path));
}

function broadcast(term, msg) {
  const data = JSON.stringify(msg);
  for (const ws of term.clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

/** WebSocket endpoint: /api/pty?path=<worktree>[&kind=dev|&kind=shell&id=<id>]. Attach only; terminals are created over HTTP. */
export function attachPtySocket(server, originOk) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/pty') return; // another endpoint's
    if (!originOk(req)) return socket.destroy();
    const key = norm(url.searchParams.get('path') ?? '');
    const kind = url.searchParams.get('kind');
    const term = kind === 'shell'
      ? shells.get(key)?.list.find((t) => t.id === url.searchParams.get('id'))
      : (kind === 'dev' ? devs : terms).get(key);
    if (!term) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      term.clients.add(ws);
      ws.send(JSON.stringify({ t: 'o', d: term.buffer }));
      if (term.exited) ws.send(JSON.stringify({ t: 'x', code: term.exitCode }));

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (term.exited) return;
        if (msg.t === 'i' && typeof msg.d === 'string') term.proc.write(msg.d);
        if (msg.t === 'r' && msg.cols > 0 && msg.rows > 0) term.proc.resize(Math.floor(msg.cols), Math.floor(msg.rows));
      });
      ws.on('close', () => term.clients.delete(ws));
    });
  });
}

export function killAllTerms() {
  const all = [...terms.values(), ...devs.values(), ...[...shells.values()].flatMap((g) => g.list)];
  for (const t of all) if (!t.exited) killTree(t);
}
