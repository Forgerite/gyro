import { Component, DestroyRef, ElementRef, afterNextRender, effect, inject, input, output } from '@angular/core';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

const RECONNECT_MS = 1500;

/** One xterm bound to one server PTY over a WebSocket. Stays alive while hidden so state is kept. */
@Component({
  selector: 'app-terminal-view',
  template: '',
  styles: `
    :host { display: block; height: 100%; padding: 4px 0 0 8px; background: var(--term-bg); }
  `,
})
export class TerminalView {
  readonly path = input.required<string>();
  readonly active = input(false);
  readonly focusTick = input(0);
  /** Claude has drawn something (or exited): the startup overlay can go. */
  readonly ready = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private term?: Terminal;
  private fit = new FitAddon();
  private ws?: WebSocket;
  private disposed = false;

  constructor() {
    afterNextRender(() => this.init());
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      this.ws?.close();
      this.term?.dispose();
    });
    effect(() => {
      this.focusTick();
      if (this.active()) requestAnimationFrame(() => requestAnimationFrame(() => (this.refit(), this.term?.focus())));
    });
  }

  private init() {
    const css = getComputedStyle(this.host);
    const v = (name: string) => css.getPropertyValue(name).trim();
    this.term = new Terminal({
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: v('--term-bg'), foreground: v('--term-fg'), cursor: v('--accent'), selectionBackground: v('--selected') },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());
    // Returning false hands the key back to the browser instead of xterm.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const key = e.key.toLowerCase();
      if (e.ctrlKey && (e.code === 'Backquote' || key === '`')) return false; // app-level toggle
      // Paste: xterm would send ^V and swallow the event. Let the browser fire a real paste,
      // which xterm forwards as bracketed paste. Dictation tools (e.g. Wispr Flow) insert this way.
      if ((e.ctrlKey && !e.altKey && key === 'v') || (e.shiftKey && key === 'insert')) return false;
      // Copy when there's a selection; otherwise Ctrl+C stays an interrupt for claude.
      if (e.ctrlKey && !e.altKey && key === 'c' && this.term!.hasSelection()) {
        navigator.clipboard?.writeText(this.term!.getSelection());
        this.term!.clearSelection();
        return false;
      }
      return true;
    });
    this.term.open(this.host);
    this.term.onData((d) => this.send({ t: 'i', d }));
    this.term.onResize(({ cols, rows }) => this.send({ t: 'r', cols, rows }));
    new ResizeObserver(() => this.refit()).observe(this.host);
    this.refit();
    this.connect();
  }

  private connect() {
    if (this.disposed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/pty?path=${encodeURIComponent(this.path())}`);
    this.ws = ws;
    ws.onopen = () => {
      // Server replays its scrollback on attach, so start from a clean screen.
      this.term?.reset();
      this.send({ t: 'r', cols: this.term!.cols, rows: this.term!.rows });
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'o' && msg.d) {
        this.term?.write(msg.d);
        if (hasVisibleText(msg.d)) this.ready.emit();
      }
      if (msg.t === 'x') {
        this.term?.write(`\r\n\x1b[2m[process exited with code ${msg.code}]\x1b[0m\r\n`);
        this.ready.emit();
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private refit() {
    if (!this.term || !this.host.offsetParent) return; // hidden tabs keep their size
    try { this.fit.fit(); } catch { /* not laid out yet */ }
  }
}

/** ConPTY emits mode-setting escapes the instant a process starts; only real glyphs mean claude has drawn. */
function hasVisibleText(data: string): boolean {
  const stripped = data
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC (window title etc.)
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[@-_]/g, ''); // other 2-byte escapes
  return /[^\s\x00-\x1f]/.test(stripped);
}
