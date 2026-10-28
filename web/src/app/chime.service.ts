import { DestroyRef, Service, effect, inject } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { Snapshot, State, sessionState } from './model';

/** A session has to have been working this long before finishing earns a chime. */
const MIN_BUSY_MS = 10_000;

/** The bell's strike tone, F#6. */
const BELL_FREQ = 1480;

/**
 * Two strikes: seconds after the start, loudness, and how long it rings as a share of the full decay.
 * The first is damped so its tail only just reaches under the second.
 */
const BELL_STRIKES = [
  { at: 0, level: 1, length: 0.25 },
  { at: 0.24, level: 0.8, length: 1 },
];

/** The metal-on-metal "tink" at the start of each strike: brief tones that die within a few tens of ms. */
const STRIKE_TONES = [
  { ratio: 2.1, gain: 0.16, decay: 0.07 },
  { ratio: 2.9, gain: 0.1, decay: 0.05 },
];

/** How much of the bell goes through the reverb, and how long its tail is. */
const REVERB_WET = 0.14;
const REVERB_SECONDS = 1;

/**
 * Bell partials: frequency as a multiple of BELL_FREQ, level, and seconds to fade out. The ratios are
 * inharmonic like a real bell's, the near-1 pair beats to give the shimmer, and higher partials die first.
 */
const BELL_PARTIALS = [
  { ratio: 1, gain: 0.5, decay: 2.2 },
  { ratio: 1.004, gain: 0.3, decay: 2.0 },
  { ratio: 2.42, gain: 0.32, decay: 1.2 },
  { ratio: 3.98, gain: 0.18, decay: 0.7 },
  { ratio: 5.43, gain: 0.1, decay: 0.4 },
  { ratio: 7.1, gain: 0.06, decay: 0.25 },
];

/** Plays a chime when a tile goes from working (green) to waiting on you (red) after working at least 10s. */
@Service()
export class ChimeService {
  private readonly api = inject(DashboardService);
  /** When each working session was first seen working, by session id. */
  private readonly busySince = new Map<string, number>();
  /** Each worktree's last seen work stage, to ring when checks go green (in review → ready to land). */
  private readonly stages = new Map<string, string>();
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
    for (const [key, state] of this.tiles(snap)) {
      seen.add(key);
      const since = this.busySince.get(key);
      if (state === 'busy') {
        if (since === undefined) this.busySince.set(key, now);
      } else if (since !== undefined) {
        this.busySince.delete(key);
        // The first snapshot only seeds: tiles already working when the page loaded have an unknown start.
        if (this.primed && state === 'waiting' && now - since >= MIN_BUSY_MS) this.play();
      }
    }
    for (const key of this.busySince.keys()) if (!seen.has(key)) this.busySince.delete(key);
    // The PR gate opening (checks went green while you weren't watching) is worth a bell too.
    const stagesSeen = new Set<string>();
    for (const w of snap.workspaces) {
      for (const wt of w.worktrees) {
        const stage = wt.work?.plan?.stage;
        if (!stage) continue;
        stagesSeen.add(wt.path);
        const was = this.stages.get(wt.path);
        this.stages.set(wt.path, stage);
        if (this.primed && !w.closed && stage === 'ready-to-land' && was === 'in-review') this.play();
      }
    }
    for (const key of this.stages.keys()) if (!stagesSeen.has(key)) this.stages.delete(key);
    this.primed = true;
  }

  /**
   * Every coloured tile and its state, worked out the way the dashboard colours it, so work the dashboard
   * runs itself (a rebase, a commit message, a PR) counts as well as Claude's own turns.
   */
  private *tiles(snap: Snapshot): Iterable<[string, State | 'idle']> {
    for (const w of snap.workspaces) {
      if (w.closed) continue;
      for (const wt of w.worktrees) yield [`wt:${wt.path}`, this.api.worktreeState(wt)];
      for (const s of w.loose) yield [`s:${s.id}`, this.api.looseSessionState(s)];
    }
    for (const s of snap.unmatched) yield [`s:${s.id}`, sessionState(s)];
  }

  private audio(): AudioContext | null {
    try {
      this.ctx ??= new AudioContext();
    } catch {
      return null;
    }
    return this.ctx;
  }

  /** A bell struck twice, with a touch of room reverb. */
  private play(): void {
    const ctx = this.audio();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    const out = ctx.createGain();
    out.gain.value = 0.22;
    out.connect(ctx.destination);

    const reverb = ctx.createConvolver();
    reverb.normalize = false;
    reverb.buffer = this.impulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = REVERB_WET;
    reverb.connect(wet).connect(ctx.destination);
    out.connect(reverb);

    for (const { at, level, length } of BELL_STRIKES) this.strike(ctx, out, t0 + at, level, length);
  }

  /** One strike: a short metallic click and tink, then inharmonic partials ringing out. */
  private strike(ctx: AudioContext, out: AudioNode, t0: number, level: number, length: number): void {
    const partials = BELL_PARTIALS.map((p) => ({ ...p, decay: p.decay * length }));
    for (const { ratio, gain: peak, decay } of [...partials, ...STRIKE_TONES]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = BELL_FREQ * ratio;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(peak * level, t0 + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
      osc.connect(gain).connect(out);
      osc.start(t0);
      osc.stop(t0 + decay + 0.05);
    }

    // The clapper hitting the bell: a few ms of high-passed noise.
    const len = Math.floor(ctx.sampleRate * 0.02);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const clickGain = ctx.createGain();
    clickGain.gain.value = 0.35 * level;
    noise.connect(hp).connect(clickGain).connect(out);
    noise.start(t0);
  }

  /** A small room: sparse random clicks fading out over REVERB_SECONDS, scaled to unit energy. */
  private impulse(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * REVERB_SECONDS);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    const spacing = Math.floor(ctx.sampleRate / 2000);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let energy = 0;
      for (let i = 0; i < len; i += spacing) {
        const k = Math.min(len - 1, i + Math.floor(Math.random() * spacing));
        const v = (Math.random() < 0.5 ? -1 : 1) * 1000 ** (-k / len);
        data[k] = v;
        energy += v * v;
      }
      const scale = 1 / Math.sqrt(energy);
      for (let i = 0; i < len; i++) data[i] *= scale;
    }
    return buf;
  }
}
