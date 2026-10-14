import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';
import { LOOSE_RECENT_MS, Selection, Session, Workspace, Worktree } from './model';
import { TerminalDock } from './terminal-dock';
import { DiffViewer } from './diff-viewer';
import { LooseSessionPanel } from './loose-session-panel';
import { Created, NewProjectPanel } from './new-project-panel';
import { ProjectPanel } from './project-panel';
import { OpenRequest, WorktreePanel } from './worktree-panel';
import { SessionPick, WorkspaceCard } from './workspace-card';
import { BulkArchivePanel, PickedSession } from './bulk-archive-panel';

const STALE_MS = 14 * 86_400_000;
const DOCK_KEY = 'ccdb.dockHeight';
const DOCK_MIN = 120;

@Component({
  selector: 'app-root',
  imports: [WorkspaceCard, ProjectPanel, WorktreePanel, LooseSessionPanel, BulkArchivePanel, NewProjectPanel, TerminalDock, DiffViewer, AgoPipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
  host: { '(document:keydown)': 'onKey($event)' },
})
export class App {
  protected readonly api = inject(DashboardService);
  private readonly filterInput = viewChild<ElementRef<HTMLInputElement>>('filterInput');

  protected readonly filter = signal('');
  protected readonly activeOnly = signal(false);
  protected readonly selected = signal<Selection | null>(null);
  /** Loose sessions multi-selected for a bulk archive (Ctrl/Shift+click); two or more take over the panel. */
  protected readonly multi = signal<string[]>([]);
  /** The panel shows the New project form instead of the selection. */
  protected readonly creating = signal(false);
  /** Last loose session clicked: where a Shift+click range starts. */
  private anchor: string | null = null;
  protected readonly now = this.api.now;
  protected readonly dockHeight = signal(loadDockHeight());

  /** Dock terminal for the selected worktree, if one exists. */
  protected readonly selectedTerm = computed(() => {
    const path = this.targetPath();
    return path ? this.api.snapshot()?.terms.find((t) => t.path === path) : undefined;
  });

  protected readonly workspaces = computed(() => {
    const snap = this.api.snapshot();
    if (!snap) return [];
    const q = this.filter().trim().toLowerCase();
    const cutoff = this.now() - STALE_MS;
    return snap.workspaces
      .map((ws) => ({
        ...ws,
        worktrees: ws.worktrees.filter((wt) => {
          if (this.activeOnly() && wt.lastActivity < cutoff && !wt.sessions.some((s) => s.live)) return false;
          if (!q) return true;
          const hay = [ws.name, wt.name, wt.branch, ...wt.sessions.map((s) => s.title)].join(' ').toLowerCase();
          return hay.includes(q);
        }),
        loose: !q ? ws.loose : ws.loose.filter((s) => [ws.name, s.worktreeName, s.title].join(' ').toLowerCase().includes(q)),
      }))
      .filter((ws) => ws.worktrees.length || ws.loose.length);
  });

  /** Display order for keyboard navigation: each project header, then its worktrees. */
  private readonly flat = computed<Selection[]>(() =>
    this.workspaces().flatMap((ws) => [
      { kind: 'project' as const, path: ws.path },
      ...ws.worktrees.map((wt) => ({ kind: 'worktree' as const, path: wt.path })),
      ...ws.loose
        .filter((s) => s.live || this.now() - s.lastActivity < LOOSE_RECENT_MS || s.id === this.selected()?.path)
        .map((s) => ({ kind: 'session' as const, path: s.id })),
    ]),
  );

  /** Resolves the selection against the latest snapshot (ignores the filter, so it survives typing). */
  protected readonly selection = computed(() => {
    const sel = this.selected();
    if (!sel) return null;
    for (const ws of this.api.snapshot()?.workspaces ?? []) {
      if (sel.kind === 'project') {
        if (ws.path === sel.path) return { kind: 'project' as const, ws };
      } else if (sel.kind === 'session') {
        const s = ws.loose.find((x) => x.id === sel.path);
        if (s) return { kind: 'session' as const, ws, s };
      } else {
        const wt = ws.worktrees.find((w) => w.path === sel.path);
        if (wt) return { kind: 'worktree' as const, ws, wt };
      }
    }
    return null;
  });

  protected readonly otherSessions = computed(() =>
    (this.api.snapshot()?.unmatched ?? []).filter((s) => s.live || this.now() - s.lastActivity < 7 * 86_400_000),
  );

  /** Folder that actions (terminal, editor) act on: the worktree, the repo for a project, or a loose session's folder. */
  private readonly targetPath = computed(() => {
    const sel = this.selection();
    if (!sel) return null;
    if (sel.kind === 'project') return sel.ws.path;
    if (sel.kind === 'session') return sel.s.folderExists ? (sel.s.cwd ?? null) : null;
    return sel.wt.path;
  });

  /** The multi-selection resolved against the latest snapshot (archived ones drop out on their own). */
  protected readonly picked = computed<PickedSession[]>(() => {
    const ids = new Set(this.multi());
    if (!ids.size) return [];
    return (this.api.snapshot()?.workspaces ?? []).flatMap((ws) =>
      ws.loose.filter((s) => ids.has(s.id)).map((s) => ({ s, project: ws.name })),
    );
  });

  constructor() {
    effect(() => {
      const sel = this.selected();
      if (sel) document.getElementById(idFor(sel))?.scrollIntoView({ block: 'nearest' });
    });
    // The diff viewer belongs to one worktree; selecting anything else closes it.
    effect(() => {
      const sel = this.selected();
      const d = untracked(() => this.api.diffView());
      if (d && !(sel?.kind === 'worktree' && sel.path === d.path)) this.api.diffView.set(null);
    });
    // Selecting a worktree brings its terminal tab forward (without stealing focus).
    effect(() => {
      const t = this.selectedTerm();
      if (t) this.api.showTerm(t.path, false);
    });
  }

  protected selectWorktree(path: string) {
    this.multi.set([]);
    this.creating.set(false);
    this.selected.set({ kind: 'worktree', path });
  }

  protected startCreating() {
    this.multi.set([]);
    this.creating.set(true);
  }

  /** New repo: select its main worktree. A converted folder opens on the Git tab to review its files. */
  protected projectCreated({ path, mode }: Created) {
    this.creating.set(false);
    this.selected.set({ kind: 'worktree', path });
    this.api.setPanelTab(mode === 'directory' ? 'git' : 'session');
  }

  protected selectSession(id: string) {
    this.selected.set({ kind: 'session', path: id });
  }

  /** Loose row clicked: plain selects it alone; Ctrl/Cmd toggles it in the multi-selection; Shift picks a range. */
  protected pickSession({ id, mode, order }: SessionPick) {
    const cur = this.selected();
    if (mode === 'single') {
      this.multi.set([]);
    } else if (mode === 'range' && this.anchor && order.includes(this.anchor)) {
      const [a, b] = [order.indexOf(this.anchor), order.indexOf(id)].sort((x, y) => x - y);
      this.multi.set(order.slice(a, b + 1));
      this.selectSession(id);
      return;
    } else {
      // Ctrl+click after a plain click starts the multi-selection from the session already shown.
      const base = this.multi().length ? this.multi() : cur?.kind === 'session' ? [cur.path] : [];
      this.multi.set(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
    }
    this.anchor = id;
    this.selectSession(id);
  }

  protected unpick(id: string) {
    this.multi.update((m) => m.filter((x) => x !== id));
  }

  protected selectProject(path: string) {
    this.multi.set([]);
    this.creating.set(false);
    this.selected.set({ kind: 'project', path });
  }

  /** Up from a worktree to its project. */
  protected up() {
    const sel = this.selection();
    if (sel?.kind === 'worktree' || sel?.kind === 'session') this.selectProject(sel.ws.path);
  }

  /** Actions target the selected worktree, or the repo root (its main worktree) for a project. */
  protected open(req: OpenRequest) {
    const path = this.targetPath();
    if (!path) return;
    if (req.action === 'term') this.api.startTerm(path, req.sessionId);
    else if (req.action === 'focus') this.api.showTerm(path);
    else this.api.open(req.action, path, req.sessionId);
  }

  /** Dock tab clicked: select its worktree (or loose session) so the panel above matches. */
  protected pickTerm(path: string) {
    const term = this.api.snapshot()?.terms.find((t) => t.path === path);
    const loose = this.api.snapshot()?.workspaces.flatMap((ws) => ws.loose).find((s) => s.id === term?.sessionId && s.cwd === path);
    if (loose) this.selectSession(loose.id);
    else this.selectWorktree(path);
    this.api.showTerm(path);
  }

  /**
   * Ctrl+`, VS Code style: hidden → show and focus; shown but focus elsewhere → focus it;
   * focused (or nothing to focus) → hide and return to the dashboard.
   */
  protected toggleTerminal() {
    const inDock = !!(document.activeElement as HTMLElement | null)?.closest('app-terminal-dock');
    if (this.api.dockOpen() && inDock) {
      this.api.setDockOpen(false);
      this.leaveTerminal();
      return;
    }
    // Open (if hidden) and focus: the active terminal, a session still starting, or the empty dock.
    const active =
      this.api.activeTerm() ?? Object.keys(this.api.starting())[0] ?? this.api.snapshot()?.terms[0]?.path ?? null;
    if (active) this.api.showTerm(active);
    else {
      this.api.setDockOpen(true);
      this.api.focusTerm.update((n) => n + 1);
    }
  }

  /** Return keyboard focus to the selected tile. */
  protected leaveTerminal() {
    (document.activeElement as HTMLElement | null)?.blur();
    const sel = this.selected();
    if (sel) document.getElementById(idFor(sel))?.focus();
  }

  protected startResize(e: PointerEvent) {
    const handle = e.target as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const h = Math.min(window.innerHeight - 160, Math.max(DOCK_MIN, window.innerHeight - ev.clientY));
      this.dockHeight.set(Math.round(h));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      try { localStorage.setItem(DOCK_KEY, String(this.dockHeight())); } catch { /* storage unavailable */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  /** Project: drill into its first worktree. Worktree: resume its latest session, or start one. Live sessions are left alone. */
  protected activate(path?: string) {
    if (path) this.selectWorktree(path);
    const sel = this.selection();
    if (!sel) return;
    if (sel.kind === 'session') {
      const t = this.selectedTerm();
      if (t && !t.exited) return this.api.showTerm(t.path);
      if (sel.s.live || !sel.s.folderExists || !sel.s.cwd) return; // open elsewhere, or nowhere left to resume it
      return this.api.startTerm(sel.s.cwd, sel.s.id);
    }
    if (sel.kind === 'project') {
      const first = this.workspaces().find((w) => w.path === sel.ws.path)?.worktrees[0] ?? sel.ws.worktrees[0];
      if (first) this.selectWorktree(first.path);
      return;
    }
    if (this.selectedTerm() && !this.selectedTerm()!.exited) return this.api.showTerm(sel.wt.path);
    const top = sel.wt.sessions[0];
    if (top?.live) return; // open elsewhere (e.g. Claude Desktop); resuming here would fork it
    this.api.startTerm(sel.wt.path, top?.id);
  }

  protected onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
    // Single handler for Ctrl+`, including from inside xterm (which only swallows the key).
    if (e.ctrlKey && (e.code === 'Backquote' || e.key === '`')) {
      this.toggleTerminal();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && this.multi().length && !typing) {
      this.multi.set([]);
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && target === this.filterInput()?.nativeElement) {
      this.filter.set('');
      target.blur();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    // The New project form owns the keyboard while it's open (Esc closes it).
    if (this.creating()) {
      if (e.key === 'Escape') this.creating.set(false);
      return;
    }

    // While a diff is open, j/k step through changed files and Esc closes it.
    if (this.api.diffView()) {
      const diffKeys: Record<string, () => void> = {
        Escape: () => this.api.diffView.set(null),
        j: () => this.api.stepDiff(1),
        ArrowDown: () => this.api.stepDiff(1),
        k: () => this.api.stepDiff(-1),
        ArrowUp: () => this.api.stepDiff(-1),
        s: () => this.api.setDiffMode(this.api.diffMode() === 'split' ? 'inline' : 'split'),
      };
      const act = diffKeys[e.key];
      if (act) {
        act();
        e.preventDefault();
        return;
      }
    }

    const list = this.flat();
    const cur = this.selected();
    const idx = cur ? list.findIndex((x) => x.kind === cur.kind && x.path === cur.path) : -1;
    const move = (d: number) => {
      const next = list[Math.min(list.length - 1, Math.max(0, idx + d))];
      if (next) this.selected.set(next);
    };

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        move(1);
        break;
      case 'k':
      case 'ArrowUp':
        move(-1);
        break;
      case 'Enter':
        // Panel buttons keep their native Enter; tile rows and headers get activate().
        if (target.tagName === 'BUTTON' && !/^(w[ts]|ls)-/.test(target.id)) return;
        this.activate();
        break;
      case 'u':
      case 'Backspace':
        this.up();
        break;
      case 'n': {
        // Only for an empty worktree; a second session is a deliberate click ("start fresh").
        const sel = this.selection();
        if (sel?.kind === 'worktree' && !sel.wt.sessions.length) this.open({ action: 'term' });
        break;
      }
      case 'c':
        this.open({ action: 'code' });
        break;
      case 'a':
        this.activeOnly.update((v) => !v);
        break;
      case 'g':
        this.api.setPanelTab(this.api.panelTab() === 'git' ? 'session' : 'git');
        break;
      case '/':
        this.filterInput()?.nativeElement.focus();
        break;
      default:
        return; // not ours: leave Tab, Space, etc. to the browser
    }
    e.preventDefault();
  }
}

function idFor(sel: Selection) {
  return ({ project: 'ws-', worktree: 'wt-', session: 'ls-' } as const)[sel.kind] + sel.path;
}

function loadDockHeight() {
  try {
    const v = Number(localStorage.getItem(DOCK_KEY));
    if (v >= DOCK_MIN) return v;
  } catch { /* storage unavailable */ }
  return Math.round(window.innerHeight * 0.45);
}
