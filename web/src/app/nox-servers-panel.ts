import { Component, ElementRef, Injector, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormField, form, required } from '@angular/forms/signals';
import { AgoPipe } from './ago.pipe';
import { NoxServer } from './model';
import { NoxService } from './nox.service';

/**
 * Add, check and remove the Nox Lumos servers Gyro talks to. Each is a URL plus an API key made in
 * that server's portal; projects then pick one in their Nox Lumos section.
 */
@Component({
  selector: 'app-nox-servers-panel',
  imports: [AgoPipe, FormField],
  template: `
    <header>
      <h2 id="nox-servers-h">Nox Lumos servers</h2>
      @if (nox.servers()?.length) {
        <button type="button" class="link" (click)="nox.load(true)" [disabled]="nox.loading()">{{ nox.loading() ? 'checking…' : 'check all' }}</button>
      }
      <button type="button" class="link" (click)="closed.emit()">close</button>
    </header>
    <p class="help">
      A Nox Lumos server works a repo's GitHub Project tickets with Claude. Add one here with an API key made on its
      <strong>API keys</strong> page (the key needs the <code>pipeline:read</code> scope), then pick it in a project's Nox Lumos section.
      The key stays in Gyro's API; the dashboard only ever sees its first characters.
    </p>
    @if (nox.error(); as e) { <p class="err" role="alert">{{ e }}</p> }

    @if (nox.servers(); as list) {
      @if (list.length) {
        <ul class="servers" aria-labelledby="nox-servers-h">
          @for (s of list; track s.id) {
            <li class="server" [class.bad]="!!s.status.error">
              <div class="top">
                <span class="dot" role="img" [attr.aria-label]="s.status.error ? 'Not working' : s.status.at ? 'Working' : 'Not checked yet'"></span>
                <span class="name">{{ s.name }}</span>
                <a [href]="s.url" target="_blank" rel="noopener">{{ s.url }}</a>
                <span class="spacer"></span>
                @if (confirming() === s.id) {
                  <span class="confirm" role="group" [attr.aria-label]="'Confirm removing ' + s.name">
                    Remove{{ s.projects.length ? ' and unlink ' + s.projects.length + ' project' + (s.projects.length === 1 ? '' : 's') : '' }}?
                    <button type="button" class="link danger" (click)="remove(s)" [disabled]="busy()">remove</button>
                    <button type="button" class="link" (click)="confirming.set(null)">keep</button>
                  </span>
                } @else {
                  <button type="button" class="link" (click)="edit(s)" [attr.aria-label]="'Change ' + s.name">change</button>
                  <button type="button" class="link" (click)="confirming.set(s.id)" [attr.aria-label]="'Remove ' + s.name">remove</button>
                }
              </div>
              <dl>
                <dt>Key</dt>
                <dd>
                  <code>{{ s.keyPrefix }}…</code>
                  @if (s.status.keyName) { <span class="muted">“{{ s.status.keyName }}”</span> }
                  @if (s.status.user) { <span class="muted">as {{ s.status.user }}</span> }
                </dd>
                @if (s.status.error) {
                  <dt>Status</dt>
                  <dd class="err" role="alert">{{ s.status.error }}</dd>
                } @else if (s.status.at) {
                  @if (s.status.auth === 'jwt') {
                    <dt>Status</dt>
                    <dd class="err">Answered as a login, not an API key: check the key</dd>
                  }
                  <dt>Scopes</dt>
                  <dd>{{ s.status.scopes?.join(', ') || '—' }}</dd>
                  <dt>Runs</dt>
                  <dd [title]="s.status.repos?.join(', ') ?? ''">{{ s.status.repos?.length ? s.status.repos!.join(', ') : 'no repos' }}</dd>
                }
                <dt>Projects</dt>
                <dd>{{ s.projects.length ? s.projects.join(', ') : 'none yet' }}</dd>
              </dl>
              @if (s.status.at) { <p class="when">checked {{ s.status.at | ago: now() }} ago</p> }
            </li>
          }
        </ul>
      } @else if (!editing()) {
        <p class="muted">No servers yet.</p>
      }
    } @else if (!nox.error()) {
      <p class="muted">Loading…</p>
    }

    @if (editing()) {
      <form class="editor" [attr.aria-label]="editingId() ? 'Change ' + model().name : 'Add a Nox Lumos server'" (submit)="$event.preventDefault(); save()">
        <label class="field">
          <span class="lbl">Server URL</span>
          <input #first type="text" [formField]="serverForm.url" placeholder="https://lumos.example.com" spellcheck="false" autocomplete="url" (blur)="suggestName()" />
        </label>
        <label class="field">
          <span class="lbl">Name</span>
          <input type="text" [formField]="serverForm.name" placeholder="Production" />
        </label>
        <label class="field">
          <span class="lbl">API key</span>
          <input type="password" [formField]="serverForm.key" autocomplete="off" spellcheck="false" aria-describedby="nox-key-help"
                 [placeholder]="editingKey() ? 'unchanged (' + editingKey() + '…)' : 'nlk_…'" />
        </label>
        <p id="nox-key-help" class="help">
          In Nox Lumos: <strong>API keys</strong> → New key, with the <code>pipeline:read</code> scope. Gyro tests it before saving.
        </p>
        <div class="actions">
          @if (formError()) { <span class="err" role="alert">{{ formError() }}</span> }
          <span class="spacer"></span>
          <button type="button" class="link" (click)="editing.set(false)">cancel</button>
          <button type="submit" class="cta" [disabled]="busy() || serverForm().invalid() || (!editingId() && !model().key.trim())">
            {{ busy() ? 'Checking…' : editingId() ? 'Save' : 'Add server' }}
          </button>
        </div>
      </form>
    } @else {
      <button type="button" class="add" (click)="add()">+ Add a server</button>
    }
  `,
  styleUrl: './new-project-panel.css',
  styles: `
    :host { overflow-y: auto; }
    .err { color: var(--danger); font-size: 11px; margin: 0; }
    .muted { color: var(--muted); }
    p { margin: 0; }
    a { color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    code { font-family: ui-monospace, 'Cascadia Code', Consolas, monospace; font-size: 11px; background: var(--panel-2); border-radius: 3px; padding: 1px 4px; }
    .link:disabled { opacity: 0.45; cursor: default; }
    .link.danger { color: var(--danger); }
    .servers { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .server { display: grid; gap: 6px; padding: 8px 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; }
    .server.bad { border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); }
    .top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .name { font-weight: 600; white-space: nowrap; }
    .spacer { flex: 1; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--quiet); flex: none; align-self: center; }
    .server:not(.bad) .dot { background: var(--busy); }
    .server.bad .dot { background: var(--danger); }
    .confirm { display: inline-flex; gap: 8px; align-items: baseline; font-size: 11px; white-space: nowrap; }
    dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 10px; margin: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
    dd .muted { margin-left: 6px; font-size: 11px; }
    .when { color: var(--muted); font-size: 11px; }
    .editor { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); }
    input[type='password'] { font: inherit; font-size: 13px; padding: 6px 8px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 5px; }
    .actions { display: flex; align-items: center; gap: 10px; }
    .cta { color: var(--bg); background: var(--accent); border: none; border-radius: 4px; padding: 4px 14px; font-weight: 600; }
    .cta:disabled { opacity: 0.45; cursor: default; }
    .add { justify-self: start; align-self: flex-start; color: var(--text); background: var(--panel); border: 1px dashed var(--border); border-radius: 5px; padding: 5px 12px; }
    .add:hover { border-color: var(--accent); color: var(--accent); }
  `,
  host: { '(keydown.escape)': 'escape($event)' },
})
export class NoxServersPanel {
  readonly now = input.required<number>();
  readonly closed = output<void>();

  protected readonly nox = inject(NoxService);
  private readonly injector = inject(Injector);
  private readonly first = viewChild<ElementRef<HTMLInputElement>>('first');

  protected readonly editing = signal(false);
  /** The server being changed; null while adding one. */
  protected readonly editingId = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly formError = signal<string | null>(null);
  /** The server whose remove is awaiting a yes. */
  protected readonly confirming = signal<string | null>(null);

  protected readonly model = signal({ name: '', url: '', key: '' });
  protected readonly serverForm = form(this.model, (p) => {
    required(p.name);
    required(p.url);
  });
  protected readonly editingKey = computed(() => this.nox.servers()?.find((s) => s.id === this.editingId())?.keyPrefix ?? null);

  constructor() {
    this.nox.load();
  }

  protected add(): void {
    this.open(null, { name: '', url: '', key: '' });
  }

  protected edit(s: NoxServer): void {
    this.open(s.id, { name: s.name, url: s.url, key: '' });
  }

  private open(id: string | null, value: { name: string; url: string; key: string }): void {
    this.editingId.set(id);
    this.model.set(value);
    this.formError.set(null);
    this.editing.set(true);
    afterNextRender(() => this.first()?.nativeElement.focus(), { injector: this.injector });
  }

  /** A new server's name defaults to its host. */
  protected suggestName(): void {
    const m = this.model();
    if (m.name.trim()) return;
    try {
      this.model.set({ ...m, name: new URL(m.url.trim()).hostname });
    } catch {
      // not a URL yet: leave the name for the user
    }
  }

  protected save(): void {
    if (this.busy()) return;
    const { name, url, key } = this.model();
    const id = this.editingId();
    this.busy.set(true);
    this.formError.set(null);
    this.nox.save({ ...(id ? { id } : {}), name, url, key }).subscribe({
      next: () => {
        this.busy.set(false);
        this.editing.set(false);
      },
      error: (e) => {
        this.busy.set(false);
        this.formError.set(e.error?.error ?? e.message);
      },
    });
  }

  protected remove(s: NoxServer): void {
    this.busy.set(true);
    this.nox.remove(s.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirming.set(null);
      },
      error: (e) => {
        this.busy.set(false);
        this.nox.error.set(e.error?.error ?? e.message);
      },
    });
  }

  /** Esc backs out of the innermost thing open: a remove confirmation, the form, then the panel. */
  protected escape(e: Event): void {
    e.stopPropagation();
    if (this.confirming()) this.confirming.set(null);
    else if (this.editing()) this.editing.set(false);
    else this.closed.emit();
  }
}
