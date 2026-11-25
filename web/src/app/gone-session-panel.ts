import { Component, computed, inject, input, output, signal } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';
import { Workspace, Worktree } from './model';

/**
 * A Gyro session whose worktree folder is gone (removed outside Gyro, or a Land that stopped partway).
 * The ledger still has it open, so it's listed until you mark it done; there's no git or terminal left to show.
 */
@Component({
  selector: 'app-gone-session-panel',
  imports: [AgoPipe],
  template: `
    @let w = wt();
    <header>
      <nav class="crumb" aria-label="Breadcrumb">
        <button type="button" class="link up" (click)="up.emit()" title="Back to project (u)">{{ ws().name }}</button>
        <span aria-hidden="true">›</span><span>Gyro session</span>
      </nav>
      <h2 tabindex="-1">{{ w.name }}</h2>
      <p class="meta">
        @if (w.branch) { <code>{{ w.branch }}</code> }
        @if (w.work?.session?.base; as base) { → <code>{{ base }}</code> }
        @if (w.work?.session?.pr; as pr) { · PR #{{ pr }} }
        @if (w.work?.session?.issue; as issue) { · issue #{{ issue }} }
      </p>
    </header>

    <section class="body">
      <p class="gone" role="status">
        This session's worktree folder is gone, so there's nothing left to commit, resume or ship from here.
        Gyro still lists it because the session was never marked done.
      </p>
      <p class="path" [title]="w.path">{{ w.path }}</p>

      @if (w.sessions.length) {
        <h3 class="label">Claude conversations</h3>
        <ul class="convs">
          @for (s of w.sessions; track s.id) {
            <li><span class="t">{{ s.title ?? s.id.slice(0, 8) }}</span> <span class="age">{{ s.lastActivity | ago: now() }}</span></li>
          }
        </ul>
      }

      <div class="actions">
        @if (confirming()) {
          <span>Mark this session done? It stops showing; its Claude conversations stay where they are.</span>
          <button type="button" class="btn primary sm" (click)="markDone()" [disabled]="busy()">Mark done</button>
          <button type="button" class="btn ghost sm" (click)="confirming.set(false)" [disabled]="busy()">Cancel</button>
        } @else {
          <button type="button" class="btn secondary sm" (click)="confirming.set(true)">Mark session done</button>
        }
      </div>
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    </section>
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; }
    header { padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--line); }
    .crumb { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--ink-3); }
    .link { all: unset; cursor: pointer; color: var(--ink-2); }
    .link:hover { text-decoration: underline; }
    .link:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
    h2 { margin: var(--space-2) 0 2px; font-size: 16px; font-weight: 600; }
    h2:focus { outline: none; }
    .meta { margin: 0; color: var(--ink-3); font-size: 12px; }
    .body { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); font-size: 13px; }
    .gone { margin: 0; padding: var(--space-3); border-radius: var(--radius-md); background: var(--danger-soft); color: var(--danger-ink); }
    .path { margin: 0; font: 400 11px/16px var(--font-mono); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    h3 { margin: 0; }
    .convs { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
    .convs li { display: flex; gap: var(--space-2); justify-content: space-between; color: var(--ink-2); }
    .convs .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .age { flex: none; font: 400 11px/16px var(--font-mono); color: var(--ink-3); }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); color: var(--ink-2); }
    .err { margin: 0; color: var(--danger-ink); }
  `,
})
export class GoneSessionPanel {
  readonly ws = input.required<Workspace>();
  readonly wt = input.required<Worktree>();
  readonly now = input.required<number>();
  readonly up = output<void>();

  private readonly api = inject(DashboardService);
  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  private readonly errorFor = signal<{ path: string; msg: string } | null>(null);
  /** An error belongs to the session it happened on; switching sessions doesn't carry it over. */
  protected readonly error = computed(() => (this.errorFor()?.path === this.wt().path ? this.errorFor()!.msg : null));

  protected markDone() {
    const path = this.wt().path;
    this.busy.set(true);
    this.api.markSessionDone(path).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirming.set(false);
        this.up.emit();
        this.api.refresh();
      },
      error: (e) => {
        this.busy.set(false);
        this.errorFor.set({ path, msg: e.error?.error ?? e.message });
      },
    });
  }
}
