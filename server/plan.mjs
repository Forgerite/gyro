// The plan evaluator: a work session's step checklist, recomputed from reality (git status
// from the scanner, the open-PR cache, the stored PR's last known state) on every snapshot.
// Nothing here is stored — manual git simply checks rows off, and a base that moves after
// Ship un-does `sync`, regresses the stage and closes the Land gate.
import { WORK_STEPS } from './work.mjs';

const label = (key) => WORK_STEPS.find((s) => s.key === key)?.label ?? key;

/**
 * @param wt        worktree from the snapshot (git has dirty/unmerged/baseRef/behindBase/upstream; pr is the open PR or null)
 * @param session   the shaped work_sessions row
 * @param prState   last known state of the stored PR when it isn't in the open list ({state, notMergeable, ...} or null)
 * @param macro     the latest macro run (running macros make the stage `landing`)
 */
export function evaluatePlan({ wt, session, prState, macro }) {
  const git = wt.git ?? {};
  if (git.missing) return null;
  const openPr = wt.pr ?? null;
  const merged = prState?.state === 'MERGED';
  const behind = git.behindBase; // null: base ref didn't resolve
  const steps = [];
  const put = (key, status, detail = null) => steps.push({ key, label: label(key), status, detail });

  // A blocked step waits on something abnormal (worth the badge), unlike a prerequisite block.
  const abnormal = [];
  const hasCommits = (git.unmerged ?? 0) > 0;

  // A clean tree only counts as committed once there's a commit beyond base; untouched is "nothing yet".
  if (git.dirty) put('commit', 'pending', `${git.dirty} uncommitted file${git.dirty === 1 ? '' : 's'}`);
  else if (hasCommits) put('commit', 'done');
  else put('commit', 'blocked', 'no changes yet');

  // Done while on top of base; pending (rebase runnable) only once base has moved ahead.
  if (behind === null) { put('sync', 'blocked', `base ${session.base} not found (deleted or renamed?)`); abnormal.push('sync'); }
  else if (behind > 0) put('sync', 'pending', `${behind} commit${behind === 1 ? '' : 's'} behind ${git.baseRef ?? session.base}`);
  else put('sync', 'done', `up to date with ${git.baseRef ?? session.base}`);

  const up = git.upstream;
  if (up?.exists && up.ahead > 0 && up.behind > 0) { put('push', 'blocked', 'diverged from upstream; resolve in the Git tab'); abnormal.push('push'); }
  else if (up?.exists && up.ahead === 0) put('push', 'done');
  else if (!up?.exists && !hasCommits) put('push', 'blocked', git.dirty ? 'commit your changes first' : 'nothing to publish yet');
  else put('push', 'pending', up?.ahead ? `${up.ahead} commit${up.ahead === 1 ? '' : 's'} to push` : 'branch not published yet');

  const pushed = steps.find((s) => s.key === 'push').status === 'done';
  if (openPr || merged) put('pr', 'done', openPr ? `PR #${openPr.number}` : `PR #${session.pr} merged`);
  else if (!hasCommits) put('pr', 'blocked', 'no commits to open a PR for yet');
  else if (!pushed) put('pr', 'blocked', 'publish the branch first');
  else if (session.pr && prState?.state === 'CLOSED') { put('pr', 'pending', `PR #${session.pr} was closed without merging`); abnormal.push('pr'); }
  else put('pr', 'pending', null);

  // The Land gate: strictly up to date with base AND the PR is clean. Open-PR facts come from
  // the pulls cache (2 minutes; 15 s while checks run); the merge step itself re-checks fresh before acting.
  if (merged) put('merge', 'done', `PR #${session.pr ?? openPr?.number} merged`);
  else if (!openPr) put('merge', 'blocked', 'no open PR');
  else {
    const earlier = steps.every((s) => s.status === 'done' || s.status === 'skipped');
    const why = !earlier ? 'finish the steps above first'
      : behind !== 0 ? `behind ${git.baseRef ?? session.base}; ship again to rebase`
      : openPr.draft ? `PR #${openPr.number} is a draft`
      : openPr.checks === 'fail' ? `checks are failing on PR #${openPr.number}`
      : openPr.checks === 'pending' || openPr.checksRunning ? `checks are still running on PR #${openPr.number}`
      : openPr.review === 'CHANGES_REQUESTED' || openPr.review === 'REVIEW_REQUIRED' ? `PR #${openPr.number} needs review`
      : null;
    put('merge', why ? 'blocked' : 'pending', why);
  }

  const over = session.status === 'done';
  put('teardown', over ? 'done' : merged ? 'pending' : 'blocked', over || merged ? null : 'merge the PR first');
  put('archive', over ? 'done' : merged ? 'pending' : 'blocked', over || merged ? null : 'merge the PR first');

  const done = (key) => steps.find((s) => s.key === key)?.status === 'done';
  // Ship's steps (everything before merge) unfinished — also when base moved after Ship: re-ship.
  const shipLeft = steps.some((s) => s.key !== 'merge' && s.key !== 'teardown' && s.key !== 'archive' && s.status !== 'done' && s.status !== 'skipped');
  const stage = over ? 'done'
    : macro?.status === 'running' && macro.macro === 'land' ? 'landing'
    : merged ? 'ready-to-land'
    : !done('pr') && git.dirty === 0 && git.unmerged === 0 ? 'setup'
    : !done('commit') ? 'working'
    : shipLeft ? 'ready-to-ship'
    : steps.find((s) => s.key === 'merge')?.status === 'pending' ? 'ready-to-land'
    : 'in-review';

  const badges = [];
  // Abnormal blocks only; waiting on a prerequisite (or on checks/review) is the normal life of a step.
  if (abnormal.length) badges.push('blocked');
  // Why the badge is there: a dead end needing a human, not a step whose turn hasn't come.
  const blockedReason = abnormal.length ? steps.find((s) => s.key === abnormal[0])?.detail ?? null : null;

  return { steps, stage, badges, blockedReason };
}
