import { Component, input } from '@angular/core';
import { GitStatus } from './model';

/** Two quiet glyphs: uncommitted changes, and commits not yet in trunk. Renders nothing when clean. */
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
  `,
  styles: `
    :host { display: inline-flex; gap: 3px; align-items: center; font-size: 10px; line-height: 1; }
    .dirty { color: var(--dirty); }
    .unmerged { color: var(--accent); }
    .missing { color: var(--danger); font-size: 11px; }
  `,
})
export class WtFlags {
  readonly git = input.required<GitStatus>();
}
