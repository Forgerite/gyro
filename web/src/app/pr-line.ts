import { Component, computed, inject, input } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { boardResource, branchFor } from './board-match';
import { Workspace, Worktree } from './model';
import { CHECKS, reviewText } from './wt-flags';

/**
 * The worktree's open PR on GitHub (or a link to open one), and the GitHub Project entries it's
 * working on. Only for projects linked to GitHub.
 */
@Component({
  selector: 'app-pr-line',
  template: `
    @if (wt().pr; as p) {
      <div class="row">
        <span class="lbl">PR</span>
        <a [href]="p.url" target="_blank" rel="noopener" class="num">#{{ p.number }}</a>
        <span class="title" [title]="p.title">{{ p.title }}</span>
        @if (p.draft) { <span class="tag">draft</span> }
        @if (review(); as r) { <span class="tag" [class.bad]="p.review === 'CHANGES_REQUESTED'">{{ r }}</span> }
        @if (p.checks) { <span class="tag" [class.bad]="p.checks === 'fail'">{{ checks[p.checks] }}</span> }
        <span class="tag">→ {{ p.base }}</span>
      </div>
    } @else if (compareUrl(); as url) {
      <div class="row">
        <span class="lbl">PR</span>
        <span class="none">none open</span>
        <a [href]="url" target="_blank" rel="noopener">Open one on GitHub</a>
      </div>
    }
    @for (e of entries(); track e.id) {
      <div class="row">
        <span class="lbl">Board</span>
        <button type="button" class="title open" [title]="'Open: ' + e.title" (click)="api.entry.set({ path: ws().path, id: e.id })">{{ e.title }}</button>
        <span class="tag">{{ e.status ?? 'no status' }}</span>
      </div>
    }
  `,
  styles: `
    :host { display: grid; gap: 3px; font-size: 12px; min-width: 0; }
    :host([hidden]) { display: none; }
    .row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; }
    .lbl { width: 38px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    a { color: var(--accent); }
    a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .num { font-weight: 600; }
    .title { flex: 1 1 120px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tag { font-size: 11px; color: var(--text-2); border: 1px solid var(--border); border-radius: 8px; padding: 0 6px; }
    .tag.bad { color: var(--danger); }
    .none { color: var(--muted); }
    .open { all: unset; flex: 1 1 120px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; color: var(--accent); }
    .open:hover { text-decoration: underline; }
    .open:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  `,
  host: { '[hidden]': '!wt().pr && !compareUrl() && !entries().length' },
})
export class PrLine {
  readonly wt = input.required<Worktree>();
  readonly ws = input.required<Workspace>();

  protected readonly api = inject(DashboardService);
  protected readonly checks = CHECKS;
  protected readonly review = computed(() => reviewText(this.wt().pr?.review ?? null));

  protected readonly board = boardResource(this.ws).board;
  /** Board entries this worktree's branch is working on: its PR's entry, and entries for issues its PR closes. */
  protected readonly entries = computed(() => {
    const branch = this.wt().branch;
    const ws = this.ws();
    if (!branch) return [];
    return (this.board.value()?.columns ?? []).flatMap((c) => c.items).filter((it) => branchFor(it, ws) === branch);
  });

  /** GitHub's "open a pull request" page for this branch, once the open-PR list has loaded. */
  protected readonly compareUrl = computed(() => {
    const g = this.ws().github;
    const w = this.wt();
    if (!g || !this.ws().pulls || !w.branch || w.detached) return null;
    const base = g.defaultBranch ?? w.git.trunk?.replace(/^[^/]+\//, '');
    if (!base || w.branch === base) return null;
    return `${g.url}/compare/${encodeURIComponent(base)}...${encodeURIComponent(w.branch)}?expand=1`;
  });
}
