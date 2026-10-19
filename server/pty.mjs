// Embedded terminals: per worktree, one claude PTY plus (when the project has one) its dev server,
// surviving browser reconnects.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { CLAUDE, childEnv } from './claude-env.mjs';
import { portEnv } from './ports.mjs';

const SCROLLBACK_CHARS = 512 * 1024;

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** ccdb's own checkout: its dev script would fight the running dashboard for its ports. */
const SELF = norm(resolve(import.meta.dirname, '..'));

/** norm(path) -> claude Term */
const terms = new Map();
/** norm(path) -> dev server Term */
const devs = new Map();

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
    };
  });
}

export function findTerm(path) {
  return terms.get(norm(path));
}

/** Run a PTY, keeping its scrollback for whoever attaches later. */
function spawnTerm(file, args, cwd, extra, env = {}) {
  const proc = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd, env: { ...childEnv(), ...env } });
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

/**
 * Start claude in `path`, resuming `sessionId` or starting a new session with a known id. The
 * project's dev server (`devCmd`, if it has one) starts alongside.
 */
export function startTerm(path, sessionId, devCmd = null, prompt = null) {
  const existing = findTerm(path);
  if (existing && !existing.exited) {
    throw Object.assign(new Error('A terminal is already running in this worktree'), { status: 409 });
  }
  const id = sessionId ?? randomUUID();
  // A new session can open on a first message (e.g. the issue it's for). claude.exe gets it as one
  // argument (node-pty quotes it), so line breaks and quotes survive; other control characters don't.
  const first = prompt?.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim();
  const args = sessionId ? ['--resume', sessionId] : ['--session-id', id, ...(first ? [first] : [])];
  // The worktree's port block: whatever claude starts (tests, a second stack) inherits it.
  const term = spawnTerm(CLAUDE, args, path, { path, sessionId: id, resumed: !!sessionId, devCommand: devCmd }, portEnv(path));
  terms.set(norm(path), term);
  const dev = devs.get(norm(path));
  if (devCmd && (!dev || dev.exited)) startDev(path, devCmd);
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

/** Kill (if running) and forget the terminals for `path`: claude and its dev server. */
export function closeTerm(path) {
  for (const map of [terms, devs]) {
    const term = map.get(norm(path));
    if (!term) continue;
    if (!term.exited) killTree(term);
    for (const ws of term.clients) ws.close();
    map.delete(norm(path));
  }
}

function broadcast(term, msg) {
  const data = JSON.stringify(msg);
  for (const ws of term.clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

/** WebSocket endpoint: /api/pty?path=<worktree>[&kind=dev]. Attach only; terminals are created over HTTP. */
export function attachPtySocket(server, originOk) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/pty' || !originOk(req)) return socket.destroy();
    const map = url.searchParams.get('kind') === 'dev' ? devs : terms;
    const term = map.get(norm(url.searchParams.get('path') ?? ''));
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
  for (const t of [...terms.values(), ...devs.values()]) if (!t.exited) killTree(t);
}
