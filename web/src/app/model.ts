export interface LiveInfo {
  pid: number;
  status: 'busy' | 'idle' | string;
  name?: string;
  entrypoint?: string;
  statusUpdatedAt?: number;
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
  sessions: Session[];
  lastActivity: number;
}

export interface Workspace {
  name: string;
  path: string;
  worktrees: Worktree[];
  /** Sessions from this project's worktree folders that are no longer worktrees (newest first). */
  loose: Session[];
  lastActivity: number;
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
  return s.live?.status === 'busy' ? 'busy' : 'waiting';
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
