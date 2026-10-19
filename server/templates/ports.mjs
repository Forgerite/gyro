// Where this project's services listen. Never hardcode a port: add the service to OFFSETS and FALLBACK
// and get it from here. Ports come from, in order:
//   1. CCDB_PORT_BASE: the block Gyro (ccdb) leases this worktree, set for everything it starts here;
//   2. a running Gyro, asked for this worktree's block (a terminal you opened yourself);
//   3. FALLBACK: fixed ports, for CI and machines without Gyro.
// Each service keeps a fixed offset in the block: 0 is the main app (the dev server, what Gyro's preview
// shows), 1–49 other dev services, 50–99 test and e2e services.
//
//   import { ports } from './ports.mjs';   const { web } = await ports();
//   node ports.mjs          prints this worktree's ports as JSON
//   node ports.mjs --env    prints them as NAME_PORT=1234 lines, for .env files and docker compose
import { fileURLToPath } from 'node:url';

export const OFFSETS = { web: 0 };
const FALLBACK = { web: 3000 };

const GYRO = process.env.CCDB_URL ?? 'http://127.0.0.1:4317';
const ROOT = fileURLToPath(new URL('.', import.meta.url));

async function block() {
  if (process.env.CCDB_PORT_BASE) return { base: Number(process.env.CCDB_PORT_BASE), from: 'env' };
  try {
    const res = await fetch(`${GYRO}/api/ports?path=${encodeURIComponent(ROOT)}`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return { base: (await res.json()).base, from: 'gyro' };
  } catch { /* Gyro isn't running */ }
  return null;
}

/** { web: 20000, ..., from: 'env' | 'gyro' | 'fallback' } */
export async function ports() {
  const b = await block();
  const out = Object.fromEntries(Object.keys(OFFSETS).map((k) => [k, b ? b.base + OFFSETS[k] : FALLBACK[k]]));
  return { ...out, from: b?.from ?? 'fallback' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { from, ...p } = await ports();
  if (process.argv.includes('--env')) {
    for (const [k, v] of Object.entries(p)) console.log(`${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_PORT=${v}`);
  } else {
    console.log(JSON.stringify({ ...p, from }, null, 2));
  }
}
