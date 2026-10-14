// Embedded terminals: at most one claude PTY per worktree, surviving browser reconnects.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import { CLAUDE, childEnv } from './claude-env.mjs';

const SCROLLBACK_CHARS = 512 * 1024;

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** norm(path) -> Term */
const terms = new Map();

/**
 * node-pty 1.1.0's Windows kill() crashes the process (getConsoleProcessList returns undefined),
 * so kill the whole tree ourselves; the PTY then reports exit through onExit as usual.
 */
function killTree(term) {
  if (process.platform === 'win32') execFile('taskkill', ['/T', '/F', '/PID', String(term.pid)], () => {});
  else term.proc.kill();
}

export function listTerms() {
  return [...terms.values()].map(({ path, sessionId, resumed, pid, startedAt, exited, exitCode, clients }) => ({
    path, sessionId, resumed, pid, startedAt, exited, exitCode, attached: clients.size,
  }));
}

export function findTerm(path) {
  return terms.get(norm(path));
}

/** Start claude in `path`, resuming `sessionId` or starting a new session with a known id. */
export function startTerm(path, sessionId) {
  const existing = findTerm(path);
  if (existing && !existing.exited) {
    throw Object.assign(new Error('A terminal is already running in this worktree'), { status: 409 });
  }
  const id = sessionId ?? randomUUID();
  const args = sessionId ? ['--resume', sessionId] : ['--session-id', id];
  const proc = pty.spawn(CLAUDE, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: path, env: childEnv() });

  const term = {
    path, sessionId: id, resumed: !!sessionId, pid: proc.pid, startedAt: Date.now(),
    exited: false, exitCode: null, proc, buffer: '', clients: new Set(),
  };
  proc.onData((d) => {
    term.buffer = (term.buffer + d).slice(-SCROLLBACK_CHARS);
    broadcast(term, { t: 'o', d });
  });
  proc.onExit(({ exitCode }) => {
    term.exited = true;
    term.exitCode = exitCode;
    broadcast(term, { t: 'x', code: exitCode });
  });
  terms.set(norm(path), term);
  return term;
}

/** Kill (if running) and forget the terminal for `path`. */
export function closeTerm(path) {
  const term = findTerm(path);
  if (!term) return;
  if (!term.exited) killTree(term);
  for (const ws of term.clients) ws.close();
  terms.delete(norm(path));
}

function broadcast(term, msg) {
  const data = JSON.stringify(msg);
  for (const ws of term.clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

/** WebSocket endpoint: /api/pty?path=<worktree>. Attach only; terminals are created over HTTP. */
export function attachPtySocket(server, originOk) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/pty' || !originOk(req)) return socket.destroy();
    const term = findTerm(url.searchParams.get('path') ?? '');
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
  for (const t of terms.values()) if (!t.exited) killTree(t);
}
