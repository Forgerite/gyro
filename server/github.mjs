// A project's GitHub side: the repo it lives in and the GitHub Project (board) it's tracked on.
// Everything goes through the gh CLI, so it uses whoever `gh auth login` signed in.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ENV = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' };
/** owner/name, as GitHub allows them. */
export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

async function gh(args, timeout = 30_000) {
  try {
    const { stdout } = await exec('gh', args, { env: ENV, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('The GitHub CLI (gh) is not installed or not on PATH');
    const msg = (e.stderr || e.message || '').trim();
    if (/gh auth login|not logged in/i.test(msg)) throw new Error('gh is not signed in; run `gh auth login`');
    if (/missing required scopes?.*project|INSUFFICIENT_SCOPES/i.test(msg)) {
      throw new Error('gh needs the project scope; run `gh auth refresh -s project`');
    }
    throw new Error(msg.split(/\r?\n/).filter(Boolean).pop() || 'gh failed');
  }
}
const ghJson = async (args) => JSON.parse(await gh(args));

/** "owner/name" from a github.com remote URL (ssh, scp-style or https), or null. */
export function repoFromUrl(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** GitHub repos among `path`'s remotes, e.g. [{ remote: 'origin', repo: 'me/app' }]. */
export async function remoteRepos(path) {
  const { stdout } = await exec('git', ['remote', '-v'], { cwd: path, windowsHide: true }).catch(() => ({ stdout: '' }));
  const seen = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const [remote, url] = line.split(/\s+/);
    const repo = url && repoFromUrl(url);
    if (repo && !seen.has(repo.toLowerCase())) seen.set(repo.toLowerCase(), { remote, repo });
  }
  return [...seen.values()];
}

const project = (p) => ({ owner: p.owner?.login ?? null, number: p.number, title: p.title, url: p.url, closed: !!p.closed });

/** The repo as GitHub has it (throws if it doesn't exist or isn't visible to this gh login). */
export async function repoInfo(repo) {
  const r = await ghJson(['repo', 'view', repo, '--json', 'nameWithOwner,url,description,isPrivate,defaultBranchRef,owner']);
  return {
    repo: r.nameWithOwner,
    url: r.url,
    description: r.description || null,
    private: r.isPrivate,
    defaultBranch: r.defaultBranchRef?.name ?? null,
    owner: r.owner?.login ?? r.nameWithOwner.split('/')[0],
  };
}

/** Projects linked to the repo, then the repo owner's and your own: what the picker offers. */
async function projectChoices(repo, owner) {
  const name = repo.split('/')[1];
  const query = 'query($o:String!,$n:String!){repository(owner:$o,name:$n){projectsV2(first:50){nodes{number title url closed owner{... on Organization{login} ... on User{login}}}}}}';
  const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: e.message }));
  const [linked, owned, mine] = await Promise.all([
    settle(ghJson(['api', 'graphql', '-f', `query=${query}`, '-f', `o=${owner}`, '-f', `n=${name}`])
      .then((d) => d.data.repository.projectsV2.nodes.map(project))),
    settle(ghJson(['project', 'list', '--owner', owner, '--format', 'json', '--limit', '100']).then((d) => d.projects.map(project))),
    settle(ghJson(['project', 'list', '--owner', '@me', '--format', 'json', '--limit', '100']).then((d) => d.projects.map(project))),
  ]);
  const seen = new Set();
  const take = (list) => (list ?? []).filter((p) => !p.closed && !seen.has(p.url) && seen.add(p.url));
  return {
    linked: take(linked.ok),
    owner: take(owned.ok),
    mine: take(mine.ok),
    // A scope or permission problem shows up here, rather than as an empty list with no explanation.
    error: linked.err ?? owned.err ?? null,
  };
}

/**
 * What the "Link to GitHub" form offers for a project: its GitHub remotes, the chosen repo
 * (`repo`, else the current link, else the first remote) and the Projects it could be put on.
 */
export async function githubOptions(path, { repo, current }) {
  const remotes = await remoteRepos(path);
  const pick = repo || current?.repo || remotes[0]?.repo || null;
  if (!pick) return { remotes, repo: null, projects: null };
  if (!REPO.test(pick)) throw new Error('Use the form owner/name');
  const info = await repoInfo(pick);
  return { remotes, repo: info, projects: await projectChoices(info.repo, info.owner) };
}

/** Check a link before it's saved: the repo exists, and so does the project, if one was picked. */
export async function resolveLink({ repo, project: p }) {
  if (!REPO.test(repo ?? '')) throw new Error('Use the form owner/name');
  const info = await repoInfo(repo);
  let board = null;
  if (p) {
    const number = Number(p.number);
    if (!Number.isInteger(number) || number < 1 || typeof p.owner !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(p.owner)) {
      throw new Error('Bad project');
    }
    board = project(await ghJson(['project', 'view', String(number), '--owner', p.owner, '--format', 'json']));
    board.owner ??= p.owner;
  }
  return {
    repo: info.repo,
    url: info.url,
    defaultBranch: info.defaultBranch,
    private: info.private,
    project: board && { owner: board.owner, number: board.number, title: board.title, url: board.url },
    linkedAt: Date.now(),
  };
}

// ---------- pull requests ----------

const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const RUNNING = new Set(['PENDING', 'EXPECTED', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED']);

const rollupStates = (rollup) =>
  (rollup ?? []).map((c) => (c.__typename === 'StatusContext' ? c.state : c.status === 'COMPLETED' ? c.conclusion : 'PENDING'));

/** One word for a PR's checks: fail beats pending beats pass; null when it has none. */
function checks(rollup) {
  const states = rollupStates(rollup);
  if (!states.length) return null;
  if (states.some((s) => FAILED.has(s))) return 'fail';
  if (states.some((s) => RUNNING.has(s))) return 'pending';
  return 'pass';
}

/** Whether any check is still running, whatever the others concluded. */
const checksRunning = (rollup) => rollupStates(rollup).some((s) => RUNNING.has(s));

/** The repo's open PRs from its own branches (forks can't be a local worktree's branch). */
export async function openPulls(repo) {
  const fields = 'number,title,url,headRefName,baseRefName,isDraft,reviewDecision,isCrossRepository,author,updatedAt,statusCheckRollup,closingIssuesReferences';
  const list = await ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', fields]);
  return list
    .filter((p) => !p.isCrossRepository)
    .map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      branch: p.headRefName,
      base: p.baseRefName,
      draft: p.isDraft,
      review: p.reviewDecision || null,
      checks: checks(p.statusCheckRollup),
      checksRunning: checksRunning(p.statusCheckRollup),
      author: p.author?.login ?? null,
      updatedAt: Date.parse(p.updatedAt) || null,
      closes: (p.closingIssuesReferences ?? []).map((i) => i.number),
    }));
}

/** The open PR from `branch` in `repo` (asked fresh, not from the cache), or null. */
export async function prForBranch(repo, branch) {
  const list = await ghJson(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number,title,url,isCrossRepository,closingIssuesReferences']);
  const p = list.find((x) => !x.isCrossRepository);
  return p ? { number: p.number, title: p.title, url: p.url, closes: (p.closingIssuesReferences ?? []).map((i) => i.number) } : null;
}

const PR_QUERY = `query($o:String!,$n:String!,$num:Int!){ repository(owner:$o,name:$n){ pullRequest(number:$num){
  number title url state isDraft merged mergedAt createdAt updatedAt bodyHTML
  author{login} headRefName baseRefName additions deletions changedFiles
  mergeable mergeStateStatus reviewDecision
  labels(first:10){nodes{name}} assignees(first:10){nodes{login}}
  reviewRequests(first:10){nodes{requestedReviewer{ ... on User{login} ... on Team{name} ... on Bot{login} ... on Mannequin{login} }}}
  latestOpinionatedReviews(first:20){nodes{author{login} state submittedAt}}
  closingIssuesReferences(first:10){nodes{number title url}}
  commits(last:1){ totalCount nodes{ commit{ oid abbreviatedOid statusCheckRollup{ contexts(first:100){ nodes{ __typename
    ... on CheckRun{ name status conclusion detailsUrl startedAt completedAt checkSuite{ workflowRun{ workflow{ name } } } }
    ... on StatusContext{ context state targetUrl description }
  } } } } } }
  comments(last:30){ totalCount nodes{ id author{login} createdAt bodyHTML url } }
  reviews(last:30){ nodes{ id author{login} state submittedAt bodyHTML url } }
} } }`;

/** One CI check: pass, fail, running or skipped, with where to read its log. */
function prCheck(c) {
  if (c.__typename === 'StatusContext') {
    const result = FAILED.has(c.state) ? 'fail' : RUNNING.has(c.state) ? 'running' : 'pass';
    return {
      name: c.context, workflow: null, result, conclusion: c.state, url: c.targetUrl ?? null,
      // A status only says when it was last set, not how long it ran: no duration.
      description: c.description || null, startedAt: null, completedAt: null,
    };
  }
  const done = c.status === 'COMPLETED';
  const result = !done ? 'running' : FAILED.has(c.conclusion) ? 'fail' : ['SKIPPED', 'NEUTRAL', 'STALE'].includes(c.conclusion) ? 'skipped' : 'pass';
  return {
    name: c.name, workflow: c.checkSuite?.workflowRun?.workflow?.name ?? null, result, conclusion: done ? c.conclusion : c.status,
    url: c.detailsUrl ?? null, description: null, startedAt: Date.parse(c.startedAt) || null, completedAt: Date.parse(c.completedAt) || null,
  };
}

/** Failures first, then what's still running: what you look at a PR's checks for. */
const CHECK_ORDER = { fail: 0, running: 1, pass: 2, skipped: 3 };

/** PR `number` of `repo` in full: description, reviews, conversation and every CI check on its head commit. */
export async function prDetail(repo, number) {
  if (!REPO.test(repo ?? '')) throw new Error('Bad repo');
  const [o, n] = repo.split('/');
  const p = (await ghJson(['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `o=${o}`, '-f', `n=${n}`, '-F', `num=${number}`]))
    .data?.repository?.pullRequest;
  if (!p) throw new Error(`PR #${number} wasn't found in ${repo}`);
  const head = p.commits.nodes[0]?.commit;
  const checks = (head?.statusCheckRollup?.contexts.nodes ?? []).map(prCheck)
    .sort((a, b) => CHECK_ORDER[a.result] - CHECK_ORDER[b.result] || a.name.localeCompare(b.name));
  const conversation = [
    ...p.comments.nodes.map((c) => ({
      id: c.id, kind: 'comment', author: c.author?.login ?? 'ghost', at: Date.parse(c.createdAt) || null, state: null, bodyHTML: tasks(c.bodyHTML), url: c.url,
    })),
    // Reviews that say something; bare approvals already show under Reviews.
    ...p.reviews.nodes.filter((r) => r.bodyHTML?.trim()).map((r) => ({
      id: r.id, kind: 'review', author: r.author?.login ?? 'ghost', at: Date.parse(r.submittedAt) || null, state: r.state, bodyHTML: tasks(r.bodyHTML), url: r.url,
    })),
  ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    state: p.merged ? 'MERGED' : p.state,
    draft: p.isDraft,
    author: p.author?.login ?? null,
    createdAt: Date.parse(p.createdAt) || null,
    updatedAt: Date.parse(p.updatedAt) || null,
    mergedAt: Date.parse(p.mergedAt) || null,
    branch: p.headRefName,
    base: p.baseRefName,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changedFiles,
    commits: p.commits.totalCount,
    head: head?.abbreviatedOid ?? null,
    /** The head commit's full SHA: a merge is pinned to it. */
    headSha: head?.oid ?? null,
    /** MERGEABLE, CONFLICTING or UNKNOWN (GitHub is still working it out). */
    mergeable: p.mergeable,
    /** CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, DRAFT, HAS_HOOKS or UNKNOWN. */
    mergeState: p.mergeStateStatus,
    review: p.reviewDecision || null,
    reviews: p.latestOpinionatedReviews.nodes.map((r) => ({ author: r.author?.login ?? 'ghost', state: r.state, at: Date.parse(r.submittedAt) || null })),
    requested: p.reviewRequests.nodes.map((r) => r.requestedReviewer?.login ?? r.requestedReviewer?.name).filter(Boolean),
    labels: p.labels.nodes.map((l) => l.name),
    assignees: p.assignees.nodes.map((a) => a.login),
    closes: p.closingIssuesReferences.nodes.map((i) => ({ number: i.number, title: i.title, url: i.url })),
    checks,
    bodyHTML: tasks(p.bodyHTML),
    conversation,
    commentCount: p.comments.totalCount,
    fetchedAt: Date.now(),
  };
}

/** Merge states GitHub reports when nothing stands in the way. */
const READY = new Set(['CLEAN', 'HAS_HOOKS']);

/** Why PR `p` (from prDetail) can't be squash-merged from Gyro yet, or null when it can. */
export function whyNotMergeable(p) {
  if (p.state !== 'OPEN') return `PR #${p.number} is ${p.state.toLowerCase()}`;
  if (p.draft) return `PR #${p.number} is a draft`;
  if (p.mergeable !== 'MERGEABLE' || !READY.has(p.mergeState)) return `PR #${p.number} isn't ready to merge (${p.mergeState.toLowerCase()})`;
  if (p.checks.some((c) => c.result === 'fail')) return `Checks are failing on PR #${p.number}`;
  if (p.checks.some((c) => c.result === 'running')) return `Checks are still running on PR #${p.number}`;
  if (!p.headSha) return `GitHub didn't say what PR #${p.number}'s head commit is`;
  return null;
}

/**
 * Squash-merge PR `number` of `repo`, pinned to head commit `sha`: if anything was pushed since it
 * was checked, GitHub refuses. The branch is left alone; its worktree may still be using it.
 */
export async function mergePr(repo, number, sha) {
  if (!REPO.test(repo ?? '')) throw new Error('Bad repo');
  if (!/^[0-9a-f]{40}$/i.test(sha ?? '')) throw new Error('Bad head commit');
  await gh(['pr', 'merge', String(number), '--repo', repo, '--squash', '--match-head-commit', sha], 60_000);
}

// ---------- GitHub Project board ----------

const BOARD_QUERY = `query($o:String!,$n:Int!,$after:String){
  repositoryOwner(login:$o){ ... on ProjectV2Owner { projectV2(number:$n){
    title url
    field(name:"Status"){ ... on ProjectV2SingleSelectField { options { id name color } } }
    items(first:100, after:$after){
      totalCount pageInfo{ hasNextPage endCursor }
      nodes{ id fullDatabaseId isArchived updatedAt
        status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { optionId } }
        content{ __typename
          ... on Issue { number title url repository{ nameWithOwner } assignees(first:5){ nodes{ login } } labels(first:6){ nodes{ name } } updatedAt }
          ... on PullRequest { number title url isDraft headRefName repository{ nameWithOwner } assignees(first:5){ nodes{ login } } labels(first:6){ nodes{ name } } updatedAt }
          ... on DraftIssue { title updatedAt }
        }
      }
    }
  } } }
}`;
/** Big boards (some have thousands of items) are cut off here; the UI says so. */
const BOARD_MAX = 500;
/** Status columns that hold finished entries. */
const DONE = /\b(done|closed|complete[d]?|shipped|released|merged|won't|wont|cancell?ed)\b/i;

/**
 * A GitHub Project's entries, grouped into its Status columns in the board's own order. An entry is
 * what the board says it is: its column decides whether it's finished and its link opens it on the
 * board, whatever the issue or PR behind it says.
 */
export async function projectBoard({ owner, number }) {
  let after = null;
  let p = null;
  const items = [];
  do {
    const args = ['api', 'graphql', '-f', `query=${BOARD_QUERY}`, '-f', `o=${owner}`, '-F', `n=${number}`];
    if (after) args.push('-f', `after=${after}`);
    p = (await ghJson(args)).data?.repositoryOwner?.projectV2;
    if (!p) throw new Error(`Project #${number} of ${owner} wasn't found`);
    items.push(...p.items.nodes);
    after = p.items.pageInfo.hasNextPage ? p.items.pageInfo.endCursor : null;
  } while (after && items.length < BOARD_MAX);

  const options = p.field?.options ?? [];
  const columns = [
    ...options.map((o) => ({ id: o.id, name: o.name, color: o.color, done: DONE.test(o.name), items: [] })),
    { id: null, name: 'No status', color: null, done: false, items: [] },
  ];
  const byId = new Map(columns.map((c) => [c.id, c]));
  for (const n of items) {
    if (n.isArchived || !n.content) continue;
    const c = n.content;
    const col = byId.get(n.status?.optionId ?? null) ?? byId.get(null);
    col.items.push({
      id: n.id,
      /** The entry on the board (works for draft entries too). */
      url: `${p.url}?pane=issue&itemId=${n.fullDatabaseId}`,
      status: col.id ? col.name : null,
      done: col.done,
      kind: c.__typename === 'PullRequest' ? 'pr' : c.__typename === 'Issue' ? 'issue' : 'draft',
      number: c.number ?? null,
      title: c.title,
      /** The issue or PR behind the entry, if any. */
      contentUrl: c.url ?? null,
      draft: !!c.isDraft,
      branch: c.headRefName ?? null,
      repo: c.repository?.nameWithOwner ?? null,
      assignees: c.assignees?.nodes.map((a) => a.login) ?? [],
      labels: c.labels?.nodes.map((l) => l.name) ?? [],
      updatedAt: Date.parse(n.updatedAt) || null,
    });
  }
  return {
    title: p.title,
    url: p.url,
    total: p.items.totalCount,
    truncated: !!after,
    columns: columns.filter((c) => c.id !== null || c.items.length),
    fetchedAt: Date.now(),
  };
}

// ---------- one board entry: read it, move it ----------

const ENTRY_QUERY = `query($id:ID!){ node(id:$id){ ... on ProjectV2Item { id fullDatabaseId isArchived updatedAt
  project { id number url title owner{ ... on Organization{login} ... on User{login} }
    field(name:"Status"){ ... on ProjectV2SingleSelectField { id options{ id name color } } } }
  status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { optionId } }
  content { __typename
    ... on Issue { number title url state stateReason body bodyHTML createdAt author{login} repository{nameWithOwner}
      assignees(first:10){nodes{login}} labels(first:10){nodes{name}}
      comments(last:30){ totalCount nodes{ id author{login} createdAt body bodyHTML url } } }
    ... on PullRequest { number title url state isDraft headRefName baseRefName body bodyHTML createdAt author{login} repository{nameWithOwner}
      assignees(first:10){nodes{login}} labels(first:10){nodes{name}}
      comments(last:30){ totalCount nodes{ id author{login} createdAt body bodyHTML url } } }
    ... on DraftIssue { title body bodyHTML createdAt creator{login} assignees(first:10){nodes{login}} }
  }
} } }`;

/** Task-list checkboxes as marks: the browser's sanitizer drops <input>s from rendered markdown. */
const tasks = (html) =>
  (html ?? '').replace(/<input\b[^>]*type="checkbox"[^>]*>/g, (m) => `<span class="task">${/\bchecked\b/.test(m) ? '☑' : '☐'}</span>`);

const ITEM_ID = /^PVTI_[A-Za-z0-9_-]{4,100}$/;

/**
 * One entry of `project` ({ owner, number }) with its body, comments and the board's Status options.
 * Throws if the id isn't an entry of that project, so a link can only ever touch its own board.
 */
export async function projectEntry(project, id) {
  if (!ITEM_ID.test(id ?? '')) throw new Error('Bad entry id');
  const n = (await ghJson(['api', 'graphql', '-f', `query=${ENTRY_QUERY}`, '-f', `id=${id}`])).data?.node;
  const p = n?.project;
  if (!p || p.number !== project.number || p.owner?.login?.toLowerCase() !== project.owner.toLowerCase()) {
    throw new Error('That entry is not on this project\'s board');
  }
  const c = n.content ?? {};
  const options = p.field?.options ?? [];
  return {
    id: n.id,
    url: `${p.url}?pane=issue&itemId=${n.fullDatabaseId}`,
    archived: n.isArchived,
    projectId: p.id,
    fieldId: p.field?.id ?? null,
    options: options.map((o) => ({ id: o.id, name: o.name, color: o.color, done: DONE.test(o.name) })),
    statusId: n.status?.optionId ?? null,
    kind: c.__typename === 'PullRequest' ? 'pr' : c.__typename === 'Issue' ? 'issue' : 'draft',
    number: c.number ?? null,
    title: c.title ?? '(untitled)',
    contentUrl: c.url ?? null,
    /** The issue or PR's own state (OPEN, CLOSED, MERGED), for reference; the board's Status is what matters here. */
    state: c.state ?? null,
    draft: !!c.isDraft,
    branch: c.headRefName ?? null,
    repo: c.repository?.nameWithOwner ?? null,
    author: c.author?.login ?? c.creator?.login ?? null,
    createdAt: Date.parse(c.createdAt) || null,
    updatedAt: Date.parse(n.updatedAt) || null,
    assignees: c.assignees?.nodes.map((a) => a.login) ?? [],
    labels: c.labels?.nodes.map((l) => l.name) ?? [],
    /** The description as written (markdown), for handing to claude. */
    body: c.body ?? '',
    bodyHTML: tasks(c.bodyHTML),
    comments: (c.comments?.nodes ?? []).map((m) => ({
      id: m.id, author: m.author?.login ?? 'ghost', createdAt: Date.parse(m.createdAt) || null, body: m.body ?? '', bodyHTML: tasks(m.bodyHTML), url: m.url,
    })),
    commentCount: c.comments?.totalCount ?? 0,
  };
}

/** Room for the brief on claude's command line (Windows caps the whole line at 32,767 characters). */
const BRIEF_MAX = 24_000;

/**
 * The first message of a session started for a board entry: its title, number, description and
 * comments, and that the worktree is for it, then hold for the user's next message.
 */
export function entryBrief(e) {
  const kind = e.kind === 'pr' ? 'pull request' : e.kind === 'issue' ? 'issue' : 'draft issue';
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : 'unknown date');
  const head = [
    `This worktree is dedicated to GitHub ${kind} ${e.number !== null ? `#${e.number}: ` : ''}${e.title}`,
    [e.contentUrl ?? e.url, e.repo].filter(Boolean).join(' in '),
    '',
    `Description${e.author ? ` (by @${e.author}, ${day(e.createdAt)})` : ''}:`,
    e.body.trim() || '(no description)',
  ].join('\n');
  const tail = [
    '',
    'All work in this worktree is for addressing this. Read it and take it in, but don\'t start changing anything yet: my next message will tell you how to proceed.',
  ].join('\n');

  // Newest comments matter most: when they don't all fit, drop the oldest and say so.
  const comments = e.comments.map((c) => `--- @${c.author}, ${day(c.createdAt)}:\n${c.body.trim()}`);
  let left = e.commentCount - comments.length;
  const fits = () => head.length + tail.length + comments.join('\n\n').length + 200 <= BRIEF_MAX;
  while (comments.length && !fits()) comments.shift(), left++;
  const middle = !e.commentCount ? '\nNo comments.' : [
    '',
    `Comments, oldest first${left ? ` (${left} earlier not included; see the link)` : ''}:`,
    ...comments.flatMap((c, i) => (i ? ['', c] : [c])),
  ].join('\n');
  const text = `${head}\n${middle}\n${tail}`;
  // A description too long on its own: cut it, keeping the instructions at the end.
  return text.length <= BRIEF_MAX ? text : `${text.slice(0, BRIEF_MAX - tail.length - 40)}\n…(cut; see the link)\n${tail}`;
}

/** Move an entry to another Status column of its board. Returns the entry as it is afterwards. */
export async function moveEntry(project, id, optionId) {
  const e = await projectEntry(project, id);
  if (!e.fieldId) throw new Error('This board has no Status field');
  if (!e.options.some((o) => o.id === optionId)) throw new Error('No such Status column');
  if (e.statusId === optionId) return e;
  const mutation = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){
    updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }`;
  await ghJson(['api', 'graphql', '-f', `query=${mutation}`, '-f', `p=${e.projectId}`, '-f', `i=${e.id}`, '-f', `f=${e.fieldId}`, '-f', `o=${optionId}`]);
  return { ...e, statusId: optionId, updatedAt: Date.now() };
}
