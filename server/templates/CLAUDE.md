# {{name}}

## Ports

This is a Gyro project: any number of its worktrees can run side by side. Every service gets its port from `ports.mjs`; never hardcode one.

- Gyro (ccdb) leases each worktree a block of 100 ports and sets `CCDB_PORT_BASE`, `CCDB_PORT_COUNT` and `CCDB_PORT_SLOT` for everything it starts there. The dev server also gets `PORT` (= `CCDB_PORT_BASE`).
- `ports.mjs` uses `CCDB_PORT_BASE`, else asks a running Gyro (`GET http://127.0.0.1:4317/api/ports?path=<worktree>`), else falls back to fixed ports for CI.
- A new service gets an entry in `OFFSETS` and `FALLBACK`: offset 0 is the main app (the dev server; Gyro's preview shows it), 1–49 other dev services, 50–99 test and e2e services.
- Dev servers must listen on their port exactly (Vite: `strictPort: true`), not drift to the next free one.
- `node ports.mjs` prints this worktree's ports; `node ports.mjs --env` prints them as `NAME_PORT=…` lines for `.env` files and docker compose.

| Service | Offset | Fallback |
|---|---|---|
| web (main app) | 0 | 3000 |
