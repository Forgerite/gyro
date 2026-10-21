import { Component, computed, inject, input, model, output, signal } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';
import { GyroStepStatus, Workspace } from './model';

const MARK: Record<GyroStepStatus, string> = { done: '✓', skipped: '–', failed: '✗', pending: '○' };

/** Converting a project to Gyro: the confirmation before it starts, then each step's progress. */
@Component({
  selector: 'app-gyro-section',
  imports: [AgoPipe],
  template: `
    @let g = ws().gyro;
    @if (confirming()) {
      <form class="editor" aria-labelledby="gy-h" (submit)="$event.preventDefault(); start()">
        <h3 id="gy-h">Convert to Gyro project</h3>
        <p>Gyro does these now:</p>
        <ul class="plan">
          <li>checks the project is a git repository</li>
          <li>
            @if (orphans()) {
              archives {{ orphans() }}{{ orphansCapped() ? '+' : '' }} orphaned session{{ orphans() === 1 ? '' : 's' }} whose worktrees are gone
              (moved to <code>~/.claude/gyro-archive</code>, so they can be restored)
            } @else {
              archives orphaned sessions (none right now)
            }
          </li>
        </ul>
        <p>Then it makes a <code>gyro</code> worktree from the trunk and starts Claude there. Claude checks each step first and only acts where the project falls short:</p>
        <ul class="plan">
          <li>work out the dev command and set it here</li>
          <li>give every service the project runs its port from one leasing module, like task-management's</li>
          <li>take those ports from the block Gyro leases each worktree, unique on this machine</li>
          <li>verify, add a Ports note to CLAUDE.md, and commit any changes on the <code>gyro</code> branch; if nothing needed changing, the worktree is removed</li>
        </ul>
        <div class="actions">
          @if (error(); as e) { <span class="err" role="alert">{{ e }}</span> }
          <span class="spacer"></span>
          <button type="button" class="link" (click)="confirming.set(false)">cancel</button>
          <button type="submit" class="cta" [disabled]="busy()">{{ busy() ? 'Starting…' : 'Start conversion' }}</button>
        </div>
      </form>
    }

    @if (g) {
      <section aria-labelledby="gyro-h">
        <div class="head">
          <h3 id="gyro-h">Gyro</h3>
          <span [class]="'state ' + g.status">
            @switch (g.status) {
              @case ('running') { converting · started {{ g.startedAt | ago: now() }} }
              @case ('done') { Gyro project · {{ g.changed === false ? 'already in shape' : 'converted' }} {{ g.finishedAt! | ago: now() }} }
              @case ('failed') { conversion didn't finish · {{ g.finishedAt! | ago: now() }} }
            }
          </span>
          <span class="spacer"></span>
          @if (g.worktree && worktreeExists() && !confirming()) {
            <button type="button" class="link" (click)="pick.emit(g.worktree)">{{ g.status === 'running' ? 'open session' : 'open worktree' }}</button>
          }
          @if (g.status !== 'running' && !confirming()) {
            <button type="button" class="link" (click)="confirming.set(true)">run again</button>
          }
        </div>
        <ol class="steps">
          @for (s of g.steps; track s.key) {
            <li [class]="s.status">
              <span class="mark" aria-hidden="true">{{ mark[s.status] }}</span>
              <span class="name">{{ s.label }} <span class="sr-only">: {{ s.status }}</span></span>
              <span class="det">{{ s.detail ?? (s.status === 'pending' ? (g.status === 'running' ? 'Claude is on it' : 'not reported') : '') }}</span>
            </li>
          }
        </ol>
        @if (g.summary) { <p class="summary">{{ g.summary }}</p> }
      </section>
    }
  `,
  styleUrl: './github-section.css',
  styles: `
    .editor p { color: var(--text-2); }
    .plan { margin: 0; padding-left: 18px; display: grid; gap: 2px; color: var(--text-2); }
    .head { flex-wrap: wrap; }
    .spacer { flex: 1; }
    .state { font-size: 11px; color: var(--muted); }
    .state.done { color: var(--accent); }
    .state.failed { color: var(--danger); }
    .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
    .steps li { display: grid; grid-template-columns: 14px auto minmax(0, 1fr); gap: 6px; align-items: baseline; }
    .mark { color: var(--muted); text-align: center; }
    .done .mark { color: var(--accent); }
    .failed .mark, .failed .det { color: var(--danger); }
    .pending .name { color: var(--muted); }
    .det { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .summary { margin-top: 4px; color: var(--text-2); overflow-wrap: anywhere; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `,
  host: { '(keydown.escape)': 'confirming.set(false)' },
})
export class GyroSection {
  readonly ws = input.required<Workspace>();
  readonly now = input.required<number>();
  /** The confirmation form is open (the panel's header button opens it). */
  readonly confirming = model(false);
  /** Select a worktree by path. */
  readonly pick = output<string>();

  private readonly api = inject(DashboardService);
  protected readonly mark = MARK;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Sessions whose worktree folder is gone; the snapshot lists at most 40 per project, so it may be more. */
  protected readonly orphans = computed(() => this.ws().loose.filter((s) => !s.folderExists && !s.live).length);
  protected readonly orphansCapped = computed(() => this.ws().loose.length >= 40);
  /** The run's worktree is still there (one that changed nothing is removed afterwards). */
  protected readonly worktreeExists = computed(() => {
    const wt = this.ws().gyro?.worktree?.toLowerCase();
    return !!wt && this.ws().worktrees.some((w) => w.path.toLowerCase() === wt);
  });

  protected start(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.convertToGyro(this.ws().path).subscribe({
      next: ({ worktree }) => {
        this.busy.set(false);
        this.confirming.set(false);
        this.pick.emit(worktree);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }
}
