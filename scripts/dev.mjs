// `npm run dev`: the API and the Angular dev server on this worktree's ports (scripts/worktree-ports.mjs).
// The API resolves its own port the same way; only the web side needs it handed over.
// `npm run serve` (--no-watch) runs the API without node --watch: a restart kills every terminal,
// so the dashboard you work in shouldn't restart whenever a file under server/ changes.
import concurrently from 'concurrently';
import { resolvePorts } from './worktree-ports.mjs';

const ports = await resolvePorts();
const watch = !process.argv.includes('--no-watch');

const { result } = concurrently(
  [
    { command: watch ? 'npm run api' : 'npm run api:serve', name: 'api', prefixColor: 'yellow' },
    {
      // ng serve refuses a taken port when not interactive, so it never drifts.
      command: `npm start --prefix web -- --port ${ports.web}`,
      name: 'web',
      prefixColor: 'cyan',
      env: { GYRO_API_PORT: String(ports.api) },
    },
  ],
  { killOthersOn: ['failure', 'success'] },
);
result.catch(() => process.exit(1));
