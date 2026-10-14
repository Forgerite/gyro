import { GraphCommit } from './model';

/** A line within one row, in lane units horizontally; y is 0 (top), 0.5 (node) or 1 (bottom). */
export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lane: number;
  /** The commit whose parent link this line draws (lets callers style e.g. the uncommitted lane). */
  origin: string;
}

export interface GraphRow {
  commit: GraphCommit;
  /** Lane the commit's node sits in. */
  col: number;
  segs: Seg[];
}

interface Lane {
  /** Hash this line is heading towards. */
  target: string;
  /** Child commit that started the line. */
  origin: string;
}

/**
 * Classic lane assignment over commits in topo order (children before parents).
 * Each lane heads towards a hash; a commit takes the lane that was waiting for it, its first parent
 * inherits that lane, and further parents (merges) get existing or free lanes. Lanes never move
 * sideways, so pass-through lines stay straight.
 */
export function layoutGraph(commits: GraphCommit[]): { rows: GraphRow[]; width: number } {
  let lanes: (Lane | null)[] = [];
  let width = 1;
  const rows = commits.map((commit) => {
    const before = lanes;
    const after = before.slice();
    let col = before.findIndex((l) => l?.target === commit.h);
    if (col < 0) {
      col = before.indexOf(null);
      if (col < 0) col = before.length;
    }
    while (after.length <= col) after.push(null);

    const segs: Seg[] = [];
    before.forEach((l, i) => {
      if (!l) return;
      if (l.target === commit.h) {
        segs.push({ x1: i, y1: 0, x2: col, y2: 0.5, lane: i, origin: l.origin }); // child lines converge here
        after[i] = null;
      } else {
        segs.push({ x1: i, y1: 0, x2: i, y2: 1, lane: i, origin: l.origin }); // unrelated line passes through
      }
    });

    commit.parents.forEach((p, k) => {
      let j = after.findIndex((l) => l?.target === p);
      if (j < 0) {
        j = k === 0 ? col : after.indexOf(null);
        if (j < 0) j = after.length;
        after[j] = { target: p, origin: commit.h };
      }
      segs.push({ x1: col, y1: 0.5, x2: j, y2: 1, lane: j, origin: commit.h });
    });

    while (after.length && after[after.length - 1] === null) after.pop();
    lanes = after;
    width = Math.max(width, before.length, after.length, col + 1);
    return { commit, col, segs };
  });
  return { rows, width };
}
