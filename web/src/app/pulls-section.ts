import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';
import { Workspace } from './model';
import { CHECKS, reviewText } from './wt-flags';

/** The linked repo's open PRs, each tied to the worktree that has its branch checked out. */
@Component({
  selector: 'app-pulls-section',
  imports: [AgoPipe],
  template: `
    @let pulls = ws().pulls;
    <div class="head">
      <h3 id="pr-h">Pull requests @if (pulls) { <span class="count">{{ pulls.list.length }}</span> }</h3>
      <button type="button" class="link" (click)="reload()" [disabled]="busy()">{{ busy() ? 'refreshing…' : 'refresh' }}</button>
      @if (pulls) { @let ago = pulls.at | ago: now(); <span class="when">{{ ago === 'now' ? 'just now' : 'as of ' + ago + ' ago' }}</span> }
    </div>
    @if (error() ?? pulls?.error; as e) { <p class="err" role="alert">{{ e }}</p> }
    @if (!pulls) {
      <p class="muted">Loading…</p>
    } @else if (!rows().length) {
      <p class="muted">No open pull requests.</p>
    } @else {
      <ul class="items" aria-labelledby="pr-h">
        @for (r of rows(); track r.p.number) {
          <li class="item">
            <span class="kind" aria-hidden="true">⇅</span>
            <a class="num" [href]="r.p.url" target="_blank" rel="noopener">#{{ r.p.number }}</a>
            <span class="t" [title]="r.p.title">{{ r.p.title }}</span>
            @if (r.wt; as wt) {
              <button type="button" class="chip" (click)="pick.emit(wt.path)" [title]="'Open worktree ' + wt.name">⎇ {{ wt.name }}</button>
            }
            <span class="meta wide">
              @if (!r.wt) { <span [title]="'No worktree has ' + r.p.branch + ' checked out'">{{ r.p.branch }}</span> · }
              @if (r.p.draft) { draft · }
              @if (r.review) { <span [class.bad]="r.p.review === 'CHANGES_REQUESTED'">{{ r.review }}</span> · }
              @if (r.p.checks) { <span [class.bad]="r.p.checks === 'fail'">{{ checks[r.p.checks] }}</span> · }
              {{ r.p.author }}
            </span>
          </li>
        }
      </ul>
    }
  `,
  styleUrl: './gh-lists.css',
})
export class PullsSection {
  readonly ws = input.required<Workspace>();
  readonly now = input.required<number>();
  /** Drill into a worktree by path. */
  readonly pick = output<string>();

  private readonly http = inject(HttpClient);
  private readonly api = inject(DashboardService);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly checks = CHECKS;

  /** PRs with a worktree first (that's where you'd act on them), then newest. */
  protected readonly rows = computed(() => {
    const wts = this.ws().worktrees;
    return (this.ws().pulls?.list ?? [])
      .map((p) => ({ p, wt: wts.find((w) => w.branch === p.branch) ?? null, review: reviewText(p.review) }))
      .sort((a, b) => Number(!!b.wt) - Number(!!a.wt) || (b.p.updatedAt ?? 0) - (a.p.updatedAt ?? 0));
  });

  protected reload(): void {
    this.busy.set(true);
    this.error.set(null);
    this.http.post('/api/github/refresh', { path: this.ws().path }).subscribe({
      next: () => {
        this.busy.set(false);
        this.api.refresh();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }
}
