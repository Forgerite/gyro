// Playwright HTML reports in a worktree: found by walking it, then served as static sites.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Folders never worth walking into. Hidden folders are skipped too, except Nx's dist/.playwright. */
const SKIP = new Set(['node_modules', '.git', '.nx', '.angular', '.next', '.turbo', '.cache', 'coverage', 'tmp', 'data', 'trace', 'assets']);
const MAX_DEPTH = 6;
const MAX_DIRS = 4000;
const CACHE_MS = 4000;

/** report id -> absolute folder. Filled as worktrees are searched; ids are stable across searches. */
const served = new Map();
/** norm(worktree) -> { at, reports } */
const cache = new Map();

/** Reports in a worktree, newest run first: { id, name, at }. `name` is the folder, relative to the worktree. */
export async function findReports(root) {
  const key = norm(root);
  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_MS) return c.reports;

  const found = [];
  let budget = MAX_DIRS;
  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || budget-- <= 0) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.playwright')) continue;
      const full = join(dir, e.name);
      // playwright-report/ by default; Nx's TS-solution layout uses test-output/playwright/report.
      if (/report/i.test(e.name)) {
        const at = await reportTime(full);
        if (at) {
          found.push({ id: idFor(full), name: relative(root, full).replace(/\\/g, '/'), at });
          served.set(idFor(full), full);
          continue;
        }
      }
      await walk(full, depth + 1);
    }
  }
  await walk(root, 0);
  found.sort((a, b) => b.at - a.at);
  cache.set(key, { at: Date.now(), reports: found });
  return found;
}

const idFor = (dir) => createHash('sha1').update(norm(dir)).digest('hex').slice(0, 16);

/** When the report in `dir` was written, if `dir` holds a Playwright HTML report. */
async function reportTime(dir) {
  const file = join(dir, 'index.html');
  let fh;
  try {
    fh = await open(file);
    const { buffer, bytesRead } = await fh.read({ buffer: Buffer.alloc(1024), position: 0 });
    if (!buffer.subarray(0, bytesRead).toString('utf8').includes('<title>Playwright Test Report</title>')) return null;
    return (await fh.stat()).mtimeMs;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.webm': 'video/webm', '.mp4': 'video/mp4', '.zip': 'application/zip',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.log': 'text/plain; charset=utf-8',
};

/**
 * GET /report/<id>/<file>: a file from a report found by findReports. Only files inside that report's
 * folder are served. Returns false when the URL isn't a report URL.
 */
export async function serveReport(req, res) {
  const m = /^\/report\/([0-9a-f]{16})(\/[^?#]*)?/.exec(req.url);
  if (!m) return false;
  const dir = served.get(m[1]);
  if (!dir) return (res.writeHead(404).end('Report not found; reopen it from ccdb'), true);
  if (!m[2]) return (res.writeHead(302, { location: `/report/${m[1]}/` }).end(), true);
  let rel;
  try { rel = decodeURIComponent(m[2]); } catch { return (res.writeHead(400).end(), true); }
  let file = resolve(dir, '.' + rel);
  if (file !== dir && !file.startsWith(dir + sep)) return (res.writeHead(403).end(), true);
  try {
    let s = await stat(file);
    if (s.isDirectory()) s = await stat((file = join(file, 'index.html')));
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': s.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return (res.end(), true);
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
  return true;
}
