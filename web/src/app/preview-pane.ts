import { Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChildren } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { DashboardService } from './dashboard.service';
import { DevServer } from './model';
import { LiveRun } from './live-run';
import { TestReport } from './test-report';

const VIEW_KEY = 'ccdb.previewView';

export interface PreviewTab {
  path: string;
  label: string;
  devCommand: string | null;
  dev: DevServer | null;
}

/**
 * The app each dock session is building, served by its dev server, or its latest Playwright report.
 * Every session keeps its own app page alive (hidden when another is shown), so switching sessions
 * swaps the preview instantly.
 */
@Component({
  selector: 'app-preview-pane',
  imports: [NgTemplateOutlet, TestReport],
  template: `
    <ng-template #views>
      <div class="views" role="tablist" aria-label="Preview">
        <button type="button" role="tab" [attr.aria-selected]="view() === 'app'" (click)="setView('app')">App</button>
        <button type="button" role="tab" [attr.aria-selected]="view() === 'tests'" (click)="setView('tests')"
                [attr.aria-label]="live.running() ? 'Tests (running)' : null">Tests@if (live.running()) {<span class="live-dot" aria-hidden="true"></span>}</button>
      </div>
    </ng-template>

    @if (view() === 'tests' && active(); as path) {
      <app-test-report [path]="path" [live]="live"><ng-container [ngTemplateOutlet]="views" /></app-test-report>
    } @else {
      <div class="bar">
        <ng-container [ngTemplateOutlet]="views" />
        <form class="addr" (submit)="go($event, addr.value)">
          <input #addr aria-label="Preview address" type="text" inputmode="url" spellcheck="false" autocomplete="off"
                 [value]="current()?.url ?? ''" [disabled]="!current()" placeholder="Waiting for the dev server" />
        </form>
        <button type="button" (click)="reload()" [disabled]="!current()" title="Reload" aria-label="Reload preview">⟳</button>
        @if (current(); as c) {
          <a [href]="c.url" target="_blank" rel="noopener" title="Open in a new tab" aria-label="Open preview in a new tab">↗</a>
        }
      </div>
    }
    <!-- The app pages stay loaded while the tests are shown, so switching back keeps their state. -->
    <div class="frames" [hidden]="view() === 'tests'">
      @for (f of frames(); track f.path) {
        <iframe #frame [src]="f.src" [title]="'Preview of ' + f.label" [attr.data-path]="f.path" [hidden]="f.path !== active()"></iframe>
      }
      @if (status(); as s) {
        <div class="status" role="status">
          <p>{{ s.text }}</p>
          <div class="acts">
            @if (s.start) { <button type="button" (click)="api.devServer(s.path, true)">{{ s.start }}</button> }
            @if (s.output) { <button type="button" (click)="showOutput.emit()">Show its output</button> }
          </div>
        </div>
      }
    </div>
  `,
  styleUrl: './preview-pane.css',
})
export class PreviewPane {
  readonly tabs = input.required<PreviewTab[]>();
  readonly active = input.required<string | null>();
  /** Switch the left pane to the dev server's terminal. */
  readonly showOutput = output<void>();

  protected readonly api = inject(DashboardService);

  protected readonly view = signal<'app' | 'tests'>(loadView());

  /** The active session's Playwright run, drawn live; a run starting brings the Tests view up. */
  protected readonly live = new LiveRun();

  constructor() {
    effect(() => this.live.watch(this.active()));
    let was = false;
    effect(() => {
      const running = this.live.running();
      if (running && !was) untracked(() => this.view.set('tests'));
      was = running;
    });
    inject(DestroyRef).onDestroy(() => this.live.stop());
  }

  protected setView(v: 'app' | 'tests'): void {
    this.view.set(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ }
  }
  private readonly sanitizer = inject(DomSanitizer);
  private readonly iframes = viewChildren<ElementRef<HTMLIFrameElement>>('frame');

  /** Addresses typed into the bar, per session; dropped when the dev server moves to a new URL. */
  private readonly typed = signal<Record<string, { base: string; url: string }>>({});
  /** One trusted URL object per address: a new object would make Angular reload the frame. */
  private readonly trusted = new Map<string, SafeResourceUrl>();

  private urlFor(t: PreviewTab): string | null {
    const base = t.dev && !t.dev.exited ? t.dev.url : null;
    if (!base) return null;
    const typed = this.typed()[t.path];
    return typed?.base === base ? typed.url : base;
  }

  protected readonly frames = computed(() =>
    this.tabs().flatMap((t) => {
      const url = this.urlFor(t);
      if (!url) return [];
      let src = this.trusted.get(url);
      if (!src) this.trusted.set(url, (src = this.sanitizer.bypassSecurityTrustResourceUrl(url)));
      return [{ path: t.path, label: t.label, src }];
    }),
  );

  protected readonly current = computed(() => {
    const t = this.tabs().find((x) => x.path === this.active());
    const url = t && this.urlFor(t);
    return t && url ? { path: t.path, url } : null;
  });

  /** What to say instead of a page: not started, starting, or stopped. */
  protected readonly status = computed(() => {
    const t = this.tabs().find((x) => x.path === this.active());
    if (!t || this.current()) return null;
    // Nothing started with the session: there may be a command now (set since, or missed), so offer to try.
    if (!t.devCommand) {
      return { path: t.path, text: 'No dev server started with this session. Its command is set under Dev server in the project panel.', start: 'Start the dev server', output: false };
    }
    if (!t.dev) return { path: t.path, text: 'The dev server isn’t running.', start: `Start ${t.devCommand}`, output: false };
    if (t.dev.exited) {
      return { path: t.path, text: `The dev server stopped (exit code ${t.dev.exitCode ?? '?'}).`, start: 'Restart it', output: true };
    }
    return { path: t.path, text: `Waiting for ${t.devCommand} to print its address…`, start: null, output: true };
  });

  protected go(ev: Event, value: string): void {
    ev.preventDefault();
    const t = this.tabs().find((x) => x.path === this.active());
    const base = t?.dev?.url;
    if (!t || !base) return;
    let url: URL;
    try {
      url = new URL(value.trim(), base); // a bare path like /settings stays on the dev server
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    this.typed.update((m) => ({ ...m, [t.path]: { base, url: url.href } }));
    if (url.href === this.current()?.url) this.reload();
  }

  protected reload(): void {
    const frame = this.iframes().find((f) => f.nativeElement.dataset['path'] === this.active())?.nativeElement;
    if (frame) frame.src = frame.src;
  }
}

function loadView(): 'app' | 'tests' {
  try { return localStorage.getItem(VIEW_KEY) === 'tests' ? 'tests' : 'app'; } catch { return 'app'; }
}
