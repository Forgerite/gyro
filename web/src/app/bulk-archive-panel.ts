import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';
import { Session } from './model';

export interface PickedSession {
  s: Session;
  project: string;
}

/** Several loose sessions multi-selected on the tiles: review them, then archive them in one go. */
@Component({
  selector: 'app-bulk-archive-panel',
  imports: [AgoPipe],
  template: `
    <header>
      <h2>{{ sessions().length }} loose sessions selected</h2>
      <p class="hint">Ctrl+click or Space adds or removes one · Shift+click selects a range · Esc clears</p>
    </header>

    <ul class="list" aria-label="Selected sessions">
      @for (p of sessions(); track p.s.id) {
        <li [class.running]="isRunning(p.s)">
          <span class="where">@if (mixed()) { {{ p.project }} / }{{ p.s.worktreeName }}</span>
          <span class="t">{{ p.s.title ?? p.s.id.slice(0, 8) }}</span>
          <span class="age">{{ isRunning(p.s) ? 'running' : (p.s.lastActivity | ago: now()) }}</span>
          <button type="button" class="x" (click)="remove.emit(p.s.id)" [attr.aria-label]="'Remove ' + (p.s.title ?? 'session') + ' from the selection'">×</button>
        </li>
      }
    </ul>

    <div class="primary">
      @if (confirming()) {
        <span class="note">Move {{ archivable().length }} session{{ archivable().length === 1 ? '' : 's' }} to ~/.claude/gyro-archive?</span>
        <button type="button" class="arch-btn danger" (click)="archive()" [disabled]="busy()">
          {{ busy() ? 'Archiving…' : 'Archive ' + archivable().length }}
        </button>
        <button type="button" class="link" (click)="confirming.set(false)">cancel</button>
      } @else {
        <button type="button" class="arch-btn" (click)="confirming.set(true)" [disabled]="!archivable().length">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12v3H2zM3 6.5v6h10v-6M6.5 9h3" /></svg>
          Archive {{ archivable().length }} session{{ archivable().length === 1 ? '' : 's' }}
        </button>
        @if (running().length) { <span class="note">{{ running().length }} running, will be skipped</span> }
      }
      <span class="spacer"></span>
      <button type="button" class="link" (click)="clear.emit()">clear selection</button>
    </div>
    @if (error()) { <p class="act-err" role="alert">{{ error() }}</p> }
  `,
  styleUrls: ['./worktree-panel.css', './bulk-archive-panel.css'],
})
export class BulkArchivePanel {
  readonly sessions = input.required<PickedSession[]>();
  readonly now = input.required<number>();
  readonly remove = output<string>();
  readonly clear = output<void>();
  /** Archived: ids that went, so the app can drop them from the selection. */
  readonly done = output<string[]>();

  private readonly http = inject(HttpClient);
  private readonly api = inject(DashboardService);

  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected isRunning(s: Session) {
    return !!s.live || (!!s.cwd && this.api.snapshot()?.terms.some((t) => t.path === s.cwd && t.sessionId === s.id && !t.exited));
  }
  /** Selection spans projects: prefix each row with its project. */
  protected readonly mixed = computed(() => new Set(this.sessions().map((p) => p.project)).size > 1);
  protected readonly running = computed(() => this.sessions().filter((p) => this.isRunning(p.s)));
  protected readonly archivable = computed(() => this.sessions().filter((p) => !this.isRunning(p.s)));

  protected archive() {
    const ids = this.archivable().map((p) => p.s.id);
    this.busy.set(true);
    this.error.set(null);
    this.http.post<{ archived: string[]; skipped: string[] }>('/api/session/archive', { ids }).subscribe({
      next: ({ archived, skipped }) => {
        this.busy.set(false);
        this.confirming.set(false);
        if (skipped.length) this.error.set(`${skipped.length} could not be archived (open somewhere)`);
        this.done.emit(archived);
        this.api.refresh();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }
}
