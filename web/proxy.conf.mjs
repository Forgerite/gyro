// The API port comes from scripts/worktree-ports.mjs via scripts/dev.mjs.
const target = `http://127.0.0.1:${process.env.CCDB_API_PORT ?? 4317}`;

export default {
  '/api': { target, secure: false, ws: true },
};
