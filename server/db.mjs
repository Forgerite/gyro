// The one SQLite handle for ~/.claude/gyro/gyro.db, shared by every module that persists
// (gyro.mjs, work.mjs). One connection per process avoids SQLITE_BUSY between them.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './data-dir.mjs';

mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(join(DATA_DIR, 'gyro.db'));
