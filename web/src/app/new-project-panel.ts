import { HttpClient } from '@angular/common/http';
import { Component, ElementRef, computed, inject, output, signal, viewChild } from '@angular/core';
import { FormField, form, pattern, required, validate } from '@angular/forms/signals';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';

type Mode = 'scratch' | 'directory';

interface Candidate {
  name: string;
  path: string;
  modifiedAt: number;
  entries: number;
  gitignore: boolean;
  nodeModules: boolean;
}

export interface Created {
  path: string;
  mode: Mode;
}

/** Same rule the server enforces: a plain folder name, not hidden, not a worktree home. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Start a git repo in the code folder: a brand-new folder, or an existing folder that isn't a repo yet. */
@Component({
  selector: 'app-new-project-panel',
  imports: [AgoPipe, FormField],
  template: `
    <header>
      <h2>New project</h2>
      <button type="button" class="link" (click)="cancel.emit()" title="Close (Esc)">cancel</button>
    </header>

    <div class="modes" role="radiogroup" aria-label="How to create the project">
      <button type="button" role="radio" [attr.aria-checked]="mode() === 'scratch'" (click)="setMode('scratch')">
        <strong>From scratch</strong><span>A new, empty folder and repository</span>
      </button>
      <button type="button" role="radio" [attr.aria-checked]="mode() === 'directory'" (click)="setMode('directory')">
        <strong>From directory</strong><span>Turn a folder already in {{ rootName() }} into a repository</span>
      </button>
    </div>

    @if (mode() === 'scratch') {
      <div class="body">
        <label class="field">
          <span class="lbl">Folder name</span>
          <input #nameInput type="text" [formField]="nameForm.name" placeholder="my-project" autocomplete="off" spellcheck="false"
                 [attr.aria-invalid]="showNameError()" aria-describedby="np-name-help" (keydown.enter)="create()" />
        </label>
        <p id="np-name-help" class="help" [class.bad]="showNameError()">
          @if (showNameError()) { {{ nameError() }} } @else { Creates {{ root() }}\\{{ nameForm.name().value() || '…' }} }
        </p>
      </div>
    } @else {
      <div class="body list-body">
        @if (candidates() === null) {
          <p class="help">Looking for folders…</p>
        } @else if (!candidates()!.length) {
          <p class="help">Every folder in {{ rootName() }} is already a git repository.</p>
        } @else {
          <span class="lbl" id="np-dir-lbl">Folders that aren't repositories yet</span>
          <div class="dirs" role="radiogroup" aria-labelledby="np-dir-lbl">
            @for (c of candidates(); track c.path) {
              <button type="button" role="radio" class="dir" [attr.aria-checked]="picked() === c.name" (click)="picked.set(c.name)">
                <span class="dn">{{ c.name }}</span>
                <span class="dm">
                  {{ c.entries }} item{{ c.entries === 1 ? '' : 's' }}
                  @if (c.gitignore) { · has .gitignore }
                  @if (c.nodeModules) { · node_modules }
                </span>
                <span class="age">{{ c.modifiedAt | ago: now() }}</span>
              </button>
            }
          </div>
          <p class="help">Its files stay uncommitted: review them in the Git tab, then make the first commit there.</p>
        }
      </div>
    }

    <div class="foot">
      <label class="check" [class.dim]="pickedHasIgnore()">
        <input type="checkbox" [checked]="gitignore() || pickedHasIgnore()" [disabled]="pickedHasIgnore()"
               (change)="gitignore.set($any($event.target).checked)" />
        <span>
          @if (pickedHasIgnore()) { Keeps the folder's own .gitignore } @else {
            Add a starter .gitignore <span class="muted">(node_modules, build output, .env, logs)</span>
          }
        </span>
      </label>
      @if (warnNodeModules()) {
        <p class="warn" role="status">This folder has node_modules. Keep the .gitignore on, or thousands of files will show as changes.</p>
      }
      <div class="actions">
        @if (error()) { <span class="err" role="alert">{{ error() }}</span> }
        <span class="spacer"></span>
        <button type="button" class="cta" (click)="create()" [disabled]="!canCreate()">
          {{ busy() ? 'Creating…' : mode() === 'scratch' ? 'Create project' : 'Make it a git repo' }}
        </button>
      </div>
    </div>
  `,
  styleUrl: './new-project-panel.css',
  host: { '(keydown.escape)': 'cancel.emit()' },
})
export class NewProjectPanel {
  readonly created = output<Created>();
  readonly cancel = output<void>();

  private readonly http = inject(HttpClient);
  private readonly api = inject(DashboardService);
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  protected readonly now = this.api.now;

  protected readonly mode = signal<Mode>('scratch');
  protected readonly gitignore = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly root = computed(() => this.api.snapshot()?.root ?? 'the code folder');
  protected readonly rootName = computed(() => this.root().split(/[\\/]/).pop());

  // --- From scratch: the folder name, validated as you type.
  private readonly existing = computed(
    () => new Set([...(this.api.snapshot()?.workspaces ?? []).map((w) => w.name.toLowerCase()), ...(this.candidates() ?? []).map((c) => c.name.toLowerCase())]),
  );
  private readonly nameModel = signal({ name: '' });
  protected readonly nameForm = form(this.nameModel, (p) => {
    required(p.name, { message: 'Give the project a folder name' });
    pattern(p.name, NAME, { message: 'Use letters, numbers, dot, dash or underscore, starting with a letter or number' });
    validate(p.name, ({ value }) => {
      const v = value();
      if (/[.-]worktrees$/i.test(v)) return { kind: 'reserved', message: 'Names ending in .worktrees are where worktrees live' };
      if (this.existing().has(v.toLowerCase())) return { kind: 'exists', message: `${v} already exists in the code folder` };
      return null;
    });
  });
  protected readonly nameError = computed(() => this.nameForm.name().errors()[0]?.message ?? '');
  protected readonly showNameError = computed(() => !!this.nameForm.name().value() && this.nameForm.name().invalid());

  // --- From directory: pick one of the code folder's non-repo folders.
  protected readonly candidates = signal<Candidate[] | null>(null);
  protected readonly picked = signal<string | null>(null);
  private readonly pickedCandidate = computed(() => this.candidates()?.find((c) => c.name === this.picked()) ?? null);
  protected readonly pickedHasIgnore = computed(() => this.mode() === 'directory' && !!this.pickedCandidate()?.gitignore);
  protected readonly warnNodeModules = computed(() => {
    const c = this.pickedCandidate();
    return this.mode() === 'directory' && !!c?.nodeModules && !c.gitignore && !this.gitignore();
  });

  protected readonly canCreate = computed(() => {
    if (this.busy()) return false;
    return this.mode() === 'scratch' ? this.nameForm.name().valid() : !!this.pickedCandidate();
  });

  constructor() {
    this.loadCandidates();
    requestAnimationFrame(() => this.nameInput()?.nativeElement.focus());
  }

  protected setMode(mode: Mode) {
    this.mode.set(mode);
    this.error.set(null);
    if (mode === 'scratch') requestAnimationFrame(() => this.nameInput()?.nativeElement.focus());
  }

  private loadCandidates() {
    this.http.get<{ candidates: Candidate[] }>('/api/projects/candidates').subscribe({
      next: ({ candidates }) => this.candidates.set(candidates),
      error: (e) => {
        this.candidates.set([]);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }

  protected create() {
    if (!this.canCreate()) return;
    const mode = this.mode();
    const name = mode === 'scratch' ? this.nameForm.name().value().trim() : this.picked()!;
    this.busy.set(true);
    this.error.set(null);
    this.http.post<{ path: string; notes: string[] }>('/api/projects/create', { mode, name, gitignore: this.gitignore() }).subscribe({
      next: ({ path }) => {
        this.busy.set(false);
        this.api.refresh();
        this.created.emit({ path, mode });
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }
}
