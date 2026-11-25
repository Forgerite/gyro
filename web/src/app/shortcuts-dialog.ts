import { Component, ElementRef, effect, model, viewChild } from '@angular/core';

interface Shortcut { keys: string[][]; what: string }
interface Group { title: string; items: Shortcut[] }

/** Each key combination is a list of keys; alternatives are separate combinations ("j" or "↓"). */
const GROUPS: readonly Group[] = [
  {
    title: 'Anywhere',
    items: [
      { keys: [['Ctrl', '`']], what: 'Open the terminal dock, or leave it' },
      { keys: [['Ctrl', 'Shift', '1–4']], what: 'Focus Workspaces, Details, Terminal or Preview' },
      { keys: [['?']], what: 'Show these shortcuts' },
    ],
  },
  {
    title: 'Moving around',
    items: [
      { keys: [['j'], ['↓']], what: 'Next row' },
      { keys: [['k'], ['↑']], what: 'Previous row' },
      { keys: [['Enter']], what: 'Open: into a project, resume or start a worktree\'s session, open a ticket' },
      { keys: [['u'], ['Backspace']], what: 'Back up to the project' },
      { keys: [['/']], what: 'Filter workspaces (Esc clears the filter)' },
      { keys: [['Esc']], what: 'Close the open entry, form, selection or full-view preview' },
    ],
  },
  {
    title: 'View',
    items: [
      { keys: [['a']], what: 'Only workspaces active in the last 14 days' },
      { keys: [['m']], what: 'Show main worktrees' },
      { keys: [['e']], what: 'Expand or contract the detail panel' },
      { keys: [['g']], what: 'Git tab' },
      { keys: [['p']], what: 'Pull request tab' },
    ],
  },
  {
    title: 'Actions',
    items: [
      { keys: [['n']], what: 'Start a session in an empty worktree' },
      { keys: [['c']], what: 'Open in VS Code' },
      { keys: [['Ctrl', 'Enter']], what: 'Commit from the diff, or send a ticket\'s prompt' },
    ],
  },
  {
    title: 'Diff',
    items: [
      { keys: [['j'], ['↓']], what: 'Next changed file' },
      { keys: [['k'], ['↑']], what: 'Previous changed file' },
      { keys: [['s']], what: 'Split or inline layout' },
      { keys: [['Esc']], what: 'Close the diff' },
    ],
  },
  {
    title: 'Terminal',
    items: [
      { keys: [['Ctrl', 'C']], what: 'Copy the selection (with none, interrupt)' },
      { keys: [['Ctrl', 'V'], ['Shift', 'Insert']], what: 'Paste' },
    ],
  },
  {
    title: 'Loose sessions',
    items: [
      { keys: [['Ctrl', 'click'], ['Space']], what: 'Add or remove one from the selection' },
      { keys: [['Shift', 'click']], what: 'Select a range' },
    ],
  },
  {
    title: 'Panel edges',
    items: [
      { keys: [['←'], ['→']], what: 'Resize (with Shift, in bigger steps)' },
      { keys: [['Enter']], what: 'Expand or contract the detail panel' },
      { keys: [['Home'], ['End']], what: 'Terminal and preview split: all the way either side' },
    ],
  },
];

/** Every keyboard shortcut, explained, in a modal. */
@Component({
  selector: 'app-shortcuts-dialog',
  template: `
    <dialog #dlg aria-labelledby="sc-title" (close)="open.set(false)" (click)="backdrop($event)">
      <div class="body">
      <header>
        <h2 id="sc-title">Keyboard shortcuts</h2>
        <button type="button" class="btn ghost sm" (click)="open.set(false)" aria-label="Close" title="Close (Esc)">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <p class="note">Single-key shortcuts don't fire while you're typing in a field or terminal.</p>
      <div class="groups">
        @for (g of GROUPS; track g.title) {
          <section>
            <h3 class="label">{{ g.title }}</h3>
            <dl>
              @for (s of g.items; track s.what) {
                <dt>
                  @for (combo of s.keys; track $index; let last = $last) {
                    @for (k of combo; track $index; let lastKey = $last) {
                      <kbd>{{ k }}</kbd>@if (!lastKey) {<span class="plus">+</span>}
                    }
                    @if (!last) { <span class="or">or</span> }
                  }
                </dt>
                <dd>{{ s.what }}</dd>
              }
            </dl>
          </section>
        }
      </div>
      </div>
    </dialog>
  `,
  styles: `
    :host { display: contents; }
    dialog {
      width: min(860px, calc(100vw - 48px));
      max-height: calc(100vh - 48px);
      padding: 0;
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      background: var(--ground-1);
      color: var(--ink);
      box-shadow: var(--shadow-pop);
    }
    .body { padding: var(--space-4) var(--space-5); }
    dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
    header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
    h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .note { margin: var(--space-1) 0 var(--space-4); color: var(--ink-3); font-size: 12px; }
    .groups { columns: 2 340px; column-gap: var(--space-5); }
    section { break-inside: avoid; margin-bottom: var(--space-4); }
    h3 { margin: 0 0 var(--space-2); }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px var(--space-3); margin: 0; font-size: 12px; }
    dt { display: flex; align-items: center; flex-wrap: wrap; gap: 3px; }
    dd { margin: 0; color: var(--ink-2); align-self: center; }
    .plus, .or { color: var(--ink-3); font-size: 11px; }
    .or { margin: 0 3px; }
  `,
})
export class ShortcutsDialog {
  readonly open = model(false);
  protected readonly GROUPS = GROUPS;
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const d = this.dlg().nativeElement;
      if (this.open() && !d.open) d.showModal();
      else if (!this.open() && d.open) d.close();
    });
  }

  /** A click on the dialog element itself, not its content, landed on the backdrop. */
  protected backdrop(e: MouseEvent) {
    if (e.target === this.dlg().nativeElement) this.open.set(false);
  }
}
