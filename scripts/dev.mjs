// `npm run dev`: the API and the Angular dev server on this worktree's ports (scripts/worktree-ports.mjs).
// The API resolves its own port the same way; only the web side needs it handed over.
import concurrently from 'concurrently';
import { resolvePorts } from './worktree-ports.mjs';

const ports = await resolvePorts();

const { result } = concurrently(
  [
    { command: 'npm run api', name: 'api', prefixColor: 'yellow' },
    {
      // ng serve refuses a taken port when not interactive, so it never drifts.
      command: `npm start --prefix web -- --port ${ports.web}`,
      name: 'web',
      prefixColor: 'cyan',
      env: { CCDB_API_PORT: String(ports.api) },
    },
  ],
  { killOthersOn: ['failure', 'success'] },
);
result.catch(() => process.exit(1));
