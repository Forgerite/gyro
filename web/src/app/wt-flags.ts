import { Component, computed, input } from '@angular/core';
import { GitStatus, PullRequest } from './model';

/** Quiet glyphs: uncommitted changes, commits not yet in trunk, and the branch's open PR. Renders nothing when clean. */
@Component({
  selector: 'app-wt-flags',
  template: `
    @let g = git();
    @if (g.missing) { <span class="missing" title="Worktree folder is missing">missing</span> }
    @if (g.dirty) {
      <span class="flag dirty" role="img" [attr.aria-label]="g.dirty + ' uncommitted'" [title]="g.dirty + ' uncommitted file' + (g.dirty === 1 ? '' : 's')">●</span>
    }
    @if (g.unmerged) {
      <span class="flag unmerged" role="img" [attr.aria-label]="g.unmerged + ' unmerged'" [title]="g.unmerged + ' commit' + (g.unmerged === 1 ? '' : 's') + ' not in ' + g.trunk">◆</span>
    }
    @if (pr(); as p) {
      <span class="pr" [class.compact]="compact()" [class.draft]="p.draft" role="img" [attr.aria-label]="prLabel()" [title]="prLabel()">
        @if (compact()) {<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="12.5" r="1.6" /><path d="M4 5.1v5.8M12 10.9V6.5c0-1.4-1-2.5-2.5-2.5H7M8.5 2.3 7 4l1.5 1.7" /></svg>} @else {#{{ p.number }}}@if (p.checks === 'fail') {<span class="fail">✕</span>}
      </span>
    }
  `,
  styles: `
    :host { display: inline-flex; gap: 3px; align-items: center; font-size: 10px; line-height: 1; }
    .dirty { color: var(--dirty); }
    .unmerged { color: var(--accent); }
    .missing { color: var(--danger); font-size: 11px; }
    .pr { color: var(--text-2); font-variant-numeric: tabular-nums; border: 1px solid var(--border); border-radius: 3px; padding: 1px 3px; }
    svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
    .pr.draft { border-style: dashed; color: var(--muted); }
    .pr.compact { border: none; padding: 0; display: inline-flex; align-items: center; }
    .fail { color: var(--danger); margin-left: 2px; }
  `,
})
export class WtFlags {
  readonly git = input.required<GitStatus>();
  readonly pr = input<PullRequest | null>();
  /** Tiles: a PR glyph instead of its number. */
  readonly compact = input(false, { transform: (v: boolean | '') => v !== false });

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
