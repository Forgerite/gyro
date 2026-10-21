import { Component, DestroyRef, ElementRef, computed, effect, inject, output, signal, untracked, viewChild } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { PreviewPane } from './preview-pane';
import { TerminalView } from './terminal-view';
import { sessionState } from './model';

/** After this long without output, the overlay says so instead of just spinning. */
const SLOW_MS = 8000;
const SPLIT_KEY = 'ccdb.previewSplit';
const PREVIEW_KEY = 'ccdb.preview';

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
const clampSplit = (f: number) => Math.min(0.8, Math.max(0.2, f));

/**
 * Bottom of the screen: one tab per dock session. Each is a group, claude plus the project's dev
 * server, on the left, with the app that dev server serves previewed on the right.
 */
@Component({
  selector: 'app-terminal-dock',
  imports: [TerminalView, PreviewPane],
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
      @if (current()) {
        <button type="button" class="toggle" [attr.aria-pressed]="previewOn()" (click)="togglePreview()" title="Show or hide the app preview and test report">Preview</button>
      }
      <span class="hint"><kbd>Ctrl</kbd>+<kbd>\`</kbd> toggle terminal</span>
      <button type="button" class="chev" (click)="api.setDockOpen(!api.dockOpen())" [attr.aria-expanded]="api.dockOpen()"
              [attr.aria-label]="api.dockOpen() ? 'Collapse terminal' : 'Expand terminal'">{{ api.dockOpen() ? '▾' : '▴' }}</button>
    </div>
    <div class="body" #body tabindex="-1" [hidden]="!api.dockOpen()" aria-label="Terminal">
      @if (!tabs().length) {
        <p class="empty">No terminal open. Select a worktree and press <kbd>Enter</kbd> to resume its session here.</p>
      }
      <div class="split" [class.solo]="!previewShown()" [style.--left]="split() * 100 + '%'" [hidden]="!tabs().length">
        <div class="group">
          @if (current()?.live) {
            <div class="panes" role="tablist" aria-label="Session terminals">
              <button type="button" role="tab" [attr.aria-selected]="pane() === 'claude'" (click)="showPane('claude')">Claude</button>
              @if (current()!.devCommand; as cmd) {
                <button type="button" role="tab" [attr.aria-selected]="pane() === 'dev'" (click)="showPane('dev')">
                  <span class="dot" [class]="'dot ' + devState()" aria-hidden="true"></span>{{ cmd }}
                  <span class="sub">{{ devText() }}</span>
                </button>
              }
              @for (s of current()!.shells; track s.id) {
                <span class="shell" [class.exited]="s.exited">
                  <button type="button" role="tab" [attr.aria-selected]="pane() === 'shell:' + s.id" (click)="showPane('shell:' + s.id)">{{ s.label }}</button>
                  <button type="button" class="x" [attr.aria-label]="'Close ' + s.label" title="Kill and close" (click)="api.closeShell(current()!.path, s.id)">×</button>
                </span>
              }
              <button type="button" class="add" aria-label="New Git Bash terminal" title="New Git Bash terminal" (click)="openShell()">+</button>
              <span class="spacer"></span>
              @if (current()!.devCommand) {
                @if (current()!.dev && !current()!.dev!.exited) {
                  <button type="button" class="act" (click)="api.devServer(current()!.path, false)">Stop</button>
                } @else {
                  <button type="button" class="act" (click)="api.devServer(current()!.path, true)">{{ current()!.dev ? 'Restart' : 'Start' }}</button>
                }
              }
            </div>
          }
          <div class="terms">
            @for (t of tabs(); track t.path) {
              @if (t.live) {
                <app-terminal-view
                  [path]="t.path"
                  [active]="t.path === active() && pane() === 'claude'"
                  [focusTick]="api.focusTerm()"
                  [hidden]="t.path !== active() || pane() !== 'claude'"
                  (ready)="api.doneStarting(t.path)"
                />
              }
              @if (t.dev) {
                <app-terminal-view
                  kind="dev"
                  [path]="t.path"
                  [active]="t.path === active() && pane() === 'dev'"
                  [focusTick]="api.focusTerm()"
                  [hidden]="t.path !== active() || pane() !== 'dev'"
                />
              }
              @for (s of t.shells; track s.id) {
                <app-terminal-view
                  kind="shell"
                  [shellId]="s.id"
                  [path]="t.path"
                  [active]="t.path === active() && pane() === 'shell:' + s.id"
                  [focusTick]="api.focusTerm()"
                  [hidden]="t.path !== active() || pane() !== 'shell:' + s.id"
                />
              }
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
        </div>
        <div
          class="psplit"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          aria-label="Resize preview"
          aria-controls="dock-preview"
          [attr.aria-valuenow]="round(split() * 100)"
          aria-valuemin="20"
          aria-valuemax="80"
          title="Drag to resize · double-click to split evenly"
          (pointerdown)="startResize($event)"
          (dblclick)="setSplitByHand(0.5)"
          (keydown)="splitKey($event)"
        ></div>
        <app-preview-pane id="dock-preview" [tabs]="tabs()" [active]="active()" (showOutput)="showPane('dev')" />
      </div>
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
      devCommand: t.devCommand ?? null, dev: t.dev ?? null, shells: t.shells ?? [],
    }));
    for (const path of Object.keys(this.api.starting())) {
      if (!terms.some((t) => t.path === path)) tabs.push({ path, exited: false, live: false, label: names.get(path) ?? path, state: 'busy', devCommand: null, dev: null, shells: [] });
    }
    return tabs;
  });

  /** Falls back to the first tab when the chosen one is gone. */
  protected readonly active = computed(() => {
    const want = this.api.activeTerm();
    const tabs = this.tabs();
    return tabs.some((t) => t.path === want) ? want : (tabs[0]?.path ?? null);
  });

  protected readonly current = computed(() => this.tabs().find((t) => t.path === this.active()) ?? null);

  /**
   * Left pane per dock tab: 'claude', 'dev' (the dev server's output) or 'shell:<id>'. Falls back to
   * claude when the chosen one is gone.
   */
  private readonly chosenPane = signal<Record<string, string>>({});
  protected readonly pane = computed(() => {
    const cur = this.current();
    const want = cur ? this.chosenPane()[cur.path] : undefined;
    if (want === 'dev' && cur?.dev) return want;
    if (want?.startsWith('shell:') && cur?.shells.some((s) => 'shell:' + s.id === want)) return want;
    return 'claude';
  });
  protected readonly devState = computed(() => {
    const d = this.current()?.dev;
    return !d || d.exited ? 'none' : d.url ? 'up' : 'busy';
  });
  protected readonly devText = computed(() => {
    const d = this.current()?.dev;
    if (!d) return 'not running';
    if (d.exited) return 'stopped';
    return d.url ? d.url.replace(/^https?:\/\/[^:/]+/, '').replace(/\/$/, '') || 'up' : 'starting…';
  });

  protected showPane(p: string): void {
    const path = this.active();
    if (!path) return;
    this.chosenPane.update((m) => ({ ...m, [path]: p }));
    this.api.focusTerm.update((n) => n + 1);
  }

  /** Open another Git Bash in the active session's worktree and switch to it. */
  protected openShell(): void {
    const path = this.active();
    if (!path) return;
    this.api.openShell(path, (id) => {
      this.chosenPane.update((m) => ({ ...m, [path]: 'shell:' + id }));
      this.api.focusTerm.update((n) => n + 1);
    });
  }

  /** The preview (the app, or its test report) takes the right part of the dock. */
  protected readonly previewOn = signal(load(PREVIEW_KEY) !== 'false');
  protected readonly previewShown = computed(() => this.previewOn() && !!this.current());
  protected readonly split = signal(clampSplit(Number(load(SPLIT_KEY)) || 0.5));
  protected readonly round = Math.round;

  protected togglePreview(): void {
    this.previewOn.update((on) => !on);
    save(PREVIEW_KEY, String(this.previewOn()));
  }

  protected setSplit(f: number): void {
    this.split.set(clampSplit(f));
    save(SPLIT_KEY, String(this.split()));
  }

  /** A quick layout: give the terminal this share of the dock, showing the preview if it was hidden. */
  focusSplit(f: number): void {
    if (!this.previewOn()) this.togglePreview();
    this.setSplit(f);
  }

  /** Resized by hand: the dock no longer matches a quick layout. */
  protected setSplitByHand(f: number): void {
    this.api.setQuickLayout(null);
    this.setSplit(f);
  }

  /** Drag the line between terminal and preview. Captures the pointer so the page in the frame can't swallow it. */
  protected startResize(e: PointerEvent): void {
    if (e.button !== 0) return;
    const handle = e.target as HTMLElement;
    const box = handle.parentElement!.getBoundingClientRect();
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      this.api.setQuickLayout(null);
      this.split.set(clampSplit((ev.clientX - box.left) / box.width));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      this.setSplit(this.split());
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  protected splitKey(e: KeyboardEvent): void {
    const step = e.shiftKey ? 0.1 : 0.05;
    const by = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    if (by) this.setSplitByHand(this.split() + by);
    else if (e.key === 'Home' || e.key === 'End') this.setSplitByHand(e.key === 'Home' ? 0.2 : 0.8);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

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
