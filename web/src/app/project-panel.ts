import { Component, computed, input, output } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { WtFlags } from './wt-flags';
import { Session, Workspace, sessionState } from './model';
import { OpenRequest } from './worktree-panel';

@Component({
  selector: 'app-project-panel',
  imports: [AgoPipe, WtFlags],
  template: `
    @let p = ws();
    <header>
      <div class="kind">Project</div>
      <h2>{{ p.name }}</h2>
      <div class="path">{{ p.path }}</div>
      <div class="stats">
        <span>{{ p.worktrees.length }} worktree{{ p.worktrees.length === 1 ? '' : 's' }}</span>
        @if (stats().busy) { <span class="busy-t">{{ stats().busy }} working</span> }
        @if (stats().waiting) { <span class="waiting-t">{{ stats().waiting }} on you</span> }
        @if (stats().dirty) { <span class="dirty">● {{ stats().dirty }} uncommitted</span> }
        @if (stats().unmerged) { <span class="unmerged">◆ {{ stats().unmerged }} unmerged</span> }
        <span>active {{ p.lastActivity | ago: now() }}</span>
      </div>
      <div class="actions">
        <button type="button" (click)="open.emit({ action: 'code' })" title="Open repo in VS Code (c)">VS Code</button>
        <button type="button" (click)="open.emit({ action: 'explorer' })">Explorer</button>
      </div>
    </header>

    <div class="body">
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
                <app-wt-flags class="git" [git]="wt.git" />
                <span class="age">{{ wt.lastActivity | ago: now() }}</span>
                <span class="sub">
                  @if (s) { {{ s.title }} } @else { <em>no session</em> }
                </span>
              </button>
            </li>
          }
        </ul>
      </section>

    </div>
  `,
  styleUrl: './project-panel.css',
})
export class ProjectPanel {
  readonly ws = input.required<Workspace>();
  readonly now = input.required<number>();
  readonly open = output<OpenRequest>();
  /** Drill into a worktree by path. */
  readonly pick = output<string>();

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
