import { HttpClient } from '@angular/common/http';
import { Component, ElementRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { DashboardService, workingEntries } from './dashboard.service';
import { Seg, layoutGraph } from './graph-layout';
import { ChangedFile, CommitInfo, GitChanges, GitGraph, Worktree } from './model';

const LANE = 12;
const ROW = 22;
/** Lanes beyond this are clipped; very wide histories would otherwise eat the subject column. */
const MAX_LANES = 10;
const LANE_COLORS = 8;
/** Pseudo-commit id for the uncommitted-changes row at the top of the history. */
const WIP = 'working-tree';
/** Opening a worktree's Git tab fetches quietly if it hasn't been fetched this recently. */
const AUTO_FETCH_MS = 5 * 60_000;
/** Worktree path → when we last fetched it (any GitTab instance). */
const lastFetch = new Map<string, number>();

type SyncAction = 'fetch' | 'pull' | 'push';

/** Changes in this worktree, then the repository graph with this worktree's own commits highlighted. */
@Component({
  selector: 'app-git-tab',
  imports: [AgoPipe],
  template: `
    <div class="bar">
      @let s = graph()?.sync;
      @if (s) {
        <span class="branch" [title]="s.branch ? 'Branch checked out in this worktree' : 'No branch checked out'">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.8" /><circle cx="4" cy="12.5" r="1.8" /><circle cx="12" cy="5" r="1.8" /><path d="M4 5.3v5.4M12 6.8c0 3-8 2-8 4" /></svg>
          {{ s.branch ?? 'detached HEAD' }}
        </span>
        @if (s.upstream) {
          <span class="up" title="Upstream (counts as of the last fetch)">→ {{ s.upstream }}</span>
        } @else if (s.branch && s.remote) {
          <span class="up">not on {{ s.remote }} yet</span>
        }
        @if (s.branch && s.remote) {
          <span class="sync" role="group" aria-label="Sync with remote">
            <button type="button" class="act" (click)="sync('fetch')" [disabled]="!!syncing()"
                    [title]="'Fetch ' + s.remote + ' to update the counts'">{{ syncing() === 'fetch' ? 'Fetching…' : 'Fetch' }}</button>
            <button type="button" class="act" [class.due]="s.behind > 0" (click)="sync('pull')" [disabled]="!!syncing() || !s.upstream"
                    [title]="s.upstream ? 'Fetch, then fast-forward ' + s.branch + ' to ' + s.upstream : 'Nothing to pull: the branch is not published yet'">
              {{ syncing() === 'pull' ? 'Pulling…' : 'Pull' }}@if (s.behind) { <span class="cnt">↓{{ s.behind }}</span> }
            </button>
            <button type="button" class="act" [class.due]="s.ahead > 0 || !s.upstream" (click)="sync('push')" [disabled]="!!syncing()"
                    [title]="s.upstream ? 'Push ' + s.branch + ' to ' + s.upstream : 'Publish ' + s.branch + ' to ' + s.remote + ' and track it'">
              {{ syncing() === 'push' ? 'Pushing…' : s.upstream ? 'Push' : 'Publish' }}@if (s.ahead) { <span class="cnt">↑{{ s.ahead }}</span> }
            </button>
          </span>
        }
      }
      <span class="spacer"></span>
      <button type="button" class="link" (click)="load()" [disabled]="loading()">{{ loading() ? 'loading…' : 'refresh' }}</button>
    </div>
    <div class="msg" role="status">
      @if (error()) { <span class="err">{{ error() }}</span> } @else if (note()) { <span class="note">{{ note() }}</span> }
    </div>

    <section aria-labelledby="gr-h" class="graph">
      <h3 id="gr-h">
        History <span class="n">{{ graph()?.commits?.length ?? '' }}{{ graph()?.truncated ? '+' : '' }}</span>
        <button type="button" class="link scope" (click)="toggleAll()" [attr.aria-pressed]="allBranches()">
          {{ allBranches() ? 'all branches' : 'this branch + ' + (changes()?.trunk ?? 'trunk') }} ⇄
        </button>
      </h3>
      @for (r of layout().rows; track r.commit.h) {
        @if (r.commit.h === WIP) {
          <!-- Uncommitted work, drawn as a pending node above this worktree's HEAD. -->
          <button type="button" class="grow wip" [class.open]="workingOpen()" (click)="openWorking()"
                  title="Uncommitted changes — open diff">
            <svg [attr.width]="svgWidth()" [attr.height]="ROW" aria-hidden="true">
              @for (s of r.segs; track $index) {
                <path [attr.d]="path(s)" class="wip-line" />
              }
              <circle [attr.cx]="x(r.col)" [attr.cy]="ROW / 2" r="4.5" class="wip-node" />
            </svg>
            <span class="subj">
              Uncommitted changes
              <span class="wip-n">{{ wipFiles().length }} file{{ wipFiles().length === 1 ? '' : 's' }}</span>
              @if (wipAdded()) { <span class="add">+{{ wipAdded() }}</span> }
              @if (wipRemoved()) { <span class="del">−{{ wipRemoved() }}</span> }
            </span>
            <span class="age"></span>
          </button>
        } @else {
          @let mine = unique().has(r.commit.h);
          <button type="button" class="grow" [class.mine]="mine" [class.head]="r.commit.h === graph()?.head"
                  [class.open]="openCommitHash() === r.commit.h" (click)="openCommit(r.commit.h)"
                  [title]="r.commit.subject + '\n' + r.commit.h.slice(0, 7) + ' · ' + r.commit.author + ' — open diff'">
            <svg [attr.width]="svgWidth()" [attr.height]="ROW" aria-hidden="true">
              @for (s of r.segs; track $index) {
                <path [attr.d]="path(s)" [attr.class]="isWipLine(s) ? 'wip-line' : 'l' + (s.lane % LANE_COLORS)" />
              }
              <circle [attr.cx]="x(r.col)" [attr.cy]="ROW / 2" [attr.r]="mine ? 4 : 3" [attr.class]="'n' + (r.col % LANE_COLORS)" />
            </svg>
            <span class="subj">
              @if (r.commit.h === graph()?.head) { <span class="ref here">this worktree</span> }
              @for (ref of r.commit.refs; track ref) { <span class="ref" [class.remote]="ref.includes('/')">{{ ref }}</span> }
              {{ r.commit.subject }}
            </span>
            <span class="age">{{ r.commit.at | ago: now() }}</span>
          </button>
        }
      }
    </section>
  `,
  styleUrl: './git-tab.css',
})
export class GitTab {
  readonly wt = input.required<Worktree>();
  readonly now = input.required<number>();

  private readonly http = inject(HttpClient);
  private readonly api = inject(DashboardService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  /** Worktree whose graph we've already scrolled to its HEAD (only on first load, not refreshes). */
  private scrolledFor = '';
  protected readonly ROW = ROW;
  protected readonly LANE_COLORS = LANE_COLORS;
  protected readonly WIP = WIP;

  protected readonly graph = signal<GitGraph | null>(null);
  protected readonly changes = signal<GitChanges | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Network action in flight (one at a time), and the last one's outcome. */
  protected readonly syncing = signal<SyncAction | null>(null);
  protected readonly note = signal<string | null>(null);
  /** Graph scope: this worktree's branch + trunk (default), or every ref in the repo. */
  protected readonly allBranches = signal(false);

  protected readonly wipFiles = computed(() => this.changes()?.files ?? []);
  protected readonly wipAdded = computed(() => this.wipFiles().reduce((n, f) => n + (f.added ?? 0), 0));
  protected readonly wipRemoved = computed(() => this.wipFiles().reduce((n, f) => n + (f.removed ?? 0), 0));

  /** History rows; uncommitted work (if any) is a pending node whose parent is this worktree's HEAD. */
  protected readonly layout = computed(() => {
    const g = this.graph();
    const commits = g?.commits ?? [];
    if (!g || !this.wipFiles().length) return layoutGraph(commits);
    const wip = { h: WIP, parents: g.head ? [g.head] : [], refs: [], author: '', at: Date.now(), subject: 'Uncommitted changes' };
    return layoutGraph([wip, ...commits]);
  });
  protected readonly unique = computed(() => new Set(this.graph()?.unique ?? []));
  protected readonly svgWidth = computed(() => Math.min(this.layout().width, MAX_LANES) * LANE + 4);

  /** Reload when the worktree, its HEAD, or its change counts move; not on every 3s poll. */
  private readonly key = computed(() => {
    const w = this.wt();
    return `${w.path}|${w.head}|${w.git.dirty}|${w.git.unmerged}|${this.api.gitTick()}`;
  });
  private lastPath = '';

  constructor() {
    effect(() => {
      this.key();
      untracked(() => {
        const path = this.wt().path;
        if (path !== this.lastPath) {
          this.lastPath = path;
          this.graph.set(null);
          this.changes.set(null);
          this.note.set(null);
        }
        this.load();
      });
    });
  }

  load() {
    const path = this.wt().path;
    const q = `?path=${encodeURIComponent(path)}`;
    this.loading.set(true);
    this.error.set(null);
    let pending = 2;
    const done = () => --pending === 0 && this.loading.set(false);
    const fail = (e: { error?: { error?: string }; message: string }) => {
      this.error.set(e.error?.error ?? e.message);
      done();
    };
    this.http.get<GitChanges>(`/api/git/changes${q}`).subscribe({
      next: (c) => {
        if (path !== this.wt().path) return;
        this.changes.set(c);
        // Keep an open working-tree diff in step with what's actually changed now.
        const d = this.api.diffView();
        if (d?.path === path && !d.commit) {
          if (!c.files.length) this.api.diffView.set(null);
          else this.api.diffView.set({ ...d, files: c.files, ...keepSelection(d.file, d.view, c.files) });
        }
        done();
      },
      error: fail,
    });
    this.http.get<GitGraph>(`/api/git/graph${q}${this.allBranches() ? '&all=1' : ''}`).subscribe({
      next: (g) => {
        if (path === this.wt().path) {
          this.graph.set(g);
          // Counts are only as fresh as the last fetch: refresh them quietly when a worktree is opened.
          const seen = lastFetch.get(path) ?? 0;
          if (g.sync.upstream && !this.syncing() && Date.now() - seen > AUTO_FETCH_MS) this.sync('fetch', true);
          if (this.scrolledFor !== path) {
            this.scrolledFor = path;
            // Uncommitted work sits at the top; otherwise HEAD can be far below newer trunk commits.
            setTimeout(() => {
              const target = this.host.querySelector('.grow.wip') ?? this.host.querySelector('.grow.head');
              target?.scrollIntoView({ block: 'center' });
            });
          }
        }
        done();
      },
      error: fail,
    });
  }

  /** Fetch / pull / push this worktree's branch; the note reports what happened. */
  protected sync(action: SyncAction, quiet = false) {
    const path = this.wt().path;
    this.syncing.set(action);
    if (!quiet) {
      this.error.set(null);
      this.note.set(null);
    }
    this.api.gitAction(path, { action }).subscribe({
      next: ({ note }) => {
        this.syncing.set(null);
        lastFetch.set(path, Date.now());
        if (!quiet && path === this.wt().path) this.note.set(note ?? null);
        this.api.gitChanged();
      },
      error: (e) => {
        this.syncing.set(null);
        if (!quiet && path === this.wt().path) this.error.set(e.error?.error ?? e.message);
      },
    });
  }

  protected toggleAll() {
    this.allBranches.update((v) => !v);
    this.load();
  }

  protected isWipLine(seg: Seg) {
    return seg.origin === WIP;
  }

  protected readonly workingOpen = computed(() => {
    const d = this.api.diffView();
    return d?.path === this.wt().path && !d.commit;
  });

  /** Uncommitted row clicked: open the working-tree changes, first file selected. */
  protected openWorking() {
    const files = this.wipFiles();
    const first = workingEntries(files)[0];
    if (first) this.api.diffView.set({ path: this.wt().path, files, ...first });
  }

  protected readonly openCommitHash = computed(() => {
    const d = this.api.diffView();
    return d?.path === this.wt().path ? (d.commit?.h ?? null) : null;
  });

  /** Graph row clicked: list the commit's files and open the first in the diff viewer. */
  protected openCommit(h: string) {
    const path = this.wt().path;
    this.http.get<{ commit: CommitInfo; files: ChangedFile[] }>(`/api/git/commit?path=${encodeURIComponent(path)}&h=${h}`).subscribe({
      next: ({ commit, files }) => {
        if (path !== this.wt().path) return;
        this.api.diffView.set({ path, file: files[0]?.path ?? '', files, commit });
      },
      error: (e) => this.error.set(e.error?.error ?? e.message),
    });
  }

  protected x(lane: number) {
    return lane * LANE + LANE / 2 + 2;
  }

  /** Straight for vertical runs, an S-curve when a line changes lanes. */
  protected path(s: { x1: number; y1: number; x2: number; y2: number }) {
    const [x1, y1, x2, y2] = [this.x(s.x1), s.y1 * ROW, this.x(s.x2), s.y2 * ROW];
    if (x1 === x2) return `M${x1} ${y1}V${y2}`;
    const my = (y1 + y2) / 2;
    return `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
  }
}

/** After the change list moves: same file and side if still there, else same file other side, else first. */
export function keepSelection(file: string, view: 'staged' | 'unstaged' | undefined, files: import('./model').ChangedFile[]) {
  const list = workingEntries(files);
  return list.find((e) => e.file === file && e.view === view) ?? list.find((e) => e.file === file) ?? list[0];
}
