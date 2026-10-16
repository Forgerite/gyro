// Per-worktree ports. Every service ccdb starts locally gets its port from here, so
// several worktrees can run their own ccdb side by side.
//
// Ports come from, in order:
//   1. CCDB_PORT_BASE in the environment (Gyro sets it for everything it starts);
//   2. a running Gyro: GET http://127.0.0.1:4317/api/ports?path=<git toplevel>;
//   3. the historic fixed ports (4200 web, 4317 api), so machines without Gyro are unchanged.
// Each service sits at a fixed offset inside the leased block (0 = what the dev command serves).
//
// CLI: `node scripts/worktree-ports.mjs` prints JSON; `--env` prints KEY=value lines.

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Offsets inside the leased block. 1–49 dev services, 50–99 test/e2e. */
export const OFFSETS = { web: 0, api: 1 };
/** Ports used when there is no lease. */
export const FALLBACK = { web: 4200, api: 4317 };

const GYRO_URL = 'http://127.0.0.1:4317';

function fromBase(base) {
  return Object.fromEntries(Object.entries(OFFSETS).map(([k, off]) => [k, base + off]));
}

function toplevel() {
  try {
    const cwd = dirname(fileURLToPath(import.meta.url));
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function leaseFromGyro() {
  const top = toplevel();
  if (!top) return null;
  try {
    const res = await fetch(`${GYRO_URL}/api/ports?path=${encodeURIComponent(top)}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const { base } = await res.json();
    return Number.isInteger(base) ? base : null;
  } catch {
    return null;
  }
}

/** Resolve every service's port: { web, api }. */
export async function resolvePorts(env = process.env) {
  const envBase = Number(env.CCDB_PORT_BASE);
  if (Number.isInteger(envBase) && envBase > 0) return fromBase(envBase);
  const base = await leaseFromGyro();
  return base == null ? { ...FALLBACK } : fromBase(base);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ports = await resolvePorts();
  if (process.argv.includes('--env')) {
    for (const [k, v] of Object.entries(ports)) console.log(`CCDB_${k.toUpperCase()}_PORT=${v}`);
  } else {
    console.log(JSON.stringify(ports));
  }
}
