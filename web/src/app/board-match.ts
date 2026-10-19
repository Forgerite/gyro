import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { Signal, computed, effect, inject, untracked } from '@angular/core';
import { DashboardService } from './dashboard.service';
import { Board, BoardItem, Workspace } from './model';

/**
 * The branch working on a board entry: a PR entry's own branch, or the branch of an open PR that
 * closes the entry's issue. Only for entries from the project's own repo; null otherwise.
 */
export function branchFor(it: BoardItem, ws: Workspace): string | null {
  const repo = ws.github?.repo.toLowerCase();
  if (!repo || it.repo?.toLowerCase() !== repo) return null;
  if (it.kind === 'pr') return it.branch;
  if (it.kind === 'issue' && it.number !== null) {
    return ws.pulls?.list.find((p) => p.closes.includes(it.number!))?.branch ?? null;
  }
  return null;
}

/**
 * The linked GitHub Project's board for `ws`, as a resource. `fresh` bumps skip the server's cache.
 * Keyed on plain strings, so a new snapshot (a new ws object) doesn't refetch it. Call in an injection context.
 */
export function boardResource(ws: Signal<Workspace>, fresh?: Signal<number>) {
  const api = inject(DashboardService);
  const path = computed(() => ws().path);
  const project = computed(() => {
    const p = ws().github?.project;
    return p ? `${p.owner}/${p.number}` : null;
  });
  const board = httpResource<Board>(() => {
    const key = project();
    if (!key) return undefined;
    const t = fresh?.() ?? 0;
    return { url: '/api/github/board', params: { path: path(), project: key, ...(t ? { fresh: '1', t } : {}) } };
  });
  // An entry moved: reload in place (keeps the board on screen, unlike new params would).
  let seen = api.boardTick();
  effect(() => {
    const tick = api.boardTick();
    if (tick !== seen) untracked(() => board.reload());
    seen = tick;
  });
  const error = computed(() => {
    const e = board.error();
    if (!e) return null;
    return e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e);
  });
  return { board, error };
}
