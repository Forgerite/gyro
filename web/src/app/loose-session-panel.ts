import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';
import { Session, Term, Workspace, sessionState } from './model';
import { OpenRequest } from './worktree-panel';

/**
 * A session whose worktree is gone. It reads like a worktree's session, but there's no git and no
 * teardown: resume it (only while its folder still exists, since claude resumes per folder) or archive it.
 */
@Component({
  selector: 'app-loose-session-panel',
  imports: [AgoPipe],
  template: `
    @let s = session();
    @let state = stateOf();
    <header>
      <h2>
        <button type="button" class="link up" (click)="up.emit()" title="Back to project (u)">{{ ws().name }}</button>
        <span class="sep" aria-hidden="true">›</span>
        <span class="title">{{ s.worktreeName }} <span class="branch">loose session</span></span>
        @if (s.folderExists) {
          <span class="acts">
            <button type="button" class="act" (click)="open.emit({ action: 'code' })" title="Open in VS Code (c)">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" /></svg>VS Code
            </button>
            <button type="button" class="act" (click)="open.emit({ action: 'explorer' })" [title]="'Open folder: ' + s.cwd">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5v8h13v-6.5h-6.5l-1.5-1.5z" /></svg>Folder
            </button>
          </span>
        }
      </h2>
    </header>

    <section class="session" [class]="state" aria-label="Session">
      <div class="band" [class.live]="!!s.live">
        <div class="s-head">
          <span class="dot" role="img" [attr.aria-label]="label()"></span>
          <h3>{{ s.title ?? 'Untitled session' }}</h3>
        </div>
        <div class="meta">
          <span class="status">{{ label() }}</span> · {{ s.lastActivity | ago: now() }}
          @if (s.branch) { · {{ s.branch }} }
          @if (s.model) { · {{ s.model }} }
          @if (s.pr) { · <a [href]="s.pr.url" target="_blank" rel="noopener">PR #{{ s.pr.number }}</a> }
        </div>
      </div>

      <div class="convo">
        @if (s.lastUser) { <div class="msg user"><span class="who">you</span>{{ s.lastUser }}</div> }
        @if (s.lastAssistant) { <div class="msg"><span class="who">claude</span>{{ s.lastAssistant }}</div> }
      </div>

      <div class="primary">
        @if (running()) {
          <button type="button" class="cta" (click)="open.emit({ action: 'focus' })" title="Focus terminal (Enter)">
            @if (booting()) { <span class="spin" aria-hidden="true"></span> Starting… } @else { Go to terminal ↓ }
          </button>
        } @else if (s.live) {
          <span class="note">Open in {{ s.live.entrypoint === 'claude-desktop' ? 'Claude Desktop' : 'another terminal' }}</span>
        } @else if (s.folderExists) {
          <button type="button" class="cta" (click)="open.emit({ action: 'term', sessionId: s.id })" title="Resume in the dock (Enter)">
            Resume session
          </button>
          <button type="button" class="ext" (click)="open.emit({ action: 'external', sessionId: s.id })"
                  title="Resume in Windows Terminal" aria-label="Resume in Windows Terminal">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3.5h-9v-9H6" /></svg>
          </button>
        } @else {
          <span class="note">Can't resume: claude resumes a session from the folder it started in.</span>
        }
        <span class="spacer"></span>
        @if (confirming()) {
          <span class="note">Archive this session?</span>
          <button type="button" class="arch-btn danger" (click)="archive()" [disabled]="busy()">Archive</button>
          <button type="button" class="link" (click)="confirmFor.set(null)">cancel</button>
        } @else {
          <button type="button" class="arch-btn" (click)="confirmFor.set(s.id)" [disabled]="!!s.live || running()"
                  [title]="s.live || running() ? 'Close the session first' : 'Move to ~/.claude/gyro-archive (reversible)'">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12v3H2zM3 6.5v6h10v-6M6.5 9h3" /></svg>Archive
          </button>
        }
      </div>
      @if (error()) { <p class="act-err" role="alert">{{ error() }}</p> }
    </section>

    <footer>
      <span class="path" [title]="s.cwd ?? ''">{{ s.cwd }}</span>
      <span class="spacer"></span>
      <button type="button" class="link" (click)="copy()">copy id</button>
    </footer>
  `,
  styleUrls: ['./worktree-panel.css', './loose-session-panel.css'],
})
export class LooseSessionPanel {
  readonly ws = input.required<Workspace>();
  readonly session = input.required<Session>();
  readonly now = input.required<number>();
  /** Dock terminal running in this session's folder, if any. */
  readonly term = input<Term | undefined>();
  readonly open = output<OpenRequest>();
  readonly up = output<void>();

  private readonly api = inject(DashboardService);
  private readonly http = inject(HttpClient);

  /** Archive confirmation, tied to the session it was opened for (survives the 3s poll, resets on navigation). */
  protected readonly confirmFor = signal<string | null>(null);
  protected readonly confirming = computed(() => this.confirmFor() === this.session().id);
  protected readonly busy = signal(false);
  private readonly errorFor = signal<{ id: string; msg: string } | null>(null);
  protected readonly error = computed(() => (this.errorFor()?.id === this.session().id ? this.errorFor()!.msg : null));

  protected readonly booting = computed(() => {
    const st = this.api.starting()[this.session().cwd ?? ''];
    return !!st && !st.failed;
  });
  protected readonly running = computed(() => this.booting() || (!!this.term() && !this.term()!.exited));

  protected readonly stateOf = computed(() => {
    const s = this.session();
    if (this.booting()) return 'busy';
    return s.live ? sessionState(s) : 'idle';
  });

  protected readonly label = computed(() => {
    const state = this.stateOf();
    if (state === 'busy') return 'Claude is working';
    if (state === 'waiting') return 'Waiting on you';
    return 'Not running';
  });

  protected archive() {
    const id = this.session().id;
    this.busy.set(true);
    this.http.post('/api/session/archive', { id }).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirmFor.set(null);
        this.up.emit();
        this.api.refresh();
      },
      error: (e) => {
        this.busy.set(false);
        this.errorFor.set({ id, msg: e.error?.error ?? e.message });
      },
    });
  }

  protected copy() {
    navigator.clipboard?.writeText(this.session().id);
  }
}
