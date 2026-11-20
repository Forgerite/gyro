import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import { Component, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { BoardEntry, BoardItem, Workspace } from './model';

/** What the server did: the issue, the column it went to, and the comment, if one was posted. */
export interface NoxStarted {
  issueId: string;
  number: number | null;
  status: string;
  commentUrl: string | null;
}

/** GET /api/nox/backlog: the Backlog of the board Lumos works, this repo's issues only. */
interface Backlog {
  project: { owner: string; number: number; title: string; url: string };
  /** The Backlog column's name; null when the board has none. */
  column: string | null;
  items: BoardItem[];
  truncated: boolean;
  fetchedAt: number;
}
const SHOWN = 40;

/**
 * Hand a backlog issue to Nox Lumos: pick one from the board's Backlog, read it, add an optional comment
 * (posted first, so Lumos's run reads it), and move it to Ready for Analysis, where Lumos picks it up.
 */
@Component({
  selector: 'app-nox-start',
  imports: [FormField],
  template: `
    <form class="editor" aria-labelledby="nxs-h" (submit)="$event.preventDefault(); start()">
      <h3 id="nxs-h">Start a Lumos ticket</h3>

      <span class="lbl" id="nxs-issue-lbl">Backlog</span>
      <input #search type="search" [formField]="f.search" placeholder="Filter by title, number, label…"
             aria-label="Filter backlog issues" autocomplete="off" spellcheck="false" />
      <div class="choices" role="radiogroup" aria-labelledby="nxs-issue-lbl">
        @for (it of shown(); track it.id) {
          <button type="button" role="radio" class="choice" [attr.aria-checked]="picked()?.id === it.id" (click)="picked.set(it)">
            <span class="cn">@if (it.number !== null) { <span class="num">#{{ it.number }}</span> }{{ it.title }}</span>
            @for (l of it.labels.slice(0, 2); track l) { <span class="cm">{{ l }}</span> }
          </button>
        }
      </div>
      <p class="help">
        @if (backlogError(); as e) { <span class="bad">{{ e }}</span> }
        @else if (!backlog.hasValue()) { Finding the board Lumos works… }
        @else if (!backlog.value().column) { <span class="bad">{{ backlog.value().project.title }} has no Backlog column.</span> }
        @else if (!issues().length) { Nothing in the Backlog of {{ backlog.value().project.title }}. }
        @else if (matches().length > shown().length) { Showing {{ shown().length }} of {{ matches().length }}; filter to find others. }
        @else if (!matches().length) { No backlog issues match. }
        @else { {{ ws().nox!.repo }} issues in {{ backlog.value().column }} on <a [href]="backlog.value().project.url" target="_blank" rel="noopener">{{ backlog.value().project.title }}</a>. }
      </p>

      @if (picked(); as it) {
        <section class="detail" aria-labelledby="nxs-d-h">
          <div class="d-head">
            <h4 id="nxs-d-h">@if (it.number !== null) { <span class="num">#{{ it.number }}</span> }{{ it.title }}</h4>
            @if (it.contentUrl) { <a [href]="it.contentUrl" target="_blank" rel="noopener">GitHub</a> }
          </div>
          @if (entry.hasValue()) {
            @let e = entry.value();
            <div class="d-meta">
              @if (e.author) { <span>by {{ e.author }}</span> }
              @for (l of e.labels; track l) { <span class="tag">{{ l }}</span> }
              @for (a of e.assignees; track a) { <span>&#64;{{ a }}</span> }
              <span>{{ e.commentCount }} comment{{ e.commentCount === 1 ? '' : 's' }}</span>
            </div>
            <div class="md body" (click)="externalLinks($event)">
              @if (e.bodyHTML) { <div [innerHTML]="e.bodyHTML"></div> } @else { <p class="muted">No description.</p> }
            </div>
          } @else if (entryError(); as m) {
            <p class="help"><span class="bad">{{ m }}</span></p>
          } @else {
            <p class="muted">Loading the issue…</p>
          }
        </section>

        <label class="field">
          <span class="lbl">Comment <span class="opt">optional</span></span>
          <textarea [formField]="f.comment" rows="3" aria-describedby="nxs-c-help"
                    placeholder="Anything Lumos should know before it analyses this…"></textarea>
        </label>
        <p id="nxs-c-help" class="help">Posted on the issue as you before it moves, so Lumos reads it in its analysis.</p>
      }

      <div class="actions">
        @if (error(); as e) { <span class="err" role="alert">{{ e }}</span> }
        <span class="spacer"></span>
        <button type="button" class="link" (click)="cancel.emit()">cancel</button>
        <button type="submit" class="cta" [disabled]="busy() || !picked()">
          {{ busy() ? 'Moving…' : 'Move to Ready for Analysis' }}
        </button>
      </div>
    </form>
  `,
  styleUrl: './github-section.css',
  styles: `
    h3 { margin: 0 0 2px; }
    input[type='search'], textarea { font: inherit; padding: 4px 7px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; }
    textarea { resize: vertical; min-height: 44px; max-height: 40vh; }
    input[type='search']:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .opt { font-weight: 400; text-transform: none; letter-spacing: 0; }
    .num { color: var(--muted); margin-right: 5px; font-variant-numeric: tabular-nums; }
    .choices { max-height: 220px; }
    .cm { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
    .help .bad { color: var(--danger); }
    .detail { display: grid; gap: 4px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); }
    .d-head { display: flex; align-items: baseline; gap: 8px; }
    .d-head h4 { margin: 0; font-size: 13px; flex: 1; min-width: 0; }
    .d-head a { font-size: 11px; white-space: nowrap; }
    .d-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: 11px; color: var(--muted); }
    .tag { padding: 0 6px; border: 1px solid var(--border); border-radius: 999px; }
    .body { max-height: 280px; overflow-y: auto; margin-top: 4px; }
  `,
  host: { '(keydown.escape)': 'cancel.emit()' },
})
export class NoxStartForm {
  readonly ws = input.required<Workspace>();
  readonly started = output<NoxStarted>();
  readonly cancel = output<void>();

  private readonly http = inject(HttpClient);
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly model = signal({ search: '', comment: '' });
  protected readonly f = form(this.model);

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Keyed on the path, so a new snapshot doesn't refetch it. */
  private readonly path = computed(() => this.ws().path);
  protected readonly backlog = httpResource<Backlog>(() => ({ url: '/api/nox/backlog', params: { path: this.path() } }));
  protected readonly backlogError = computed(() => errorText(this.backlog.error()));
  protected readonly issues = computed(() => (this.backlog.hasValue() ? this.backlog.value().items : []));
  protected readonly matches = computed(() => {
    const q = this.model().search.trim().toLowerCase();
    if (!q) return this.issues();
    return this.issues().filter((it) =>
      [it.title, it.number !== null ? `#${it.number} ${it.number}` : '', ...it.labels, ...it.assignees].join(' ').toLowerCase().includes(q),
    );
  });
  protected readonly shown = computed(() => this.matches().slice(0, SHOWN));
  protected readonly picked = signal<BoardItem | null>(null);

  protected readonly entry = httpResource<BoardEntry>(() => {
    const it = this.picked();
    return it ? { url: '/api/nox/entry', params: { path: this.path(), id: it.id } } : undefined;
  });
  protected readonly entryError = computed(() => errorText(this.entry.error()));

  constructor() {
    afterNextRender(() => this.search()?.nativeElement.focus());
  }

  protected start(): void {
    const it = this.picked();
    if (this.busy() || !it) return;
    this.busy.set(true);
    this.error.set(null);
    this.http.post<NoxStarted>('/api/nox/start', { path: this.ws().path, id: it.id, comment: this.model().comment }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.started.emit(r);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }

  /** Links inside GitHub's markdown open in a new tab, like every other GitHub link here. */
  protected externalLinks(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a || !a.href || a.target === '_blank') return;
    ev.preventDefault();
    window.open(a.href, '_blank', 'noopener');
  }
}

function errorText(e: unknown): string | null {
  if (!e) return null;
  return e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e);
}
