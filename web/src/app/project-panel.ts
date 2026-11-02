import { Component, computed, input, output, signal } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { BaseSection } from './base-section';
import { BoardSection } from './board-section';
import { DevSection } from './dev-section';
import { GithubSection } from './github-section';
import { GyroSection } from './gyro-section';
import { NewSession, NewSessionForm } from './new-session';
import { PullsSection } from './pulls-section';
import { WtFlags } from './wt-flags';
import { Session, Workspace, sessionState } from './model';
import { OpenRequest } from './worktree-panel';

@Component({
  selector: 'app-project-panel',
  imports: [AgoPipe, BaseSection, BoardSection, DevSection, GithubSection, GyroSection, NewSessionForm, PullsSection, WtFlags],
  template: `
    @let p = ws();
    <header>
      <div class="kind">Project</div>
      <h2>{{ p.name }}</h2>
      <div class="path">{{ p.path }}</div>
      <div class="stats">
        <span>{{ p.worktrees.length }} worktree{{ p.worktrees.length === 1 ? '' : 's' }}</span>
        @if (!p.closed) {
          @if (stats().busy) { <span class="busy-t">{{ stats().busy }} working</span> }
          @if (stats().waiting) { <span class="waiting-t">{{ stats().waiting }} on you</span> }
        }
        @if (stats().dirty) { <span class="dirty">● {{ stats().dirty }} uncommitted</span> }
        @if (stats().unmerged) { <span class="unmerged">◆ {{ stats().unmerged }} unmerged</span> }
        <span>active {{ p.lastActivity | ago: now() }}</span>
      </div>
      <div class="actions">
        @if (!p.closed) {
          <button type="button" class="primary" (click)="newing.set(true)" [attr.aria-expanded]="newing()" title="Start a session in a new worktree">New session</button>
        }
        @if (!p.closed && (!p.gyro || p.gyro.status === 'failed')) {
          <button type="button" (click)="gyroing.set(true)" [attr.aria-expanded]="gyroing()" title="Set the dev command, archive orphaned sessions, and move the project onto Gyro's port leases">Convert to Gyro project</button>
        }
        <button type="button" (click)="open.emit({ action: 'code' })" title="Open repo in VS Code (c)">VS Code</button>
        <button type="button" (click)="open.emit({ action: 'explorer' })">Explorer</button>
        <span class="spacer"></span>
        @if (p.closed) {
          <button type="button" (click)="closeProject.emit(false)" title="Show its worktrees and sessions again">Reopen project</button>
        } @else {
          <button type="button" class="close-btn" (click)="closeProject.emit(true)" title="Collapse it, stop its dock terminals, move it to the end">Close project</button>
        }
      </div>
      @if (p.closed) {
        <p class="closed-note">
          Closed: collapsed at the end of the list and never shown as waiting on you.
          @if (liveElsewhere()) { {{ liveElsewhere() }} session{{ liveElsewhere() === 1 ? ' is' : 's are' }} still open outside the dock (Claude Desktop or another terminal); close {{ liveElsewhere() === 1 ? 'it' : 'them' }} there. }
        </p>
      }
    </header>

    <div class="body">
      @if (newing() && !p.closed) {
        <app-new-session [ws]="p" (started)="newing.set(false); started.emit($event)" (cancel)="newing.set(false)" />
      }
      @if (!p.closed && (gyroing() || p.gyro)) {
        <app-gyro-section [ws]="p" [now]="now()" [(confirming)]="gyroing" (pick)="pick.emit($event)" />
      }
      <app-github-section [ws]="p" />
      <app-base-section [ws]="p" />
      <app-dev-section [ws]="p" />

      <section aria-labelledby="wt-h">
        <h3 id="wt-h">Worktrees</h3>
        <ul class="wts">
          @for (wt of p.worktrees; track wt.path) {
            @let s = wt.sessions[0];
            <li>
              <button type="button" [class]="'wt ' + stateOf(s)" [class.live]="!!s?.live" (click)="pick.emit(wt.path)">
                <span class="dot" role="img" [attr.aria-label]="stateOf(s)"></span>
                <span class="wt-name">
                  {{ wt.name }}
                  @if (wt.branch && wt.branch !== wt.name) { <span class="branch">{{ wt.branch }}</span> }
                </span>
                <app-wt-flags class="git" [git]="wt.git" [pr]="wt.pr" />
                <span class="age">{{ wt.lastActivity | ago: now() }}</span>
                <span class="sub">
                  @if (s) { {{ s.title }} } @else { <em>no session</em> }
                </span>
              </button>
            </li>
          }
        </ul>
      </section>

      @if (p.github && !p.closed) {
        <app-pulls-section [ws]="p" [now]="now()" (pick)="pick.emit($event)" />
        @if (p.github.project) { <app-board-section [ws]="p" [now]="now()" (pick)="pick.emit($event)" /> }
      }
    </div>
  `,
  styleUrl: './project-panel.css',
})
export class ProjectPanel {
  readonly ws = input.required<Workspace>();
  readonly now = input.required<number>();
  /** true = close the project, false = reopen it. */
  readonly closeProject = output<boolean>();
  /** Sessions still running outside the dock, which closing doesn't stop. */
  protected readonly liveElsewhere = computed(
    () => [...this.ws().worktrees.flatMap((w) => w.sessions), ...this.ws().loose].filter((s) => s.live).length,
  );
  readonly open = output<OpenRequest>();
  /** Drill into a worktree by path. */
  readonly pick = output<string>();
  /** A new worktree was created for a new session: select it and start claude there. */
  readonly started = output<NewSession>();
  /** The new-session form is open. */
  readonly newing = signal(false);
  /** The Gyro conversion's confirmation is open. */
  readonly gyroing = signal(false);

  protected readonly stats = computed(() => {
    const c = { busy: 0, waiting: 0, dirty: 0, unmerged: 0 };
    for (const wt of this.ws().worktrees) {
      if (wt.git.dirty) c.dirty++;
      if (wt.git.unmerged) c.unmerged++;
      const st = sessionState(wt.sessions[0]);
      if (st === 'busy') c.busy++;
      else if (st === 'waiting') c.waiting++;
    }
    return c;
  });


  protected stateOf(s: Session | undefined) {
    return sessionState(s);
  }
}
