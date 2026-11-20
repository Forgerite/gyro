import { HttpClient } from '@angular/common/http';
import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { AgoPipe } from './ago.pipe';
import { NoxConclusion, NoxRun, NoxTicket, NoxTicketDetail, NoxTicketStatus, Workspace } from './model';

/**
 * A ticket Nox Lumos is working for the project. Where a session panel shows the conversation, this shows
 * what Lumos did: each stage run, the prompts it gave Claude and what came back, what the run concluded,
 * and the trail. It's read from the linked server, and read again whenever the tile sees the ticket move.
 */
@Component({
  selector: 'app-nox-ticket-panel',
  imports: [AgoPipe],
  template: `
    @let t = ticket();
    @let d = detail();
    @let head = d?.ticket;
    <header>
      <h2>
        <button type="button" class="link up" (click)="up.emit()" title="Back to project (u)">{{ ws().name }}</button>
        <span class="sep" aria-hidden="true">›</span>
        <span class="title">#{{ t?.number ?? head?.number }} <span class="branch">Nox Lumos ticket</span></span>
        <span class="acts">
          @if (lumosUrl(); as url) {
            <a class="act" [href]="url" target="_blank" rel="noopener" [title]="'Open on ' + ws().nox!.server.name + ' (Enter)'">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3.5h-9v-9H6" /></svg>Lumos
            </a>
          }
          @if (t?.url ?? head?.url; as url) {
            <a class="act" [href]="url" target="_blank" rel="noopener" title="Open the issue on GitHub">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3.5h-9v-9H6" /></svg>GitHub
            </a>
          }
        </span>
      </h2>
    </header>

    <section class="session" [class]="state()" aria-label="Ticket">
      <div class="band">
        <div class="s-head">
          <span class="dot" role="img" [attr.aria-label]="stateLabel()"></span>
          <h3>{{ t?.title ?? head?.title ?? 'Loading…' }}</h3>
        </div>
        <div class="meta">
          <span class="status">{{ t?.label ?? (head ? 'No longer in a Lumos stage' : stateLabel()) }}</span>
          @if (t?.updatedAt ?? head?.updatedAt; as at) { · {{ at | ago: now() }} }
        </div>
        @if (head) {
          <dl class="facts">
            <div>
              <dt><label for="nox-status">Status</label></dt>
              <dd>
                @if (board(); as b) {
                  @if (b.itemId) {
                    <select id="nox-status" class="status-pick" [disabled]="moving()"
                            (change)="move($any($event.target).value)"
                            title="Move the card on GitHub; Lumos starts the new stage's workflow, if it has one">
                      @if (!b.statusId) { <option value="" selected>No status</option> }
                      @for (o of b.options; track o.id) { <option [value]="o.id" [selected]="o.id === b.statusId">{{ o.name }}</option> }
                    </select>
                  } @else {
                    {{ head.status }} <span class="muted">· not on a GitHub Project, so it can't be moved here</span>
                  }
                } @else {
                  {{ head.status }}
                }
                @if (moving()) { <span class="muted" role="status">moving…</span> }
                @else { <span class="muted">since {{ head.since | ago: now() }}</span> }
              </dd>
            </div>
            @if (boardError(); as m) { <div><dt></dt><dd class="err" role="alert">{{ m }}</dd></div> }
            @if (head.issueType) { <div><dt>Type</dt><dd>{{ head.issueType }}</dd></div> }
            <div><dt>Queue</dt><dd>{{ queueLabel(head.queueState) }}@if (head.attempts > 1) { <span class="muted">· {{ head.attempts }} tries</span> }</dd></div>
            <div><dt>Runs</dt><dd>{{ head.runs }}</dd></div>
            <div><dt>Server</dt><dd>{{ ws().nox?.server?.name }} <span class="muted">· {{ head.repo }}</span></dd></div>
            @if (head.lastError) { <div><dt>Last error</dt><dd class="err">{{ head.lastError }}</dd></div> }
          </dl>
        }
      </div>

      @if (error(); as err) { <p class="act-err" role="alert">{{ err }}</p> }

      <div class="convo">
        @if (!d) {
          @if (!error()) { <p class="note">Reading the ticket from {{ ws().nox?.server?.name ?? 'Nox Lumos' }}…</p> }
        } @else {
          @if (head?.conclusion; as c) {
            <div class="msg concl" [class]="'msg concl ' + c.kind">
              <span class="who">lumos {{ conclusionVerb(c) }} · {{ c.at | ago: now() }}</span>
              <strong>{{ c.headline }}</strong>
              @if (c.comment) { <div class="comment">{{ comment(c.comment) }}</div> }
              @if (c.error && !c.headline.includes(c.error)) { <div class="err">{{ c.error }}</div> }
            </div>
          }

          <h4>Runs <span class="muted">· newest first</span></h4>
          @for (r of d.runs; track r.eventId; let first = $first) {
            <details class="run" [open]="first">
              <summary>
                <span class="qs" [class]="'qs ' + r.queueState">{{ queueLabel(r.queueState) }}</span>
                <span class="stage">@if (r.prompt) { prompt · {{ r.status }} } @else { @if (r.fromStatus) { {{ r.fromStatus }} → }{{ r.status }} }</span>
                <span class="headline">{{ runHeadline(r) }}</span>
                <span class="age">{{ r.updatedAt | ago: now() }}</span>
              </summary>
              <div class="run-body">
                @if (r.attempts > 1 || r.lastError) {
                  <p class="note">{{ r.attempts }} {{ r.attempts === 1 ? 'try' : 'tries' }}@if (r.lastError) { · <span class="err">{{ r.lastError }}</span> }</p>
                }
                @if (r.prompt; as p) {
                  <div class="msg user asked"><span class="who">{{ p.requestedBy }} asked lumos · {{ r.createdAt | ago: now() }}</span>{{ p.text }}</div>
                }
                @for (x of r.claude; track x.taskId + x.at) {
                  <details class="prompt">
                    <summary><span class="who inline">lumos → claude</span> {{ x.at | ago: now() }} · {{ firstLine(x.prompt) }}</summary>
                    <div class="msg user">{{ x.prompt }}</div>
                  </details>
                  @if (x.response; as resp) {
                    <div class="msg reply" [class.failed]="!resp.ok">
                      <span class="who">claude · {{ resp.ok ? 'finished' : 'failed' + (resp.exitCode !== null ? ' (exit ' + resp.exitCode + ')' : '') }} · took {{ took(x.at, resp.at) }}</span>
                      @if (resp.error) { <div class="err">{{ resp.error }}</div> }
                      {{ resp.output || '(no output)' }}
                    </div>
                  } @else {
                    <div class="msg reply pending"><span class="who">claude</span>@if (r.queueState === 'processing') { Working… } @else { No answer (the run was cut short) }</div>
                  }
                }
                @if (r.conclusion?.comment && !first) {
                  <div class="msg concl"><span class="who">lumos commented</span>{{ comment(r.conclusion!.comment!) }}</div>
                }
                @if (r.trail.length) {
                  <ol class="trail" aria-label="Trail">
                    @for (e of r.trail; track e.id) {
                      <li><span class="age">{{ e.at | ago: now() }}</span><span class="tmsg" [title]="e.type">{{ e.message }}</span></li>
                    }
                  </ol>
                }
              </div>
            </details>
          } @empty {
            <p class="note">No runs yet.</p>
          }

          @if (d.other.length) {
            <h4>Other activity</h4>
            <ol class="trail" aria-label="Other activity">
              @for (e of d.other; track e.id) {
                <li><span class="age">{{ e.at | ago: now() }}</span><span class="tmsg" [title]="e.type">{{ e.message }}</span></li>
              }
            </ol>
          }
        }
      </div>

      <form class="compose" (submit)="$event.preventDefault()" aria-label="Talk to the ticket">
        <textarea
          id="nox-compose"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)"
          (keydown.control.enter)="canSendPrompt() ? sendPrompt() : null"
          (keydown.meta.enter)="canSendPrompt() ? sendPrompt() : null"
          [disabled]="sending() !== null"
          rows="3"
          [attr.aria-label]="'Comment or prompt for #' + (t?.number ?? head?.number)"
          placeholder="Comment on the issue, or ask Lumos to do something with it…"
        ></textarea>
        <div class="compose-acts">
          <button type="button" class="cta" (click)="sendPrompt()" [disabled]="!canSendPrompt()"
                  [title]="promptTitle()">
            {{ sending() === 'prompt' ? 'Sending…' : 'Ask Lumos' }}
          </button>
          <button type="button" class="act" (click)="sendComment()" [disabled]="!draft().trim() || sending() !== null"
                  title="Post on the GitHub issue as you (gh). In Analysis and Solutioning, Lumos reads it and runs again.">
            {{ sending() === 'comment' ? 'Posting…' : 'Comment' }}
          </button>
          <span class="note hint">
            @if (sent(); as m) {
              <span role="status">@if (m.url) { <a [href]="m.url" target="_blank" rel="noopener">{{ m.text }}</a> } @else { {{ m.text }} }</span>
            } @else if (ws().nox?.server?.canPrompt === false) {
              Prompts need the key's tickets:prompt scope
            } @else {
              <kbd>Ctrl</kbd>+<kbd>↵</kbd> asks Lumos
            }
          </span>
        </div>
        @if (sendError(); as m) { <p class="act-err" role="alert">{{ m }}</p> }
      </form>
    </section>

    <footer>
      <span class="note">@if (d) { Read from {{ ws().nox?.server?.name }} {{ d.at | ago: now() }} }</span>
      <span class="spacer"></span>
      <button type="button" class="link" (click)="reload()" [disabled]="loading()">{{ loading() ? 'reading…' : 'refresh' }}</button>
    </footer>
  `,
  styleUrls: ['./worktree-panel.css', './nox-ticket-panel.css'],
})
export class NoxTicketPanel {
  readonly ws = input.required<Workspace>();
  /** The issue's node id. */
  readonly ticketId = input.required<string>();
  /** The ticket as the tile has it; null once it leaves Lumos's stages (the panel keeps what it read). */
  readonly ticket = input<NoxTicket | null>(null);
  readonly now = input.required<number>();
  readonly up = output<void>();

  private readonly http = inject(HttpClient);
  protected readonly detail = signal<NoxTicketDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(false);
  private readonly bump = signal(0);
  private readonly boardBump = signal(0);
  /** Each snapshot brings new objects: key the re-read on what changes when Lumos moves the ticket. */
  private readonly path = computed(() => this.ws().path);
  private readonly ticketKey = computed(() => {
    const t = this.ticket();
    return t ? `${t.updatedAt}|${t.status}|${t.queueState}|${t.label}` : null;
  });

  protected readonly state = computed(() => this.ticket()?.state ?? 'none');
  protected readonly stateLabel = computed(() => {
    const s = this.ticket()?.state;
    return s === 'busy' ? 'Lumos is on it' : s === 'waiting' ? 'Lumos is paused' : 'Not in a Lumos stage';
  });
  /** The ticket on its server's board page. */
  protected readonly lumosUrl = computed(() => {
    const n = this.ws().nox;
    return n ? `${n.server.url}/board?ticket=${encodeURIComponent(this.ticketId())}` : null;
  });

  /** The card on its GitHub Project, to move between Status columns; null until read. */
  protected readonly board = signal<NoxTicketStatus | null>(null);
  protected readonly boardError = signal<string | null>(null);
  protected readonly moving = signal(false);

  protected readonly draft = signal('');
  protected readonly sending = signal<'prompt' | 'comment' | null>(null);
  protected readonly sendError = signal<string | null>(null);
  /** What the last send did, with a link where there is one. */
  protected readonly sent = signal<{ text: string; url?: string | null } | null>(null);
  protected readonly canSendPrompt = computed(
    () => !!this.draft().trim() && this.sending() === null && this.ws().nox?.server?.canPrompt !== false,
  );
  protected readonly promptTitle = computed(() =>
    this.ws().nox?.server?.canPrompt === false
      ? `The API key for ${this.ws().nox?.server?.name} lacks the tickets:prompt scope`
      : 'Lumos runs Claude on this with the ticket, its thread, the stage\'s instructions and its PR branch, then answers on the issue. It can push code. (Ctrl+Enter)',
  );

  constructor() {
    // A different ticket clears the panel; the same one just re-reads in place.
    effect(() => {
      this.ticketId();
      untracked(() => {
        this.detail.set(null);
        this.error.set(null);
        this.board.set(null);
        this.boardError.set(null);
        this.draft.set('');
        this.sent.set(null);
        this.sendError.set(null);
      });
    });
    // The card's board and columns, from GitHub: once per ticket, and again after a move.
    effect((onCleanup) => {
      const path = this.path();
      const id = this.ticketId();
      this.boardBump();
      const status = untracked(() => this.ticket()?.status ?? '');
      const sub = this.http.get<NoxTicketStatus>('/api/nox/ticket/status', { params: { path, id, status } }).subscribe({
        next: (b) => {
          this.board.set(b);
          this.boardError.set(null);
        },
        error: (e) => this.boardError.set(`Can't move it from here: ${e.error?.error ?? e.message}`),
      });
      onCleanup(() => sub.unsubscribe());
    });
    // Read again whenever the tile sees the ticket change (the board is polled every 15 s), or on refresh.
    effect((onCleanup) => {
      const path = this.path();
      const id = this.ticketId();
      this.ticketKey();
      this.bump();
      untracked(() => this.loading.set(true));
      const sub = this.http.get<NoxTicketDetail>('/api/nox/ticket', { params: { path, id } }).subscribe({
        next: (d) => {
          this.loading.set(false);
          this.error.set(null);
          this.detail.set(d);
        },
        error: (e) => {
          this.loading.set(false);
          this.error.set(e.error?.error ?? e.message);
        },
      });
      onCleanup(() => sub.unsubscribe());
    });
  }

  reload() {
    this.bump.update((n) => n + 1);
  }

  /** Move the card to another Status column on GitHub; Lumos sees the move and runs that stage. */
  protected move(optionId: string) {
    const b = this.board();
    if (!b || !optionId || optionId === b.statusId || this.moving()) return;
    const from = b.options.find((o) => o.id === b.statusId)?.name ?? null;
    this.board.set({ ...b, statusId: optionId }); // show it moved; undone if GitHub refuses
    this.moving.set(true);
    this.boardError.set(null);
    this.http.post<NoxTicketStatus>('/api/nox/ticket/move', { path: this.path(), id: this.ticketId(), status: optionId, from }).subscribe({
      next: (moved) => {
        this.moving.set(false);
        this.board.set(moved);
        // Lumos hears of it by webhook; its board catches up on the next poll, so read the ticket again soon.
        setTimeout(() => this.reload(), 4000);
      },
      error: (e) => {
        this.moving.set(false);
        this.board.set(b);
        this.boardError.set(e.error?.error ?? e.message);
      },
    });
  }

  protected sendPrompt() {
    const text = this.draft().trim();
    if (!text || this.sending()) return;
    this.send('prompt', '/api/nox/ticket/prompt', { prompt: text }, () => ({
      text: 'Queued for Lumos: it will answer on the issue',
    }));
  }

  protected sendComment() {
    const text = this.draft().trim();
    if (!text || this.sending()) return;
    this.send('comment', '/api/nox/ticket/comment', { body: text }, (r: { url?: string | null }) => ({
      text: 'Commented on GitHub', url: r.url,
    }));
  }

  private send<R>(kind: 'prompt' | 'comment', url: string, body: object, done: (r: R) => { text: string; url?: string | null }) {
    this.sending.set(kind);
    this.sendError.set(null);
    this.sent.set(null);
    this.http.post<R>(url, { path: this.path(), id: this.ticketId(), ...body }).subscribe({
      next: (r) => {
        this.sending.set(null);
        this.draft.set('');
        this.sent.set(done(r));
        this.reload();
      },
      error: (e) => {
        this.sending.set(null);
        this.sendError.set(e.error?.error ?? e.message);
      },
    });
  }

  /** Enter on the tile: the ticket on its Lumos server. */
  openInLumos() {
    const url = this.lumosUrl();
    if (url) window.open(url, '_blank', 'noopener');
  }

  protected queueLabel(q: NoxRun['queueState']) {
    return { pending: 'queued', processing: 'running', done: 'done', dead: 'gave up' }[q];
  }

  protected conclusionVerb(c: NoxConclusion) {
    return { advance: 'moved it on', comment: 'commented', noop: 'did nothing', failed: 'failed', skipped: 'skipped it' }[c.kind];
  }

  protected runHeadline(r: NoxRun) {
    if (r.conclusion) return r.conclusion.headline;
    if (r.queueState === 'processing') return 'Lumos is working';
    if (r.queueState === 'pending') return r.attempts > 0 ? 'Queued to retry' : 'Queued';
    if (r.queueState === 'dead') return r.lastError ?? 'Gave up';
    return '';
  }

  /** A posted comment without the hidden marker Lumos tags its comments with. */
  protected comment(s: string) {
    return s.replace(/<!--[\s\S]*?-->\s*/g, '').trim();
  }

  protected firstLine(s: string) {
    const line = s.split('\n').find((l) => l.trim()) ?? '';
    return line.length > 90 ? line.slice(0, 90) + '…' : line;
  }

  protected took(from: number, to: number) {
    const s = Math.max(0, Math.round((to - from) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
}
