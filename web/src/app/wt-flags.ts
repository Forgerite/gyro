import { Component, computed, input } from '@angular/core';
import { GitStatus, PullRequest } from './model';

/** Chips: uncommitted changes, commits not yet in trunk, and the branch's open PR. Renders nothing when clean. */
@Component({
  selector: 'app-wt-flags',
  template: `
    @let g = git();
    @if (g.missing) { <span class="chip danger" title="Worktree folder is missing">missing</span> }
    @if (g.dirty) {
      <span class="chip" role="img" [attr.aria-label]="g.dirty + ' uncommitted'" [title]="g.dirty + ' uncommitted file' + (g.dirty === 1 ? '' : 's')">±{{ g.dirty }}</span>
    }
    @if (g.unmerged) {
      <span class="chip" role="img" [attr.aria-label]="g.unmerged + ' unmerged'" [title]="g.unmerged + ' commit' + (g.unmerged === 1 ? '' : 's') + ' not in ' + g.trunk">↑{{ g.unmerged }}</span>
    }
    @if (pr(); as p) {
      <span class="chip" [class]="'chip ' + prTone()" [class.draft]="p.draft" role="img" [attr.aria-label]="prLabel()" [title]="prLabel()">
        @if (p.checks === 'fail') {✕ } @else if (p.checks === 'pass') {✓ }#{{ p.number }}
      </span>
    }
  `,
  styles: `
    :host { display: inline-flex; gap: var(--space-1); align-items: center; }
    .chip { display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border-radius: var(--radius-sm); background: var(--ground-2); color: var(--ink-2); font: 500 11px/16px var(--font-mono); white-space: nowrap; }
    .chip.outline { background: none; box-shadow: inset 0 0 0 1px var(--line); }
    .chip.go { background: var(--go-soft); color: var(--go-ink); }
    .chip.danger { background: var(--danger-soft); color: var(--danger-ink); }
    .chip.work { background: var(--work-soft); color: var(--work-ink); }
    .chip.draft { box-shadow: inset 0 0 0 1px var(--line); background: none; color: var(--ink-3); }
  `,
})
export class WtFlags {
  readonly git = input.required<GitStatus>();
  readonly pr = input<PullRequest | null>();

  /** PR chip colour: failing checks coral, passing green, running cyan, otherwise an outline. */
  protected readonly prTone = computed(() => {
    const c = this.pr()?.checks;
    return c === 'fail' ? 'danger' : c === 'pass' ? 'go' : c === 'pending' ? 'work' : 'outline';
  });

  protected readonly prLabel = computed(() => {
    const p = this.pr();
    return p ? prSummary(p) : '';
  });
}

/** "PR #12 (draft): title · changes requested · checks failing", for titles and screen readers. */
export function prSummary(p: PullRequest): string {
  const bits = [`PR #${p.number}${p.draft ? ' (draft)' : ''}: ${p.title}`];
  const review = reviewText(p.review);
  if (review) bits.push(review);
  if (p.checks) bits.push(CHECKS[p.checks]);
  return bits.join(' · ');
}

export const CHECKS = { pass: 'checks passing', fail: 'checks failing', pending: 'checks running' } as const;

export function reviewText(review: string | null): string | null {
  return review === 'APPROVED' ? 'approved'
    : review === 'CHANGES_REQUESTED' ? 'changes requested'
    : review === 'REVIEW_REQUIRED' ? 'review required'
    : null;
}
