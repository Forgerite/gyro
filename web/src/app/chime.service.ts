import { DestroyRef, Service, effect, inject } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { Session, Snapshot, sessionState } from './model';

/** A session has to have been working this long before finishing earns a chime. */
const MIN_BUSY_MS = 10_000;

/** Plays a chime when a session goes from working (green) to waiting on you (red) after working at least 10s. */
@Service()
export class ChimeService {
  private readonly api = inject(DashboardService);
  /** When each working session was first seen working, by session id. */
  private readonly busySince = new Map<string, number>();
  private primed = false;
  private ctx: AudioContext | null = null;

  constructor() {
    effect(() => {
      const snap = this.api.snapshot();
      if (snap) this.check(snap);
    });
    // Browsers keep audio suspended until the page gets a gesture; unlock it on the first one.
    const unlock = () => this.audio()?.resume();
    document.addEventListener('pointerdown', unlock, { once: true, capture: true });
    document.addEventListener('keydown', unlock, { once: true, capture: true });
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('pointerdown', unlock, { capture: true });
      document.removeEventListener('keydown', unlock, { capture: true });
      this.ctx?.close();
    });
  }

  private check(snap: Snapshot): void {
    const now = Date.now();
    const seen = new Set<string>();
    for (const s of sessionsOf(snap)) {
      seen.add(s.id);
      const since = this.busySince.get(s.id);
      if (sessionState(s) === 'busy') {
        if (since === undefined) this.busySince.set(s.id, now);
      } else if (since !== undefined) {
        this.busySince.delete(s.id);
        // The first snapshot only seeds: sessions already working when the page loaded have an unknown start.
        if (this.primed && now - since >= MIN_BUSY_MS) this.play();
      }
    }
    for (const id of this.busySince.keys()) if (!seen.has(id)) this.busySince.delete(id);
    this.primed = true;
  }

  private audio(): AudioContext | null {
    try {
      this.ctx ??= new AudioContext();
    } catch {
      return null;
    }
    return this.ctx;
  }

  /** Two soft bell tones, rising. */
  private play(): void {
    const ctx = this.audio();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    [
      { freq: 880, at: 0 },
      { freq: 1318.5, at: 0.14 },
    ].forEach(({ freq, at }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + at;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 1.25);
    });
  }
}

/** Every session the dashboard colours: open projects' worktrees and loose sessions, plus unmatched ones. */
function sessionsOf(snap: Snapshot): Session[] {
  const open = snap.workspaces.filter((w) => !w.closed);
  return [...open.flatMap((w) => [...w.worktrees.flatMap((wt) => wt.sessions), ...w.loose]), ...snap.unmatched];
}
