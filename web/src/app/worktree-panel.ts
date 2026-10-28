import { Component, computed, inject, input, output, signal } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { AgoPipe } from './ago.pipe';
import { GitTab } from './git-tab';
import { NgTemplateOutlet } from '@angular/common';
import { ArchiveResult, TeardownCard } from './teardown-card';
import { WtFlags, prSummary } from './wt-flags';
import { WorkPlan } from './work-plan';
import { PrTab } from './pr-tab';
import { Session, Term, Workspace, Worktree, sessionState } from './model';

export type OpenRequest = {
  /** term: embedded dock terminal · focus: jump to it · external: Windows Terminal */
  action: 'term' | 'focus' | 'external' | 'code' | 'explorer';
  sessionId?: string;
};

/**
 * One worktree, one session. The current session (live, else most recent) owns the panel;
 * earlier sessions sit behind a small "history" affordance and are only previewed on request.
 */
@Component({
  selector: 'app-worktree-panel',
  imports: [AgoPipe, GitTab, WtFlags, TeardownCard, NgTemplateOutlet, WorkPlan, PrTab],
  template: `
    @let w = wt();
    <header>
      <nav class="crumb" aria-label="Breadcrumb">
        <button type="button" class="link up" (click)="up.emit()" title="Back to project (u)">{{ ws().name }}</button> ›
      </nav>
      <h2>{{ w.name }} @if (w.branch && w.branch !== w.name) { <span class="branch">{{ w.branch }}</span> }</h2>
      <div class="git">
        @if (w.git.dirty) { <span class="dirty">● {{ w.git.dirty }} uncommitted</span> }
        @if (w.git.unmerged) { <span class="unmerged" [title]="'vs ' + w.git.trunk">◆ {{ w.git.unmerged }} unmerged</span> }
        @if (w.ports; as p) {
          <span class="ports" [title]="'Leased to this worktree. Its processes get GYRO_PORT_BASE=' + p.base + ' and GYRO_PORT_COUNT=' + p.count + '; the dev server also gets PORT=' + p.base + '.'">ports {{ p.base }}–{{ p.base + p.count - 1 }}</span>
        }
        <span class="acts">
          <button type="button" class="act" (click)="open.emit({ action: 'code' })" title="Open in VS Code (c)">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" /></svg>VS Code
          </button>
          <button type="button" class="act" (click)="open.emit({ action: 'explorer' })" [title]="'Open folder: ' + w.path">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5v8h13v-6.5h-6.5l-1.5-1.5z" /></svg>Folder
          </button>
        </span>
      </div>
      @if (liveCount() > 1) {
        <div class="warn" role="status">{{ liveCount() }} sessions are live in this worktree. Consider closing all but one.</div>
      }
    </header>

    <div class="tabs" role="tablist" aria-label="Worktree views">
      <button type="button" role="tab" [attr.aria-selected]="tab() === 'session'" (click)="api.setPanelTab('session')">Session</button>
      <button type="button" role="tab" [attr.aria-selected]="tab() === 'git'" (click)="api.setPanelTab('git')" title="Git (g)">
        Git <app-wt-flags [git]="w.git" />
      </button>
      @if (ws().github) {
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'pr'" (click)="api.setPanelTab('pr')"
                [title]="w.pr ? prSummary(w.pr) + ' (p)' : 'Pull request (p)'">
          PR
          @if (w.pr; as p) {
            <span class="pr-badge" [class.draft]="p.draft">#{{ p.number }}</span>
            @switch (p.checks) {
              @case ('fail') { <span class="ci fail" role="img" aria-label="checks failing">✕</span> }
              @case ('pending') { <span class="ci pending" role="img" aria-label="checks running">●</span> }
              @case ('pass') { <span class="ci pass" role="img" aria-label="checks passing">✓</span> }
            }
          }
        </button>
      }
    </div>

    @if (tab() === 'git') {
      <app-git-tab [wt]="w" [now]="now()" />
    } @else if (tab() === 'pr') {
      <app-pr-tab [wt]="w" [ws]="ws()" />
    } @else if (tearingDown()) {
      <app-teardown-card [wt]="w" (done)="archived($event)" (cancel)="setTearingDown(false)" />
    } @else {
    <app-work-plan [wt]="w" />
    @if (shown(); as s) {
      @let state = stateOf(s);
      <section class="session" [class]="state" aria-label="Session">
        @if (s.id !== current()?.id) {
          <div class="banner">
            Earlier session · {{ s.lastActivity | ago: now() }} ago
            <button type="button" class="link" (click)="view(null)">← back to current</button>
          </div>
        }
        <div class="band" [class.live]="!!s.live">
          <div class="s-head">
            <span class="dot" role="img" [attr.aria-label]="label(s)"></span>
            <h3>{{ s.title ?? 'Untitled session' }}</h3>
          </div>
          <div class="meta">
            <span class="status">{{ label(s) }}</span> · {{ s.lastActivity | ago: now() }}
            @if (s.model) { · {{ s.model }} }
            @if (s.pr) { · <a [href]="s.pr.url" target="_blank" rel="noopener">PR #{{ s.pr.number }}</a> }
          </div>
        </div>

        <div class="convo">
          @if (s.lastUser) { <div class="msg user"><span class="who">you</span>{{ s.lastUser }}</div> }
          @if (s.lastAssistant) { <div class="msg"><span class="who">claude</span>{{ s.lastAssistant }}</div> }
          @if (s.lastRole === 'tool' && state === 'busy') { <div class="tool">running {{ s.lastTool }}…</div> }
        </div>

        <div class="primary">
          @if (running()) {
            <button type="button" class="cta" (click)="open.emit({ action: 'focus' })" title="Focus terminal (Enter)">
              @if (booting()) { <span class="spin" aria-hidden="true"></span> Starting… } @else { Go to terminal ↓ }
            </button>
            <span class="note">Running in the dock below</span>
          } @else if (s.live) {
            <span class="note">Open in {{ s.live.entrypoint === 'claude-desktop' ? 'Claude Desktop' : 'another terminal' }}</span>
          } @else {
            <button type="button" class="cta" (click)="open.emit({ action: 'term', sessionId: s.id })" title="Resume in the dock (Enter)">
              Resume session
            </button>
            <button type="button" class="ext" (click)="open.emit({ action: 'external', sessionId: s.id })"
                    title="Resume in Windows Terminal" aria-label="Resume in Windows Terminal">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3.5h-9v-9H6" /></svg>
            </button>
          }
          <span class="spacer"></span>
          <ng-container [ngTemplateOutlet]="archiveBtn" />
        </div>
      </section>
    } @else {
      <section class="session empty-state">
        @if (running()) {
          <p>Session starting in the dock below.</p>
          <button type="button" class="cta" (click)="open.emit({ action: 'focus' })" title="Focus terminal (Enter)">
              @if (booting()) { <span class="spin" aria-hidden="true"></span> Starting… } @else { Go to terminal ↓ }
            </button>
        } @else {
          <p>No Claude session in this worktree yet.</p>
          <div class="primary">
            <button type="button" class="cta" (click)="open.emit({ action: 'term' })" title="Start session (Enter)">Start session</button>
            <span class="spacer"></span>
            <ng-container [ngTemplateOutlet]="archiveBtn" />
          </div>
        }
      </section>
    }

    <ng-template #archiveBtn>
      <button type="button" class="arch-btn" (click)="setTearingDown(true)"
              [title]="w.isMain ? 'Archive this checkout\\'s sessions' : 'Archive sessions and remove this worktree'">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12v3H2zM3 6.5v6h10v-6M6.5 9h3" /></svg>Archive
      </button>
    </ng-template>

    @if (current()) {
      <footer>
        @if (earlier().length) {
          <button type="button" class="link" [attr.aria-expanded]="historyOpen()" (click)="toggleHistory()">
            {{ historyOpen() ? '▾' : '▸' }} {{ earlier().length }} earlier
          </button>
        }
        <span class="spacer"></span>
        <button type="button" class="link" (click)="copy(shown()!)">copy id</button>
        @if (!running()) {
          <button type="button" class="link" (click)="open.emit({ action: 'term' })" title="Starts a second session in this worktree">
            start fresh
          </button>
        }
      </footer>
      @if (historyOpen()) {
        <ul class="history" aria-label="Earlier sessions">
          @for (s of earlier(); track s.id) {
            <li>
              <button type="button" [class.on]="s.id === shown()?.id" (click)="view(s.id)">
                <span class="h-title">{{ s.title ?? s.id.slice(0, 8) }}</span>
                <span class="age">{{ s.lastActivity | ago: now() }}</span>
              </button>
            </li>
          }
        </ul>
      }
    }
    }
  `,
  styleUrl: './worktree-panel.css',
})
export class WorktreePanel {
  readonly ws = input.required<Workspace>();
  readonly wt = input.required<Worktree>();
  readonly now = input.required<number>();
  /** The dock terminal for this worktree, if any. */
  readonly term = input<Term | undefined>();
  readonly open = output<OpenRequest>();
  readonly up = output<void>();

  /**
   * Panel-local UI state, tagged with the worktree it belongs to so it resets on navigation
   * but survives the 3s poll (which hands us a fresh Worktree object each time).
   */
  private readonly ui = signal({ path: '', viewingId: null as string | null, historyOpen: false });
  private readonly uiHere = computed(() => {
    const u = this.ui();
    return u.path === this.wt().path ? u : { path: this.wt().path, viewingId: null, historyOpen: false };
  });
  /** Session being previewed; null means the current one. */
  protected readonly viewingId = computed(() => this.uiHere().viewingId);
  protected readonly historyOpen = computed(() => this.uiHere().historyOpen);

  protected view(id: string | null) {
    this.ui.set({ ...this.uiHere(), viewingId: id });
  }

  /** Archive (teardown) confirmation open, tied to the worktree it was opened for. */
  private readonly teardownFor = signal<string | null>(null);
  protected readonly tearingDown = computed(() => this.teardownFor() === this.wt().path);

  protected setTearingDown(on: boolean) {
    this.teardownFor.set(on ? this.wt().path : null);
  }

  /** Archived: a removed worktree no longer exists, so step up to its project. */
  protected archived(r: ArchiveResult) {
    this.teardownFor.set(null);
    if (r.removed) this.up.emit();
  }

  protected toggleHistory() {
    this.ui.set({ ...this.uiHere(), historyOpen: !this.historyOpen() });
  }

  /** Server sorts live-first, then most recent. */
  protected readonly current = computed(() => this.wt().sessions[0]);
  protected readonly earlier = computed(() => this.wt().sessions.slice(1));
  protected readonly shown = computed(
    () => this.wt().sessions.find((s) => s.id === this.viewingId()) ?? this.current(),
  );
  protected readonly api = inject(DashboardService);
  /** The PR tab only exists for projects linked to GitHub; elsewhere it falls back to the session. */
  protected readonly tab = computed(() => {
    const t = this.api.panelTab();
    return t === 'pr' && !this.ws().github ? 'session' : t;
  });
  protected readonly prSummary = prSummary;
  /** Requested but claude hasn't drawn yet. */
  protected readonly booting = computed(() => {
    const st = this.api.starting()[this.wt().path];
    return !!st && !st.failed;
  });
  protected readonly running = computed(() => this.booting() || (!!this.term() && !this.term()!.exited));
  protected readonly liveCount = computed(() => this.wt().sessions.filter((s) => s.live).length);

  /** A session still booting in the dock counts as working. */
  protected stateOf(s: Session) {
    return this.booting() && s === this.current() ? 'busy' : sessionState(s);
  }

  protected label(s: Session) {
    const state = this.stateOf(s);
    if (state === 'busy') return 'Claude is working';
    return s.live ? 'Waiting on you' : 'Waiting on you · not running';
  }

  protected copy(s: Session) {
    navigator.clipboard?.writeText(s.id);
  }
}
