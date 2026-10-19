export interface LiveInfo {
  pid: number;
  status: 'busy' | 'idle' | string;
  name?: string;
  entrypoint?: string;
  statusUpdatedAt?: number;
  /** Background shells, subagents and workflows it started that are still running. */
  background?: number;
}

export interface Session {
  id: string;
  title: string | null;
  cwd?: string;
  branch?: string;
  model?: string;
  entrypoint?: string;
  startedAt?: number;
  lastActivity: number;
  lastRole?: 'user' | 'assistant' | 'tool';
  lastAssistant?: string;
  lastUser?: string;
  lastPrompt?: string;
  lastTool?: string;
  pr?: { number: number; url: string };
  sizeBytes: number;
  live: LiveInfo | null;
  /** Loose sessions only: the removed worktree's folder name, and whether that folder is still on disk. */
  worktreeName?: string;
  folderExists?: boolean;
}

export interface GitStatus {
  missing?: boolean;
  /** Uncommitted files (incl. untracked). */
  dirty: number;
  /** Commits on HEAD not contained in trunk. */
  unmerged: number;
  trunk: string | null;
  lastCommitAt: number | null;
  lastCommitSubject: string | null;
}

export interface Worktree {
  path: string;
  name: string;
  head: string;
  branch: string | null;
  detached: boolean;
  isMain: boolean;
  prunable: boolean;
  git: GitStatus;
  /** The open GitHub PR from this branch (linked projects only). */
  pr?: PullRequest | null;
  /** Its port block, once ccdb has run something here (see server/ports.mjs). */
  ports?: PortBlock | null;
  sessions: Session[];
  lastActivity: number;
}

/** Ports leased to one worktree: base … base + count − 1, unique on this machine. */
export interface PortBlock {
  slot: number;
  base: number;
  count: number;
}

export interface Workspace {
  name: string;
  path: string;
  worktrees: Worktree[];
  /** Sessions from this project's worktree folders that are no longer worktrees (newest first). */
  loose: Session[];
  lastActivity: number;
  /** Closed: collapsed to its header at the end of the list, never coloured, its dock terminals killed. */
  closed?: boolean;
  /** The GitHub repo (and optionally GitHub Project) this project is linked to. */
  github?: GithubLink | null;
  /** Open PRs of the linked repo, as of `at`; absent until first fetched. */
  pulls?: { list: PullRequest[]; at: number; error: string | null } | null;
  /** The dev server dock sessions start beside. */
  dev?: DevSetting;
  /** Its Gyro conversion, if one was ever started. */
  gyro?: GyroRun | null;
}

export type GyroStepStatus = 'pending' | 'done' | 'skipped' | 'failed';

export interface GyroStep {
  key: 'dev' | 'git' | 'prune' | 'lease' | 'ccdb';
  label: string;
  /** Who does it: ccdb itself before the session starts, or the Claude session. */
  by: 'ccdb' | 'claude';
  status: GyroStepStatus;
  detail: string | null;
  at: number | null;
}

/** A Gyro conversion: running until its session reports it finished; done only if every step was done or skipped. */
export interface GyroRun {
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  /** Where the session works: a worktree made for it (or the main checkout of a repo with no commits). */
  worktree: string | null;
  sessionId: string | null;
  summary: string | null;
  /** false: everything was already in shape, so nothing changed (and the run's worktree is removed). null while running. */
  changed: boolean | null;
  steps: GyroStep[];
}

/** A project's dev command: set in ccdb (`''` for none), else detected from package.json. */
export interface DevSetting {
  command: string | null;
  detected: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  branch: string;
  base: string;
  draft: boolean;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when no review is needed. */
  review: string | null;
  checks: 'pass' | 'fail' | 'pending' | null;
  /** Some check is still running, even if another has already failed. */
  checksRunning: boolean;
  author: string | null;
  updatedAt: number | null;
  /** Issue numbers this PR closes. */
  closes: number[];
}

/** One CI check on a PR's head commit (a GitHub Actions job, or a commit status from another service). */
export interface PrCheck {
  name: string;
  /** The Actions workflow it belongs to, if any. */
  workflow: string | null;
  result: 'pass' | 'fail' | 'running' | 'skipped';
  /** GitHub's own word for it: SUCCESS, FAILURE, IN_PROGRESS, QUEUED, PENDING… */
  conclusion: string;
  url: string | null;
  description: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

/** A PR in full, for the PR tab. */
export interface PrDetail {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  author: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  mergedAt: number | null;
  branch: string;
  base: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  head: string | null;
  /** The head commit's full SHA. */
  headSha: string | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeState: string;
  review: string | null;
  reviews: { author: string; state: string; at: number | null }[];
  /** Reviewers asked who haven't answered yet. */
  requested: string[];
  labels: string[];
  assignees: string[];
  closes: { number: number; title: string; url: string }[];
  checks: PrCheck[];
  bodyHTML: string;
  /** Comments and reviews with a body, oldest first. */
  conversation: { id: string; kind: 'comment' | 'review'; author: string; at: number | null; state: string | null; bodyHTML: string; url: string }[];
  commentCount: number;
  fetchedAt: number;
}

/** An entry on a GitHub Project: its column, not the issue or PR behind it, says where it stands. */
export interface BoardItem {
  id: string;
  /** The entry on the board. */
  url: string;
  /** Its Status column; null when it has none. */
  status: string | null;
  /** In a finished column (Done, Closed, ...). */
  done: boolean;
  kind: 'issue' | 'pr' | 'draft';
  number: number | null;
  title: string;
  /** The issue or PR behind the entry; null for draft entries. */
  contentUrl: string | null;
  draft: boolean;
  branch: string | null;
  repo: string | null;
  assignees: string[];
  labels: string[];
  updatedAt: number | null;
}

export interface Board {
  title: string;
  url: string;
  total: number;
  truncated: boolean;
  columns: { id: string | null; name: string; color: string | null; done: boolean; items: BoardItem[] }[];
  fetchedAt: number;
}

export interface GithubProject {
  owner: string;
  number: number;
  title: string;
  url: string;
}

export interface GithubLink {
  /** owner/name */
  repo: string;
  url: string;
  defaultBranch: string | null;
  private: boolean;
  project: GithubProject | null;
  linkedAt: number;
}

export interface Snapshot {
  generatedAt: number;
  root: string;
  workspaces: Workspace[];
  unmatched: Session[];
  terms: Term[];
}

/** busy: Claude is working. waiting: anything else with a session (live or not) — it's on you. none: no session. */
export type State = 'busy' | 'waiting' | 'none';

export function sessionState(s: Session | undefined): State {
  if (!s) return 'none';
  // Claude goes idle when its turn ends, but a background shell, monitor or subagent it's waiting on is still work.
  return isWorking(s.live?.status) || s.live?.background ? 'busy' : 'waiting';
}

/** Claude Code's own live statuses: 'shell' (running a shell) counts as working, like 'busy'. */
export function isWorking(status: string | undefined): boolean {
  return status === 'busy' || status === 'shell';
}

/**
 * What the detail panel shows: a whole project (repo), one of its worktrees, or a loose session.
 * `path` is the repo or worktree path (the main worktree shares the repo's, hence the kind), or the session id.
 */
export interface Selection {
  kind: 'project' | 'worktree' | 'session';
  path: string;
}

/** Loose sessions: live or recent ones show on the tile; older ones sit behind "+N older". */
export const LOOSE_RECENT_MS = 14 * 86_400_000;

/** Loose sessions have no worktree to wait on you, so only a running one gets a state colour. */
export function looseState(s: Session): State | 'idle' {
  return s.live ? sessionState(s) : 'idle';
}

/** An embedded claude PTY on the server (at most one per worktree). */
export interface Term {
  path: string;
  sessionId: string;
  resumed: boolean;
  pid: number;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  attached: number;
  /** The project's dev script (`npm run dev`), run beside claude; null when it has none. */
  devCommand: string | null;
  dev: DevServer | null;
}

/** The dev server running beside a dock session, and the local URL it printed once it was up. */
export interface DevServer {
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
  url: string | null;
}

export interface GraphCommit {
  h: string;
  parents: string[];
  refs: string[];
  author: string;
  at: number;
  subject: string;
}

export interface GitGraph {
  /** null before the repository's first commit. */
  head: string | null;
  trunk: string | null;
  commits: GraphCommit[];
  /** Commits on this worktree's HEAD that trunk doesn't have. */
  unique: string[];
  truncated: boolean;
  sync: BranchSync;
}

/** This worktree's branch and its remote counterpart, as of the last fetch. */
export interface BranchSync {
  /** null when HEAD is detached. */
  branch: string | null;
  /** Remote it pushes to: the upstream's, or the one a first push would publish to. */
  remote: string | null;
  /** e.g. "origin/feature"; null when the branch isn't published (or its remote branch is gone). */
  upstream: string | null;
  merge: string | null;
  /** The upstream's commit as of the last fetch; a force push is leased to it. */
  upstreamSha: string | null;
  ahead: number;
  behind: number;
}

export interface ChangedFile {
  /** Porcelain v1 status letters: index (x) and worktree (y); "??" is untracked. */
  x: string;
  y: string;
  path: string;
  from: string | null;
  added: number | null;
  removed: number | null;
}

export interface GitChanges {
  trunk: string | null;
  files: ChangedFile[];
}

/** A commit opened in the diff viewer (diffed against its first parent). */
export interface CommitInfo {
  h: string;
  short: string;
  author: string;
  at: number;
  subject: string;
  body: string;
  parents: string[];
}

/** A board entry opened in the detail panel: everything needed to read it and move it along. */
export interface BoardEntry {
  id: string;
  url: string;
  archived: boolean;
  options: { id: string; name: string; color: string | null; done: boolean }[];
  /** The Status column it's in; null when it has none. */
  statusId: string | null;
  kind: 'issue' | 'pr' | 'draft';
  number: number | null;
  title: string;
  contentUrl: string | null;
  /** The issue or PR's own state (OPEN, CLOSED, MERGED). */
  state: string | null;
  draft: boolean;
  branch: string | null;
  repo: string | null;
  author: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  assignees: string[];
  labels: string[];
  /** Rendered by GitHub. */
  bodyHTML: string;
  comments: { id: string; author: string; createdAt: number | null; bodyHTML: string; url: string }[];
  commentCount: number;
}

/** Which board entry the detail panel is showing: the project it belongs to, and the entry's id. */
export interface EntryTarget {
  path: string;
  id: string;
}
