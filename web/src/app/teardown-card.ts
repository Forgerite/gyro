import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { Worktree } from './model';

/** What archiving a worktree would do, as reported fresh by the server. */
interface TeardownPlan {
  path: string;
  name: string;
  isMain: boolean;
  sessions: number;
  dockTerminal: boolean;
  liveElsewhere: { title: string | null; where: string }[];
  branch: string | null;
  trunk: string | null;
  dirty: number;
  files: string[];
  unmerged: number;
  commits: { h: string; subject: string }[];
  /** The remote branch it was pushed to; its counts are what deleting both copies would lose. */
  remoteBranch: { remote: string; name: string; unmerged: number; commits: { h: string; subject: string }[] } | null;
}

export interface ArchiveResult {
  removed: boolean;
  branchDeleted?: boolean;
  branchError?: string | null;
  remoteDeleted?: boolean;
  archived: number;
}

/**
 * Confirm "archive": archive every session of the worktree, close its dock terminal, remove the
 * worktree folder and delete its branch (main checkout: sessions only). Work that would be lost
 * needs an explicit acknowledgement; the server re-checks and refuses without it.
 */
@Component({
  selector: 'app-teardown-card',
  template: `
    @if (error() && !plan()) {
      <p class="err">{{ error() }}</p>
      <button type="button" class="link" (click)="cancel.emit()">Back</button>
    } @else if (!plan()) {
      <p class="muted">Checking {{ wt().name }}…</p>
    } @else {
      @let p = plan()!;
      <h3>{{ land() ? 'Land' : 'Archive' }} {{ p.isMain ? 'sessions in' : '' }} {{ p.name }}?</h3>
      <ul class="steps">
        @if (land()) { <li>Squash-merge the PR into <code>{{ p.trunk }}</code></li> }
        <li>Archive {{ p.sessions }} session{{ p.sessions === 1 ? '' : 's' }} to <code>~/.claude/gyro-archive</code></li>
        @if (p.dockTerminal) { <li>Close the terminal running in the dock</li> }
        @if (p.isMain) {
          <li class="muted">The main checkout stays — it's the repository itself.</li>
        } @else {
          <li>Remove the worktree folder <code>{{ p.path }}</code></li>
          @if (p.branch) { <li>Delete the branch <code>{{ p.branch }}</code></li> }
          @if (p.remoteBranch; as rb) {
            <li>
              <label class="opt">
                <input type="checkbox" [checked]="deleteRemote()" (change)="setDeleteRemote($any($event.target).checked)" [disabled]="busy()" />
                Also delete <code>{{ rb.remote }}/{{ rb.name }}</code> on {{ rb.remote }}
              </label>
            </li>
          }
        }
      </ul>

      @if (p.liveElsewhere.length) {
        <div class="block" role="alert">
          A session is open in {{ p.liveElsewhere[0].where }}. Close it there first.
        </div>
      }

      @if (!p.isMain && (p.dirty || lost().count)) {
        <div class="loss" role="alert">
          <div class="loss-title">⚠ This permanently loses work</div>
          @if (p.dirty) {
            <div>{{ p.dirty }} uncommitted file{{ p.dirty === 1 ? '' : 's' }}:</div>
            <ul class="items">
              @for (f of p.files; track f) { <li><code>{{ f }}</code></li> }
              @if (p.dirty > p.files.length) { <li class="muted">…and {{ p.dirty - p.files.length }} more</li> }
            </ul>
          }
          @if (lost(); as l) {
            @if (l.count) {
              <div>
                {{ l.count }} commit{{ l.count === 1 ? ' that exists' : 's that exist' }} only on this branch{{ l.withRemote ? ' and its remote branch' : '' }}
                (only recoverable from git's reflog for a while):
              </div>
              <ul class="items">
                @for (c of l.commits; track c.h) { <li><code>{{ c.h }}</code> {{ c.subject }}</li> }
                @if (l.count > l.commits.length) { <li class="muted">…and {{ l.count - l.commits.length }} more</li> }
              </ul>
            }
          }
          <label class="ack">
            <input type="checkbox" [checked]="ack()" (change)="ack.set($any($event.target).checked)" />
            I understand this work will be lost
          </label>
        </div>
      }

      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }

      <div class="actions">
        <button type="button" class="danger" (click)="run()" [disabled]="!canRun()">
          {{ land() ? 'Land it' : busy() ? 'Archiving…' : p.isMain ? 'Archive sessions' : 'Archive & remove worktree' }}
        </button>
        <button type="button" class="link" (click)="cancel.emit()" [disabled]="busy()">Cancel</button>
      </div>
    }
  `,
  styleUrl: './teardown-card.css',
})
export class TeardownCard {
  readonly wt = input.required<Worktree>();
  /** Land mode: confirm the teardown half of Land it — emit `confirm` instead of archiving here. */
  readonly land = input(false);
  readonly done = output<ArchiveResult>();
  readonly confirm = output<{ ack: boolean; deleteRemote: boolean }>();
  readonly cancel = output<void>();

  private readonly http = inject(HttpClient);
  private readonly api = inject(DashboardService);

  protected readonly plan = signal<TeardownPlan | null>(null);
  protected readonly ack = signal(false);
  /** Off by default: the remote copy is what keeps a pushed branch's commits safe. */
  protected readonly deleteRemote = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Commits archiving would lose: deleting the remote branch too can lose more than the local one alone.
   *  Land mode: the merge lands these commits first, so they aren't losses (dirty files still are). */
  protected readonly lost = computed(() => {
    const p = this.plan();
    if (this.land()) return { count: 0, commits: [], withRemote: false };
    const rb = this.deleteRemote() ? p?.remoteBranch : null;
    if (rb) return { count: rb.unmerged, commits: rb.commits, withRemote: true };
    return { count: p?.unmerged ?? 0, commits: p?.commits ?? [], withRemote: false };
  });

  private readonly needsAck = computed(() => {
    const p = this.plan();
    return !!p && !p.isMain && (p.dirty > 0 || this.lost().count > 0);
  });
  protected readonly canRun = computed(
    () => !!this.plan() && !this.busy() && !this.plan()!.liveElsewhere.length && (!this.needsAck() || this.ack()),
  );

  /** Only the path matters: the 3s poll hands us a new Worktree object each time. */
  private readonly path = computed(() => this.wt().path);

  constructor() {
    effect(() => {
      const path = this.path();
      untracked(() => this.check(path));
    });
  }

  private check(path: string) {
    this.plan.set(null);
    this.ack.set(false);
    this.deleteRemote.set(this.land()); // landing is done with the branch, remote copy included
    this.error.set(null);
    this.http.get<TeardownPlan>(`/api/worktree/check?path=${encodeURIComponent(path)}`).subscribe({
      next: (p) => this.plan.set(p),
      error: (e) => this.error.set(e.error?.error ?? e.message),
    });
  }

  /** What would be lost changes with it, so an earlier acknowledgement no longer counts. */
  protected setDeleteRemote(on: boolean) {
    this.deleteRemote.set(on);
    this.ack.set(false);
  }

  protected run() {
    const p = this.plan();
    if (!p || !this.canRun()) return;
    if (this.land()) {
      this.confirm.emit({ ack: this.ack() || !this.needsAck(), deleteRemote: this.deleteRemote() && !!p.remoteBranch });
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    const deleteRemote = this.deleteRemote() && !!p.remoteBranch;
    this.http.post<ArchiveResult>('/api/worktree/archive', { path: p.path, ack: this.ack(), deleteRemote }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.api.refresh();
        this.done.emit(r);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? e.message);
        // The server found more at-risk work than we showed (it changed meanwhile): re-check.
        if (e.error?.needsAck) this.check(p.path);
      },
    });
  }
}
