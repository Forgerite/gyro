import { httpResource } from '@angular/common/http';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';

/** A finished recording of a live run, as /api/recordings lists it. */
export interface Recording {
  id: string;
  /** When the run started. */
  at: number;
  /** How long it ran. */
  ms: number;
  frames: number;
  bytes: number;
  /** Distinct test titles seen. */
  tests: number;
}

/** One browser page of the run: frames are [t, offset, length], titles [t, title]; t is ms into the run. */
interface RecordedStream {
  id: string;
  start: number;
  end: number;
  frames: [number, number, number][];
  titles: [number, string][];
}

interface RecordingIndex {
  id: string;
  ms: number;
  streams: RecordedStream[];
}

/** Where a test starts, for the timeline's marks and the previous/next buttons. */
interface Chapter {
  t: number;
  title: string;
}

const SPEEDS = [0.5, 1, 2, 4, 8];
/** "Previous" within this long of a test's start goes to the test before it. */
const RESTART_MS = 1500;
/** Frames fetched ahead of the playhead, per page, so playback doesn't wait on each one. */
const AHEAD = 8;

export const formatMs = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Index of the last entry at or before `t` (entries sorted by their first element), or -1. */
function at<T extends [number, ...unknown[]]>(list: T[], t: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] <= t) (found = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  return found;
}

/** Plays back a recorded live run (see server/recordings.mjs), laid out like the live view. */
@Component({
  selector: 'app-recording-player',
  template: `
    <div class="stage">
      @if (idx.hasValue()) {
        <div class="live" [class.multi]="view().length > 1">
          @for (s of view(); track s.id) {
            <figure [class.ended]="s.ended">
              @if (s.src) { <img [src]="s.src" [alt]="'Recorded browser page of ' + (s.title ?? 'a test')" /> }
              @else { <div class="blank">Opening the page…</div> }
              <figcaption [title]="s.title ?? ''">{{ s.title ?? 'Test' }}</figcaption>
            </figure>
          }
        </div>
      } @else if (idx.error()) {
        <div class="status" role="alert"><p>Couldn’t load this recording.</p></div>
      } @else {
        <div class="status" role="status"><p>Loading the recording…</p></div>
      }
    </div>
    <div class="controls">
      <button type="button" (click)="prev()" [disabled]="!chapters().length" title="Previous test" aria-label="Previous test">⏮</button>
      <button type="button" (click)="toggle()" [disabled]="!length()" [title]="playing() ? 'Pause' : 'Play'" [attr.aria-label]="playing() ? 'Pause' : 'Play'">{{ playing() ? '⏸' : '▶' }}</button>
      <button type="button" (click)="next()" [disabled]="!chapters().length" title="Next test" aria-label="Next test">⏭</button>
      <div class="track">
        @for (c of chapters(); track c.t) {
          <span class="mark" [style.left.%]="(c.t / length()) * 100" [title]="c.title"></span>
        }
        <input type="range" min="0" [max]="length()" step="1" [value]="pos()" aria-label="Position"
          (input)="seek(+$any($event.target).value)" />
      </div>
      <span class="time">{{ fmt(pos()) }} / {{ fmt(length()) }}</span>
      <select aria-label="Playback speed" (change)="speed.set(+$any($event.target).value)">
        @for (s of speeds; track s) { <option [value]="s" [selected]="s === speed()">{{ s }}×</option> }
      </select>
    </div>
  `,
  styleUrl: './preview-pane.css',
})
export class RecordingPlayer {
  /** The worktree it was recorded in. */
  readonly path = input.required<string>();
  readonly recording = input.required<Recording>();

  protected readonly speeds = SPEEDS;
  protected readonly fmt = formatMs;

  protected readonly idx = httpResource<RecordingIndex>(() => ({
    url: '/api/recordings/index',
    params: { path: this.path(), id: this.recording().id },
  }));
  private readonly streams = computed(() => (this.idx.hasValue() ? this.idx.value().streams : []));
  protected readonly length = computed(() => (this.idx.hasValue() ? this.idx.value().ms : 0));

  protected readonly pos = signal(0);
  protected readonly playing = signal(false);
  protected readonly speed = signal(1);

  protected readonly chapters = computed<Chapter[]>(() => {
    const all = this.streams()
      .flatMap((s) => s.titles.map(([t, title]) => ({ t, title })))
      .sort((a, b) => a.t - b.t);
    return all.filter((c, i) => i === 0 || c.title !== all[i - 1].title);
  });

  /** The pages up at the playhead: the open ones, or else those that closed last (dimmed, as live). */
  protected readonly view = computed(() => {
    const pos = this.pos();
    const len = this.length();
    const list = this.streams();
    let shown = list.filter((s) => s.start <= pos && (pos < s.end || s.end >= len));
    let ended = false;
    if (!shown.length) {
      const last = Math.max(-1, ...list.filter((s) => s.end <= pos).map((s) => s.end));
      shown = list.filter((s) => s.end === last);
      ended = true;
    }
    return shown.map((s) => {
      const f = at(s.frames, pos);
      const ti = at(s.titles, pos);
      return {
        id: s.id,
        ended,
        src: f < 0 ? null : this.frameUrl(s.frames[f]),
        title: (s.titles[Math.max(ti, 0)] ?? [0, null])[1],
      };
    });
  });

  private readonly fetched = new Set<string>();

  constructor() {
    // A new recording starts from the top, playing.
    effect(() => {
      this.recording();
      untracked(() => {
        this.pos.set(0);
        this.playing.set(false);
        this.fetched.clear();
      });
    });
    effect(() => {
      if (this.idx.hasValue() && this.length() > 0) untracked(() => this.playing.set(true));
    });

    // Fetch the next few frames of each page ahead of the playhead.
    effect(() => {
      const pos = this.pos();
      for (const s of this.streams()) {
        const i = at(s.frames, pos);
        for (const f of s.frames.slice(Math.max(i, 0), i + 1 + AHEAD)) {
          const url = this.frameUrl(f);
          if (this.fetched.has(url)) continue;
          this.fetched.add(url);
          new Image().src = url;
        }
      }
    });

    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = 0;
      if (!this.playing()) return;
      const next = Math.min(this.length(), this.pos() + (now - last) * this.speed());
      last = now;
      this.pos.set(next);
      if (next >= this.length()) this.playing.set(false);
      else raf = requestAnimationFrame(tick);
    };
    effect(() => {
      if (!this.playing()) return;
      untracked(() => {
        last = performance.now();
        if (!raf) raf = requestAnimationFrame(tick);
      });
    });
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(raf));
  }

  protected toggle(): void {
    if (!this.playing() && this.pos() >= this.length()) this.pos.set(0);
    this.playing.update((p) => !p);
  }

  protected seek(t: number): void {
    this.pos.set(Math.max(0, Math.min(this.length(), t)));
  }

  protected prev(): void {
    const before = this.chapters().filter((c) => c.t < this.pos() - RESTART_MS);
    this.seek(before.at(-1)?.t ?? 0);
  }

  protected next(): void {
    const after = this.chapters().find((c) => c.t > this.pos());
    if (after) this.seek(after.t);
  }

  private frameUrl([, o, n]: [number, number, number]): string {
    const q = new URLSearchParams({ path: this.path(), id: this.recording().id, o: String(o), n: String(n) });
    return `/api/recordings/frame?${q}`;
  }
}
