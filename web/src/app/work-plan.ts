import { Component, computed, inject, input, signal } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { StepList } from './step-list';
import { TeardownCard } from './teardown-card';
import { WorkStepKey, Worktree } from './model';

const LAND_KEYS: ReadonlySet<string> = new Set(['merge', 'teardown', 'archive']);

/**
 * A work session's lifecycle: the step checklist (each row doubles as a manual knob),
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
        @if (p.badges.length) {
          <div class="badges">
            @for (b of p.badges; track b) { <span [class]="'badge ' + b" [title]="p.blockedReason ?? ''">{{ b }}</span> }
          </div>
        }

        @if (macroShown(); as m) {
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
          @let canShip = shipLeft() && p.stage !== 'ready-to-land' && p.stage !== 'landing' && p.stage !== 'done';
          <section class="group" aria-labelledby="ship-h">
            <div class="g-head">
              <h3 id="ship-h">Ship</h3>
              <button type="button" class="btn" [class.due]="canShip" (click)="api.ship(w.path)"
                      [disabled]="!canShip || busy() || working() || p.stage === 'setup'"
                      [title]="!canShip ? 'Shipped: the PR is open'
                        : p.stage === 'setup' ? 'Nothing to ship yet — no changes or commits in this worktree'
                        : working() ? 'Wait until the work here finishes (the tile is still green)'
                        : 'Commit leftovers, rebase if behind, push, and open a PR — then stop for your review'">
                {{ busy() && canShip ? 'Working…' : 'Ship it' }}
              </button>
            </div>
            <app-step-list [steps]="shipSteps()" [quietDone]="true" [runnable]="runnable()" [runDisabled]="busy() || working()" (run)="runStep($event)" />
          </section>

          <section class="group" aria-labelledby="land-h">
            <div class="g-head">
              <h3 id="land-h">Land</h3>
              @if (p.stage !== 'done') {
                <button type="button" class="btn" [class.due]="p.stage === 'ready-to-land'" (click)="landing.set(true)"
                        [disabled]="busy() || p.stage !== 'ready-to-land'"
                        [title]="p.stage === 'ready-to-land' ? 'Merge the PR, remove the worktree, archive the session' : 'Enabled once the PR is clean and the branch is up to date with ' + w.work!.session.base">
                  {{ p.stage === 'landing' ? 'Landing…' : 'Land it' }}
                </button>
              }
            </div>
            @if (landing()) {
              <app-teardown-card [wt]="w" [land]="true" (confirm)="land($event)" (cancel)="landing.set(false)" />
            } @else {
              <app-step-list [steps]="landSteps()" [quietDone]="true" [runnable]="runnable()" [runDisabled]="busy() || working()" (run)="runStep($event)" />
            }
          </section>
        }
      </section>
    }
  `,
  styles: `
    /* The parent sets the inset: none inside the session card, 12px when it sits on its own. */
    :host { display: block; flex: none; }
    :host(.top) { padding: 12px 12px 0; }
    .plan { display: grid; gap: 10px; }
    .badges { display: flex; gap: 6px; }
    .group { display: grid; gap: 4px; }
    .group + .group { padding-top: 10px; border-top: 1px solid var(--border); }
    .g-head { display: flex; align-items: center; gap: 8px; min-height: 22px; }
    .g-head h3 { flex: 1; margin: 0; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    /* Both groups share one name width (it also holds the ready step's context), so their columns line up as one list. */
    app-step-list { --step-name-col: 22ch; }
    .badge { font-size: 11px; color: var(--muted); }
    /* Same raised button as the Git tab's actions; "due" = the step this plan is waiting on. */
    .btn {
      display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px;
      font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
      color: var(--text); background: var(--panel);
      border: 1px solid var(--border); border-radius: 5px; box-shadow: 0 1px 0 var(--border);
    }
    .btn.due:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    .btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--hover); }
    .btn:active:not(:disabled) { transform: translateY(1px); box-shadow: none; }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .btn:disabled { cursor: default; color: var(--muted); box-shadow: none; }
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
  /** The Land it confirmation (teardown card in land mode) is open. */
  protected readonly landing = signal(false);
  /** startedAt of the finished macro run the user dismissed. */
  protected readonly dismissed = signal<number | null>(null);

  protected readonly busy = computed(() => this.api.workBusy(this.wt().path) || this.api.smartBusy(this.wt().path));
  /** The tile is green (Claude mid-turn, a session booting, checks running): shipping now would catch half-done work. */
  protected readonly working = computed(() => this.api.worktreeState(this.wt()) === 'busy');

  /** Ship it covers commit…pr; Land it covers merge → teardown → archive. */
  protected readonly shipSteps = computed(() => (this.wt().work?.plan?.steps ?? []).filter((s) => !LAND_KEYS.has(s.key)));
  protected readonly landSteps = computed(() => (this.wt().work?.plan?.steps ?? []).filter((s) => LAND_KEYS.has(s.key)));

  /** Ship's half (commit…pr) isn't finished: the primary action is Ship it. */
  protected readonly shipLeft = computed(() => this.shipSteps().some((s) => s.status !== 'done' && s.status !== 'skipped'));

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
