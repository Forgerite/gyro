// `npm run serve`: the built dashboard (web/dist), served by the API itself on the dashboard's port,
// instead of a ~1 GB `ng serve` that watches and rebuilds files nobody is editing.
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** True for a request that came in on the dashboard's port (see listenDashboard). */
export const viaDashboard = (req) => req.socket.gyroDashboard === true;

/**
 * Accept connections on `port` and hand them to `server`, so the API (with its WebSockets) answers on
 * both ports. Sockets are marked so the handler can serve the dashboard on this port only.
 */
export function listenDashboard(server, port) {
  const front = createServer((socket) => {
    socket.gyroDashboard = true;
    server.emit('connection', socket);
  });
  front.listen(port, '127.0.0.1', () => console.log(`Gyro dashboard on http://localhost:${port}`));
  return front;
}

/** A GET for a file in `root`; anything that isn't a file gets index.html (the app routes itself). */
export async function serveStatic(root, req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = normalize(join(root, path));
  const inside = file.startsWith(root.endsWith(sep) ? root : root + sep);
  let body = null;
  if (inside && extname(file)) body = await readFile(file).catch(() => null);
  if (body) {
    // Built files are content-hashed; index.html and the rest of public/ are not.
    const hashed = /-[A-Z0-9]{8}\.(js|css)$/.test(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  const index = await readFile(join(root, 'index.html')).catch(() => null);
  if (!index) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    return res.end('The dashboard is not built: run npm run serve, which builds it first.');
  }
  res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : index);
}
