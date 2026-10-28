import { Component, computed, inject, input, signal } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { StepList } from './step-list';
import { TeardownCard } from './teardown-card';
import { WorkStage, WorkStepKey, Worktree } from './model';

export const STAGE_LABEL: Record<WorkStage, string> = {
  'setup': 'setting up',
  'working': 'working',
  'ready-to-ship': 'ready to ship',
  'in-review': 'in review',
  'ready-to-land': 'ready to land',
  'landing': 'landing',
  'done': 'done',
};

/**
 * A work session's lifecycle: stage pill, the step checklist (each row doubles as a manual knob),
 * and the two macros. Ship it runs commit → sync → push → PR and stops there for review; Land it
 * (merge → teardown → archive) stays disabled until the PR is clean AND the branch is current with
 * its base, and confirms through the teardown card first.
 */
@Component({
  selector: 'app-work-plan',
  imports: [StepList, TeardownCard],
  template: `
    @let w = wt();
    @if (w.work?.plan; as p) {
      <section class="plan" aria-label="Session lifecycle">
        <div class="head">
          <span [class]="'stage ' + p.stage">{{ stageLabel[p.stage] }}</span>
          @for (b of p.badges; track b) { <span [class]="'badge ' + b" [title]="p.blockedReason ?? ''">{{ b }}</span> }
          <span class="spacer"></span>
          @if (shipLeft() && p.stage !== 'ready-to-land' && p.stage !== 'landing' && p.stage !== 'done') {
            <button type="button" class="cta" (click)="api.ship(w.path)" [disabled]="busy() || working() || p.stage === 'setup'"
                    [title]="p.stage === 'setup' ? 'Nothing to ship yet — no changes or commits in this worktree'
                      : working() ? 'Wait until the work here finishes (the tile is still green)'
                      : 'Commit leftovers, rebase if behind, push, and open a PR — then stop for your review'">
              {{ busy() ? 'Working…' : 'Ship it' }}
            </button>
          } @else if (p.stage !== 'done') {
            <button type="button" class="cta" (click)="landing.set(true)" [disabled]="busy() || p.stage !== 'ready-to-land'"
                    [title]="p.stage === 'ready-to-land' ? 'Merge the PR, remove the worktree, archive the session' : 'Enabled once the PR is clean and the branch is up to date with ' + w.work!.session.base">
              {{ p.stage === 'landing' ? 'Landing…' : 'Land it' }}
            </button>
          }
        </div>

        @if (landing()) {
          <app-teardown-card [wt]="w" [land]="true" (confirm)="land($event)" (cancel)="landing.set(false)" />
        } @else if (macroShown(); as m) {
          <div class="macro" [class.failed]="m.status === 'failed'">
            <div class="m-head">
              <span>{{ m.macro === 'ship' ? 'Ship it' : m.macro === 'land' ? 'Land it' : 'Step' }}
                {{ m.status === 'running' ? 'is running…' : m.status === 'failed' ? 'stopped' : 'finished' }}</span>
              @if (m.status !== 'running') {
                <button type="button" class="link" (click)="dismissed.set(m.startedAt)">dismiss</button>
              }
            </div>
            <app-step-list [steps]="m.steps" />
            @if (m.error) { <p class="err" role="alert">{{ m.error }}</p> }
          </div>
        } @else {
          <app-step-list [steps]="p.steps" [runnable]="runnable()" [runDisabled]="busy() || working()" (run)="runStep($event)" />
        }
      </section>
    }
  `,
  styles: `
    /* The parent sets the inset: none inside the session card, 12px when it sits on its own. */
    :host { display: block; flex: none; }
    :host(.top) { padding: 12px 12px 0; }
    .plan { display: grid; gap: 6px; }
    .head { display: flex; align-items: center; gap: 6px; }
    .spacer { flex: 1; }
    .stage { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--text-2); white-space: nowrap; }
    .stage.ready-to-ship, .stage.ready-to-land { color: var(--accent); border-color: var(--accent); }
    .stage.landing { color: var(--accent); }
    .stage.done { color: var(--muted); }
    .badge { font-size: 11px; color: var(--muted); }
    .badge.blocked { color: var(--danger); }
    .macro { display: grid; gap: 4px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; }
    .macro.failed { border-color: var(--danger); }
    .m-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: var(--text-2); }
    .err { margin: 0; color: var(--danger); font-size: 12px; overflow-wrap: anywhere; }
  `,
})
export class WorkPlan {
  readonly wt = input.required<Worktree>();

  protected readonly api = inject(DashboardService);
  protected readonly stageLabel = STAGE_LABEL;
  /** The Land it confirmation (teardown card in land mode) is open. */
  protected readonly landing = signal(false);
  /** startedAt of the finished macro run the user dismissed. */
  protected readonly dismissed = signal<number | null>(null);

  protected readonly busy = computed(() => this.api.workBusy(this.wt().path) || this.api.smartBusy(this.wt().path));
  /** The tile is green (Claude mid-turn, a session booting, checks running): shipping now would catch half-done work. */
  protected readonly working = computed(() => this.api.worktreeState(this.wt()) === 'busy');

  /** Ship's half (commit…pr) isn't finished: the primary action is Ship it. */
  protected readonly shipLeft = computed(() => {
    const steps = this.wt().work?.plan?.steps ?? [];
    return steps.some((s) => s.key !== 'merge' && s.key !== 'teardown' && s.key !== 'archive' && s.status !== 'done' && s.status !== 'skipped');
  });

  /** The latest macro run, while it runs and until its outcome is dismissed. */
  protected readonly macroShown = computed(() => {
    const m = this.wt().work?.macro;
    if (!m || m.startedAt === this.dismissed()) return null;
    return m.status === 'running' || m.status === 'failed' ? m : null;
  });

  /**
   * The manual knobs: pending rows only — the evaluator marks a step with unmet prerequisites as
   * blocked, with the reason as its detail. Teardown stays behind the Archive/Land flows (the ack).
   */
  protected readonly runnable = computed(() => {
    const steps = this.wt().work?.plan?.steps ?? [];
    return new Set(steps.filter((s) => s.status === 'pending' && s.key !== 'teardown').map((s) => s.key));
  });

  protected runStep(step: string): void {
    this.api.runStep(this.wt().path, step as WorkStepKey);
  }

  protected land(opts: { ack: boolean; deleteRemote: boolean }): void {
    this.landing.set(false);
    this.api.land(this.wt().path, opts);
  }
}
