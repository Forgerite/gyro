import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { AgoPipe } from './ago.pipe';
import { DashboardService } from './dashboard.service';
import { LiveRun } from './live-run';

interface Report {
  id: string;
  /** Folder, relative to the worktree. */
  name: string;
  /** When the run wrote it. */
  at: number;
  url: string;
}

/** How often to look for a newer run while the tab is open: a run Claude starts shows up by itself. */
const POLL_MS = 5000;

/** The worktree's latest Playwright HTML report, as Playwright draws it. */
@Component({
  selector: 'app-test-report',
  imports: [AgoPipe, DatePipe],
  template: `
    <div class="bar">
      <ng-content />
      @if (live()?.running()) {
        <span class="live-badge" role="status"><span class="live-dot" aria-hidden="true"></span>Running</span>
        <button type="button" class="toggle" (click)="wantReport.set(!wantReport())">{{ wantReport() ? 'Watch live' : 'Last report' }}</button>
      }
      @if (showLive()) {
        <span class="spacer"></span>
      } @else {
        @if (reports().length > 1) {
          <select aria-label="Report" [value]="selected()?.id" (change)="pick($any($event.target).value)">
            @for (r of reports(); track r.id) { <option [value]="r.id">{{ r.name }}</option> }
          </select>
        } @else if (selected(); as r) {
          <span class="name" [title]="r.name">{{ r.name }}</span>
        }
        @if (selected(); as r) {
          @let ago = r.at | ago: now();
          <span class="when" [title]="r.at | date: 'medium'">ran {{ ago === 'now' ? 'just now' : ago + ' ago' }}</span>
          <button type="button" (click)="reload()" title="Reload" aria-label="Reload report">⟳</button>
          <a [href]="r.url" target="_blank" rel="noopener" title="Open in a new tab" aria-label="Open report in a new tab">↗</a>
        } @else {
          <span class="spacer"></span>
        }
      }
    </div>
    <div class="frames">
      @if (showLive()) {
        <div class="live" [class.multi]="live()!.streams().length > 1">
          @for (s of live()!.streams(); track s.id) {
            <figure [class.ended]="s.ended">
              @if (s.src) { <img [src]="s.src" [alt]="'Browser page of ' + (s.title ?? 'a running test')" /> }
              @else { <div class="blank">Opening the page…</div> }
              <figcaption [title]="s.title ?? ''">{{ s.title ?? 'Test' }}</figcaption>
            </figure>
          }
        </div>
      } @else if (src(); as s) {
        <iframe #frame [src]="s" title="Playwright test report"></iframe>
      } @else if (errorText(); as m) {
        <div class="status" role="alert"><p>{{ m }}</p></div>
      } @else if (res.hasValue()) {
        <div class="status">
          <p>No Playwright report in this worktree yet.</p>
          <p class="hint">
            Turn on the HTML reporter, and keep it from opening a browser (which would stall a run Claude starts):
          </p>
          <code>reporter: [['list'], ['html', {{ '{' }} open: 'never' {{ '}' }}]]</code>
          <p class="hint">Reports in <code>playwright-report/</code>, or Nx's <code>dist/.playwright/…</code>, show up here after the next run.</p>
        </div>
      } @else {
        <div class="status" role="status"><p>Looking for test reports…</p></div>
      }
    </div>
  `,
  styleUrl: './preview-pane.css',
})
export class TestReport {
  /** The worktree of the session being previewed. */
  readonly path = input.required<string>();
  /** Its Playwright run, while one is going. */
  readonly live = input<LiveRun | null>(null);

  /** Show the last report even though a run is going. Each new run starts on the live view. */
  protected readonly wantReport = signal(false);
  protected readonly showLive = computed(() => !!this.live()?.running() && !this.wantReport());

  private readonly api = inject(DashboardService);
  protected readonly now = this.api.now;
  private readonly sanitizer = inject(DomSanitizer);
  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');

  protected readonly res = httpResource<{ reports: Report[] }>(() => ({ url: '/api/reports', params: { path: this.path() } }));
  protected readonly reports = computed(() => (this.res.hasValue() ? this.res.value().reports : []));
  protected readonly errorText = computed(() => {
    const e = this.res.error() as { error?: { error?: string }; message?: string } | undefined;
    return e ? (e.error?.error ?? e.message ?? 'Couldn’t look for reports') : null;
  });

  /** Report picked per worktree; the newest run when nothing (or something now gone) is picked. */
  private readonly picked = signal<Record<string, string>>({});
  protected readonly selected = computed(() => {
    const list = this.reports();
    return list.find((r) => r.id === this.picked()[this.path()]) ?? list[0] ?? null;
  });

  /** One trusted URL per report run: a new run changes it, which reloads the frame. */
  private readonly trusted = new Map<string, SafeResourceUrl>();
  protected readonly src = computed(() => {
    const r = this.selected();
    if (!r) return null;
    const url = `${r.url}?run=${Math.round(r.at)}`;
    let s = this.trusted.get(url);
    if (!s) this.trusted.set(url, (s = this.sanitizer.bypassSecurityTrustResourceUrl(url)));
    return s;
  });

  constructor() {
    // A run starting goes to the live view; one ending has just written its report, so look now.
    let was = false;
    effect(() => {
      const running = !!this.live()?.running();
      if (running && !was) untracked(() => this.wantReport.set(false));
      if (!running && was) untracked(() => this.res.reload());
      was = running;
    });
    const id = setInterval(() => this.res.reload(), POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  protected pick(id: string): void {
    this.picked.update((m) => ({ ...m, [this.path()]: id }));
  }

  protected reload(): void {
    const f = this.frame()?.nativeElement;
    if (f) f.src = f.src;
  }
}
