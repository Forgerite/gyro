import { Component, input, output } from '@angular/core';

/** One checklist row; statuses cover both Gyro conversions and work-session plans. */
export interface StepRow {
  key: string;
  label: string;
  status: 'done' | 'skipped' | 'failed' | 'pending' | 'running' | 'blocked';
  detail: string | null;
}

const MARK: Record<StepRow['status'], string> = { done: '✓', skipped: '–', failed: '✗', pending: '○', running: '◌', blocked: '⊘' };

/** A dumb step checklist (Gyro conversion, work-session plan, macro progress). */
@Component({
  selector: 'app-step-list',
  template: `
    <ol class="steps">
      @for (s of steps(); track s.key) {
        <li [class]="s.status">
          <span class="mark" aria-hidden="true">{{ mark[s.status] }}</span>
          <span class="name">{{ s.label }} <span class="sr-only">: {{ s.status }}</span></span>
          <span class="det">{{ s.detail ?? (s.status === 'pending' ? pendingDetail() : '') }}</span>
          @if (runnable()?.has(s.key)) {
            <button type="button" class="link run" (click)="run.emit(s.key)" [disabled]="runDisabled()">{{ runLabel(s.key) }}</button>
          }
        </li>
      }
    </ol>
  `,
  styles: `
    /* One grid for the whole list, each row a subgrid of it: labels and reasons line up down the column. */
    .steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 14px auto minmax(0, 1fr) auto; gap: 2px 12px; }
    .steps li { display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; align-items: baseline; }
    .mark { color: var(--muted); text-align: center; }
    .done .mark, .running .mark { color: var(--accent); }
    /* Only a step that actually went wrong is coloured; blocked just means its turn hasn't come. */
    .failed .mark, .failed .det { color: var(--danger); }
    .pending .name, .blocked .name { color: var(--muted); }
    .det { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .run { font-size: 11px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `,
})
export class StepList {
  readonly steps = input.required<StepRow[]>();
  /** Shown for a pending row with no detail of its own. */
  readonly pendingDetail = input('');
  /** Keys that get a "run" button (the manual knobs); null hides them all. */
  readonly runnable = input<Set<string> | null>(null);
  readonly runDisabled = input(false);
  /** Run one step by key. */
  readonly run = output<string>();

  protected readonly mark = MARK;

  protected runLabel(key: string): string {
    return { commit: 'compose commit', sync: 'rebase', push: 'push', pr: 'create PR', merge: 'merge', teardown: 'remove worktree', archive: 'archive' }[key] ?? 'run';
  }
}
