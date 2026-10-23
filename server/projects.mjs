// New projects: start a repo from scratch, or turn an existing folder in the code root into one.
// Runs in the detail worker (spawning git blocks the event loop on Windows).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const exec = promisify(execFile);

/** Folder names we'll create or convert: plain names only, nothing hidden and no worktree homes. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const isWorktreeHome = (name) => /[.-]worktrees$/i.test(name);

/** A new project's Gyro starting point: the ports module and the CLAUDE.md that tells sessions to use it. */
const TEMPLATES = join(import.meta.dirname, 'templates');
async function gyroFiles(path, name) {
  await writeFile(join(path, 'ports.mjs'), await readFile(join(TEMPLATES, 'ports.mjs'), 'utf8'));
  await writeFile(join(path, 'CLAUDE.md'), (await readFile(join(TEMPLATES, 'CLAUDE.md'), 'utf8')).replace('{{name}}', name));
}

/** Starter .gitignore: keeps dependency, build and secret files out of the first commit. */
export const DEFAULT_GITIGNORE = `# Dependencies
node_modules/

# Build output
dist/
build/
out/
coverage/
.angular/
.next/

# Secrets and local settings
.env
.env.*
!.env.example

# Logs and OS files
*.log
.DS_Store
Thumbs.db
`;

async function git(cwd, ...args) {
  try {
    return (await exec('git', args, { cwd, windowsHide: true })).stdout;
  } catch (e) {
    throw new Error((e.stderr || e.message || '').trim().split('\n').slice(-2).join('\n'));
  }
}

function checkName(name) {
  if (!NAME.test(name ?? '') || name.endsWith('.') || isWorktreeHome(name)) {
    throw new Error('Use letters, numbers, dot, dash or underscore (starting with a letter or number)');
  }
}

/** Folders directly in the code root that aren't git repos yet, most recently changed first. */
export async function projectCandidates(codeRoot) {
  const entries = await readdir(codeRoot, { withFileTypes: true });
  const out = await Promise.all(entries
    .filter((e) => e.isDirectory() && NAME.test(e.name) && !isWorktreeHome(e.name))
    .map(async (e) => {
      const path = join(codeRoot, e.name);
      if (existsSync(join(path, '.git'))) return null;
      const [st, kids] = await Promise.all([stat(path), readdir(path).catch(() => [])]);
      return {
        name: e.name,
        path,
        modifiedAt: st.mtimeMs,
        entries: kids.length,
        gitignore: kids.includes('.gitignore'),
        nodeModules: kids.includes('node_modules'),
      };
    }));
  return out.filter(Boolean).sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Throws if `name` can't become a project in `mode`; run before anything is created (on GitHub too). */
export async function checkProject({ codeRoot, mode, name }) {
  checkName(name);
  const path = join(codeRoot, name);
  if (mode === 'scratch') {
    if (existsSync(path)) throw new Error(`${name} already exists in the code folder`);
  } else if (mode === 'directory') {
    const st = await stat(path).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`${name} isn't a folder in the code folder`);
    if (existsSync(join(path, '.git'))) throw new Error(`${name} is already a git repository`);
  } else {
    throw new Error('unknown mode');
  }
  return { path };
}

/**
 * scratch: new folder, git init, optional .gitignore, and an initial commit so the branch exists.
 * directory: git init in an existing folder (plus .gitignore if asked); its files stay uncommitted
 * so they can be reviewed and committed from the Git tab.
 * gyro (scratch only): start it as a Gyro project, with ports.mjs and CLAUDE.md in the first commit.
 * remote: a new, empty GitHub repo's URL, added as origin. main is pushed to it straight away when it
 * has a commit, so it becomes the repo's default branch before any session branch can get there.
 */
export async function createProject({ codeRoot, mode, name, gitignore, gyro, remote }) {
  const { path } = await checkProject({ codeRoot, mode, name });
  const notes = [];

  if (mode === 'scratch') await mkdir(path);

  await git(path, 'init', '-q', '-b', 'main');
  const ignoreFile = join(path, '.gitignore');
  if (gitignore && !existsSync(ignoreFile)) {
    await writeFile(ignoreFile, DEFAULT_GITIGNORE);
    notes.push('Added a starter .gitignore');
  }
  if (mode === 'scratch' && gyro) {
    await gyroFiles(path, name);
    notes.push('Added ports.mjs and CLAUDE.md (Gyro project)');
  }
  if (mode === 'scratch') {
    try {
      await git(path, 'add', '-A');
      await git(path, 'commit', '-q', '--allow-empty', '-m', 'Initial commit');
    } catch (e) {
      notes.push(`Created, but the initial commit failed: ${e.message}`);
    }
  }
  if (remote) notes.push(...(await connectRemote(path, remote)));
  return { path, notes };
}

/** Add `url` as origin and push main to it if main has a commit (a converted folder's doesn't yet). */
async function connectRemote(path, url) {
  try {
    await git(path, 'remote', 'add', 'origin', url);
  } catch (e) {
    return [`Couldn't add the GitHub repo as origin: ${e.message}`];
  }
  const born = await git(path, 'rev-parse', '--verify', '-q', 'refs/heads/main').then(() => true, () => false);
  if (!born) return ['Added the GitHub repo as origin; main is pushed before the first session once it has a commit'];
  try {
    await exec('git', ['push', '-q', '--set-upstream', 'origin', 'refs/heads/main:refs/heads/main'], {
      cwd: path, windowsHide: true, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return ['Pushed main to the new GitHub repo'];
  } catch (e) {
    const why = (e.stderr || e.message || '').trim().split('\n').pop();
    return [`Added the GitHub repo as origin, but pushing main failed (${why}); it's pushed before the first session`];
  }
}
