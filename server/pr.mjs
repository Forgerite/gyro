// Smart feature: "Create PR". Gyro pushes the branch, then headless claude reads its commits, writes
// the title and description (linking the project issue it addresses, when there is one) and runs
// `gh pr create`. Gyro then asks GitHub whether the PR exists.
import { prForBranch } from './github.mjs';
import { git, runClaude, tryGit, whyFailed, withLock } from './smart.mjs';

const TIMEOUT_MS = 6 * 60_000;

/** Look at the repo and its issues, and create the PR; nothing that edits, pushes or merges. */
const ALLOWED = [
  'Read', 'Glob', 'Grep',
  'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)',
  'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh pr view:*)', 'Bash(gh pr create:*)',
];
const ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' };
/** Board issues listed in the prompt, at most. */
const MAX_ISSUES = 60;

function prompt({ repo, branch, base, remoteBase, project, issues }) {
  const issueLines = issues.map((i) => `- #${i.number} ${i.title}${i.status ? ` [${i.status}]` : ''}`);
  return [
    `Open a GitHub pull request in ${repo} from branch \`${branch}\` into \`${base}\`. The branch is already pushed.`,
    '',
    `1. See what the branch changes: \`git log ${remoteBase}..HEAD\` and \`git diff ${remoteBase}...HEAD\`.`,
    '2. Write a title and description following this repository\'s conventions: any pull request template',
    '   (such as .github/pull_request_template.md) and any PR instructions you have, such as in CLAUDE.md.',
    '   Describe what changed and why; keep it concise.',
    '3. Link the issue this work addresses, when there is one. If the branch implements a GitHub issue, put',
    '   `Closes #N` in the description so GitHub links the PR to that issue (and to its project board entry).',
    '   Judge by the branch name, the commit messages and the issue itself (`gh issue view N`). Only link an issue',
    '   the branch clearly addresses; if none fits, link nothing. Never invent issue numbers.',
    ...(project
      ? [
        `   Work here is tracked on the GitHub Project "${project}".`,
        ...(issueLines.length ? ['   Its open issues in this repository:', ...issueLines.map((l) => `   ${l}`)] : []),
      ]
      : []),
    `4. Create it: \`gh pr create --repo ${repo} --base ${base} --head ${branch} --title "<title>" --body-file -\``,
    '   with the description on stdin (a quoted heredoc works). Do not make it a draft.',
    '',
    'Rules: do not edit files, commit, push, or merge anything. Create exactly one pull request.',
    '',
    'When done, reply with only the pull request URL.',
  ].join('\n');
}

/**
 * Create a PR for `path`'s branch. `push(path)` publishes the branch first (Gyro's own push).
 * Resolves with the new PR, or throws with why there isn't one.
 */
export function createPr({ path, repo, base, project, issues = [] }, push) {
  return withLock(path, 'a PR', async () => {
    const branch = await tryGit(path, 'symbolic-ref', '--short', '-q', 'HEAD');
    if (!branch) throw new Error('HEAD is detached; check out a branch first');
    if (!base) throw new Error('No base branch found for this repository');
    if (branch === base) throw new Error(`${branch} is the base branch itself`);
    const existing = await prForBranch(repo, branch);
    if (existing) throw new Error(`PR #${existing.number} is already open for ${branch}`);

    // GitHub can only open a PR for commits it has.
    const pushNote = (await push(path)).note ?? null;
    const remote = (await tryGit(path, 'config', `branch.${branch}.remote`)) || 'origin';
    const remoteBase = (await tryGit(path, 'rev-parse', '-q', '--verify', `${remote}/${base}`)) ? `${remote}/${base}` : base;
    const ahead = Number(await tryGit(path, 'rev-list', '--count', `${remoteBase}..HEAD`)) || 0;
    if (!ahead) throw new Error(`${branch} has no commits that ${base} doesn't already have`);
    const dirty = (await git(path, 'status', '--porcelain')).split(/\r?\n/).filter(Boolean).length;

    const run = await runClaude(path, prompt({ repo, branch, base, remoteBase, project, issues: issues.slice(0, MAX_ISSUES) }), {
      tools: ['Bash', 'Read', 'Glob', 'Grep'],
      allowed: ALLOWED,
      timeoutMs: TIMEOUT_MS,
      env: ENV,
    });

    // Judge by GitHub, not by what claude says.
    const pr = await prForBranch(repo, branch);
    if (!pr) throw new Error(run.timedOut ? 'Claude took too long; no PR was created' : `Claude didn't create a PR: ${whyFailed(run)}`);
    return {
      pr,
      pushNote,
      warning: dirty ? `${dirty} uncommitted file${dirty === 1 ? ' was' : 's were'} left out of the PR` : null,
      costUsd: run.result?.total_cost_usd ?? null,
      ms: run.result?.duration_ms ?? null,
    };
  });
}
