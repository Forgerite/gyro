// ccdb's own small persistent state (closed projects, GitHub links, dev commands, port leases), in ~/.claude/ccdb/state.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const FILE = join(homedir(), '.claude', 'ccdb', 'state.json');
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

let state = load();

function load() {
  try {
    const s = JSON.parse(readFileSync(FILE, 'utf8'));
    return {
      closedProjects: Array.isArray(s.closedProjects) ? s.closedProjects : [],
      github: s.github && typeof s.github === 'object' ? s.github : {},
      dev: s.dev && typeof s.dev === 'object' ? s.dev : {},
      ports: s.ports && typeof s.ports === 'object' ? s.ports : {},
    };
  } catch {
    return { closedProjects: [], github: {}, dev: {}, ports: {} };
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

/** The project's dev command as set in ccdb: a command, '' for none, or undefined to detect it. */
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
