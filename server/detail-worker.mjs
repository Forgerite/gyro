// Git detail worker: serves the panel's Git tab. The main thread has already validated the
// worktree and passes it in (with its trunk), so this never waits on the scanner.
import { parentPort } from 'node:worker_threads';
import { gitDetail } from './gitdetail.mjs';
import { createProject, projectCandidates } from './projects.mjs';
import { composeCommit } from './compose.mjs';
import { autoRebase } from './rebase.mjs';
import { createPr } from './pr.mjs';
import { createWorktree, worktreeBases } from './worktrees.mjs';

const detail = gitDetail(async (wt) => wt);
/** Create PR pushes with the Git tab's own push first. */
const pushBranch = (path) => detail.gitAction({ path: { path, git: {} }, action: 'push' });

const ops = {
  ...detail, createProject, projectCandidates, composeCommit, autoRebase, createWorktree, worktreeBases,
  createPr: (arg) => createPr(arg, pushBranch),
};

parentPort.on('message', async ({ id, op, arg }) => {
  try {
    parentPort.postMessage({ id, result: await ops[op](arg) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
