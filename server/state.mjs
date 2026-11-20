// Gyro's own small persistent state (closed projects, GitHub links, Nox Lumos servers and links, dev commands, base branches, port leases), in ~/.claude/gyro/state.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './data-dir.mjs';
import { dirname, join } from 'node:path';

const FILE = join(DATA_DIR, 'state.json');
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

let state = load();

function load() {
  try {
    const s = JSON.parse(readFileSync(FILE, 'utf8'));
    return {
      closedProjects: Array.isArray(s.closedProjects) ? s.closedProjects : [],
      github: s.github && typeof s.github === 'object' ? s.github : {},
      dev: s.dev && typeof s.dev === 'object' ? s.dev : {},
      base: s.base && typeof s.base === 'object' ? s.base : {},
      ports: s.ports && typeof s.ports === 'object' ? s.ports : {},
      noxServers: s.noxServers && typeof s.noxServers === 'object' ? s.noxServers : {},
      noxLinks: s.noxLinks && typeof s.noxLinks === 'object' ? s.noxLinks : {},
    };
  } catch {
    return { closedProjects: [], github: {}, dev: {}, base: {}, ports: {}, noxServers: {}, noxLinks: {} };
  }
}

/** Write via a temp file so a crash mid-write can't leave half a JSON file behind. */
function save() {
  if (!existsSync(dirname(FILE))) mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${FILE}.tmp`, FILE);
}

export function isClosed(path) {
  const key = norm(path);
  return state.closedProjects.some((p) => norm(p) === key);
}

export function setClosed(path, closed) {
  const key = norm(path);
  const rest = state.closedProjects.filter((p) => norm(p) !== key);
  state = { ...state, closedProjects: closed ? [...rest, path] : rest };
  save();
}

/** The project's GitHub link ({ repo, url, project, ... }), or null. Keyed by normalized repo path. */
export function getGithub(path) {
  return state.github[norm(path)] ?? null;
}

/** Link a project to GitHub, or unlink it with null. */
export function setGithub(path, link) {
  const { [norm(path)]: _, ...rest } = state.github;
  state = { ...state, github: link ? { ...rest, [norm(path)]: link } : rest };
  save();
}

/** The project's dev command as set in Gyro: a command, '' for none, or undefined to detect it. */
export function getDev(path) {
  return state.dev[norm(path)];
}

/** Port block leases: { normalized worktree path: slot }. */
export function getPorts() {
  return state.ports;
}

export function setPorts(ports) {
  state = { ...state, ports };
  save();
}

/** Set the project's dev command ('' turns it off), or go back to detecting it with null. */
export function setDev(path, command) {
  const { [norm(path)]: _, ...rest } = state.dev;
  state = { ...state, dev: command === null ? rest : { ...rest, [norm(path)]: command } };
  save();
}

/** All set base branches: { normalized repo path: ref }. */
export function allBases() {
  return state.base;
}

/** The project's base branch as set in Gyro (a ref like origin/develop), or undefined to detect the trunk. */
export function getBase(path) {
  return state.base[norm(path)];
}

/** Set the project's base branch, or go back to detecting the trunk with null. */
export function setBase(path, ref) {
  const { [norm(path)]: _, ...rest } = state.base;
  state = { ...state, base: ref === null ? rest : { ...rest, [norm(path)]: ref } };
  save();
}

/** Nox Lumos servers: { id: { id, name, url, key, addedAt } }. The key never leaves this machine's API process. */
export function allNoxServers() {
  return state.noxServers;
}

export function getNoxServer(id) {
  return state.noxServers[id] ?? null;
}

/** Add or replace a server, or remove it (and every project's link to it) with null. */
export function setNoxServer(id, server) {
  const { [id]: _, ...rest } = state.noxServers;
  const noxLinks = server ? state.noxLinks : Object.fromEntries(Object.entries(state.noxLinks).filter(([, l]) => l.server !== id));
  state = { ...state, noxServers: server ? { ...rest, [id]: server } : rest, noxLinks };
  save();
}

/**
 * All project links: { normalized repo path: { server, name, repo?, auto? } } (name: the project's, for the servers
 * list; auto: made by matching repos), or { off: true, name } for a project unlinked by hand.
 */
export function allNoxLinks() {
  return state.noxLinks;
}

/** The project's Nox Lumos link: { server: id, name, repo? } (repo overrides the linked GitHub repo), or null. */
export function getNoxLink(path) {
  return state.noxLinks[norm(path)] ?? null;
}

/** Link a project to a Nox Lumos server, or unlink it with null. */
export function setNoxLink(path, link) {
  const { [norm(path)]: _, ...rest } = state.noxLinks;
  state = { ...state, noxLinks: link ? { ...rest, [norm(path)]: link } : rest };
  save();
}
