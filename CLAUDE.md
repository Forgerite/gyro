# ccdb

`npm run dev` runs the API (`server/`) and the Angular dashboard (`web/`) together.

## Ports

Every port comes from `scripts/worktree-ports.mjs`, so several worktrees can run ccdb at once. It takes a block base from, in order: `CCDB_PORT_BASE` in the environment (Gyro sets it, with `CCDB_PORT_COUNT` = 100 and `CCDB_PORT_SLOT`, for everything it starts; the dev server also gets `PORT` = base), then a running Gyro (`GET http://127.0.0.1:4317/api/ports?path=<git toplevel>`, 1.5 s timeout), then the old fixed ports.

| Offset | Service | Fallback |
| --- | --- | --- |
| 0 | Angular dev server (`ng serve`, what `npm run dev` serves) | 4200 |
| 1 | API (`server/index.mjs`) | 4317 |
| 50–99 | reserved for test/e2e services | |

- Node code imports `resolvePorts()` from `scripts/worktree-ports.mjs`; anything else runs `node scripts/worktree-ports.mjs` (JSON) or `--env` (`CCDB_WEB_PORT=…` lines).
- `scripts/dev.mjs` resolves once, passes `--port` to `ng serve` and `CCDB_API_PORT` to `web/proxy.conf.mjs`.
- `CCDB_PORT` and `CCDB_ORIGINS` still override the API port and allowed origins explicitly.
- Never hardcode a port; add the service to `OFFSETS` and `FALLBACK` instead.
