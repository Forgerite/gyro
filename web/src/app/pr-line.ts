import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { boardResource, branchFor } from './board-match';
import { Workspace, Worktree } from './model';
import { CHECKS, reviewText } from './wt-flags';

/**
 * The worktree's open PR on GitHub (or a button to have Claude open one), and the GitHub Project
 * entries it's working on. Only for projects linked to GitHub.
 */
@Component({
  selector: 'app-pr-line',
  template: `
    @if (pr(); as p) {
      @if (showPr()) {
      <div class="row">
        <span class="lbl">PR</span>
        <div class="val">
          <a [href]="p.url" target="_blank" rel="noopener" class="num">#{{ p.number }}</a>
          <span class="title" [title]="p.title">{{ p.title }}</span>
          @if (p.draft) { <span class="tag">draft</span> }
          @if (review(); as r) { <span class="tag" [class.bad]="p.review === 'CHANGES_REQUESTED'">{{ r }}</span> }
          @if (p.checks) { <span class="tag" [class.bad]="p.checks === 'fail'">{{ checks[p.checks] }}</span> }
          @for (n of p.closes; track n) { <span class="tag" [title]="'Merging this PR closes issue #' + n">closes #{{ n }}</span> }
          @if (p.base) { <span class="tag">→ {{ p.base }}</span> }
        </div>
      </div>
      }
    } @else if (base(); as b) {
      <div class="row">
        <span class="lbl">PR</span>
        <div class="val">
          @if (since(); as at) {
            <span class="run" role="status"><span class="spin" aria-hidden="true"></span>Claude is opening a PR into {{ b }}… {{ seconds(at) }}s</span>
          } @else {
            <span class="none">none open</span>
            <button type="button" class="create" (click)="api.createPr(wt().path)" [disabled]="api.smartBusy(wt().path)"
                    [title]="'Push ' + wt().branch + ', then Claude writes the title and description (linking the issue it addresses) and opens a PR into ' + b">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11M4 13.5a1.5 1.5 0 1 0 0 .01M4 2.5a1.5 1.5 0 1 0 0 .01M12 13.5a1.5 1.5 0 1 0 0 .01M12 12V6.5c0-1.5-1-2.5-2.5-2.5H7M8.5 2.5 7 4l1.5 1.5" /></svg>
              Create PR
            </button>
          }
        </div>
      </div>
    }
    @if (outcome(); as o) {
      @if (o.error || o.result?.warning) {
        <div class="row" role="status">
          <span class="lbl"></span>
          <div class="val">
            <span [class]="o.error ? 'err' : 'note'">{{ o.error ?? o.result!.warning }}</span>
            <button type="button" class="x" (click)="api.clearPrCreated(wt().path)" aria-label="Dismiss">×</button>
          </div>
        </div>
      }
    }
    @for (e of entries(); track e.id) {
      <div class="row">
        <span class="lbl">Board</span>
        <div class="val">
          <button type="button" class="title open" [title]="'Open: ' + e.title" (click)="api.entry.set({ path: ws().path, id: e.id })">{{ e.title }}</button>
          <span class="tag">{{ e.status ?? 'no status' }}</span>
        </div>
      </div>
    }
  `,
  styles: `
    /* Labels share one column sized to the widest label, so values start right after it. */
    :host { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 8px; row-gap: 3px; font-size: 12px; min-width: 0; }
    :host([hidden]) { display: none; }
    .row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: baseline; min-width: 0; }
    .val { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; }
    .lbl { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    a { color: var(--accent); }
    a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .num { font-weight: 600; }
    .title { flex: 1 1 120px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tag { font-size: 11px; color: var(--text-2); border: 1px solid var(--border); border-radius: 8px; padding: 0 6px; }
    .tag.bad { color: var(--danger); }
    .none { color: var(--muted); }
    .note { color: var(--text-2); font-size: 11px; }
    .err { color: var(--danger); font-size: 11px; white-space: pre-line; }
    .run { color: var(--text-2); }
    .open { all: unset; flex: 1 1 120px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; color: var(--accent); }
    .open:hover { text-decoration: underline; }
    .open:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .create {
      display: inline-flex; align-items: center; gap: 5px; align-self: center;
      padding: 1px 9px; font: inherit; font-size: 11px; cursor: pointer;
      color: var(--accent); background: var(--panel);
      border: 1px solid color-mix(in srgb, var(--accent) 60%, var(--border)); border-radius: 5px; box-shadow: 0 1px 0 var(--border);
    }
    .create:hover:not(:disabled) { border-color: var(--accent); background: var(--hover); }
    .create:active:not(:disabled) { transform: translateY(1px); box-shadow: none; }
    .create:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .create:disabled { opacity: 0.6; cursor: default; }
    .create svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
    .x { all: unset; cursor: pointer; color: var(--muted); padding: 0 4px; }
    .x:hover { color: var(--text); }
    .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .spin {
      display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px;
      border: 2px solid color-mix(in srgb, currentColor 35%, transparent); border-top-color: currentColor;
      border-radius: 50%; animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `,
  host: { '[hidden]': '!(pr() ? showPr() : base()) && !outcome() && !entries().length' },
})
export class PrLine {
  readonly wt = input.required<Worktree>();
  readonly ws = input.required<Workspace>();
  /** The open PR's own row; off where the PR is already shown in full. */
  readonly showPr = input(true);

  protected readonly api = inject(DashboardService);
  protected readonly checks = CHECKS;

  /** Create PR running or finished here. */
  protected readonly since = computed(() => this.api.creatingPr()[this.wt().path] ?? null);
  protected readonly outcome = computed(() => this.api.prCreated()[this.wt().path] ?? null);

  /** The open PR: from the snapshot, or the one Claude just created until the snapshot catches up. */
  protected readonly pr = computed(() => {
    const p = this.wt().pr;
    if (p) return p;
    const o = this.outcome();
    const fresh = o?.result && (this.ws().pulls?.at ?? 0) < (o.at ?? 0);
    return fresh ? { ...o.result!.pr, draft: false, review: null, checks: null, checksRunning: false, base: null } : null;
  });
  protected readonly review = computed(() => reviewText(this.pr()?.review ?? null));

  protected readonly board = boardResource(this.ws).board;
  /** Board entries this worktree's branch is working on: its PR's entry, and entries for issues its PR closes. */
  protected readonly entries = computed(() => {
    const branch = this.wt().branch;
    const ws = this.ws();
    if (!branch) return [];
    return (this.board.value()?.columns ?? []).flatMap((c) => c.items).filter((it) => branchFor(it, ws) === branch);
  });

  /** Branch a new PR would merge into, once the open-PR list has loaded (so we know there's none). */
  protected readonly base = computed(() => {
    const g = this.ws().github;
    const w = this.wt();
    if (!g || !this.ws().pulls || !w.branch || w.detached) return null;
    // || not ??: a link saved while the repo was empty can have "" here.
    const base = g.defaultBranch || w.git.trunk?.replace(/^[^/]+\//, '');
    return base && w.branch !== base ? base : null;
  });

  private readonly clock = signal(Date.now());
  private readonly ticking = effect((onCleanup) => {
    if (this.since() === null) return;
    const id = setInterval(() => this.clock.set(Date.now()), 1000);
    onCleanup(() => clearInterval(id));
  });
  protected seconds(at: number) {
    return Math.max(0, Math.round((this.clock() - at) / 1000));
  }
}
