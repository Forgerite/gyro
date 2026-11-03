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
        @let detail = quietDone() && s.status === 'done' ? '' : s.detail ?? (s.status === 'pending' ? pendingDetail() : '');
        <li [class]="s.status">
          <span class="mark" aria-hidden="true">{{ mark[s.status] }}</span>
          @if (runnable()?.has(s.key)) {
            <!-- Ready for action: its context sits under the name, the button takes the last column. -->
            <span class="name">
              {{ s.label }} <span class="sr-only">: {{ s.status }}</span>
              @if (detail) { <span class="ctx">{{ detail }}</span> }
            </span>
            <span class="slot">
              <button type="button" class="run" (click)="run.emit(s.key)" [disabled]="runDisabled()">{{ runLabel(s.key) }}</button>
            </span>
          } @else {
            <!-- Not ready (or done): the explainer stands where the button will appear. -->
            <span class="name">{{ s.label }} <span class="sr-only">: {{ s.status }}</span></span>
            <span class="slot det">{{ detail }}</span>
          }
        </li>
      }
    </ol>
  `,
  styles: `
    /*
     * One grid for the whole list, each row a subgrid of it: mark · name (plus context on a step
     * that's ready) · one slot that holds either the step's button or why it isn't ready yet.
     */
    .steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 14px var(--step-name-col, auto) minmax(0, 1fr); gap: 3px 12px; }
    .steps li { display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; align-items: baseline; }
    .mark { color: var(--muted); text-align: center; }
    .done .mark, .running .mark { color: var(--accent); }
    /* Only a step that actually went wrong is coloured; blocked just means its turn hasn't come. */
    .failed .mark, .failed .det { color: var(--danger); }
    .pending .name, .blocked .name { color: var(--muted); }
    .name { min-width: 0; }
    .ctx { display: block; color: var(--text-2); font-size: 11px; overflow-wrap: anywhere; }
    .slot { min-width: 0; }
    .det { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .run {
      padding: 1px 8px; font: inherit; font-size: 11px; white-space: nowrap; cursor: pointer;
      color: var(--text); background: var(--panel);
      border: 1px solid var(--border); border-radius: 5px; box-shadow: 0 1px 0 var(--border);
    }
    .run:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--hover); }
    .run:active:not(:disabled) { transform: translateY(1px); box-shadow: none; }
    .run:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .run:disabled { cursor: default; color: var(--muted); box-shadow: none; }
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
  /** A checked-off step shows no detail: nothing left to say about it. */
  readonly quietDone = input(false);
  /** Run one step by key. */
  readonly run = output<string>();

  protected readonly mark = MARK;

  protected runLabel(key: string): string {
    return { commit: 'compose commit', sync: 'rebase', push: 'push', pr: 'create PR', merge: 'merge', teardown: 'remove worktree', archive: 'archive' }[key] ?? 'run';
  }
}
