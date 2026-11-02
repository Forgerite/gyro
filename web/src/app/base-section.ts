import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { FormField, form, required } from '@angular/forms/signals';
import { DashboardService } from './dashboard.service';
import { BaseSetting, Workspace, branchName } from './model';

interface Bases {
  branches: { name: string; remote: boolean; at: number }[];
}

/** The branch new work starts from, rebases onto and opens PRs into: set here, else detected. */
@Component({
  selector: 'app-base-section',
  imports: [FormField],
  template: `
    @let b = ws().base;
    <div class="head">
      <h3 id="base-h">Base branch</h3>
      @if (!editing()) { <button type="button" class="link" (click)="edit()">change</button> }
    </div>

    @if (!editing()) {
      @if (ws().trunk; as t) {
        <p>
          <code>{{ t }}</code> <span class="muted">{{ b?.ref && !b?.missing ? 'set here' : 'detected' }}</span>
          @if (prBranch(); as pr) { <span class="muted"> · PRs into {{ pr }}</span> }
        </p>
      } @else {
        <p class="muted">No base branch found yet: the repository has no main or master, and none is set here.</p>
      }
      @if (b?.missing) {
        <p class="err" role="alert"><code>{{ b!.missing }}</code> is set here but no longer exists, so Gyro is using the detected branch.</p>
      }
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    } @else {
      <form class="editor" aria-labelledby="base-h" (submit)="$event.preventDefault(); save(model().ref)">
        <label class="field">
          <span class="lbl">Branch</span>
          <select [formField]="baseForm.ref" aria-describedby="base-help">
            @if (!bases.hasValue()) { <option value="">{{ bases.error() ? 'Couldn’t load branches' : 'Loading branches…' }}</option> }
            <optgroup label="Remote">
              @for (br of remote(); track br.name) { <option [value]="br.name">{{ br.name }}</option> }
            </optgroup>
            <optgroup label="Local">
              @for (br of local(); track br.name) { <option [value]="br.name">{{ br.name }}</option> }
            </optgroup>
          </select>
        </label>
        <p id="base-help" class="help">
          New sessions start from it, Ship it rebases onto it, and PRs merge into it. Pick the remote branch
          (such as <code>origin/develop</code>) so work starts from what's on GitHub. Sessions already running keep the base they started from.
        </p>
        <div class="actions">
          @if (error()) { <span class="err" role="alert">{{ error() }}</span> }
          <span class="spacer"></span>
          @if (b?.ref && b?.detected) {
            <button type="button" class="link" (click)="save(null)" [disabled]="busy()">use {{ b!.detected }}</button>
          }
          <button type="button" class="link" (click)="editing.set(false)">cancel</button>
          <button type="submit" class="cta" [disabled]="busy() || baseForm().invalid() || !bases.hasValue()">{{ busy() ? 'Saving…' : 'Save' }}</button>
        </div>
      </form>
    }
  `,
  styleUrl: './github-section.css',
  styles: `
    select { font: inherit; padding: 3px 5px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; }
    select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  `,
  host: { '(keydown.escape)': 'editing.set(false)' },
})
export class BaseSection {
  readonly ws = input.required<Workspace>();

  private readonly http = inject(HttpClient);
  private readonly api = inject(DashboardService);

  protected readonly editing = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The branch name a PR targets, when it differs from the ref shown (origin/develop -> develop). */
  protected readonly prBranch = computed(() => {
    const t = this.ws().trunk;
    const name = t ? branchName(t, this.ws().remotes) : null;
    return name && name !== t ? name : null;
  });

  /** Branches to pick from, only fetched while editing. */
  protected readonly bases = httpResource<Bases>(() =>
    this.editing() ? { url: '/api/worktrees/bases', params: { path: this.ws().path } } : undefined,
  );
  protected readonly remote = computed(() => (this.bases.hasValue() ? this.bases.value().branches.filter((b) => b.remote) : []));
  protected readonly local = computed(() => (this.bases.hasValue() ? this.bases.value().branches.filter((b) => !b.remote) : []));

  protected readonly model = signal({ ref: '' });
  protected readonly baseForm = form(this.model, (p) => required(p.ref));

  protected edit(): void {
    this.editing.set(true);
    this.error.set(null);
    this.model.set({ ref: this.ws().trunk ?? '' });
  }

  /** Save a base branch, or null to go back to the detected trunk. */
  protected save(ref: string | null): void {
    if (this.busy()) return;
    const path = this.ws().path;
    this.busy.set(true);
    this.error.set(null);
    this.http.post<{ base: BaseSetting; trunk: string | null }>('/api/projects/base', { path, ref }).subscribe({
      next: ({ base, trunk }) => {
        this.busy.set(false);
        this.editing.set(false);
        this.api.snapshot.update((s) => s && { ...s, workspaces: s.workspaces.map((w) => (w.path === path ? { ...w, base, trunk } : w)) });
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }
}
