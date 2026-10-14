import { Component, DestroyRef, ElementRef, computed, effect, inject, output, signal, untracked, viewChild } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { TerminalView } from './terminal-view';
import { sessionState } from './model';

/** After this long without output, the overlay says so instead of just spinning. */
const SLOW_MS = 8000;

/** Bottom half of the screen: one tab per embedded claude terminal. */
@Component({
  selector: 'app-terminal-dock',
  imports: [TerminalView],
  template: `
    <div class="tabs" role="tablist" aria-label="Terminals">
      @for (t of tabs(); track t.path) {
        <div class="tab" [class]="'tab ' + t.state" [class.on]="t.path === active()" [class.exited]="t.exited">
          <button type="button" role="tab" [attr.aria-selected]="t.path === active()" (click)="pick.emit(t.path)">
            @if (api.starting()[t.path]) { <span class="spin" aria-hidden="true"></span> } @else { <span class="dot"></span> }
            {{ t.label }}
          </button>
          <button type="button" class="x" [attr.aria-label]="'Close ' + t.label" title="Kill and close" (click)="api.closeTerm(t.path)">×</button>
        </div>
      }
      <span class="spacer"></span>
      <span class="hint"><kbd>Ctrl</kbd>+<kbd>\`</kbd> toggle terminal</span>
      <button type="button" class="chev" (click)="api.setDockOpen(!api.dockOpen())" [attr.aria-expanded]="api.dockOpen()"
              [attr.aria-label]="api.dockOpen() ? 'Collapse terminal' : 'Expand terminal'">{{ api.dockOpen() ? '▾' : '▴' }}</button>
    </div>
    <div class="body" #body tabindex="-1" [hidden]="!api.dockOpen()" aria-label="Terminal">
      @for (t of tabs(); track t.path) {
        @if (t.live) {
          <app-terminal-view
            [path]="t.path"
            [active]="t.path === active()"
            [focusTick]="api.focusTerm()"
            [hidden]="t.path !== active()"
            (ready)="api.doneStarting(t.path)"
          />
        }
      } @empty {
        <p class="empty">No terminal open. Select a worktree and press <kbd>Enter</kbd> to resume its session here.</p>
      }

      @if (boot(); as b) {
        <div class="boot" role="status" aria-live="polite">
          @if (b.failed) {
            <div class="boot-title fail">Couldn't start Claude</div>
            <div class="boot-sub">{{ b.failed }}</div>
            <button type="button" (click)="api.closeTerm(b.path)">Dismiss</button>
          } @else {
            <div class="boot-title"><span class="spin big" aria-hidden="true"></span>{{ b.resume ? 'Resuming session' : 'Starting Claude' }}</div>
            <div class="boot-sub">
              {{ b.label }} · {{ b.seconds }}s
              @if (b.slow) { · still waiting for Claude to draw… }
            </div>
          }
        </div>
      }
    </div>
  `,
  styleUrl: './terminal-dock.css',
})
export class TerminalDock {
  protected readonly api = inject(DashboardService);
  /** Tab clicked: the app selects that worktree, which also activates the tab. */
  readonly pick = output<string>();

  /** Re-renders the elapsed counter; only ticks while something is starting. */
  private readonly clock = signal(Date.now());

  private readonly names = computed(() => {
    const names = new Map<string, string>();
    for (const ws of this.api.snapshot()?.workspaces ?? []) {
      for (const wt of ws.worktrees) names.set(wt.path, wt.isMain ? ws.name : `${ws.name} / ${wt.name}`);
      for (const s of ws.loose) if (s.cwd && s.folderExists) names.set(s.cwd, `${ws.name} / ${s.worktreeName} (loose)`);
    }
    return names;
  });

  /** Session state per worktree, so each tab shows working (green) or waiting on you (red). */
  private readonly states = computed(() => {
    const m = new Map<string, string>();
    for (const ws of this.api.snapshot()?.workspaces ?? []) {
      for (const wt of ws.worktrees) m.set(wt.path, this.api.starting()[wt.path] ? 'busy' : sessionState(wt.sessions[0]));
    }
    return m;
  });

  /** Server terminals, plus placeholder tabs for ones still being requested. */
  protected readonly tabs = computed(() => {
    const names = this.names();
    const terms = this.api.snapshot()?.terms ?? [];
    const states = this.states();
    const tabs = terms.map((t) => ({
      path: t.path, exited: t.exited, live: true, label: names.get(t.path) ?? t.path,
      state: t.exited ? 'none' : (states.get(t.path) ?? 'waiting'),
    }));
    for (const path of Object.keys(this.api.starting())) {
      if (!terms.some((t) => t.path === path)) tabs.push({ path, exited: false, live: false, label: names.get(path) ?? path, state: 'busy' });
    }
    return tabs;
  });

  /** Falls back to the first tab when the chosen one is gone. */
  protected readonly active = computed(() => {
    const want = this.api.activeTerm();
    const tabs = this.tabs();
    return tabs.some((t) => t.path === want) ? want : (tabs[0]?.path ?? null);
  });

  /** Startup overlay for the active tab, if it is still booting. */
  protected readonly boot = computed(() => {
    const path = this.active();
    const st = path ? this.api.starting()[path] : undefined;
    if (!path || !st) return null;
    const elapsed = this.clock() - st.at;
    return {
      path,
      label: this.names().get(path) ?? path,
      resume: st.resume,
      failed: st.failed,
      seconds: (Math.max(0, elapsed) / 1000).toFixed(1),
      slow: elapsed > SLOW_MS,
    };
  });

  private readonly body = viewChild.required<ElementRef<HTMLElement>>('body');

  constructor() {
    // A focus request with no live terminal to take it (empty dock, or a session still starting):
    // focus the dock itself, so Ctrl+` sees "focus is in the terminal" and closes it next time.
    effect(() => {
      if (this.api.focusTerm() === 0) return; // initial run: nothing has asked for focus yet
      untracked(() => {
        const tab = this.tabs().find((t) => t.path === this.active());
        if (tab?.live) return; // the terminal view focuses itself
        requestAnimationFrame(() => requestAnimationFrame(() => this.body().nativeElement.focus()));
      });
    });

    let timer: ReturnType<typeof setInterval> | undefined;
    effect(() => {
      const anyStarting = Object.keys(this.api.starting()).length > 0;
      if (anyStarting && !timer) timer = setInterval(() => this.clock.set(Date.now()), 100);
      if (!anyStarting && timer) timer = (clearInterval(timer), undefined);
    });
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
}
