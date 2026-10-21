import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { Worktree } from './model';

/** Auto rebase progress, then its outcome: Claude's summary plus anything Gyro's own checks flagged. */
@Component({
  selector: 'app-rebase-status',
  template: `
    @if (since(); as at) {
      <div class="card run" role="status">
        <span class="spin" aria-hidden="true"></span>
        Claude is rebasing onto {{ wt().git.trunk }}… {{ seconds(at) }}s
        <span class="sub">Stashing, rebasing, resolving any conflicts, then reapplying your changes. Git actions here wait until it's done.</span>
      </div>
    } @else if (outcome(); as o) {
      @let r = o.result;
      <div class="card" [class.bad]="!!o.error || !!r?.problems?.length" [class.good]="!o.error && !r?.problems?.length" role="status">
        <div class="head">
          <strong>
            @if (o.error) { Rebase didn't run }
            @else if (r!.upToDate) { Already up to date }
            @else if (r!.problems.length) { Rebase needs attention }
            @else { Rebased onto {{ r!.trunk }} · {{ r!.commits }} commit{{ r!.commits === 1 ? '' : 's' }} }
          </strong>
          <button type="button" class="x" (click)="api.clearRebased(wt().path)" aria-label="Dismiss">×</button>
        </div>
        @if (o.error) { <p>{{ o.error }}</p> }
        @if (r) {
          @if (r.upToDate) { <p>{{ r.branch }} already sits on top of {{ r.trunk }}.</p> }
          @for (p of r.problems; track p) { <p class="problem">⚠ {{ p }}</p> }
          @if (r.problems.length) {
            <p class="sub">Open the session terminal to finish it. Nothing is lost: the old tip is saved as <code>{{ r.backup?.head }}</code>@if (r.backup?.wip) { and your uncommitted work as <code>{{ r.backup!.wip }}</code> }.</p>
          }
          @if (r.fetchNote) { <p class="sub">{{ r.fetchNote }}</p> }
          @if (r.summary) {
            <button type="button" class="link" [attr.aria-expanded]="open()" (click)="open.set(!open())">
              {{ open() ? '▾' : '▸' }} What Claude did
            </button>
            @if (open()) { <div class="summary">{{ r.summary }}</div> }
          }
        }
      </div>
    }
  `,
  styleUrl: './rebase-status.css',
})
export class RebaseStatus {
  readonly wt = input.required<Worktree>();
  protected readonly api = inject(DashboardService);

  protected readonly since = computed(() => this.api.rebasing()[this.wt().path] ?? null);
  protected readonly outcome = computed(() => this.api.rebased()[this.wt().path] ?? null);
  /** Claude's summary starts open when something needs a decision or went wrong. */
  protected readonly open = signal(true);

  private readonly clock = signal(Date.now());
  private readonly ticking = effect((onCleanup) => {
    if (this.since() === null) return;
    const id = setInterval(() => this.clock.set(Date.now()), 1000);
    onCleanup(() => clearInterval(id));
  });
  protected seconds(at: number) {
    return Math.max(0, Math.round((this.clock() - at) / 1000));
  }
}
