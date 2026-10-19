import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import { Component, ElementRef, ViewEncapsulation, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';
import { BoardEntry, EntryTarget } from './model';

/**
 * A GitHub Project entry, read inline: its body and comments as GitHub renders them, and its place
 * in the board's workflow, which you can move it along from here.
 */
@Component({
  selector: 'app-entry-view',
  imports: [AgoPipe],
  template: `
    <header>
      <nav class="crumb" aria-label="Breadcrumb">
        <button type="button" class="link" (click)="close()" title="Back (Esc)">← {{ wsName() }}</button>
        @if (ws()?.github?.project; as p) { <span class="muted">› {{ p.title }}</span> }
      </nav>
      @if (entry(); as e) {
        <h2 #heading tabindex="-1">
          <span class="kind" aria-hidden="true">{{ e.kind === 'pr' ? '⇅' : e.kind === 'draft' ? '✎' : '○' }}</span>
          {{ e.title }}
          @if (e.number !== null) { <span class="num">#{{ e.number }}</span> }
        </h2>
        <div class="meta">
          <span>{{ e.kind === 'pr' ? 'Pull request' : e.kind === 'issue' ? 'Issue' : 'Draft' }}</span>
          @if (e.author) { <span>by {{ e.author }}</span> }
          @if (e.createdAt) { <span>{{ e.createdAt | ago: now() }} ago</span> }
          @if (e.repo) { <span>{{ e.repo }}</span> }
          @if (e.state && e.state !== 'OPEN') { <span class="tag">{{ e.state.toLowerCase() }}</span> }
          @if (e.draft) { <span class="tag">draft</span> }
          @for (l of e.labels; track l) { <span class="tag">{{ l }}</span> }
          @for (a of e.assignees; track a) { <span>&#64;{{ a }}</span> }
        </div>
        <div class="links">
          <a [href]="e.url" target="_blank" rel="noopener">Open on the board</a>
          @if (e.contentUrl) { <a [href]="e.contentUrl" target="_blank" rel="noopener">Open the {{ e.kind === 'pr' ? 'pull request' : 'issue' }}</a> }
        </div>

        <section class="flow" aria-labelledby="flow-h">
          <div class="flow-head">
            <h3 id="flow-h">Status</h3>
            @if (moving()) { <span class="muted" role="status">Moving…</span> }
            @if (prev(); as p) {
              <button type="button" class="step" (click)="move(p.id)" [disabled]="busy()">← {{ p.name }}</button>
            }
            @if (next(); as n) {
              <button type="button" class="step cta" (click)="move(n.id)" [disabled]="busy()">{{ n.name }} →</button>
            }
          </div>
          <ol class="stages">
            @for (o of e.options; track o.id) {
              <li>
                <button type="button" class="stage" [class.current]="o.id === e.statusId" [class.done-col]="o.done"
                        [attr.aria-current]="o.id === e.statusId ? 'step' : null" [disabled]="busy() || o.id === e.statusId"
                        (click)="move(o.id)" [title]="o.id === e.statusId ? 'Current status' : 'Move to ' + o.name">
                  <span class="swatch" [attr.data-color]="o.color" aria-hidden="true"></span>{{ o.name }}
                </button>
              </li>
            }
          </ol>
          @if (!e.statusId) { <p class="muted">No status yet.</p> }
          @if (moveError(); as m) { <p class="err" role="alert">{{ m }}</p> }
        </section>
      }
    </header>

    <div class="body" (click)="externalLinks($event)">
      @if (errorText(); as m) {
        <p class="err" role="alert">{{ m }}</p>
      } @else if (entry(); as e) {
        @if (e.bodyHTML) { <div class="md" [innerHTML]="e.bodyHTML"></div> } @else { <p class="muted">No description.</p> }
        @if (e.commentCount) {
          <h3 class="c-h">Comments <span class="muted">{{ e.commentCount }}</span></h3>
          @if (e.commentCount > e.comments.length) {
            <p class="muted">Showing the latest {{ e.comments.length }}. <a [href]="e.contentUrl" target="_blank" rel="noopener">All on GitHub</a></p>
          }
          @for (c of e.comments; track c.id) {
            <article class="comment" [attr.aria-label]="'Comment by ' + c.author">
              <div class="c-meta"><strong>{{ c.author }}</strong> @if (c.createdAt) { · {{ c.createdAt | ago: now() }} ago }</div>
              <div class="md" [innerHTML]="c.bodyHTML"></div>
            </article>
          }
        }
      } @else {
        <p class="muted">Loading…</p>
      }
    </div>
  `,
  styleUrl: './entry-view.css',
  // GitHub's rendered markdown is styled too, so these rules aren't scoped (they're all under app-entry-view).
  encapsulation: ViewEncapsulation.None,
})
export class EntryView {
  readonly target = input.required<EntryTarget>();

  private readonly http = inject(HttpClient);
  private readonly api = inject(DashboardService);
  protected readonly now = this.api.now;
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  protected readonly ws = computed(() => this.api.snapshot()?.workspaces.find((w) => w.path === this.target().path) ?? null);
  protected readonly wsName = computed(() => this.ws()?.name ?? 'Back');

  private readonly res = httpResource<BoardEntry>(() => ({ url: '/api/github/entry', params: { path: this.target().path, id: this.target().id } }));
  protected readonly entry = computed(() => (this.res.hasValue() ? this.res.value() : null));
  protected readonly errorText = computed(() => {
    const e = this.res.error();
    if (!e) return null;
    return e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e);
  });

  /** The neighbouring columns: one click to move it along (or back). */
  private readonly index = computed(() => {
    const e = this.entry();
    return e ? e.options.findIndex((o) => o.id === e.statusId) : -1;
  });
  protected readonly next = computed(() => this.entry()?.options[this.index() + 1] ?? null);
  protected readonly prev = computed(() => (this.index() > 0 ? this.entry()!.options[this.index() - 1] : null));

  protected readonly moving = signal(false);
  protected readonly moveError = signal<string | null>(null);
  protected readonly busy = computed(() => this.moving() || this.res.isLoading());

  /** Land focus on the title when an entry opens, so keyboard and screen reader users start there. */
  private readonly focusOnOpen = effect(() => this.heading()?.nativeElement.focus());

  protected move(status: string): void {
    const e = this.entry();
    if (!e || this.moving()) return;
    const was = e.statusId;
    this.res.value.set({ ...e, statusId: status }); // show it moved; undone if GitHub refuses
    this.moving.set(true);
    this.moveError.set(null);
    this.http.post<BoardEntry>('/api/github/entry/move', { path: this.target().path, id: e.id, status }).subscribe({
      next: (moved) => {
        this.moving.set(false);
        this.res.value.set(moved);
        this.api.boardChanged();
        // The button you pressed may be gone now (no next column): keep focus in the panel.
        setTimeout(() => {
          if (!document.activeElement || document.activeElement === document.body) this.heading()?.nativeElement.focus();
        });
      },
      error: (err) => {
        this.moving.set(false);
        this.res.value.set({ ...e, statusId: was });
        this.moveError.set(err.error?.error ?? err.message);
      },
    });
  }

  protected close(): void {
    this.api.entry.set(null);
  }

  /** Links inside GitHub's markdown open in a new tab, like every other GitHub link here. */
  protected externalLinks(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a || !a.closest('.md') || !a.href || a.target === '_blank') return;
    ev.preventDefault();
    window.open(a.href, '_blank', 'noopener');
  }
}
