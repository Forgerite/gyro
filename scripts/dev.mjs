// `npm run dev`: the API and the Angular dev server on this worktree's ports (scripts/worktree-ports.mjs).
// The API resolves its own port the same way; only the web side needs it handed over.
// `npm run serve` (--no-watch) builds the dashboard once and has the API serve it on the web port: no
// `ng serve` (about 1 GB, watching files), and no node --watch, since a restart kills every terminal.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import concurrently from 'concurrently';
import { resolvePorts } from './worktree-ports.mjs';

const ports = await resolvePorts();
const watch = !process.argv.includes('--no-watch');

if (!watch) {
  execSync('npm run build --prefix web', { stdio: 'inherit' });
  // The API runs in this process: no npm or concurrently wrappers (~70 MB each) left idling around it.
  process.env.GYRO_STATIC = fileURLToPath(new URL('../web/dist/web/browser', import.meta.url));
  await import('../server/index.mjs');
} else {
  const { result } = concurrently(
    [
      { command: 'npm run api', name: 'api', prefixColor: 'yellow' },
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
}
