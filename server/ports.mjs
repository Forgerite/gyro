// Port leases: every worktree ccdb runs things in gets its own block of ports, unique on this machine,
// so dev servers and test stacks of different projects and worktrees never collide. The block goes to
// the worktree's processes as environment variables; repos map their services into it.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getPorts, setPorts } from './state.mjs';

/** Blocks start here and stay below the dynamic (ephemeral) range Windows hands out from 49152. */
export const PORT_FIRST = 20000;
export const PORT_COUNT = 100;
export const MAX_SLOTS = 250; // 20000–44999

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Ports Windows won't let anyone bind (Hyper-V and WSL reserve ranges, sometimes new ones after a reboot). */
let excluded = [];
export function loadExcludedPorts() {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((done) => {
    execFile('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], { windowsHide: true }, (err, out) => {
      if (!err) excluded = [...out.matchAll(/^\s*(\d+)\s+(\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]);
      done();
    });
  });
}

export const blockFor = (slot) => ({ slot, base: PORT_FIRST + slot * PORT_COUNT, count: PORT_COUNT });
const usable = (slot) => {
  const { base } = blockFor(slot);
  return !excluded.some(([a, b]) => a < base + PORT_COUNT && b >= base);
};

/** Leases whose folder is gone (worktree removed outside ccdb) go back to the pool. */
function prune(leases) {
  const kept = Object.fromEntries(Object.entries(leases).filter(([path]) => existsSync(path)));
  if (Object.keys(kept).length !== Object.keys(leases).length) setPorts(kept);
  return kept;
}

/** The worktree's block, leasing the lowest free one the first time. */
export function leasePorts(path) {
  const key = norm(path);
  const leases = prune(getPorts());
  if (leases[key] !== undefined) return blockFor(leases[key]);
  const taken = new Set(Object.values(leases));
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    if (taken.has(slot) || !usable(slot)) continue;
    setPorts({ ...leases, [key]: slot });
    return blockFor(slot);
  }
  throw Object.assign(new Error('Every port block is leased; remove some worktrees'), { status: 503 });
}

/** The worktree's block if it has one (no leasing). */
export function portsOf(path) {
  const slot = getPorts()[norm(path)];
  return slot === undefined ? null : blockFor(slot);
}

export function releasePorts(path) {
  const { [norm(path)]: _, ...rest } = getPorts();
  setPorts(rest);
}

/** What a worktree's processes see. PORT (the first port) only for the dev server: claude's shell would pass it to everything. */
export function portEnv(path, { dev = false } = {}) {
  const { slot, base, count } = leasePorts(path);
  return {
    CCDB_PORT_SLOT: String(slot),
    CCDB_PORT_BASE: String(base),
    CCDB_PORT_COUNT: String(count),
    ...(dev ? { PORT: String(base) } : {}),
  };
}
