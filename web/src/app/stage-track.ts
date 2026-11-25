import { Component, computed, input, output } from '@angular/core';
import { WorkPlan, WorkStage } from './model';

export const STAGE_LABEL: Record<WorkStage, string> = {
  setup: 'Setup',
  working: 'Working',
  'ready-to-ship': 'Ready to ship',
  'in-review': 'In review',
  'ready-to-land': 'Ready to land',
  landing: 'Landing',
  done: 'Done',
};

type Mark = 'done' | 'current' | 'blocked' | 'skipped' | 'todo';

/**
 * Each step's mark. The first pending step is current. A step the server can't run yet ("blocked", e.g. nothing
 * to commit) is just not done, unless the whole plan is blocked on a human: then the first one is coral.
 */
function marks(plan: WorkPlan): Mark[] {
  const current = plan.steps.findIndex((s) => s.status === 'pending');
  const stuck = plan.badges.includes('blocked') ? plan.steps.findIndex((s) => s.status === 'blocked') : -1;
  return plan.steps.map((s, i) =>
    i === stuck ? 'blocked' : s.status === 'done' ? 'done' : s.status === 'skipped' ? 'skipped' : i === current ? 'current' : 'todo');
}

/** The plan folded into a row: one bar per step, the same colours as StageTrack. */
@Component({
  selector: 'app-stage-strip',
  template: `
    @for (m of marks(); track $index) { <i [class]="m"></i> }
  `,
  styles: `
    :host { display: inline-flex; align-items: center; gap: 2px; flex: none; }
    i { display: block; width: 9px; height: 4px; border-radius: 1px; background: var(--line-strong); opacity: .55; }
    i.done { background: var(--go); opacity: 1; }
    i.current { background: var(--ink); height: 8px; opacity: 1; }
    i.blocked { background: var(--danger); height: 8px; opacity: 1; }
    i.skipped { background: none; box-shadow: inset 0 0 0 1px var(--line-strong); }
  `,
  host: { role: 'img', '[attr.aria-label]': 'label()', '[title]': 'label()' },
})
export class StageStrip {
  readonly plan = input.required<WorkPlan>();
  protected readonly marks = computed(() => marks(this.plan()));
  protected readonly label = computed(() => 'Plan: ' + STAGE_LABEL[this.plan().stage].toLowerCase());
}

/** The selected worktree's plan: seven steps in a line, each with its detail. */
@Component({
  selector: 'app-stage-track',
  template: `
    <ol [attr.aria-label]="'Plan: ' + stage()">
      @for (s of plan().steps; track s.key; let i = $index) {
        <li [class]="marks()[i]" [attr.aria-current]="marks()[i] === 'current' ? 'step' : null">
          <span class="pip" aria-hidden="true"></span>{{ s.label }}
          <span class="detail" [title]="s.detail ?? ''">{{ s.detail ?? ' ' }}</span>
          @if (runnable()?.has(s.key)) {
            <button type="button" class="run" (click)="run.emit(s.key)" [disabled]="runDisabled()"
                    [title]="'Run just this step: ' + s.label">{{ runLabel(s.key) }}</button>
          }
        </li>
      }
    </ol>
  `,
  styles: `
    :host { display: block; }
    ol { display: flex; list-style: none; margin: 0; padding: 0; }
    li { flex: 1; position: relative; display: flex; flex-direction: column; gap: 6px; font-size: 11px; line-height: 14px; color: var(--ink-3); min-width: 0; }
    li::before { content: ''; position: absolute; top: 5px; left: 14px; right: 4px; height: 2px; background: var(--line); }
    li:last-child::before { display: none; }
    .pip { position: relative; z-index: 1; width: 12px; height: 12px; border-radius: var(--radius-pill); border: 2px solid var(--line-strong); background: var(--ground-1); box-sizing: border-box; }
    li.done { color: var(--ink-2); }
    li.done::before { background: var(--go); }
    li.done .pip { border-color: var(--go); background: var(--go); }
    li.current { color: var(--ink); font-weight: 600; }
    li.current .pip { border-color: var(--ink); box-shadow: 0 0 0 3px var(--ground-3); }
    li.blocked { color: var(--danger-ink); font-weight: 600; }
    li.blocked .pip { border-color: var(--danger); background: var(--danger); border-radius: var(--radius-sm); transform: rotate(45deg) scale(.85); }
    li.skipped { text-decoration: line-through; }
    .run {
      align-self: flex-start; display: inline-flex; align-items: center; height: 20px; padding: 0 6px; margin-top: 2px;
      border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: none; color: var(--ink);
      font: 500 11px/1 var(--font-sans); cursor: pointer; white-space: nowrap; max-width: calc(100% - 4px); overflow: hidden; text-overflow: ellipsis;
    }
    .run:hover:not(:disabled) { background: var(--ground-2); }
    .run:disabled { opacity: .45; cursor: default; }
    .detail { font: 400 11px/14px var(--font-mono); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 8px; font-weight: 400; text-decoration: none; }
  `,
})
export class StageTrack {
  readonly plan = input.required<WorkPlan>();
  /** Steps that get their own run button (the manual knobs); null hides them all. */
  readonly runnable = input<ReadonlySet<string> | null>(null);
  readonly runDisabled = input(false);
  /** Run one step by key. */
  readonly run = output<string>();

  protected runLabel(key: string): string {
    return ({ commit: 'Compose', sync: 'Rebase', push: 'Push', pr: 'Create PR', merge: 'Merge', teardown: 'Remove', archive: 'Archive' } as Record<string, string>)[key] ?? 'Run';
  }
  protected readonly marks = computed(() => marks(this.plan()));
  protected readonly stage = computed(() => STAGE_LABEL[this.plan().stage].toLowerCase());
}
