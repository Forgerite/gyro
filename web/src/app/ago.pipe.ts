import { Pipe, PipeTransform } from '@angular/core';

/** Compact relative time: "now", "4m", "3h", "2d", "5w". Pass `now` so it re-evaluates on poll. */
@Pipe({ name: 'ago' })
export class AgoPipe implements PipeTransform {
  transform(ts: number | null | undefined, now: number): string {
    if (!ts) return '—';
    const s = Math.max(0, (now - ts) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
    return `${Math.floor(s / 604800)}w`;
  }
}
