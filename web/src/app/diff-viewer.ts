import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DashboardService, DiffSide, workingEntries } from './dashboard.service';
import { keepSelection } from './git-tab';
import { ParsedDiff, parseDiff, splitRows } from './diff-parse';
import { baseOf, dirOf, fileStatus } from './file-status';
import { NgTemplateOutlet } from '@angular/common';
import { ChangedFile } from './model';

/** Full-size diff of one changed file, inline or side by side. Opened from the Git tab's file list. */
@Component({
  selector: 'app-diff-viewer',
  imports: [NgTemplateOutlet],
  template: `
    @if (api.diffView(); as d) {
      @if (d.commit; as c) {
        <div class="commit-bar">
          <code>{{ c.short }}</code>
          <span class="c-subj" [title]="c.body || c.subject">{{ c.subject }}</span>
          <span class="c-meta">{{ c.author }} · {{ when(c.at) }}{{ c.parents.length > 1 ? ' · merge, vs first parent' : c.parents.length === 0 ? ' · first commit' : '' }}</span>
        </div>
      }
      <div class="pane">
      <nav class="files" aria-label="Changed files">
        <div class="lists">
          @if (d.commit) {
            @for (f of d.files; track f.path) {
              <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: f, group: null }" />
            } @empty {
              <p class="msg">No files.</p>
            }
          } @else {
            <div class="grp">
              <span>Staged <b>{{ staged().length }}</b></span>
              @if (staged().length) { <button type="button" class="g-act" (click)="run('unstage', null)" [disabled]="busy()">unstage all</button> }
            </div>
            @for (f of staged(); track f.path) {
              <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: f, group: 'staged' }" />
            } @empty {
              <p class="empty-grp">Stage files to include them in the commit.</p>
            }

            <div class="grp">
              <span>Unstaged <b>{{ unstaged().length }}</b></span>
              @if (unstaged().length) {
                <button type="button" class="g-act" (click)="run('stage', paths(unstaged()))" [disabled]="busy()">stage all</button>
                <button type="button" class="g-act danger-t" (click)="confirmDiscard.set(paths(unstaged()))" [disabled]="busy()">discard all</button>
              }
            </div>
            @if (confirmDiscard(); as c) {
              <div class="discard-confirm" role="alertdialog" aria-label="Confirm discard">
                <div>Discard changes to {{ c.length === 1 ? baseOf(c[0]) : c.length + ' files' }}? This can't be undone; new files are deleted.</div>
                <button type="button" class="danger" (click)="run('discard', c)" [disabled]="busy()">Discard</button>
                <button type="button" class="g-act" (click)="confirmDiscard.set(null)">Cancel</button>
              </div>
            }
            @for (f of unstaged(); track f.path) {
              <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: f, group: 'unstaged' }" />
            } @empty {
              <p class="empty-grp">Nothing unstaged.</p>
            }
          }
        </div>

        @if (!d.commit) {
          <div class="commit-box">
            <textarea rows="3" placeholder="Commit message" aria-label="Commit message"
                      [value]="message()" (input)="message.set($any($event.target).value)"
                      (keydown.control.enter)="run('commit', null)"></textarea>
            @if (actionError()) { <div class="act-err" role="alert">{{ actionError() }}</div> }
            <button type="button" class="commit-btn" (click)="run('commit', null)"
                    [disabled]="busy() || !staged().length || !message().trim()" title="Commit (Ctrl+Enter)">
              {{ busy() ? 'Working…' : 'Commit ' + staged().length + ' staged file' + (staged().length === 1 ? '' : 's') }}
            </button>
          </div>
        }
      </nav>

      <ng-template #row let-f let-group="group">
        @let st = status(f);
        @let on = f.path === d.file && (d.commit || group === d.view);
        <div class="f-row" [class.on]="on">
          <button type="button" class="f" (click)="pick(f.path, group)" [attr.aria-current]="on"
                  [title]="f.from ? f.from + ' → ' + f.path : f.path">
            <span class="st" [class]="'st ' + st.cls" [title]="st.title">{{ st.letter }}</span>
            <span class="fname">{{ baseOf(f.path) }}<span class="fdir">{{ dirOf(f.path) }}</span></span>
            <span class="fnums">
              @if (f.added !== null) { <span class="n-add">+{{ f.added }}</span> }
              @if (f.removed !== null) { <span class="n-del">−{{ f.removed }}</span> }
            </span>
          </button>
          @if (group === 'staged') {
            <button type="button" class="ia" (click)="run('unstage', [f.path])" [disabled]="busy()" title="Unstage" aria-label="Unstage file">−</button>
          } @else if (group === 'unstaged') {
            <button type="button" class="ia" (click)="run('stage', [f.path])" [disabled]="busy()" title="Stage" aria-label="Stage file">+</button>
            <button type="button" class="ia danger-t" (click)="confirmDiscard.set([f.path])" [disabled]="busy()" title="Discard changes" aria-label="Discard changes">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" /></svg>
            </button>
          }
        </div>
      </ng-template>
      <div class="right">
      <header>
        <div class="file">
          <span class="name">{{ base() }}</span>
          <span class="dir">{{ dir() }}</span>
          @if (parsed(); as p) {
            @if (p.binary) { <span class="dir">binary</span> }
            @else { <span class="n-add">+{{ p.added }}</span><span class="n-del">−{{ p.removed }}</span> }
          }
        </div>
        @if (d.view) { <span class="side-tag" [class]="'side-tag ' + d.view">{{ d.view }}</span> }
        <span class="pos">{{ index() + 1 }} / {{ count() }}</span>
        <button type="button" class="nav" (click)="api.stepDiff(-1)" [disabled]="index() <= 0" title="Previous file (k)">↑</button>
        <button type="button" class="nav" (click)="api.stepDiff(1)" [disabled]="index() >= count() - 1" title="Next file (j)">↓</button>
        <div class="seg" role="group" aria-label="Diff layout" title="Toggle layout (s)">
          <button type="button" [attr.aria-pressed]="api.diffMode() === 'inline'" (click)="api.setDiffMode('inline')">Inline</button>
          <button type="button" [attr.aria-pressed]="api.diffMode() === 'split'" (click)="api.setDiffMode('split')">Side by side</button>
        </div>
        <button type="button" class="close" (click)="api.diffView.set(null)" aria-label="Close diff" title="Close (Esc)">×</button>
      </header>

      <div class="body" [class.split]="api.diffMode() === 'split'">
        @if (!d.file) {
          <p class="msg">This commit doesn't change any files.</p>
        } @else if (error()) {
          <p class="msg err">{{ error() }}</p>
        } @else if (!parsed()) {
          <p class="msg">Loading…</p>
        } @else if (parsed()!.binary) {
          <p class="msg">Binary file — no text diff.</p>
        } @else if (!parsed()!.hunks.length) {
          <p class="msg">No textual changes (mode or whitespace only).</p>
        } @else {
          @for (h of parsed()!.hunks; track $index) {
            <div class="hunk">
              <span class="hunk-h">{{ h.header }}</span>
              @if (d.view === 'unstaged') {
                <button type="button" class="hunk-act" (click)="runHunk('stageHunk', $index)" [disabled]="busy()">Stage hunk</button>
              } @else if (d.view === 'staged') {
                <button type="button" class="hunk-act" (click)="runHunk('unstageHunk', $index)" [disabled]="busy()">Unstage hunk</button>
              }
            </div>
            @if (api.diffMode() === 'inline') {
              @for (l of h.lines; track $index) {
                <div class="row" [class]="'row ' + l.kind">
                  <span class="no">{{ l.oldNo }}</span>
                  <span class="no">{{ l.newNo }}</span>
                  <span class="sign">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '' }}</span>
                  <span class="code">@for (s of l.segs; track $index) {<span [class.hl]="s.hl">{{ s.text }}</span>}</span>
                </div>
              }
            } @else {
              @for (r of split()[$index]; track $index) {
                <div class="srow">
                  <div class="side" [class]="'side ' + (r.left ? (r.left.kind === 'ctx' ? 'ctx' : 'del') : 'blank')">
                    <span class="no">{{ r.left?.oldNo }}</span>
                    <span class="code">@for (s of r.left?.segs ?? []; track $index) {<span [class.hl]="s.hl">{{ s.text }}</span>}</span>
                  </div>
                  <div class="side" [class]="'side ' + (r.right ? (r.right.kind === 'ctx' ? 'ctx' : 'add') : 'blank')">
                    <span class="no">{{ r.right?.newNo }}</span>
                    <span class="code">@for (s of r.right?.segs ?? []; track $index) {<span [class.hl]="s.hl">{{ s.text }}</span>}</span>
                  </div>
                </div>
              }
            }
          }
          @if (truncated()) { <p class="msg">Diff truncated (over 200 KB).</p> }
        }
      </div>
      </div>
      </div>
    }
  `,
  styleUrl: './diff-viewer.css',
  host: { '[class.open]': '!!api.diffView()' },
})
export class DiffViewer {
  protected readonly status = fileStatus;
  protected readonly baseOf = baseOf;
  protected readonly dirOf = dirOf;

  /** Working-tree mode: what's in the index vs. what isn't (a file can be in both). */
  protected readonly staged = computed(() => (this.api.diffView()?.files ?? []).filter((f) => f.x !== ' ' && f.x !== '?'));
  protected readonly unstaged = computed(() => (this.api.diffView()?.files ?? []).filter((f) => f.x === '?' || f.y !== ' '));
  protected readonly confirmDiscard = signal<string[] | null>(null);
  protected readonly busy = signal(false);
  protected readonly actionError = signal<string | null>(null);
  protected readonly message = signal('');

  protected paths(files: ChangedFile[]) {
    return files.map((f) => f.path);
  }

  /** Stage / unstage / discard (files, or null = everything) or commit, then refresh the list and the Git tab. */
  protected run(action: 'stage' | 'unstage' | 'discard' | 'commit', files: string[] | null) {
    const d = this.api.diffView();
    if (!d || d.commit || this.busy()) return;
    if (action === 'commit' && (!this.staged().length || !this.message().trim())) return;
    this.busy.set(true);
    this.actionError.set(null);
    const body = { action, ...(files ? { files } : { all: true }), ...(action === 'commit' ? { message: this.message() } : {}) };
    this.api.gitAction(d.path, body).subscribe({
      next: ({ files: now }) => {
        if (action === 'commit') this.message.set('');
        this.afterAction(d.path, now);
      },
      error: (e) => {
        this.busy.set(false);
        this.actionError.set(e.error?.error ?? e.message);
      },
    });
  }

  protected pick(file: string, group: DiffSide | null) {
    const d = this.api.diffView();
    if (d) this.api.diffView.set({ ...d, file, view: group ?? undefined });
  }

  /** Stage or unstage one hunk of the shown file (the server rebuilds the patch from its own diff). */
  protected runHunk(action: 'stageHunk' | 'unstageHunk', hunk: number) {
    const d = this.api.diffView();
    if (!d || d.commit || !d.view || this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    this.api.gitAction(d.path, { action, file: d.file, view: d.view, hunk }).subscribe({
      next: ({ files: now }) => this.afterAction(d.path, now),
      error: (e) => {
        this.busy.set(false);
        this.actionError.set(e.error?.error ?? e.message);
      },
    });
  }

  private afterAction(path: string, now: ChangedFile[]) {
    this.busy.set(false);
    this.confirmDiscard.set(null);
    const cur = this.api.diffView();
    if (cur && !cur.commit && cur.path === path) {
      if (!now.length) this.api.diffView.set(null);
      else this.api.diffView.set({ ...cur, files: now, ...keepSelection(cur.file, cur.view, now) });
    }
    this.api.gitChanged();
  }

  protected when(at: number) {
    return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  protected readonly api = inject(DashboardService);
  private readonly http = inject(HttpClient);

  protected readonly parsed = signal<ParsedDiff | null>(null);
  protected readonly truncated = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly split = computed(() => this.parsed()?.hunks.map((h) => splitRows(h.lines)) ?? []);
  /** Position in the list: commits by file; working tree by (file, side) in staged-then-unstaged order. */
  protected readonly index = computed(() => {
    const d = this.api.diffView();
    if (!d) return -1;
    if (d.commit) return d.files.findIndex((f) => f.path === d.file);
    return workingEntries(d.files).findIndex((e) => e.file === d.file && e.view === d.view);
  });
  protected readonly count = computed(() => {
    const d = this.api.diffView();
    return !d ? 0 : d.commit ? d.files.length : workingEntries(d.files).length;
  });
  protected readonly base = computed(() => {
    const f = this.api.diffView()?.file ?? '';
    return f.slice(f.lastIndexOf('/') + 1);
  });
  protected readonly dir = computed(() => {
    const f = this.api.diffView()?.file ?? '';
    return f.slice(0, f.lastIndexOf('/') + 1);
  });

  constructor() {
    effect(() => {
      const d = this.api.diffView();
      // gitTick: refetch the same file after stage/discard/commit changes its content.
      const key = d ? `${d.path}\n${d.file}\n${d.commit?.h ?? ''}\n${d.view ?? ''}\n${this.api.gitTick()}` : null;
      untracked(() => key && d!.file && this.fetch(d!.path, d!.file, d!.commit?.h, d!.view));
    });
  }

  private fetch(path: string, file: string, h?: string, view?: DiffSide) {
    this.parsed.set(null);
    this.error.set(null);
    const q = `?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}${h ? `&h=${h}` : ''}${view ? `&view=${view}` : ''}`;
    this.http.get<{ diff: string; truncated: boolean }>(`/api/git/diff${q}`).subscribe({
      next: (r) => {
        const cur = this.api.diffView();
        if (cur?.path !== path || cur.file !== file || cur.commit?.h !== h || cur.view !== view) return; // user moved on
        this.parsed.set(parseDiff(r.diff));
        this.truncated.set(r.truncated);
      },
      error: (e) => this.error.set(e.error?.error ?? e.message),
    });
  }
}
