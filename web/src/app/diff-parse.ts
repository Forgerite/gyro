import { diffWordsWithSpace } from 'diff';

export type LineKind = 'ctx' | 'add' | 'del';

/** A run of text within a line; `hl` marks the words that actually changed. */
export interface Seg {
  text: string;
  hl: boolean;
}

export interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  segs: Seg[];
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

export interface ParsedDiff {
  hunks: Hunk[];
  binary: boolean;
  added: number;
  removed: number;
}

/** Word-level highlighting is skipped for very long lines; it's slow and rarely useful there. */
const WORD_DIFF_MAX = 500;

/** Parse one file's unified diff (git output) into hunks, with word-level highlights on changed pairs. */
export function parseDiff(text: string): ParsedDiff {
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;
  let binary = false;

  for (const raw of text.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      hunk = { header: raw, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (raw.startsWith('Binary files')) binary = true;
      continue; // file header (diff --git, index, ---/+++)
    }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const body = raw.slice(1);
    if (raw.startsWith('+')) {
      hunk.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, segs: [{ text: body, hl: false }] });
      added++;
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, segs: [{ text: body, hl: false }] });
      removed++;
    } else if (raw.startsWith(' ')) {
      hunk.lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, segs: [{ text: body, hl: false }] });
    }
  }
  for (const h of hunks) highlightPairs(h.lines);
  return { hunks, binary, added, removed };
}

/** Side-by-side rows: context on both sides; each block of removals paired line-by-line with the additions after it. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind === 'ctx') {
      rows.push({ left: lines[i], right: lines[i] });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

/** For each removed/added block, word-diff the lines that line up and mark what changed. */
function highlightPairs(lines: DiffLine[]) {
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== 'del') {
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i].kind === 'del') i++;
    const mid = i;
    while (i < lines.length && lines[i].kind === 'add') i++;
    const pairs = Math.min(mid - start, i - mid);
    for (let k = 0; k < pairs; k++) wordDiff(lines[start + k], lines[mid + k]);
  }
}

function wordDiff(del: DiffLine, add: DiffLine) {
  const a = del.segs[0].text;
  const b = add.segs[0].text;
  if (a.length > WORD_DIFF_MAX || b.length > WORD_DIFF_MAX) return;
  const parts = diffWordsWithSpace(a, b);
  // If almost everything changed, highlighting every word is just noise.
  const same = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.length, 0);
  if (same < Math.min(a.length, b.length) * 0.3) return;
  del.segs = parts.filter((p) => !p.added).map((p) => ({ text: p.value, hl: !!p.removed }));
  add.segs = parts.filter((p) => !p.removed).map((p) => ({ text: p.value, hl: !!p.added }));
}
