import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { FormField, form, maxLength } from '@angular/forms/signals';
import { DashboardService } from './dashboard.service';
import { DevSetting, Workspace } from './model';

/** The command that runs the project's app, started beside each dock session and shown in its preview. */
@Component({
  selector: 'app-dev-section',
  imports: [FormField],
  template: `
    @let d = ws().dev;
    <div class="head">
      <h3 id="dev-h">Dev server</h3>
      @if (!editing()) { <button type="button" class="link" (click)="edit()">change</button> }
    </div>

    @if (!editing()) {
      @if (effective(); as cmd) {
        <p><code>{{ cmd }}</code> <span class="muted">{{ d?.command ? 'set here' : 'from package.json' }}</span></p>
      } @else {
        <p class="muted">{{ d?.command === '' ? 'Turned off.' : 'No dev or start script found.' }} Sessions start without a preview.</p>
      }
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
    } @else {
      <form class="editor" aria-labelledby="dev-h" (submit)="$event.preventDefault(); save(model().command)">
        <label class="field">
          <span class="lbl">Command</span>
          <input type="text" [formField]="devForm.command" [placeholder]="d?.detected ?? 'e.g. npm run dev:web'"
                 autocomplete="off" spellcheck="false" aria-describedby="dev-help" />
        </label>
        <p id="dev-help" class="help">
          Runs in the worktree beside each session you start here; the address it prints opens in the preview. Leave it blank for none.
        </p>
        <div class="actions">
          @if (error()) { <span class="err" role="alert">{{ error() }}</span> }
          <span class="spacer"></span>
          @if (d?.command !== null && d?.detected) {
            <button type="button" class="link" (click)="save(null)" [disabled]="busy()">use {{ d!.detected }}</button>
          }
          <button type="button" class="link" (click)="editing.set(false)">cancel</button>
          <button type="submit" class="cta" [disabled]="busy() || devForm().invalid()">{{ busy() ? 'Saving…' : 'Save' }}</button>
        </div>
      </form>
    }
  `,
  styleUrl: './github-section.css',
  host: { '(keydown.escape)': 'editing.set(false)' },
})
export class DevSection {
  readonly ws = input.required<Workspace>();

  private readonly http = inject(HttpClient);
  private readonly api = inject(DashboardService);

  protected readonly editing = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** What actually runs: the command set here ('' is off), else the detected script. */
  protected readonly effective = computed(() => {
    const d = this.ws().dev;
    return d ? (d.command ?? d.detected) : null;
  });

  protected readonly model = signal({ command: '' });
  protected readonly devForm = form(this.model, (p) => maxLength(p.command, 500));

  protected edit(): void {
    this.editing.set(true);
    this.error.set(null);
    this.model.set({ command: this.effective() ?? '' });
  }

  /** Save a command ('' for none), or null to go back to the package.json script. */
  protected save(command: string | null): void {
    if (this.busy()) return;
    const path = this.ws().path;
    this.busy.set(true);
    this.error.set(null);
    this.http.post<{ dev: DevSetting }>('/api/projects/dev', { path, command: command?.trim() ?? null }).subscribe({
      next: ({ dev }) => {
        this.busy.set(false);
        this.editing.set(false);
        this.api.snapshot.update((s) => s && { ...s, workspaces: s.workspaces.map((w) => (w.path === path ? { ...w, dev } : w)) });
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }
}
