import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { FormField, form, pattern, required } from '@angular/forms/signals';
import { DashboardService } from './dashboard.service';
import { GithubLink, GithubProject, Workspace } from './model';

interface RepoInfo {
  repo: string;
  url: string;
  description: string | null;
  private: boolean;
  defaultBranch: string | null;
  owner: string;
}

interface Options {
  remotes: { remote: string; repo: string }[];
  repo: RepoInfo | null;
  projects: { linked: GithubProject[]; owner: GithubProject[]; mine: GithubProject[]; error: string | null } | null;
}

/** Same rule the server enforces. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** The project's GitHub side: which repo it is, and which GitHub Project tracks it. */
@Component({
  selector: 'app-github-section',
  imports: [FormField],
  template: `
    @let g = ws().github;
    <div class="head">
      <h3 id="gh-h">GitHub</h3>
      @if (!editing()) {
        <button type="button" class="link" (click)="edit()">{{ g ? 'change' : 'link' }}</button>
        @if (g) { <button type="button" class="link" (click)="unlink()" [disabled]="busy()">unlink</button> }
      }
    </div>

    @if (!editing()) {
      @if (g) {
        <dl>
          <dt>Repo</dt>
          <dd>
            <a [href]="g.url" target="_blank" rel="noopener">{{ g.repo }}</a>
            <span class="muted">{{ g.private ? 'private' : 'public' }}@if (g.defaultBranch) { · {{ g.defaultBranch }} }</span>
          </dd>
          <dt>Project</dt>
          <dd>
            @if (g.project) { <a [href]="g.project.url" target="_blank" rel="noopener">{{ g.project.title }}</a> <span class="muted">#{{ g.project.number }}</span> }
            @else { <span class="muted">none</span> }
          </dd>
        </dl>
      } @else {
        <p class="muted">Not linked to a GitHub repo.</p>
      }
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    } @else {
      <form class="editor" aria-labelledby="gh-h" (submit)="$event.preventDefault(); save()">
        <label class="field">
          <span class="lbl">Repository</span>
          <span class="row">
            <input type="text" [formField]="repoForm.repo" placeholder="owner/name" list="gh-remotes" autocomplete="off" spellcheck="false"
                   [attr.aria-invalid]="repoBad()" aria-describedby="gh-repo-help" (keydown.enter)="$event.preventDefault(); lookUp()" />
            <button type="button" (click)="lookUp()" [disabled]="repoBad() || loading()">Look up</button>
          </span>
        </label>
        <datalist id="gh-remotes">
          @for (r of options()?.remotes ?? []; track r.repo) { <option [value]="r.repo">{{ r.remote }}</option> }
        </datalist>
        <p id="gh-repo-help" class="help" [class.bad]="repoBad()">
          @if (repoBad()) { Use the form owner/name }
          @else if (loading()) { Asking GitHub… }
          @else if (found(); as r) { {{ r.private ? 'Private' : 'Public' }} · default branch {{ r.defaultBranch ?? '?' }}@if (r.description) { · {{ r.description }} } }
          @else if (options() && !options()!.remotes.length) { No GitHub remote here; type the repo it belongs to. }
        </p>

        @if (found() && options()?.projects; as p) {
          <span class="lbl" id="gh-proj-lbl">GitHub Project</span>
          <div class="choices" role="radiogroup" aria-labelledby="gh-proj-lbl">
            <button type="button" role="radio" class="choice" [attr.aria-checked]="picked() === ''" (click)="picked.set('')">
              <span class="cn">No project</span>
            </button>
            @for (group of groups(); track group.label) {
              @for (pr of group.items; track pr.url) {
                <button type="button" role="radio" class="choice" [attr.aria-checked]="picked() === pr.url" (click)="picked.set(pr.url)">
                  <span class="cn">{{ pr.title }}</span>
                  <span class="cm">{{ group.label }} · #{{ pr.number }}</span>
                </button>
              }
            }
          </div>
          @if (p.error) { <p class="help bad">Couldn't list every project: {{ p.error }}</p> }
        }

        <div class="actions">
          @if (error()) { <span class="err" role="alert">{{ error() }}</span> }
          <span class="spacer"></span>
          <button type="button" class="link" (click)="editing.set(false)">cancel</button>
          <button type="submit" class="cta" [disabled]="!found() || busy() || loading()">{{ busy() ? 'Saving…' : 'Save' }}</button>
        </div>
      </form>
    }
  `,
  styleUrl: './github-section.css',
  host: { '(keydown.escape)': 'editing.set(false)' },
})
export class GithubSection {
  readonly ws = input.required<Workspace>();

  private readonly http = inject(HttpClient);
  private readonly api = inject(DashboardService);

  protected readonly editing = signal(false);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly options = signal<Options | null>(null);
  /** The picked project's url; '' for none. */
  protected readonly picked = signal('');

  private readonly repoModel = signal({ repo: '' });
  protected readonly repoForm = form(this.repoModel, (p) => {
    required(p.repo);
    pattern(p.repo, REPO);
  });
  protected readonly repoBad = computed(() => !!this.repoForm.repo().value() && this.repoForm.repo().invalid());
  /** The looked-up repo, while the field still says the same thing. */
  protected readonly found = computed(() => {
    const r = this.options()?.repo;
    return r && r.repo.toLowerCase() === this.repoForm.repo().value().trim().toLowerCase() ? r : null;
  });
  protected readonly groups = computed(() => {
    const p = this.options()?.projects;
    if (!p) return [];
    return [
      { label: 'Linked to repo', items: p.linked },
      { label: this.found()?.owner ?? 'Owner', items: p.owner },
      { label: 'Yours', items: p.mine },
    ].filter((g) => g.items.length);
  });

  protected edit(): void {
    this.editing.set(true);
    this.error.set(null);
    this.repoModel.set({ repo: this.ws().github?.repo ?? '' });
    this.load(null);
  }

  protected lookUp(): void {
    if (!this.repoBad()) this.load(this.repoForm.repo().value().trim() || null);
  }

  /** Fetch the repo (null: the current link, else the first GitHub remote) and the projects it could go on. */
  private load(repo: string | null): void {
    this.loading.set(true);
    this.error.set(null);
    const params: Record<string, string> = { path: this.ws().path, ...(repo ? { repo } : {}) };
    this.http.get<Options>('/api/github/options', { params }).subscribe({
      next: (o) => {
        this.loading.set(false);
        this.options.set(o);
        if (o.repo) this.repoModel.set({ repo: o.repo.repo });
        const all = [...(o.projects?.linked ?? []), ...(o.projects?.owner ?? []), ...(o.projects?.mine ?? [])];
        const current = this.ws().github?.project?.url;
        // Keep the current choice if it's still offered; a fresh link starts on the repo's own project.
        this.picked.set(all.some((p) => p.url === current) ? current! : (o.projects?.linked[0]?.url ?? ''));
      },
      error: (e) => {
        this.loading.set(false);
        this.options.update((o) => o && { ...o, repo: null, projects: null });
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }

  protected save(): void {
    const repo = this.found();
    if (!repo || this.busy()) return;
    const p = this.groups().flatMap((g) => g.items).find((x) => x.url === this.picked()) ?? null;
    this.post({ repo: repo.repo, project: p && { owner: p.owner, number: p.number } }, () => this.editing.set(false));
  }

  protected unlink(): void {
    this.post({ repo: null }, () => {});
  }

  private post(body: object, done: () => void): void {
    const path = this.ws().path;
    this.busy.set(true);
    this.error.set(null);
    this.http.post<{ github: GithubLink | null }>('/api/github/link', { path, ...body }).subscribe({
      next: ({ github }) => {
        this.busy.set(false);
        this.api.snapshot.update((s) => s && { ...s, workspaces: s.workspaces.map((w) => (w.path === path ? { ...w, github } : w)) });
        done();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }
}
