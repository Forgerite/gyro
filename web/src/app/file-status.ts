import { ChangedFile } from './model';

const TITLES: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict' };
const CLASSES: Record<string, string> = { M: 'mod', A: 'new', D: 'del', R: 'mod', C: 'mod', U: 'del' };

/** One-letter status, a color class and a tooltip for a changed file (working tree or commit). */
export function fileStatus(f: ChangedFile) {
  if (f.x === '?') return { letter: 'N', cls: 'new', title: 'Untracked (new file)' };
  const c = f.x !== ' ' ? f.x : f.y;
  return { letter: c, cls: CLASSES[c] ?? 'mod', title: TITLES[c] ?? c };
}

export function dirOf(p: string) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
}

export function baseOf(p: string) {
  return p.slice(p.lastIndexOf('/') + 1);
}
