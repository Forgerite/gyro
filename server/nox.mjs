// Nox Lumos: separately hosted servers that work a repo's GitHub Project tickets with Claude.
// Servers are added once (URL + an API key made in that server's portal) and picked per project;
// a linked project shows the tickets Nox Lumos is operating on next to its sessions.
//
// Every call sends the key as `Authorization: Bearer nlk_…`. The key is scoped in Nox Lumos; Gyro
// only needs pipeline:read (the board and the list of repos the server runs).

const TIMEOUT_MS = 10_000;
/** Lumos runs take minutes; this keeps the tile's green/red within a poll or two of the truth. */
const BOARD_TTL = 15_000;
/** How long a server's checked status (who the key is, which repos it runs) is trusted. */
/** Also how often every server is polled for it, so repos added to a server get noticed. */
export const STATUS_TTL = 60_000;
export const REQUIRED_SCOPE = 'pipeline:read';

/** "serverId|repo" -> { at, board, error, pending } */
const boards = new Map();
/** serverId -> { at, info, error, pending } */
const statuses = new Map();

/** A server URL as we store it: http(s) only, no trailing slash. */
export function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('Enter the Nox Lumos server URL, like https://lumos.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The server URL must start with https:// or http://');
  if (u.username || u.password || u.search || u.hash) throw new Error('Enter just the server URL, without a login, query or #');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Shown in place of the key: enough to match it against the key list in Nox Lumos. */
export const keyPrefix = (key) => key.slice(0, 12);

async function call({ url, key }, path) {
  let res;
  try {
    res = await fetch(`${url}${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? `${url} didn't answer within ${TIMEOUT_MS / 1000}s` : `Couldn't reach ${url} (${e.cause?.code ?? e.message})`);
  }
  if (!res.ok) {
    throw new Error(
      res.status === 401 ? 'Nox Lumos turned the API key away (wrong, revoked, or its user was removed)'
        : res.status === 403 ? `The API key isn't allowed to read the board: give it the ${REQUIRED_SCOPE} scope`
          : res.status === 404 && path === '/api/whoami' ? `${url} answered 404 for /api/whoami: it's not a Nox Lumos server, or one too old for API keys`
            : `Nox Lumos answered ${res.status} for ${path}`,
    );
  }
  // Unknown paths fall through to the portal's SPA, so HTML here means "not a Nox Lumos server" (or one without API keys).
  if (!(res.headers.get('content-type') ?? '').includes('json')) {
    throw new Error(`${url} doesn't look like a Nox Lumos server with API keys (${path} isn't JSON)`);
  }
  return res.json();
}

/**
 * Who the key is and what this server runs: { user, keyName, scopes, repos }. Throws, with a message
 * fit for the user, when the key doesn't work or can't read the board.
 */
export async function checkServer(server) {
  const me = await call(server, '/api/whoami');
  if (!me.permissions?.includes(REQUIRED_SCOPE)) {
    throw new Error(`The API key works but can't read the board: give it the ${REQUIRED_SCOPE} scope in Nox Lumos`);
  }
  const pipeline = await call(server, '/api/pipeline');
  return {
    user: me.user?.email ?? null,
    keyName: me.key?.name ?? null,
    auth: me.auth ?? null,
    scopes: me.key?.scopes ?? me.permissions,
    repos: Array.isArray(pipeline.repos) ? pipeline.repos : [],
  };
}

/** A server's last checked status, rechecked in the background once stale (or `force`d). */
export function serverStatus(server, force = false) {
  const c = statuses.get(server.id) ?? { at: 0, info: null, error: null, pending: null };
  statuses.set(server.id, c);
  if ((force || Date.now() - c.at > STATUS_TTL) && !c.pending) {
    const before = reposKey(c.info);
    c.pending = checkServer(server)
      .then((info) => {
        Object.assign(c, { info, error: null });
        if (reposKey(info) !== before) for (const fn of reposListeners) fn(server.id);
      })
      // Keep the last good repos: a server that's briefly down shouldn't look like it dropped them.
      .catch((e) => (c.error = e.message))
      .finally(() => Object.assign(c, { at: Date.now(), pending: null }));
  }
  return c;
}

const reposKey = (info) => (info ? [...info.repos].sort().join(',') : '');
const reposListeners = new Set();

/** Call `fn(serverId)` whenever a check finds a server running a different set of repos than before. */
export function onReposChanged(fn) {
  reposListeners.add(fn);
}

/** Recheck every server now (the repo poll); each check runs in the background. */
export function pollServers(servers) {
  for (const server of servers) serverStatus(server, true);
}

/** A server was just checked (when saving it): start its status from that, so auto-linking can use it at once. */
export function rememberStatus(id, info) {
  statuses.set(id, { at: Date.now(), info, error: null, pending: null });
}

/** A server was saved or removed: drop what we knew about it. */
export function forgetServer(id) {
  statuses.delete(id);
  for (const k of boards.keys()) if (k.startsWith(`${id}|`)) boards.delete(k);
}

/** Cached board of `repo` on `server`, refetched in the background once stale. */
function boardFor(server, repo) {
  const key = `${server.id}|${repo.toLowerCase()}`;
  const c = boards.get(key) ?? { at: 0, board: null, error: null, pending: null };
  boards.set(key, c);
  if (Date.now() - c.at > BOARD_TTL && !c.pending) {
    c.pending = call(server, `/api/board?repo=${encodeURIComponent(repo)}`)
      .then((board) => Object.assign(c, { board, error: null }))
      .catch((e) => (c.error = e.message)) // keep the last good board
      .finally(() => Object.assign(c, { at: Date.now(), pending: null }));
  }
  return c;
}

/**
 * Green (busy) while Lumos has work queued or running on the ticket; red (waiting) when it has stopped
 * on something it can't do itself: a question or sign-off for a human, CI or a merge, a failure.
 */
export function classify(t) {
  const c = t.conclusion;
  if (t.queueState === 'processing') return { state: 'busy', label: 'Lumos is working' };
  if (t.queueState === 'pending') {
    return { state: 'busy', label: t.attempts > 0 && t.lastError ? `Queued to retry: ${t.lastError}` : 'Queued for Lumos' };
  }
  if (t.queueState === 'dead') return { state: 'waiting', label: `Gave up after ${t.attempts} tries${t.lastError ? `: ${t.lastError}` : ''}` };
  if (c?.kind === 'advance' && c.statusWrite !== 'failed') return { state: 'busy', label: c.headline || `Moving to ${c.toStatus}` };
  if (c?.kind === 'advance') return { state: 'waiting', label: `Couldn't move the card to ${c.toStatus}` };
  if (c?.kind === 'comment') return { state: 'waiting', label: c.headline || 'Waiting on a reply' };
  if (c?.kind === 'failed') return { state: 'waiting', label: c.headline || `Failed${c.error ? `: ${c.error}` : ''}` };
  if (c) return { state: 'waiting', label: c.headline || c.reason || 'Paused' };
  return { state: 'waiting', label: 'Paused' };
}

/**
 * The tickets of `repo` on `server` in a stage Lumos runs a workflow in, for the snapshot (null
 * until the first fetch). Filtered here too: a server from before ?repo= returns every repo's.
 */
export function noxTickets(server, repo) {
  const c = boardFor(server, repo);
  const base = { at: c.at || null, error: c.error };
  if (!c.board) return { ...base, tickets: null };
  const want = repo.toLowerCase();
  const tickets = (c.board.columns ?? [])
    .filter((col) => col.pipeline)
    .flatMap((col) => col.tickets.filter((t) => t.repo.toLowerCase() === want).map((t) => ({
      id: t.issueNodeId,
      number: t.number,
      title: t.title,
      url: t.url,
      status: t.status,
      stage: col.stage,
      queueState: t.queueState,
      updatedAt: t.updatedAt,
      ...classify(t),
    })))
    .sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting') || b.updatedAt - a.updatedAt);
  return { ...base, tickets };
}
