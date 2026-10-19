import { Component, computed, inject, input, output, signal } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { AgoPipe } from './ago.pipe';
import { boardResource, branchFor } from './board-match';
import { BoardItem, Workspace } from './model';

/** Long columns show this many until expanded. */
const FIRST = 25;

/** The linked GitHub Project, column by column, with entries tied to the worktrees working on them. */
@Component({
  selector: 'app-board-section',
  imports: [AgoPipe],
  template: `
    <div class="head">
      <h3 id="board-h">Board</h3>
      @if (ws().github?.project; as p) { <a class="sub" [href]="p.url" target="_blank" rel="noopener">{{ p.title }}</a> }
      <button type="button" class="link" (click)="fresh.set(fresh() + 1)" [disabled]="board.isLoading()">{{ board.isLoading() ? 'loading…' : 'refresh' }}</button>
      @if (board.value(); as b) { @let ago = b.fetchedAt | ago: now(); <span class="when">{{ ago === 'now' ? 'just now' : 'as of ' + ago + ' ago' }}</span> }
    </div>
    @if (error(); as e) { <p class="err" role="alert">{{ e }}</p> }
    @if (board.value(); as b) {
      @if (b.truncated) { <p class="muted">Showing the first {{ shownCount() }} of {{ b.total }} entries.</p> }
      @for (col of b.columns; track col.name) {
        @let open = isOpen(col.name, col.done);
        <section class="col" [attr.aria-label]="col.name">
          <button type="button" class="col-h" [attr.aria-expanded]="open" (click)="toggle(col.name, col.done)" [disabled]="!col.items.length">
            <span aria-hidden="true">{{ col.items.length ? (open ? '▾' : '▸') : '·' }}</span>
            <span class="swatch" [attr.data-color]="col.color" aria-hidden="true"></span>
            {{ col.name }} <span class="count">{{ col.items.length }}</span>
          </button>
          @if (open && col.items.length) {
            <ul class="items">
              @for (it of visible(col.name, col.items); track it.id) {
                @let wt = worktreeFor(it);
                <li class="item" [class.closed]="it.done">
                  <span class="kind" role="img" [attr.aria-label]="kindLabel(it)" [title]="kindLabel(it)">{{ it.kind === 'pr' ? '⇅' : it.kind === 'draft' ? '✎' : '○' }}</span>
                  <a class="num" [href]="it.url" target="_blank" rel="noopener" [title]="'Open the entry on ' + b.title">{{ it.number !== null ? '#' + it.number : 'draft' }}</a>
                  <button type="button" class="t open" [title]="'Open: ' + it.title" (click)="api.entry.set({ path: ws().path, id: it.id })">{{ it.title }}</button>
                  @if (wt) {
                    <button type="button" class="chip" (click)="pick.emit(wt.path)" [title]="'Being worked on in ' + wt.name">⎇ {{ wt.name }}</button>
                  }
                  @let other = it.repo && it.repo.toLowerCase() !== repo();
                  @if (other || it.labels.length || it.assignees.length) {
                    <span class="meta wide">
                      @if (other) { <span class="repo">{{ it.repo }}</span> }
                      @for (l of it.labels; track l) { <span class="label">{{ l }}</span> }
                      @for (a of it.assignees; track a) { <span>&#64;{{ a }}</span> }
                    </span>
                  }
                </li>
              }
            </ul>
            @if (col.items.length > FIRST && !expanded()[col.name]) {
              <button type="button" class="link more" (click)="expand(col.name)">show all {{ col.items.length }}</button>
            }
          }
        </section>
      }
    } @else if (board.isLoading()) {
      <p class="muted">Loading the board…</p>
    }
  `,
  styleUrl: './gh-lists.css',
})
export class BoardSection {
  readonly ws = input.required<Workspace>();
  readonly now = input.required<number>();
  /** Drill into a worktree by path. */
  readonly pick = output<string>();

  protected readonly api = inject(DashboardService);
  protected readonly FIRST = FIRST;
  /** Bumped by "refresh": asks the server to skip its cache. */
  protected readonly fresh = signal(0);
  private readonly res = boardResource(this.ws, this.fresh);
  protected readonly board = this.res.board;
  protected readonly error = this.res.error;
  protected readonly repo = computed(() => this.ws().github?.repo.toLowerCase() ?? null);
  protected readonly shownCount = computed(() => this.board.value()?.columns.reduce((n, c) => n + c.items.length, 0) ?? 0);

  /** Open/closed per column, once you've toggled it; until then finished columns start closed. */
  private readonly toggled = signal<Record<string, boolean>>({});
  protected readonly expanded = signal<Record<string, boolean>>({});

  protected isOpen(name: string, done: boolean): boolean {
    return this.toggled()[name] ?? !done;
  }
  protected toggle(name: string, done: boolean): void {
    const open = this.isOpen(name, done);
    this.toggled.update((t) => ({ ...t, [name]: !open }));
  }
  protected expand(name: string): void {
    this.expanded.update((e) => ({ ...e, [name]: true }));
  }
  protected visible(name: string, items: BoardItem[]): BoardItem[] {
    return this.expanded()[name] ? items : items.slice(0, FIRST);
  }

  /** The worktree on an unfinished entry, if any. */
  protected worktreeFor(it: BoardItem) {
    if (it.done) return null;
    const branch = branchFor(it, this.ws());
    return branch ? (this.ws().worktrees.find((w) => w.branch === branch) ?? null) : null;
  }

  protected kindLabel(it: BoardItem): string {
    const kind = it.kind === 'pr' ? 'Pull request' : it.kind === 'issue' ? 'Issue' : 'Draft';
    return `${kind} entry, ${it.status ?? 'no status'}`;
  }
}
