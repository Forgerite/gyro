import { HttpClient, httpResource } from '@angular/common/http';
import { Component, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { FormField, form, pattern, required } from '@angular/forms/signals';
import { boardResource, branchFor } from './board-match';
import { BoardItem, Workspace } from './model';

interface Bases {
  trunk: string | null;
  branches: { name: string; remote: boolean; at: number }[];
}

export interface NewSession {
  path: string;
  /** The board entry the session is for: claude opens on its description and comments. */
  entry: string | null;
}

/** Same rule the server enforces: a folder name that's also a valid branch name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** How many entries the issue list shows before asking you to filter. */
const SHOWN = 40;

/** "284-update-the-active-work-screen": the issue number, then its title, cut at a word. */
export function suggestName(it: BoardItem): string {
  let slug = it.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 50) slug = slug.slice(0, 50).replace(/-[^-]*$/, '');
  return [it.number, slug].filter((x) => x !== null && x !== '').join('-') || 'work';
}

/** Start a new session in a new worktree: optionally for a board entry, from a branch you pick. */
@Component({
  selector: 'app-new-session',
  imports: [FormField],
  template: `
    <form class="editor" aria-labelledby="ns-h" (submit)="$event.preventDefault(); create()">
      <h3 id="ns-h">New session</h3>

      @if (ws().github?.project) {
        <span class="lbl" id="ns-issue-lbl">Issue <span class="opt">optional</span></span>
        <input #search type="search" [formField]="f.search" placeholder="Filter by title, number, status, label…"
               aria-label="Filter issues" autocomplete="off" spellcheck="false" />
        <div class="choices" role="radiogroup" aria-labelledby="ns-issue-lbl">
          <button type="button" role="radio" class="choice" [attr.aria-checked]="!picked()" (click)="pick(null)">
            <span class="cn">No issue</span>
          </button>
          @for (it of shown(); track it.id) {
            <button type="button" role="radio" class="choice" [attr.aria-checked]="picked()?.id === it.id" (click)="pick(it)">
              <span class="cn">@if (it.number !== null) { <span class="num">#{{ it.number }}</span> }{{ it.title }}</span>
              @if (branchOf(it); as b) { <span class="cm" [title]="'Already being worked on in ' + b">⎇ {{ b }}</span> }
              <span class="cm">{{ it.status ?? 'no status' }}</span>
            </button>
          }
        </div>
        <p class="help">
          @if (boardError(); as e) { <span class="bad">Couldn't load the board: {{ e }}</span> }
          @else if (!board.value()) { Loading the board… }
          @else if (matches().length > shown().length) { Showing {{ shown().length }} of {{ matches().length }}; filter to find others. }
          @else if (!matches().length) { No open entries match. }
          @else { Open entries on {{ ws().github!.project!.title }}. }
        </p>
      }

      <label class="field">
        <span class="lbl">Start from</span>
        <select [formField]="f.base">
          @if (!bases.hasValue()) { <option value="">Loading branches…</option> }
          <optgroup label="Remote">
            @for (b of remote(); track b.name) { <option [value]="b.name">{{ b.name }}</option> }
          </optgroup>
          <optgroup label="Local">
            @for (b of local(); track b.name) { <option [value]="b.name">{{ b.name }}</option> }
          </optgroup>
        </select>
      </label>

      <label class="field">
        <span class="lbl">Name</span>
        <input type="text" [formField]="f.name" autocomplete="off" spellcheck="false" placeholder="e.g. 123-fix-login"
               [attr.aria-invalid]="nameBad()" aria-describedby="ns-name-help" (input)="named = true" />
      </label>
      <p id="ns-name-help" class="help" [class.bad]="nameBad()">
        @if (nameBad()) { Letters, numbers, dot, dash or underscore, starting with a letter or number. }
        @else if (model().name) { New branch <code>{{ model().name }}</code> in <code>{{ ws().name }}.worktrees/{{ model().name }}</code> }
        @else { Names the branch and the worktree folder. }
      </p>

      @if (picked()) {
        <label class="check">
          <input type="checkbox" [formField]="f.brief" />
          Brief Claude on this issue: its description and comments go in the first message, then it waits for yours
        </label>
      }

      <div class="actions">
        @if (error(); as e) { <span class="err" role="alert">{{ e }}</span> }
        <span class="spacer"></span>
        <button type="button" class="link" (click)="cancel.emit()">cancel</button>
        <button type="submit" class="cta" [disabled]="busy() || f().invalid() || !bases.hasValue()">
          {{ busy() ? 'Creating…' : 'Create and start' }}
        </button>
      </div>
    </form>
  `,
  styleUrl: './github-section.css',
  styles: `
    h3 { margin: 0 0 2px; }
    select { font: inherit; padding: 3px 5px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; }
    select:focus-visible, input[type='search']:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    input[type='search'] { font: inherit; padding: 4px 7px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; }
    .opt { font-weight: 400; text-transform: none; letter-spacing: 0; }
    .num { color: var(--muted); margin-right: 5px; font-variant-numeric: tabular-nums; }
    .choices { max-height: 220px; }
    .cm { max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
    .check { display: flex; gap: 6px; align-items: center; font-size: 12px; }
    .help .bad { color: var(--danger); }
  `,
  host: { '(keydown.escape)': 'cancel.emit()' },
})
export class NewSessionForm {
  readonly ws = input.required<Workspace>();
  readonly started = output<NewSession>();
  readonly cancel = output<void>();

  private readonly http = inject(HttpClient);
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly model = signal({ search: '', base: '', name: '', brief: true });
  protected readonly f = form(this.model, (p) => {
    required(p.base);
    required(p.name);
    pattern(p.name, NAME);
  });
  protected readonly nameBad = computed(() => !!this.model().name && this.f.name().invalid());
  /** Typed into the name field: stop replacing it with suggestions. */
  protected named = false;

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly boardRes = boardResource(this.ws);
  protected readonly board = this.boardRes.board;
  protected readonly boardError = this.boardRes.error;
  /** Open entries, in board order. */
  private readonly open = computed(() => (this.board.value()?.columns ?? []).filter((c) => !c.done).flatMap((c) => c.items));
  protected readonly matches = computed(() => {
    const q = this.model().search.trim().toLowerCase();
    if (!q) return this.open();
    return this.open().filter((it) =>
      [it.title, it.number !== null ? `#${it.number} ${it.number}` : '', it.status ?? '', ...it.labels, ...it.assignees].join(' ').toLowerCase().includes(q),
    );
  });
  protected readonly shown = computed(() => this.matches().slice(0, SHOWN));
  protected readonly picked = signal<BoardItem | null>(null);

  protected readonly bases = httpResource<Bases>(() => ({ url: '/api/worktrees/bases', params: { path: this.ws().path } }));
  protected readonly remote = computed(() => (this.bases.hasValue() ? this.bases.value().branches.filter((b) => b.remote) : []));
  protected readonly local = computed(() => (this.bases.hasValue() ? this.bases.value().branches.filter((b) => !b.remote) : []));

  constructor() {
    // Default to the trunk once the branches are in.
    effect(() => {
      const trunk = this.bases.hasValue() ? this.bases.value().trunk : null;
      if (trunk && !untracked(this.model).base) this.model.update((m) => ({ ...m, base: trunk }));
    });
    afterNextRender(() => this.search()?.nativeElement.focus());
  }

  protected branchOf(it: BoardItem): string | null {
    return branchFor(it, this.ws());
  }

  protected pick(it: BoardItem | null): void {
    this.picked.set(it);
    if (it && !this.named) this.model.update((m) => ({ ...m, name: suggestName(it) }));
  }

  protected create(): void {
    if (this.busy() || this.f().invalid()) return;
    const { name, base, brief } = this.model();
    const it = this.picked();
    const entry = it && brief ? it.id : null;
    this.busy.set(true);
    this.error.set(null);
    // The picked entry links the work session even when claude isn't briefed on it.
    this.http.post<{ path: string }>('/api/worktrees/create', { path: this.ws().path, name: name.trim(), base, entry: it?.id ?? null, issue: it?.number ?? null }).subscribe({
      next: ({ path }) => {
        this.busy.set(false);
        this.started.emit({ path, entry });
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }
}
