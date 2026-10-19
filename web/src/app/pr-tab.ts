import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';
import { PrLine } from './pr-line';
import { PrCheck, PrDetail, Workspace, Worktree } from './model';
import { reviewText } from './wt-flags';

/** How often to re-read a PR while its CI is still running. */
const RUNNING_POLL_MS = 15_000;
/** Last read of each PR, by "worktree path#number", shown while a fresh read is on its way. */
const lastRead = new Map<string, PrDetail>();

/**
 * The worktree's PR in full: where CI stands, whether it can merge, reviews, the description and
 * the conversation. Without a PR it offers to have Claude open one (via PrLine).
 */
@Component({
  selector: 'app-pr-tab',
  imports: [AgoPipe, PrLine],
  templateUrl: './pr-tab.html',
  styleUrl: './pr-tab.css',
})
export class PrTab {
  readonly ws = input.required<Workspace>();
  readonly wt = input.required<Worktree>();

  protected readonly api = inject(DashboardService);
  protected readonly now = this.api.now;

  /** The open PR's number: from the snapshot, or the one Claude just opened. */
  protected readonly number = computed(
    () => this.wt().pr?.number ?? this.api.prCreated()[this.wt().path]?.result?.pr.number ?? null,
  );

  private readonly res = httpResource<PrDetail>(() => {
    const n = this.number();
    return n ? { url: '/api/github/pr', params: { path: this.wt().path, number: n } } : undefined;
  });
  private readonly cacheKey = computed(() => `${this.wt().path}#${this.number()}`);
  /** The fresh read, else the last one seen (so switching tabs doesn't blank it while it re-reads). */
  protected readonly pr = computed(() => {
    const fresh = this.res.hasValue() && this.res.value().number === this.number() ? this.res.value() : null;
    return fresh ?? (this.number() ? (lastRead.get(this.cacheKey()) ?? null) : null);
  });
  protected readonly loading = computed(() => this.res.isLoading());
  protected readonly errorText = computed(() => {
    const e = this.res.error();
    if (!e) return null;
    return e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e);
  });

  protected readonly checks = computed(() => this.pr()?.checks ?? []);
  protected readonly tally = computed(() => {
    const t = { pass: 0, fail: 0, running: 0, skipped: 0 };
    for (const c of this.checks()) t[c.result]++;
    return t;
  });
  /** "3 of 12 checks done · 1 failing · 2 running". */
  protected readonly checkSummary = computed(() => {
    const t = this.tally();
    const total = this.checks().length;
    if (!total) return 'No checks';
    if (!t.running) {
      return t.fail ? `${t.fail} of ${total} failing` : `All ${total} passing${t.skipped ? ` (${t.skipped} skipped)` : ''}`;
    }
    const bits = [`${total - t.running} of ${total} done`];
    if (t.fail) bits.push(`${t.fail} failing`);
    return bits.join(' · ');
  });
  /** Bar segments, as percentages, in display order. */
  protected readonly bar = computed(() => {
    const t = this.tally();
    const total = this.checks().length || 1;
    return (['fail', 'pass', 'skipped', 'running'] as const)
      .filter((k) => t[k])
      .map((k) => ({ kind: k, pct: (t[k] / total) * 100 }));
  });

  /** Can it merge, and if not, why not. */
  protected readonly merge = computed(() => {
    const p = this.pr();
    if (!p) return null;
    if (p.state === 'MERGED') return { tone: 'ok', text: 'Merged' };
    if (p.state === 'CLOSED') return { tone: 'muted', text: 'Closed without merging' };
    if (p.mergeable === 'CONFLICTING') return { tone: 'bad', text: `Conflicts with ${p.base}` };
    switch (p.mergeState) {
      case 'CLEAN': return { tone: 'ok', text: 'Ready to merge' };
      case 'HAS_HOOKS': return { tone: 'ok', text: 'Ready to merge (hooks will run)' };
      case 'UNSTABLE': return { tone: 'warn', text: 'Mergeable, but some checks are not passing' };
      case 'BEHIND': return { tone: 'warn', text: `Behind ${p.base}; update the branch to merge` };
      case 'BLOCKED': return { tone: 'warn', text: 'Blocked by required reviews or checks' };
      case 'DRAFT': return { tone: 'muted', text: 'Draft: mark it ready for review to merge' };
      case 'DIRTY': return { tone: 'bad', text: `Conflicts with ${p.base}` };
      default: return { tone: 'muted', text: 'GitHub is still working out whether it can merge' };
    }
  });

  protected readonly reviewWord = computed(() => reviewText(this.pr()?.review ?? null));

  constructor() {
    effect(() => {
      const p = this.pr();
      if (p) lastRead.set(this.cacheKey(), p);
    });
    // CI still running: keep re-reading until it settles.
    effect((onCleanup) => {
      if (!this.tally().running) return;
      const id = setInterval(() => this.res.reload(), RUNNING_POLL_MS);
      onCleanup(() => clearInterval(id));
    });
    // The snapshot (re-read every couple of minutes) says the PR changed: catch up.
    let seen = '';
    effect(() => {
      const p = this.wt().pr;
      const key = p ? `${p.number}|${p.updatedAt}|${p.checks}|${p.review}|${p.draft}` : '';
      untracked(() => {
        if (seen && key && seen.split('|')[0] === key.split('|')[0] && seen !== key) this.res.reload();
        seen = key;
      });
    });
  }

  protected refresh(): void {
    this.res.reload();
  }

  protected duration(c: PrCheck): string | null {
    if (!c.startedAt) return null;
    const end = c.completedAt ?? (c.result === 'running' ? this.now() : null);
    if (!end) return null;
    const s = Math.max(0, Math.round((end - c.startedAt) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  protected resultLabel(c: PrCheck): string {
    return { pass: 'Passed', fail: 'Failed', running: 'Running', skipped: 'Skipped' }[c.result];
  }

  protected stateWord(state: string): string {
    return state === 'APPROVED' ? 'approved'
      : state === 'CHANGES_REQUESTED' ? 'requested changes'
      : state === 'DISMISSED' ? 'review dismissed'
      : 'commented';
  }

  /** Links inside GitHub's markdown open in a new tab, like every other GitHub link here. */
  protected externalLinks(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a || !a.closest('.md') || !a.href || a.target === '_blank') return;
    ev.preventDefault();
    window.open(a.href, '_blank', 'noopener');
  }
}
