// Git detail worker: serves the panel's Git tab. The main thread has already validated the
// worktree and passes it in (with its trunk), so this never waits on the scanner.
import { parentPort } from 'node:worker_threads';
import { gitDetail } from './gitdetail.mjs';
import { createProject, projectCandidates } from './projects.mjs';
import { composeCommit } from './compose.mjs';
import { autoRebase } from './rebase.mjs';
import { createWorktree, worktreeBases } from './worktrees.mjs';

const ops = { ...gitDetail(async (wt) => wt), createProject, projectCandidates, composeCommit, autoRebase, createWorktree, worktreeBases };

parentPort.on('message', async ({ id, op, arg }) => {
  try {
    parentPort.postMessage({ id, result: await ops[op](arg) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
