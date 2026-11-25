# Gyro

`npm run dev` runs the API (`server/`) and the Angular dashboard (`web/`) together, restarting the API whenever a file under `server/` changes.

`npm run serve` is for the dashboard you work in: the embedded terminals live inside the API process, so every restart kills all running sessions. It doesn't restart on changes, and it doesn't run `ng serve` (about 1 GB): it builds `web/` once and the API serves `web/dist` on the dashboard's port itself (`GYRO_STATIC`, `server/static.mjs`). To pick up dashboard changes without killing terminals, run `npm run build --prefix web` and reload the page.

## Sessions

A Gyro session is a row in `work_sessions` (`server/work.mjs`) that Gyro created (`origin = 'wizard'`) and that is still `active`. Git worktrees and Claude conversations are properties of a session, never the definition of one: `withGyroSessions` in `server/index.mjs` builds each project's session list from those rows, attaching the scanned worktree at the row's path (shown as removed when its folder is gone) and the conversations linked by id.

- Rows with `origin = 'backfill'` are made automatically for worktrees created outside Gyro, so Ship and Land work there; they don't count as sessions.
- Worktrees with no Gyro session, and loose Claude sessions, are listed under each card's collapsed **External** section. The main checkout keeps its own row (the Main toggle), since every session forks from it.

## Idle cost

Gyro is left open all day, so polling has to stay cheap. On Windows every git launch costs about 20 ms of CPU plus a Defender scan.

- The dashboard polls `/api/snapshot` every 3 s, and every 30 s while its tab is hidden.
- The scanner (`server/scanner.mjs`) re-runs git status every 15 s only for hot worktrees (a live or recent session or commit, or one being viewed), and every 5 min for the rest. Commits, checkouts and staging show at once anyway, through the mtimes of the worktree's `logs/HEAD`, `HEAD` and `index`. Uncommitted changes alone don't make a worktree hot.
- Snapshots carry the last exchange only for each worktree's top session; the rest are marked `textOmitted` and fetched from `/api/session/text` when opened.

## Ports

Every port comes from `scripts/worktree-ports.mjs`, so several worktrees can run Gyro at once. It takes a block base from, in order: `GYRO_PORT_BASE` in the environment (Gyro sets it, with `GYRO_PORT_COUNT` = 100 and `GYRO_PORT_SLOT`, for everything it starts; the dev server also gets `PORT` = base), then a running Gyro (`GET http://127.0.0.1:4317/api/ports?path=<git toplevel>`, 1.5 s timeout), then the old fixed ports.

| Offset | Service | Fallback |
| --- | --- | --- |
| 0 | Angular dev server (`ng serve`, what `npm run dev` serves) | 4200 |
| 1 | API (`server/index.mjs`) | 4317 |
| 50–99 | reserved for test/e2e services | |

- Node code imports `resolvePorts()` from `scripts/worktree-ports.mjs`; anything else runs `node scripts/worktree-ports.mjs` (JSON) or `--env` (`GYRO_WEB_PORT=…` lines).
- `scripts/dev.mjs` resolves once, passes `--port` to `ng serve` and `GYRO_API_PORT` to `web/proxy.conf.mjs`.
- `GYRO_PORT` and `GYRO_ORIGINS` still override the API port and allowed origins explicitly.
- Gyro was called ccdb. It still sets the old `CCDB_PORT_*` names next to the `GYRO_` ones, for projects converted before the rename.
- Never hardcode a port; add the service to `OFFSETS` and `FALLBACK` instead.
