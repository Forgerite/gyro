import { Component, computed, inject, input, output, signal } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';
import { WtFlags } from './wt-flags';
import { LOOSE_RECENT_MS, Selection, Session, State, Workspace, Worktree, sessionState } from './model';

@Component({
  selector: 'app-workspace-card',
  imports: [AgoPipe, WtFlags],
  template: `
    <header>
      <button
        type="button"
        class="project"
        [id]="'ws-' + ws().path"
        [class.selected]="isSel('project', ws().path)"
        [attr.aria-pressed]="isSel('project', ws().path)"
        (click)="selectProject.emit(ws().path)"
      >
        <h2>{{ ws().name }}</h2>
      </button>
      @if (ws().closed) {
        <span class="closed-tag">closed</span>
        <button type="button" class="hdr-act" (click)="closeProject.emit(false)" [attr.aria-label]="'Reopen ' + ws().name"
                title="Reopen: show its worktrees and sessions again">reopen</button>
      } @else {
        <button type="button" class="hdr-act close" (click)="closeProject.emit(true)" [attr.aria-label]="'Close ' + ws().name"
                title="Close project: collapse it, stop its dock terminals, move it to the end">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      }
      <span class="age">{{ ws().lastActivity | ago: now() }}</span>
    </header>
    @if (!ws().closed) {
    <ul>
      @for (wt of ws().worktrees; track wt.path) {
        @let s = wt.sessions[0];
        @let state = stateOf(wt);
        <li>
          <button
            type="button"
            [id]="'wt-' + wt.path"
            [class]="'row ' + state"
            [class.live]="!!s?.live"
            [class.selected]="isSel('worktree', wt.path)"
            [attr.aria-pressed]="isSel('worktree', wt.path)"
            (click)="select.emit(wt.path)"
            (dblclick)="activate.emit(wt.path)"
          >
            <span class="dot" role="img" [attr.aria-label]="wtLabel(wt)"></span>
            <span class="name" [title]="wt.path">
              {{ wt.name }}
              @if (wt.branch && wt.branch !== wt.name) { <span class="branch">{{ wt.branch }}</span> }
              @if (wt.detached) { <span class="branch">&#64;{{ wt.head }}</span> }
            </span>
            <app-wt-flags [git]="wt.git" [pr]="wt.pr" compact />
            @if (stageChip(wt); as stage) {
              <span class="stagechip" [class.land]="stage === 'ready to land'" [title]="'Session is ' + stage">{{ stage }}</span>
            }
            <span class="title">{{ s?.title ?? wt.git.lastCommitSubject ?? '' }}</span>
            <span class="multi">@if (liveIn(wt) > 1) { <span title="More than one live session in this worktree">×{{ liveIn(wt) }}</span> }</span>
            <span class="age">{{ wt.lastActivity | ago: now() }}</span>
          </button>
        </li>
      }
    </ul>
    @if (looseShown().length || looseOlder()) {
      <div class="loose" role="group" [attr.aria-label]="'Loose sessions in ' + ws().name">
        <h3>
          <span title="Sessions from worktrees of this project that have since been removed. Ctrl+click or Space to multi-select, Shift+click for a range.">Loose sessions</span>
          <button type="button" class="more pick-all" (click)="pickSessions.emit(pickable())" [disabled]="!pickable().length"
                  title="Select every loose session listed here (running ones excluded)">select all</button>
        </h3>
        <ul>
          @for (s of looseShown(); track s.id) {
            @let state = looseStateOf(s);
            <li>
              <button
                type="button"
                [id]="'ls-' + s.id"
                [class]="'row loose-row ' + state"
                [class.live]="!!s.live"
                [class.selected]="isSel('session', s.id)"
                [class.picked]="multi().includes(s.id)"
                [attr.aria-pressed]="isSel('session', s.id) || multi().includes(s.id)"
                (mousedown)="$event.shiftKey && $event.preventDefault()"
                (click)="pick($event, s.id)"
                (keydown.space)="$event.preventDefault(); pickSession.emit({ id: s.id, mode: 'toggle', order: order() })"
                (dblclick)="activateSession.emit(s.id)"
              >
                <span class="dot" role="img" [attr.aria-label]="looseLabel(s)"></span>
                <span class="name" [title]="(s.cwd ?? '') + (s.folderExists ? '' : ' (folder removed)')">{{ s.worktreeName }}</span>
                <span></span>
                <span class="title">{{ s.title ?? s.id.slice(0, 8) }}</span>
                <span></span>
                <span class="age">{{ s.lastActivity | ago: now() }}</span>
              </button>
            </li>
          }
        </ul>
        @if (looseOlder()) {
          <button type="button" class="more" [attr.aria-expanded]="showOlder()" (click)="showOlder.set(!showOlder())">
            {{ showOlder() ? 'hide older' : '+' + looseOlder() + ' older' }}
          </button>
        }
      </div>
    }
    }
  `,
  styleUrl: './workspace-card.css',
  host: { '[class]': 'cardState()' },
})
export class WorkspaceCard {
  readonly ws = input.required<Workspace>();
  readonly selected = input<Selection | null>(null);
  readonly now = input.required<number>();
  readonly select = output<string>();
  readonly selectProject = output<string>();
  readonly activate = output<string>();
  /** Loose session clicked: plain = select it, Ctrl/Cmd = add/remove from the multi-selection, Shift = range. */
  readonly pickSession = output<SessionPick>();
  /** "select all": replace the multi-selection with these ids. */
  readonly pickSessions = output<string[]>();
  /** Loose sessions in the multi-selection (any project). */
  readonly multi = input<string[]>([]);
  readonly activateSession = output<string>();
  /** true = close the project, false = reopen it. */
  readonly closeProject = output<boolean>();

  /** Older loose sessions are tucked away unless asked for (or one of them is selected). */
  protected readonly showOlder = signal(false);
  private readonly looseRecent = computed(() =>
    this.ws().loose.filter((s) => s.live || this.now() - s.lastActivity < LOOSE_RECENT_MS),
  );
  /** Rows in display order, for Shift+click ranges. */
  protected readonly order = computed(() => this.looseShown().map((s) => s.id));
  /** What "select all" picks: the listed sessions that aren't running. */
  protected readonly pickable = computed(() => this.looseShown().filter((s) => !s.live).map((s) => s.id));

  protected pick(e: MouseEvent, id: string) {
    const mode = e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'single';
    this.pickSession.emit({ id, mode, order: this.order() });
  }

  protected readonly looseOlder = computed(() => this.ws().loose.length - this.looseRecent().length);
  protected readonly looseShown = computed(() => {
    const sel = this.selected();
    const forced = sel?.kind === 'session' && !this.looseRecent().some((s) => s.id === sel.path);
    return this.showOlder() || forced ? this.ws().loose : this.looseRecent();
  });

  private readonly api = inject(DashboardService);

  /** Worktrees per state; the card itself takes the most urgent one (waiting on you beats working). */
  protected readonly counts = computed(() => {
    const c = { busy: 0, waiting: 0 };
    const states = [...this.ws().worktrees.map((wt) => this.stateOf(wt)), ...this.ws().loose.map((s) => this.looseStateOf(s))];
    for (const st of states) {
      if (st === 'busy') c.busy++;
      else if (st === 'waiting') c.waiting++;
    }
    return c;
  });
  protected readonly cardState = computed<State | 'closed'>(() =>
    this.ws().closed ? 'closed' : this.counts().waiting ? 'waiting' : this.counts().busy ? 'busy' : 'none',
  );

  protected isSel(kind: Selection['kind'], path: string) {
    const sel = this.selected();
    return sel?.kind === kind && sel.path === path;
  }

  protected liveIn(wt: Worktree) {
    return wt.sessions.filter((s) => s.live).length;
  }

  /** The stage chip, only when the session awaits the user or a macro runs (quiet otherwise). */
  protected stageChip(wt: Worktree): string | null {
    const stage = wt.work?.plan?.stage;
    return stage === 'ready-to-ship' ? 'ready to ship' : stage === 'ready-to-land' ? 'ready to land' : stage === 'landing' ? 'landing…' : null;
  }

  protected stateOf(wt: Worktree): State {
    return this.api.worktreeState(wt);
  }

  protected wtLabel(wt: Worktree) {
    const s = wt.sessions[0];
    const st = this.api.starting()[wt.path];
    const claudeBusy = this.api.smartBusy(wt.path) || (st && !st.failed) || sessionState(s) === 'busy';
    if (!claudeBusy && wt.pr?.checksRunning) return 'PR checks running';
    return this.label(this.stateOf(wt), !!s?.live);
  }

  protected looseStateOf(s: Session) {
    return this.api.looseSessionState(s);
  }

  protected looseLabel(s: Session) {
    const state = this.looseStateOf(s);
    if (state === 'idle') return s.folderExists ? 'Not running' : 'Not running · folder removed';
    return this.label(state, !!s.live);
  }

  protected label(state: State, live: boolean) {
    if (state === 'busy') return 'Claude is working';
    if (state === 'waiting') return live ? 'Waiting on you (session open)' : 'Waiting on you (not running)';
    return 'No session';
  }
}

export interface SessionPick {
  id: string;
  mode: 'single' | 'toggle' | 'range';
  /** The card's loose rows in display order. */
  order: string[];
}
