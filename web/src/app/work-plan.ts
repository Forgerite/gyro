import { Component, computed, inject, input, signal } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { StepList } from './step-list';
import { StageTrack } from './stage-track';
import { TeardownCard } from './teardown-card';
import { WorkStepKey, Worktree } from './model';

const LAND_KEYS: ReadonlySet<string> = new Set(['merge', 'teardown', 'archive']);

/**
 * A work session's lifecycle: the seven steps as a track (a ready step gets its own run button),
 * with each macro bracketing the steps it runs. Ship it runs commit → sync → push → PR and stops there for review; Land it
 * (merge → teardown → archive) stays disabled until the PR is clean AND the branch is current with
 * its base, and confirms through the teardown card first.
 */
@Component({
  selector: 'app-work-plan',
  imports: [StepList, TeardownCard, StageTrack],
  template: `
    @let w = wt();
    @if (w.work?.plan; as p) {
      @let canShip = shipLeft() && p.stage !== 'ready-to-land' && p.stage !== 'landing' && p.stage !== 'done';
      @let shipOff = !canShip || busy() || working() || p.stage === 'setup';
      @let landOff = busy() || p.stage !== 'ready-to-land';
      <section class="plan" aria-label="Session lifecycle">
        <app-stage-track [plan]="p" [runnable]="macroShown() || landing() ? null : runnable()" [runDisabled]="busy() || working()" (run)="runStep($event)" />

        <!-- One bracket per macro under its half of the track: Ship it ends commit…PR, Land it ends merge…archive. -->
        <div class="phases" [style.grid-template-columns]="'repeat(' + (shipSteps().length + landSteps().length) + ', minmax(0, 1fr))'">
          <div class="phase ship" [class.due]="canShip && !shipOff" [style.grid-column]="'1 / span ' + shipSteps().length">
            <span class="label">Ship</span>
            <button type="button" class="btn sm" [class.primary]="canShip && !shipOff" [class.secondary]="!(canShip && !shipOff)"
                    (click)="api.ship(w.path)" [disabled]="shipOff"
                    [title]="!canShip ? 'Shipped: the PR is open'
                      : p.stage === 'setup' ? 'Nothing to ship yet — no changes or commits in this worktree'
                      : working() ? 'Wait until the work here finishes (Claude is still working)'
                      : 'Commit leftovers, rebase if behind, push, and open a PR — then stop for your review'">
              {{ busy() && canShip ? 'Working…' : canShip ? 'Ship it' : 'Shipped' }}
            </button>
          </div>
          <div class="phase land" [class.due]="!landOff" [style.grid-column]="(shipSteps().length + 1) + ' / span ' + landSteps().length">
            <span class="label">Land</span>
            @if (p.stage !== 'done') {
              <button type="button" class="btn sm" [class.primary]="!landOff" [class.secondary]="landOff"
                      (click)="landing.set(true)" [disabled]="landOff"
                      [title]="p.stage === 'ready-to-land' ? 'Merge the PR, remove the worktree, archive the session' : 'Enabled once the PR is clean and the branch is up to date with ' + w.work!.session.base">
                {{ p.stage === 'landing' ? 'Landing…' : 'Land it' }}
              </button>
            } @else {
              <span class="done-note">Landed</span>
            }
          </div>
        </div>

        @if (p.blockedReason || p.badges.length) {
          <p class="blocked" role="status"><span class="ring sm failing" aria-hidden="true"></span>Blocked@if (p.blockedReason) {: {{ p.blockedReason }}}</p>
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
        }

        @if (landing()) {
          <app-teardown-card [wt]="w" [land]="true" (confirm)="land($event)" (cancel)="landing.set(false)" />
        }
      </section>
    }
  `,
  styles: `
    /* The parent sets the inset: none inside the session card, 12px when it sits on its own. */
    :host { display: block; flex: none; min-width: 0; }
    :host(.top) { padding: var(--space-3) var(--space-4) 0; }
    .plan { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); background: var(--ground-0); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: var(--space-3); }
    /* Same column widths as the track (each step is one equal share), so a bracket sits under its own steps. */
    .phases { display: grid; }
    .phase { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-2) 0 0; border-top: 2px solid var(--line); margin-right: var(--space-2); min-width: 0; }
    .phase.land { margin-right: 0; }
    .phase.due { border-top-color: var(--ink); }
    .phase .label { flex: 1; }
    .phase.due .label { color: var(--ink); }
    .done-note { font-size: 12px; color: var(--go-ink); }
    .blocked { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: 12px; color: var(--danger-ink); overflow-wrap: anywhere; }
    .macro { display: grid; gap: 4px; padding: var(--space-2) var(--space-3); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--ground-1); }
    .macro.failed { border-color: var(--danger); }
    .m-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: var(--ink-2); }
    .link { background: none; border: none; padding: 0; color: var(--ink-3); font: inherit; font-size: 11px; cursor: pointer; }
    .link:hover { color: var(--ink); text-decoration: underline; }
    .err { margin: 0; color: var(--danger-ink); font-size: 12px; overflow-wrap: anywhere; }
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
