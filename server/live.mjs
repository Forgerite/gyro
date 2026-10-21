// Live Playwright runs: test workers started from ccdb's terminals screencast their pages here
// (see pw-live-hook.cjs), and the dashboard watches them over /api/live.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { recordEnd, recordFrame, recordStart } from './recordings.mjs';

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const HOOK = new URL('./pw-live-hook.cjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
/** Only processes ccdb started know it, so nothing else can push frames into the dashboard. */
const TOKEN = randomBytes(18).toString('base64url');
let apiPort = null;

/** norm(worktree) -> { streams: Map<id, { id, title, w, h, data }>, viewers: Set<ws> } */
const runs = new Map();
const runOf = (path) => {
  const key = norm(path);
  if (!runs.has(key)) runs.set(key, { streams: new Map(), viewers: new Set() });
  return runs.get(key);
};

/** Environment for a terminal in `path`: preloads the hook into every Node process it starts. */
export function liveEnv(path) {
  if (!apiPort) return {};
  const q = new URLSearchParams({ path, token: TOKEN });
  const prev = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  return {
    CCDB_LIVE_URL: `ws://127.0.0.1:${apiPort}/api/live/push?${q}`,
    NODE_OPTIONS: `${prev}--require ${JSON.stringify(HOOK)}`,
  };
}

function tokenOk(t) {
  const a = Buffer.from(t ?? '');
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tell(run, msg) {
  const data = JSON.stringify(msg);
  for (const ws of run.viewers) if (ws.readyState === ws.OPEN) ws.send(data);
}

/**
 * WebSockets: /api/live/push?path&token from test workers ({t:'start'|'frame'|'end', id, ...}), and
 * /api/live?path from the dashboard, which gets every running page's latest frame, then updates.
 */
export function attachLiveSocket(server, originOk, port) {
  apiPort = port;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.searchParams.get('path');
    if (url.pathname === '/api/live/push') {
      if (!path || !tokenOk(url.searchParams.get('token'))) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => pusher(path, runOf(path), ws));
    } else if (url.pathname === '/api/live') {
      if (!path || !originOk(req)) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => viewer(runOf(path), ws));
    }
  });
}

/** Recording never gets in the way of the live view. */
function record(fn, ...args) {
  try { fn(...args); } catch { /* disk full, folder gone: the run still shows live */ }
}

function pusher(path, run, ws) {
  const mine = new Set();
  const end = (id) => {
    if (!run.streams.delete(id)) return;
    mine.delete(id);
    record(recordEnd, path, id);
    tell(run, { t: 'end', id });
  };
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (typeof m.id !== 'string' || m.id.length > 64) return;
    const id = m.id;
    if (m.t === 'end') return end(id);
    if (m.t !== 'start' && m.t !== 'frame') return;
    const s = run.streams.get(id) ?? { id, title: null, w: 0, h: 0, data: null };
    if (typeof m.title === 'string') s.title = m.title.slice(0, 300);
    if (m.t === 'frame' && typeof m.data === 'string') {
      Object.assign(s, { data: m.data, w: m.w | 0, h: m.h | 0 });
      record(recordFrame, path, id, s.title, m.data);
    } else if (m.t === 'start') record(recordStart, path, id, s.title);
    run.streams.set(id, s);
    mine.add(id);
    tell(run, { t: 'frame', ...s });
  });
  // A worker that exits (or crashes) mid-test takes its pages with it.
  ws.on('close', () => { for (const id of [...mine]) end(id); });
}

function viewer(run, ws) {
  run.viewers.add(ws);
  for (const s of run.streams.values()) ws.send(JSON.stringify({ t: 'frame', ...s }));
  ws.on('close', () => run.viewers.delete(ws));
}
