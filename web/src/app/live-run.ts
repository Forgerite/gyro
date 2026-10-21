import { computed, signal } from '@angular/core';

/** One browser page of a running Playwright test, as last drawn. */
export interface LiveStream {
  id: string;
  title: string | null;
  src: string | null;
  /** Closed; still shown for a moment so the view doesn't flash between tests. */
  ended: boolean;
}

/** After a page closes, how long it stays up while waiting for the next test's page. */
const LINGER_MS = 2500;

/**
 * The pages a Playwright run in one worktree is drawing right now, streamed from ccdb's API (the
 * run's workers send them there; see server/pw-live-hook.cjs). Watches one worktree at a time.
 */
export class LiveRun {
  private readonly all = signal<LiveStream[]>([]);
  /** Open pages; when none are, the ones that just closed. */
  readonly streams = computed(() => {
    const list = this.all();
    const open = list.filter((s) => !s.ended);
    return open.length ? open : list;
  });
  readonly running = computed(() => this.all().length > 0);

  private path: string | null = null;
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  watch(path: string | null): void {
    if (path === this.path) return;
    this.stop();
    this.path = path;
    if (path) this.connect();
  }

  stop(): void {
    this.path = null;
    clearTimeout(this.retry);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.all.set([]);
  }

  private connect(): void {
    const path = this.path!;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = (this.ws = new WebSocket(`${proto}://${location.host}/api/live?${new URLSearchParams({ path })}`));
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let m: { t: string; id: string; title?: string | null; data?: string | null };
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'frame') this.frame(m.id, m.title ?? null, m.data ?? null);
      if (m.t === 'end') this.end(m.id);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.all.set([]);
      this.retry = setTimeout(() => this.path === path && this.connect(), 2000);
    };
  }

  private frame(id: string, title: string | null, data: string | null): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const src = data ? `data:image/jpeg;base64,${data}` : null;
    this.all.update((list) => {
      const old = list.find((s) => s.id === id);
      const next: LiveStream = { id, title: title ?? old?.title ?? null, src: src ?? old?.src ?? null, ended: false };
      return old ? list.map((s) => (s === old ? next : s)) : [...list, next];
    });
  }

  private end(id: string): void {
    this.all.update((list) => list.map((s) => (s.id === id ? { ...s, ended: true } : s)));
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      this.all.update((list) => list.filter((s) => s.id !== id || !s.ended));
    }, LINGER_MS));
  }
}
