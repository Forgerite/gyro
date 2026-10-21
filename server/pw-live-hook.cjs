// Preloaded (NODE_OPTIONS --require) into everything Gyro's terminals run. When a process loads
// playwright-core, every page it opens is screencast to Gyro (any browser with Playwright's own
// page.screencast, Chromium only before that), so the dashboard can show a
// test run live. It does nothing anywhere else, and never lets a failure reach the test run.
'use strict';

(() => {
  const url = process.env.GYRO_LIVE_URL;
  // Bun (claude.exe) honours NODE_OPTIONS too; it never runs Playwright, so stay out of its way.
  if (!url || process.versions.bun || typeof globalThis.WebSocket !== 'function') return;

  let Module;
  try { Module = require('node:module'); } catch { return; }
  const hooked = new WeakSet();
  const load = Module._load;
  Module._load = function (request, ...rest) {
    const exports = load.call(this, request, ...rest);
    if (request === 'playwright-core' || request === 'playwright') {
      try { hook(exports); } catch { /* not the Playwright we know */ }
    }
    return exports;
  };

  function hook(pw) {
    const inst = pw?._instrumentation;
    if (!inst || typeof inst.addListener !== 'function' || hooked.has(inst)) return;
    hooked.add(inst);
    // Older Playwrights called it onDidCreateBrowserContext; newer, runAfterCreateBrowserContext.
    const seen = new WeakSet();
    const onContext = async (context) => {
      if (seen.has(context)) return;
      seen.add(context);
      try { watchContext(context); } catch { /* never fail the test */ }
    };
    inst.addListener({ runAfterCreateBrowserContext: onContext, onDidCreateBrowserContext: onContext });
  }

  // ---- the connection to Gyro: one socket per process, opened on the first page ----

  let ws = null;
  let queue = [];
  function send(msg) {
    if (!ws) connect();
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    else if (ws.readyState === 0 && queue.length < 50) queue.push(msg);
  }
  function connect() {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => { for (const m of queue) ws.send(JSON.stringify(m)); queue = []; });
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', () => { queue = []; });
  }

  // ---- pages ----

  let nextId = 0;

  function watchContext(context) {
    const browser = context.browser?.();
    const chromium = (browser?.browserType?.().name?.() ?? context._browserType?.name?.() ?? 'chromium') === 'chromium';
    const watch = (page) => {
      // Playwright's own screencast API where it has one (any browser); raw CDP before that (Chromium only).
      if (typeof page.screencast?.start === 'function') return viaScreencast(page);
      if (chromium) return viaCdp(context, page);
    };
    for (const page of context.pages()) watch(page);
    context.on('page', watch);
  }

  /** Announce a page to Gyro and end it when the page closes; `frame()` sends what it draws. */
  function stream(page) {
    const id = `${process.pid}-${nextId++}`;
    const state = { ended: false };
    page.once('close', () => {
      state.ended = true;
      send({ t: 'end', id });
    });
    send({ t: 'start', id, title: testTitle() });
    state.frame = (data, w, h) => { if (!state.ended) send({ t: 'frame', id, title: testTitle(), w, h, data }); };
    return state;
  }

  /**
   * page.screencast takes one caller at a time. The test comes first: if it starts its own, ours
   * stops and the frames it asked for are copied to Gyro too; when it stops, ours resumes.
   */
  function viaScreencast(page) {
    const sc = page.screencast;
    const s = stream(page);
    const toGyro = (f) => s.frame(f.data.toString('base64'), f.viewportWidth, f.viewportHeight);
    const start = sc.start;
    const stop = sc.stop;
    let ours = false;
    let starting = null;
    const startOurs = () =>
      (starting = hidden(page, () => start.call(sc, { onFrame: toGyro, quality: 60, size: frameSize(page) }))
        .then(() => { ours = true; }, () => {})
        .finally(() => { starting = null; }));
    sc.start = async function (options = {}) {
      await starting;
      if (ours) {
        ours = false;
        await hidden(page, () => stop.call(sc)).catch(() => {});
      }
      const theirs = options.onFrame;
      try {
        return await start.call(sc, { ...options, onFrame: (f) => { toGyro(f); return theirs?.(f); } });
      } catch (e) {
        // Theirs never started, but Playwright still thinks one is running until it's stopped.
        if (!s.ended && !page.isClosed()) hidden(page, () => stop.call(sc)).catch(() => {}).then(startOurs);
        throw e;
      }
    };
    sc.stop = async function () {
      await starting;
      if (ours) return; // nothing of the test's to stop
      try {
        return await stop.call(sc);
      } finally {
        if (!s.ended && !page.isClosed()) startOurs();
      }
    };
    startOurs();
  }

  /** The page's viewport, scaled down to fit 1280×900 (left alone, Playwright sends 800 wide). */
  function frameSize(page) {
    const v = page.viewportSize?.();
    if (!v) return undefined;
    const k = Math.min(1, 1280 / v.width, 900 / v.height);
    return { width: Math.round(v.width * k), height: Math.round(v.height * k) };
  }

  async function viaCdp(context, page) {
    let cdp;
    try {
      cdp = await hidden(context, () => context.newCDPSession(page));
    } catch {
      return;
    }
    const s = stream(page);
    cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
      if (s.ended) return;
      s.frame(data, metadata?.deviceWidth, metadata?.deviceHeight);
      hidden(context, () => cdp.send('Page.screencastFrameAck', { sessionId })).catch(() => {});
    });
    try {
      await hidden(context, () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 900 }));
    } catch { /* page already gone */ }
  }

  /** Run a Playwright call without it showing up as a step in the test's report and trace. */
  function hidden(obj, fn) {
    return typeof obj._wrapApiCall === 'function' ? obj._wrapApiCall(fn, { internal: true }) : fn();
  }

  // ---- which test is running ----

  let testApi;
  function testTitle() {
    try {
      if (testApi === undefined) {
        testApi = null;
        const from = require.resolve('playwright/test', { paths: [process.cwd()] });
        testApi = require(from).test;
      }
      const info = testApi?.info();
      return info ? info.titlePath.slice(1).join(' › ') : null;
    } catch {
      return null;
    }
  }
})();
