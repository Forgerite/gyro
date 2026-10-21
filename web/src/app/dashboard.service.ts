import { DestroyRef, Service, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { ChangedFile, CommitInfo, EntryTarget, PrDetail, Snapshot, Term } from './model';

const POLL_MS = 3000;
const PANEL_TAB_KEY = 'ccdb.panelTab';
const DIFF_MODE_KEY = 'ccdb.diffMode';
const DOCK_OPEN_KEY = 'ccdb.dockOpen';
const QUICK_LAYOUT_KEY = 'ccdb.quickLayout';

export type DiffMode = 'inline' | 'split';

/** The diff viewer's target: one changed file, plus its siblings for next/previous. */
export interface DiffTarget {
  path: string;
  file: string;
  files: ChangedFile[];
  /** Set when viewing a commit from the graph; otherwise the working-tree changes. */
  commit?: CommitInfo;
  /** Working-tree mode: which side of the index the selected file is shown from. */
  view?: DiffSide;
}

export type DiffSide = 'staged' | 'unstaged';

/** Working-tree entries in list order: staged files, then unstaged (a partly staged file is in both). */
export function workingEntries(files: ChangedFile[]): { file: string; view: DiffSide }[] {
  return [
    ...files.filter((f) => f.x !== ' ' && f.x !== '?').map((f) => ({ file: f.path, view: 'staged' as const })),
    ...files.filter((f) => f.x === '?' || f.y !== ' ').map((f) => ({ file: f.path, view: 'unstaged' as const })),
  ];
}

export type PanelTab = 'session' | 'git' | 'pr';

/** A header preset that gives one of the four quadrants most of the screen. */
export type QuickLayout = 'tiles' | 'detail' | 'terminal' | 'preview';
const QUICK_LAYOUTS: readonly string[] = ['tiles', 'detail', 'terminal', 'preview'];

function loadPanelTab(): PanelTab {
  try {
    const t = localStorage.getItem(PANEL_TAB_KEY);
    return t === 'git' || t === 'pr' ? t : 'session';
  } catch {
    return 'session';
  }
}

@Service()
export class DashboardService {
  private readonly http = inject(HttpClient);

  readonly snapshot = signal<Snapshot | null>(null);
  readonly error = signal<string | null>(null);
  /** Ticks with each poll so relative times re-render. */
  readonly now = signal(Date.now());

  /** Worktree path of the terminal tab shown in the dock. */
  readonly activeTerm = signal<string | null>(null);
  /** Bumped to ask the active terminal to take keyboard focus. */
  readonly focusTerm = signal(0);
  /** Terminals between "user asked" and "claude drew something", keyed by worktree path. */
  readonly starting = signal<Record<string, Starting>>({});

  /** Which view the worktree panel shows; remembered across worktrees and reloads. */
  readonly panelTab = signal<PanelTab>(loadPanelTab());

  /** Terminal dock expanded, or collapsed to its tab strip. */
  readonly dockOpen = signal(load(DOCK_OPEN_KEY) !== 'false');

  setDockOpen(open: boolean): void {
    this.dockOpen.set(open);
    save(DOCK_OPEN_KEY, String(open));
  }

  /** The quick layout the dividers were last set to; null once one is dragged by hand. */
  readonly quickLayout = signal<QuickLayout | null>(loadQuickLayout());

  setQuickLayout(layout: QuickLayout | null): void {
    if (this.quickLayout() === layout) return;
    this.quickLayout.set(layout);
    save(QUICK_LAYOUT_KEY, layout ?? '');
  }

  /** Board entry open in the detail panel (over whatever is selected); null when closed. */
  readonly entry = signal<EntryTarget | null>(null);
  /** Bumped when an entry moves, so boards on screen reload (the server already dropped its cached copy). */
  readonly boardTick = signal(0);

  boardChanged(): void {
    this.boardTick.update((n) => n + 1);
  }

  /** File shown in the diff viewer (covers the tile area); null when closed. */
  readonly diffView = signal<DiffTarget | null>(null);
  readonly diffMode = signal<DiffMode>(load(DIFF_MODE_KEY) === 'inline' ? 'inline' : 'split');

  setDiffMode(mode: DiffMode): void {
    this.diffMode.set(mode);
    save(DIFF_MODE_KEY, mode);
  }

  /** Step to the next/previous changed file in the open diff. */
  stepDiff(delta: number): void {
    const d = this.diffView();
    if (!d) return;
    if (!d.commit) {
      const list = workingEntries(d.files);
      const i = list.findIndex((e) => e.file === d.file && e.view === d.view);
      const next = list[i + delta];
      if (next) this.diffView.set({ ...d, ...next });
      return;
    }
    const i = d.files.findIndex((f) => f.path === d.file);
    const next = d.files[i + delta];
    if (next) this.diffView.set({ ...d, file: next.path });
  }

  setPanelTab(tab: PanelTab): void {
    this.panelTab.set(tab);
    try { localStorage.setItem(PANEL_TAB_KEY, tab); } catch { /* storage unavailable */ }
  }

  /** Bumped whenever terminals change locally, so slower in-flight snapshots don't resurrect old ones. */
  private termsVersion = 0;

  constructor() {
    this.refresh();
    const id = setInterval(() => this.refresh(), POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  refresh(): void {
    const version = this.termsVersion;
    this.http.get<Snapshot>('/api/snapshot').subscribe({
      next: (s) => {
        const terms = version === this.termsVersion ? s.terms : (this.snapshot()?.terms ?? s.terms);
        this.snapshot.set({ ...s, terms });
        this.error.set(null);
        this.now.set(Date.now());
      },
      error: (e) => this.error.set(e.message ?? 'API unreachable'),
    });
  }

  open(action: 'external' | 'code' | 'explorer', path: string, sessionId?: string): void {
    this.http.post('/api/open', { action, path, sessionId }).subscribe({
      error: (e) => this.error.set(e.error?.error ?? e.message),
    });
  }

  /**
   * Start (or resume) claude in the dock for this worktree, then show and focus it. A new session for a
   * board `entry` opens on that entry: the server fetches it and briefs claude.
   */
  startTerm(path: string, sessionId?: string, entry?: string): void {
    if (this.starting()[path]) return this.showTerm(path);
    // Show the placeholder tab and overlay right away; the POST and claude's boot happen behind it.
    this.starting.update((m) => ({ ...m, [path]: { at: Date.now(), resume: !!sessionId } }));
    this.showTerm(path);
    this.http.post<{ terms: Term[] }>('/api/terms', { action: 'start', path, sessionId, ...(entry ? { entry } : {}) }).subscribe({
      next: ({ terms }) => {
        this.setTerms(terms);
        this.showTerm(path);
      },
      error: (e) => {
        const msg = e.error?.error ?? e.message;
        this.starting.update((m) => ({ ...m, [path]: { ...m[path], failed: msg } }));
        this.error.set(msg);
      },
    });
  }

  /** "Fix in session" asks in flight, by worktree path. */
  readonly fixing = signal<Record<string, true>>({});

  /**
   * Hand PR `number`'s failing checks to the worktree's Claude: typed into its running dock session,
   * else its latest session is resumed (or a new one started) on it. Then show that terminal.
   */
  fixPr(path: string, number: number, resume: boolean): void {
    if (this.fixing()[path]) return;
    const running = this.snapshot()?.terms.some((t) => t.path === path && !t.exited);
    // No session up yet: show the boot placeholder while claude starts, as startTerm does.
    const placed = !running && !this.starting()[path];
    if (placed) this.starting.update((m) => ({ ...m, [path]: { at: Date.now(), resume } }));
    this.fixing.update((m) => ({ ...m, [path]: true }));
    this.showTerm(path);
    const done = () => this.fixing.update(({ [path]: _, ...rest }) => rest);
    this.http.post<{ terms: Term[]; how: 'sent' | 'resumed' | 'started' }>('/api/terms', { action: 'fix-pr', path, number }).subscribe({
      next: ({ terms, how }) => {
        done();
        if (placed && how === 'sent') this.doneStarting(path);
        this.setTerms(terms);
        this.showTerm(path);
      },
      error: (e) => {
        done();
        if (placed) this.doneStarting(path);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }

  /** Squash-merges in flight, by worktree path; and each worktree's PR as it read once merged. */
  readonly merging = signal<Record<string, true>>({});
  readonly prMerged = signal<Record<string, PrDetail>>({});

  /** Squash-merge PR `number` through GitHub. The server re-checks it's ready first. */
  mergePr(path: string, number: number): void {
    if (this.merging()[path]) return;
    this.merging.update((m) => ({ ...m, [path]: true }));
    const done = () => this.merging.update(({ [path]: _, ...rest }) => rest);
    this.http.post<PrDetail>('/api/github/pr/merge', { path, number }).subscribe({
      next: (pr) => {
        done();
        this.prMerged.update((m) => ({ ...m, [path]: pr }));
        this.refresh(); // the snapshot drops the PR from the open list
      },
      error: (e) => {
        done();
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }

  /** Convert a project to Gyro: ccdb's steps run now, then a Claude session starts in a worktree made for it. */
  convertToGyro(path: string): Observable<{ worktree: string }> {
    return this.http.post<{ worktree: string; terms: Term[] }>('/api/gyro/convert', { path }).pipe(
      tap(({ worktree, terms }) => this.termStarted(worktree, terms)),
    );
  }

  /** The server started a dock terminal (e.g. a Gyro conversion): take its terminal list and show that one. */
  termStarted(path: string, terms: Term[]): void {
    this.setTerms(terms);
    this.showTerm(path);
    this.refresh();
  }

  /** First output from claude (or the start was abandoned): drop the startup indicator. */
  doneStarting(path: string): void {
    const st = this.starting()[path];
    if (!st) return;
    if (!st.failed) console.info(`[ccdb] claude ready in ${Date.now() - st.at}ms`, path);
    this.starting.update(({ [path]: _, ...rest }) => rest);
  }

  /** Bumped after stage/unstage/discard/commit so the Git tab reloads its history and changes. */
  readonly gitTick = signal(0);

  /** Run a git action in a worktree; resolves with the fresh change list. */
  gitAction(
    path: string,
    body: {
      action: 'stage' | 'unstage' | 'discard' | 'commit' | 'stageHunk' | 'unstageHunk' | 'fetch' | 'pull' | 'push' | 'forcePush';
      files?: string[];
      all?: boolean;
      message?: string;
      /** Hunk actions: which file, which side's diff, which hunk (by index). */
      file?: string;
      view?: DiffSide;
      hunk?: number;
      /** forcePush: the upstream commit the user saw; the push fails if the remote has moved from it. */
      expect?: string;
    },
  ) {
    return this.http.post<{ files: ChangedFile[]; note?: string }>('/api/git/action', { path, ...body });
  }

  /** Compose commit (Claude writes the message and commits) in flight, by worktree path → start time. */
  readonly composing = signal<Record<string, number>>({});
  /** Last compose outcome per worktree, until the next commit attempt there. */
  readonly composed = signal<Record<string, ComposeOutcome>>({});

  /** Smart feature: hand the staged changes to Claude to describe and commit. `hint` steers the message. */
  composeCommit(path: string, hint: string): void {
    if (this.composing()[path]) return;
    this.composing.update((m) => ({ ...m, [path]: Date.now() }));
    this.clearComposed(path);
    const done = (o: ComposeOutcome) => {
      this.composing.update(({ [path]: _, ...rest }) => rest);
      this.composed.update((m) => ({ ...m, [path]: o }));
      this.gitChanged();
    };
    this.http.post<ComposeResult>('/api/git/compose', { path, hint }).subscribe({
      next: (r) => done({ ok: `Committed ${r.commit.short} · ${r.commit.subject}`, warning: r.warning }),
      error: (e) => done({ error: e.error?.error ?? e.message }),
    });
  }

  /** Auto rebase in flight, by worktree path → start time; and the last outcome per worktree. */
  readonly rebasing = signal<Record<string, number>>({});
  readonly rebased = signal<Record<string, RebaseOutcome>>({});

  /** Smart feature: Claude stashes, rebases onto trunk, reapplies the stash and resolves conflicts. */
  autoRebase(path: string): void {
    if (this.smartBusy(path)) return;
    this.rebasing.update((m) => ({ ...m, [path]: Date.now() }));
    this.clearRebased(path);
    const done = (o: RebaseOutcome) => {
      this.rebasing.update(({ [path]: _, ...rest }) => rest);
      this.rebased.update((m) => ({ ...m, [path]: o }));
      this.gitChanged();
    };
    this.http.post<RebaseResult>('/api/git/rebase', { path }).subscribe({
      next: (r) => done({ result: r }),
      error: (e) => done({ error: e.error?.error ?? e.message }),
    });
  }

  clearRebased(path: string): void {
    if (this.rebased()[path]) this.rebased.update(({ [path]: _, ...rest }) => rest);
  }

  /** Create PR in flight, by worktree path → start time; and the last outcome per worktree. */
  readonly creatingPr = signal<Record<string, number>>({});
  readonly prCreated = signal<Record<string, PrOutcome>>({});

  /** Smart feature: push the branch, then Claude writes the PR (linking its issue) and opens it. */
  createPr(path: string): void {
    if (this.smartBusy(path)) return;
    this.creatingPr.update((m) => ({ ...m, [path]: Date.now() }));
    this.clearPrCreated(path);
    const done = (o: PrOutcome) => {
      this.creatingPr.update(({ [path]: _, ...rest }) => rest);
      this.prCreated.update((m) => ({ ...m, [path]: o }));
      this.gitChanged();
      this.refresh(); // the snapshot carries the new PR
    };
    this.http.post<PrResult>('/api/github/pr', { path }).subscribe({
      next: (r) => done({ result: r, at: Date.now() }),
      error: (e) => done({ error: e.error?.error ?? e.message }),
    });
  }

  clearPrCreated(path: string): void {
    if (this.prCreated()[path]) this.prCreated.update(({ [path]: _, ...rest }) => rest);
  }

  /** A smart feature (compose, rebase or PR) is working in this worktree: other git actions wait. */
  smartBusy(path: string): boolean {
    return !!this.composing()[path] || !!this.rebasing()[path] || !!this.creatingPr()[path];
  }

  clearComposed(path: string): void {
    if (this.composed()[path]) this.composed.update(({ [path]: _, ...rest }) => rest);
  }

  /** Close a project (kills its dock terminals) or reopen it. Updates the tile right away. */
  setProjectClosed(path: string, closed: boolean): void {
    this.snapshot.update((s) => s && { ...s, workspaces: s.workspaces.map((w) => (w.path === path ? { ...w, closed } : w)) });
    this.http.post<{ terms?: Term[] }>('/api/projects/close', { path, closed }).subscribe({
      next: ({ terms }) => {
        if (terms) this.setTerms(terms);
        for (const p of Object.keys(this.starting())) if (terms && !terms.some((t) => t.path === p)) this.doneStarting(p);
        this.refresh();
      },
      error: (e) => {
        this.error.set(e.error?.error ?? e.message);
        this.refresh();
      },
    });
  }

  /** After a git action: tell the Git tab and the tiles. */
  gitChanged(): void {
    this.gitTick.update((n) => n + 1);
    this.refresh();
  }

  closeTerm(path: string): void {
    this.doneStarting(path);
    this.http.post<{ terms: Term[] }>('/api/terms', { action: 'close', path }).subscribe({
      next: ({ terms }) => this.setTerms(terms),
      error: (e) => this.error.set(e.error?.error ?? e.message),
    });
  }

  /** Restart or stop the dev server beside a dock session. */
  devServer(path: string, run: boolean): void {
    this.http.post<{ terms: Term[] }>('/api/terms', { action: run ? 'dev-start' : 'dev-stop', path }).subscribe({
      next: ({ terms }) => this.setTerms(terms),
      error: (e) => this.error.set(e.error?.error ?? e.message),
    });
  }

  /** Open another shell beside a dock session; `done` gets its id. */
  openShell(path: string, done: (id: string) => void): void {
    const before = new Set(this.snapshot()?.terms.find((t) => t.path === path)?.shells?.map((s) => s.id));
    this.http.post<{ terms: Term[] }>('/api/terms', { action: 'shell-start', path }).subscribe({
      next: ({ terms }) => {
        this.setTerms(terms);
        const added = terms.find((t) => t.path === path)?.shells?.find((s) => !before.has(s.id));
        if (added) done(added.id);
      },
      error: (e) => this.error.set(e.error?.error ?? e.message),
    });
  }

  closeShell(path: string, id: string): void {
    this.http.post<{ terms: Term[] }>('/api/terms', { action: 'shell-close', path, id }).subscribe({
      next: ({ terms }) => this.setTerms(terms),
      error: (e) => this.error.set(e.error?.error ?? e.message),
    });
  }

  private setTerms(terms: Term[]): void {
    this.termsVersion++;
    this.snapshot.update((s) => (s ? { ...s, terms } : s));
  }

  showTerm(path: string, focus = true): void {
    this.activeTerm.set(path);
    if (focus) {
      this.setDockOpen(true);
      this.focusTerm.update((n) => n + 1);
    }
  }
}

interface ComposeResult {
  commit: { h: string; short: string; subject: string };
  warning: string | null;
}

export interface RebaseResult {
  upToDate: boolean;
  branch: string;
  trunk: string;
  commits?: number;
  moved?: boolean;
  note?: string;
  summary?: string | null;
  /** Whatever ccdb's own checks found wrong afterwards (empty = clean). */
  problems: string[];
  backup?: { head: string; wip: string | null };
  fetchNote?: string | null;
}

export interface RebaseOutcome {
  result?: RebaseResult;
  error?: string;
}

export interface PrResult {
  pr: { number: number; title: string; url: string; closes: number[] };
  pushNote: string | null;
  /** e.g. uncommitted files that weren't part of the PR. */
  warning: string | null;
}

export interface PrOutcome {
  result?: PrResult;
  /** When the PR was created. */
  at?: number;
  error?: string;
}

export interface ComposeOutcome {
  ok?: string;
  warning?: string | null;
  error?: string;
}

export interface Starting {
  at: number;
  resume: boolean;
  /** Set when the server refused or failed to start the terminal. */
  failed?: string;
}

function loadQuickLayout(): QuickLayout | null {
  const v = load(QUICK_LAYOUT_KEY);
  return v && QUICK_LAYOUTS.includes(v) ? (v as QuickLayout) : null;
}

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
