import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormField, form, required } from '@angular/forms/signals';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';
import { NoxLink, Workspace } from './model';
import { NoxService } from './nox.service';

/**
 * The project's Nox Lumos side: the separately hosted server that works its GitHub Project tickets,
 * and the tickets it's on now (green while it works them, red once it stops on something).
 */
@Component({
  selector: 'app-nox-section',
  imports: [AgoPipe, FormField],
  template: `
    @let n = ws().nox;
    <div class="head">
      <h3 id="nox-h">Nox Lumos @if (n?.tickets; as t) { <span class="count">{{ t.length }}</span> }</h3>
      @if (!editing()) {
        <button type="button" class="link" (click)="edit()">{{ n ? 'change' : 'link' }}</button>
        @if (n) { <button type="button" class="link" (click)="unlink()" [disabled]="busy()" title="Unlink; Gyro won't link it automatically again">unlink</button> }
      }
      @if (n?.at && !editing()) { @let ago = n!.at! | ago: now(); <span class="when">{{ ago === 'now' ? 'just now' : 'as of ' + ago + ' ago' }}</span> }
    </div>

    @if (!editing()) {
      @if (n) {
        <dl>
          <dt>Server</dt>
          <dd><a [href]="n.server.url" target="_blank" rel="noopener">{{ n.server.name }}</a> <span class="muted">{{ n.server.url }}</span></dd>
          <dt>Repo</dt>
          <dd>{{ n.repo ?? '—' }} @if (n.auto) { <span class="muted" title="Gyro linked this project because the server runs its repo">linked automatically</span> }</dd>
        </dl>
        @if (n.error) { <p class="err" role="alert">{{ n.error }}</p> }
        @if (n.tickets === null) {
          @if (!n.error) { <p class="muted">Loading tickets…</p> }
        } @else if (!n.tickets.length) {
          <p class="muted">No tickets in a stage Nox Lumos works.</p>
        } @else {
          <ul class="tickets" aria-labelledby="nox-h">
            @for (t of n.tickets; track t.id) {
              <li [class]="'ticket ' + t.state">
                <span class="dot" role="img" [attr.aria-label]="t.state === 'busy' ? 'Lumos is on it' : 'Lumos is paused'"></span>
                <a class="num" [href]="t.url" target="_blank" rel="noopener">#{{ t.number }}</a>
                <span class="t" [title]="t.title">{{ t.title }}</span>
                <span class="status">{{ t.status }}</span>
                <span class="why" [title]="t.label">{{ t.label }}</span>
              </li>
            }
          </ul>
        }
      } @else {
        <p class="muted">Not linked to a Nox Lumos server. Gyro links it on its own when a server it knows runs this repo{{ ws().github ? '' : ' (once it knows the repo: link GitHub, or add a GitHub remote)' }}.</p>
      }
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    } @else {
      <form class="editor" aria-labelledby="nox-h" (submit)="$event.preventDefault(); save()">
        @if (servers(); as list) {
          @if (list.length) {
            <label class="field">
              <span class="lbl">Server</span>
              <select [formField]="linkForm.server">
                @for (s of list; track s.id) {
                  <option [value]="s.id">{{ s.name }} — {{ s.url }}{{ s.status.error ? ' (not working)' : '' }}</option>
                }
              </select>
            </label>
            @if (pickedServer(); as s) {
              <p class="help" [class.bad]="!!s.status.error">
                @if (s.status.error) { {{ s.status.error }} }
                @else if (s.status.repos) { Runs {{ s.status.repos.length ? s.status.repos.join(', ') : 'no repos yet' }} }
              </p>
            }
            <label class="field">
              <span class="lbl">Repo</span>
              <input type="text" [formField]="linkForm.repo" [placeholder]="ws().github?.repo ?? 'owner/name'" spellcheck="false" aria-describedby="nox-repo-help" />
            </label>
            <p id="nox-repo-help" class="help">
              @if (ws().github?.repo) { Leave empty to use the linked GitHub repo. } @else { Name the repo, or link the project to GitHub first. }
            </p>
          } @else {
            <p class="muted">No Nox Lumos servers in Gyro yet.</p>
          }
        } @else {
          <p class="muted">{{ nox.error() ?? 'Loading servers…' }}</p>
        }
        <div class="actions">
          <button type="button" class="link" (click)="nox.managing.set(true)">manage servers</button>
          @if (error()) { <span class="err" role="alert">{{ error() }}</span> }
          <span class="spacer"></span>
          <button type="button" class="link" (click)="editing.set(false)">cancel</button>
          <button type="submit" class="cta" [disabled]="busy() || !servers()?.length || linkForm().invalid()">{{ busy() ? 'Checking…' : 'Save' }}</button>
        </div>
      </form>
    }
  `,
  styleUrl: './github-section.css',
  styles: `
    .count { color: var(--muted); font-weight: 400; margin-left: 2px; }
    .when { margin-left: auto; color: var(--muted); font-size: 11px; white-space: nowrap; }
    select { font: inherit; padding: 3px 5px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; }
    select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .tickets { list-style: none; margin: 4px 0 0; padding: 0; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
    .ticket {
      display: grid;
      grid-template-columns: 10px auto minmax(0, 1fr) auto;
      grid-template-areas: 'dot num t status' '. . why why';
      align-items: baseline;
      column-gap: 6px;
      padding: 4px 8px;
      --muted: color-mix(in srgb, var(--text) 72%, transparent);
    }
    .ticket + .ticket { border-top: 1px solid color-mix(in srgb, var(--panel) 40%, transparent); }
    .ticket.busy { background: var(--busy-bg); }
    .ticket.waiting { background: var(--waiting-bg); }
    .dot { grid-area: dot; width: 8px; height: 8px; border-radius: 50%; align-self: center; }
    .busy .dot { background: var(--busy); animation: pulse 1.2s ease-in-out infinite; }
    .waiting .dot { background: var(--waiting); }
    .num { grid-area: num; font-size: 11px; font-variant-numeric: tabular-nums; }
    .t { grid-area: t; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { grid-area: status; font-size: 10.5px; color: var(--text-2); white-space: nowrap; }
    .why { grid-area: why; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @keyframes pulse { 50% { opacity: 0.35; } }
  `,
  host: { '(keydown.escape)': 'editing.set(false)' },
})
export class NoxSection {
  readonly ws = input.required<Workspace>();
  readonly now = input.required<number>();

  private readonly http = inject(HttpClient);
  private readonly api = inject(DashboardService);
  protected readonly nox = inject(NoxService);

  protected readonly editing = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly servers = this.nox.servers;

  private readonly model = signal({ server: '', repo: '' });
  protected readonly linkForm = form(this.model, (p) => required(p.server));
  protected readonly pickedServer = computed(() => this.servers()?.find((s) => s.id === this.model().server) ?? null);

  constructor() {
    // A server added in the panel while this form is open: pick it if nothing usable is picked yet.
    effect(() => {
      const list = this.servers();
      if (list?.length && !list.some((s) => s.id === untracked(this.model).server)) {
        this.model.update((m) => ({ ...m, server: list[0].id }));
      }
    });
  }

  protected edit(): void {
    const n = this.ws().nox;
    this.editing.set(true);
    this.error.set(null);
    this.nox.load();
    const own = n?.repo && n.repo !== this.ws().github?.repo ? n.repo : '';
    this.model.set({ server: n?.server.id ?? this.servers()?.[0]?.id ?? '', repo: own });
  }

  protected save(): void {
    if (this.busy()) return;
    const { server, repo } = this.model();
    this.post({ server, repo: repo.trim() || null }, () => this.editing.set(false));
  }

  protected unlink(): void {
    this.post({ server: null }, () => {});
  }

  private post(body: object, done: () => void): void {
    const path = this.ws().path;
    this.busy.set(true);
    this.error.set(null);
    this.http.post<{ nox: NoxLink | null }>('/api/projects/nox', { path, ...body }).subscribe({
      next: ({ nox }) => {
        this.busy.set(false);
        this.api.snapshot.update((s) => s && { ...s, workspaces: s.workspaces.map((w) => (w.path === path ? { ...w, nox } : w)) });
        done();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }
}
