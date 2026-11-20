import { HttpClient } from '@angular/common/http';
import { Service, inject, signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';
import { DashboardService } from './dashboard.service';
import { NoxServer } from './model';

/** The Nox Lumos servers added to Gyro, shared by the servers panel and each project's server picker. */
@Service()
export class NoxService {
  private readonly http = inject(HttpClient);
  private readonly api = inject(DashboardService);

  /** null until first loaded. */
  readonly servers = signal<NoxServer[] | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** The servers panel is open in the detail area. */
  readonly managing = signal(false);

  /** Load the list; `check` re-tests every key against its server first. */
  load(check = false): void {
    this.loading.set(true);
    this.http.get<{ servers: NoxServer[] }>('/api/nox/servers', { params: check ? { check: 1 } : {} }).subscribe({
      next: ({ servers }) => {
        this.loading.set(false);
        this.error.set(null);
        this.servers.set(servers);
      },
      error: (e) => {
        this.loading.set(false);
        this.error.set(e.error?.error ?? e.message);
      },
    });
  }

  /** Add (no id) or change a server; an empty key keeps the saved one. Emits the saved server's id. */
  save(body: { id?: string; name: string; url: string; key: string }): Observable<string> {
    return this.http.post<{ servers: NoxServer[]; id: string }>('/api/nox/servers', body).pipe(
      tap(({ servers }) => {
        this.servers.set(servers);
        this.api.refresh(); // projects whose repo it runs get linked, and their tiles show its tickets
      }),
      map(({ id }) => id),
    );
  }

  /** Remove a server; the projects linked to it lose their link. */
  remove(id: string): Observable<void> {
    return this.http.post<{ servers: NoxServer[] }>('/api/nox/servers/remove', { id }).pipe(
      tap(({ servers }) => {
        this.servers.set(servers);
        this.api.refresh(); // the tiles drop the removed server's tickets
      }),
      map(() => undefined),
    );
  }
}
