// Where Gyro keeps its own files: ~/.claude/gyro (state, SQLite, recordings) and ~/.claude/gyro-archive
// (archived sessions). Gyro used to be called ccdb; the first start after the rename moves the old
// ~/.claude/ccdb* folders over, or copies them when an older instance still has them open.
import { cpSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_DIR = join(homedir(), '.claude');

export const DATA_DIR = join(CLAUDE_DIR, 'gyro');
export const ARCHIVE_DIR = join(CLAUDE_DIR, 'gyro-archive');

const MOVES = [
  [join(CLAUDE_DIR, 'ccdb'), DATA_DIR],
  [join(CLAUDE_DIR, 'ccdb-archive'), ARCHIVE_DIR],
  [join(DATA_DIR, 'ccdb.db'), join(DATA_DIR, 'gyro.db')],
];
for (const [from, to] of MOVES) {
  if (existsSync(to) || !existsSync(from)) continue;
  try {
    renameSync(from, to);
  } catch {
    try {
      cpSync(from, to, { recursive: true });
    } catch (e) {
      console.warn(`Couldn't bring ${from} over to ${to}: ${e.message}`);
    }
  }
}
