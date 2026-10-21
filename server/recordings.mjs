// Recordings of live Playwright runs: every frame live.mjs relays to the dashboard is also written
// to disk, so a run can be played back in the Tests tab after it ends.
//
// One folder per run under ~/.claude/ccdb/recordings/<worktree hash>/<id>/:
//   frames.bin   the JPEG frames, back to back
//   index.jsonl  one line per event: {t, s, start|end|o+n, title?}; t is ms since the run began
//   meta.json    written when the run ends; a run without one is still recording (or ccdb stopped mid-run)
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.claude', 'ccdb', 'recordings');
/** Recordings kept per worktree; older ones are deleted when a new one finishes. */
const KEEP = 10;
/** A run ends this long after its last page closes; a page opening sooner belongs to the same run. */
const IDLE_MS = 8000;
/** Past this, a recording stops taking frames (the live view carries on). */
const MAX_BYTES = 500 * 1024 ** 2;
const MAX_FRAME = 16 * 1024 ** 2;

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const baseOf = (path) => join(ROOT, createHash('sha1').update(norm(path)).digest('hex').slice(0, 16));
const ID = /^\d{13}$/;

/** norm(worktree) -> the recording being written */
const active = new Map();

function current(path) {
  const key = norm(path);
  let r = active.get(key);
  if (r) return r;
  const base = baseOf(path);
  const id = String(Date.now());
  const dir = join(base, id);
  mkdirSync(dir, { recursive: true });
  r = {
    key, base, id, dir, path,
    at: Number(id),
    last: 0,
    bytes: 0,
    count: 0,
    failed: false,
    open: new Set(),
    titles: new Map(),
    tests: new Set(),
    idle: undefined,
    frames: createWriteStream(join(dir, 'frames.bin')),
    index: createWriteStream(join(dir, 'index.jsonl')),
  };
  const fail = () => { r.failed = true; };
  r.frames.on('error', fail);
  r.index.on('error', fail);
  active.set(key, r);
  return r;
}

function line(r, s, ev, title) {
  r.last = Date.now() - r.at;
  const entry = { t: r.last, s, ...ev };
  // A page's test title, written only when it changes.
  if (typeof title === 'string' && r.titles.get(s) !== title) {
    r.titles.set(s, title);
    entry.title = title;
    r.tests.add(title);
  }
  r.index.write(JSON.stringify(entry) + '\n');
}

function opened(r, s) {
  clearTimeout(r.idle);
  r.open.add(s);
}

export function recordStart(path, s, title) {
  const r = current(path);
  if (r.failed) return;
  opened(r, s);
  line(r, s, { start: 1 }, title);
}

export function recordFrame(path, s, title, base64) {
  const r = current(path);
  if (r.failed) return;
  if (!r.open.has(s)) {
    opened(r, s);
    line(r, s, { start: 1 }, title);
  }
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length || buf.length > MAX_FRAME || r.bytes + buf.length > MAX_BYTES) return;
  r.frames.write(buf);
  line(r, s, { o: r.bytes, n: buf.length }, title);
  r.bytes += buf.length;
  r.count++;
}

export function recordEnd(path, s) {
  const r = active.get(norm(path));
  if (!r || !r.open.delete(s)) return;
  if (!r.failed) line(r, s, { end: 1 });
  if (!r.open.size) r.idle = setTimeout(() => finish(r).catch(() => {}), IDLE_MS);
}

async function finish(r) {
  if (active.get(r.key) !== r) return;
  active.delete(r.key);
  await Promise.all([r.frames, r.index].map((w) => new Promise((done) => w.end(done))));
  if (!r.count || r.failed) await rm(r.dir, { recursive: true, force: true });
  else await writeMeta(r.dir, r.id, r.at, r.last, r.count, r.bytes, r.tests.size);
  await prune(r.base);
}

function writeMeta(dir, id, at, ms, frames, bytes, tests) {
  const meta = { id, at, ms, frames, bytes, tests };
  return writeFile(join(dir, 'meta.json'), JSON.stringify(meta)).then(() => meta);
}

async function prune(base) {
  let ids;
  try { ids = (await readdir(base)).filter((d) => ID.test(d)); } catch { return; }
  const live = new Set([...active.values()].map((r) => r.id));
  ids.sort().reverse();
  for (const id of ids.slice(KEEP)) if (!live.has(id)) await rm(join(base, id), { recursive: true, force: true }).catch(() => {});
}

/** Finished recordings in a worktree, newest first: { id, at, ms, frames, bytes, tests }. */
export async function listRecordings(path) {
  const base = baseOf(path);
  let ids;
  try { ids = (await readdir(base)).filter((d) => ID.test(d)); } catch { return []; }
  const live = active.get(norm(path))?.id;
  const out = [];
  for (const id of ids) {
    if (id === live) continue;
    const dir = join(base, id);
    try {
      out.push(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')));
    } catch {
      // ccdb stopped mid-run: whatever reached the disk still plays back.
      const idx = await recordingIndex(path, id);
      if (idx?.frames) out.push(await writeMeta(dir, id, idx.at, idx.ms, idx.frames, idx.bytes, idx.tests).catch(() => null));
    }
  }
  return out.filter(Boolean).sort((a, b) => b.at - a.at);
}

/**
 * One recording, ready to play: each page with when it opened and closed, its frames as
 * [t, offset, length], and its test titles as [t, title].
 */
export async function recordingIndex(path, id) {
  if (!ID.test(id ?? '')) return null;
  let text;
  try { text = await readFile(join(baseOf(path), id, 'index.jsonl'), 'utf8'); } catch { return null; }
  const streams = new Map();
  const of = (s) => {
    if (!streams.has(s)) streams.set(s, { id: s, start: null, end: null, frames: [], titles: [] });
    return streams.get(s);
  };
  let ms = 0;
  let bytes = 0;
  const titles = new Set();
  for (const l of text.split('\n')) {
    let e;
    try { e = JSON.parse(l); } catch { continue; } // the last line may be cut short
    if (typeof e?.s !== 'string' || !Number.isFinite(e.t)) continue;
    const st = of(e.s);
    ms = Math.max(ms, e.t);
    if (st.start === null) st.start = e.t;
    if (typeof e.title === 'string') {
      st.titles.push([e.t, e.title]);
      titles.add(e.title);
    }
    if (e.end) st.end = e.t;
    else if (Number.isInteger(e.o) && Number.isInteger(e.n)) {
      st.frames.push([e.t, e.o, e.n]);
      bytes = Math.max(bytes, e.o + e.n);
    }
  }
  const list = [...streams.values()].filter((s) => s.frames.length);
  for (const s of list) s.end ??= ms;
  return {
    id,
    at: Number(id),
    ms,
    bytes,
    tests: titles.size,
    frames: list.reduce((n, s) => n + s.frames.length, 0),
    streams: list,
  };
}

/** One JPEG frame of a recording, by its offset and length in frames.bin. */
export async function readFrame(path, id, o, n) {
  if (!ID.test(id ?? '') || !Number.isInteger(o) || !Number.isInteger(n) || o < 0 || n <= 0 || n > MAX_FRAME) return null;
  let fh;
  try {
    fh = await open(join(baseOf(path), id, 'frames.bin'));
    const { size } = await fh.stat();
    if (o + n > size) return null;
    const { buffer } = await fh.read({ buffer: Buffer.alloc(n), position: o });
    return buffer;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
