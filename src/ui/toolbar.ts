/**
 * The tool drawer — a rail of the seven tools, down the left edge.
 *
 * Every tool on this board was reachable only from the keyboard until this
 * existed, and `state/tools/note.ts` said so on purpose: "nothing on screen says
 * which tool is active. There is no toolbar, no cursor change, no indicator of
 * any kind — and there should not be one." That held while the board was being
 * built by the person who wrote the key map. It stops holding the moment
 * somebody else has to find their way in, and D-44 is where it was decided
 * (with Phil, before any of this was planned).
 *
 * ## What it is, and what it deliberately is not
 *
 * The seven tools of DESIGN section 3.9's `Tools` line and nothing else — not
 * the pens' colours and sizes, which the context menu and the bracket keys
 * already own, and not undo, fit or actual size, which are history and camera
 * rather than tools. A drawer that held all three would stop being a statement
 * about what is in your hand.
 *
 * Each button is a glyph with **its key letter under it**, which is the whole
 * argument for the rail: it teaches the keyboard while you use the mouse, and
 * the tools were keyboard-only until now. So a person who finds the drawer
 * finds the shortcuts, rather than finding an alternative to them.
 *
 * The handle at the foot is the **only** toggle. No new binding, so nothing has
 * to be added to DESIGN section 3.9 — and this codebase has already deleted a
 * shortcut (`KeyB`, `state/tools/machine.ts`) for the sin of not being in that
 * table.
 *
 * ## It reports, it does not decide
 *
 * A click calls `pick` with a tool id and touches no tool state at all. That is
 * not tidiness: switching tools cancels the outgoing gesture and therefore
 * touches the scene, so the caller has to queue it to the phase where that is
 * legal (`app/main.ts`) — exactly as it already queues a keystroke. A rail that
 * called `setTool` itself would be doing it from a DOM event listener, which is
 * the one place it must not happen.
 *
 * ## Not in the tab order
 *
 * Every button is `tabindex="-1"` and swallows its own `mousedown`, so a click
 * never leaves one focused. A focused button eats `Space`, which is the pan, and
 * `Delete`, which is the erase — and nothing is lost, because every tool here
 * has a letter and the letter is printed on the button.
 */

/** One tool as the rail presents it. The glyph is markup, not an element. */
export interface RailTool {
  /** The tool's own `Tool.id`. */
  readonly id: string;
  /** Its letter in DESIGN section 3.9 — printed on the button and, with `Key`
   *  in front of it, the `KeyboardEvent.code` that picks it. */
  readonly key: string;
  readonly label: string;
  readonly glyph: string;
}

/*
 * The glyphs, one named const each, so that changing the pin means grepping for
 * `GLYPH_PIN` rather than counting entries in a builder. All seven are drawn in
 * one 24-unit box against `currentColor`, stroked rather than filled except
 * where a solid shape is the thing being drawn — a pin's head is a bead and a
 * cursor is an arrow, and neither of those is an outline.
 */

/** The arrow. The one glyph that is a picture of the pointer rather than of a
 *  tool, because select is what the pointer does when it is not a tool. */
const GLYPH_SELECT = '<path d="M6 3.6 6 18.2 9.9 14.5 12.5 20.6 15.1 19.4 12.6 13.5 17.8 13.2Z" fill="currentColor" stroke="none"/>';

/** Head, shaft, point — DESIGN section 4.5's pushpin, seen from the side. */
const GLYPH_PIN =
  '<circle cx="12" cy="7.4" r="3.7" fill="currentColor" stroke="none"/>' +
  '<path d="M12 11.1 12 20.6"/>';

/** Two pins and the sag between them. Drawn with drape in it because a taut
 *  chord is the one thing a string on this board is usually not. */
const GLYPH_STRING =
  '<circle cx="4.8" cy="6.6" r="1.8" fill="currentColor" stroke="none"/>' +
  '<circle cx="19.2" cy="6.6" r="1.8" fill="currentColor" stroke="none"/>' +
  '<path d="M4.8 6.6C8.2 20 15.8 20 19.2 6.6"/>';

/** A sheet with its corner turned. */
const GLYPH_NOTE = '<path d="M5.6 4.4h8.6l4.2 4.2v11H5.6Z"/><path d="M14.2 4.4v4.2h4.2"/>';

/** A pen on the diagonal, nib toward the bottom left, with the ferrule across
 *  it — which is the line that stops it reading as a leaf. */
const GLYPH_MARKER =
  '<path d="M4.6 19.4 5.6 15.8 15.2 6.2a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4L8.6 18.8Z"/>' +
  '<path d="M13.8 7.6 16.8 10.6"/>';

/** The chisel tip, and the broad wet line it has just laid down. The line is
 *  what separates this from the marker at 18 pixels; the nib alone did not. */
const GLYPH_HIGHLIGHTER =
  '<path d="M7.4 14.8 14 8.2l3.3 3.3-6.6 6.6-4 .8Z"/>' +
  '<path d="M4.6 20.6h14.8" stroke-width="2.4"/>';

/** A rubber on its edge, on the line it is taking a mark off. */
const GLYPH_ERASER =
  '<path d="M8.6 17.7 5.8 14.9a1.4 1.4 0 0 1 0-2l6.9-6.9a1.4 1.4 0 0 1 2 0l3.8 3.8a1.4 1.4 0 0 1 0 2l-5.7 5.7Z"/>' +
  '<path d="M9.9 9.5 15.7 15.3"/>' +
  '<path d="M6.6 20.6h11.4"/>';

/**
 * The seven, in DESIGN section 3.9's order: V P S N M H E.
 *
 * Exported because it is the *only* list of them. `app/main.ts` pairs these ids
 * with the tool instances and derives each key's `KeyboardEvent.code` from
 * `key`, so the rail and the keyboard cannot come to disagree about which
 * letter belongs to which tool — which is what two hand-maintained lists would
 * eventually do.
 *
 * The `Shift+E` smudge is absent, and that is deliberate rather than an
 * oversight: D-44 settled the drawer as the seven of the `Tools` line, and a
 * modifier variant of the eraser is a row of the pen's own menu.
 */
export const RAIL: readonly RailTool[] = [
  { id: "select", key: "V", label: "Select", glyph: GLYPH_SELECT },
  { id: "pin", key: "P", label: "Pin", glyph: GLYPH_PIN },
  { id: "string", key: "S", label: "String", glyph: GLYPH_STRING },
  { id: "note", key: "N", label: "Note", glyph: GLYPH_NOTE },
  { id: "marker", key: "M", label: "Marker", glyph: GLYPH_MARKER },
  { id: "highlighter", key: "H", label: "Highlighter", glyph: GLYPH_HIGHLIGHTER },
  { id: "eraser", key: "E", label: "Eraser", glyph: GLYPH_ERASER },
];

export interface ToolbarOptions {
  /** A tool was asked for. The id is one of [`RAIL`]'s. */
  pick(id: string): void;
  /**
   * The handle was used. The caller persists it — `app/prefs.ts`, because it is
   * a fact about this machine rather than about the board.
   *
   * The panel does not read or write the preference itself: `ui/` imports
   * nothing from `app/` (ARCHITECTURE section 2), and this is the seam that
   * keeps it that way.
   */
  toggled?(open: boolean): void;
  /** Whether the drawer starts open. Default true — see [`ToolbarOptions.toggled`];
   *  the preference is the caller's to read. */
  open?: boolean;
}

export class Toolbar {
  private readonly options: ToolbarOptions;
  private readonly el: HTMLDivElement;
  private readonly tools: HTMLDivElement;
  private readonly handle: HTMLButtonElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  /** What is on screen, so a rail whose tool has not changed writes no DOM.
   *  Null is "nothing written yet", which is not the same as no tool active. */
  private written: string | null = null;
  private isOpen: boolean;
  private readonly disposers: (() => void)[] = [];

  constructor(host: HTMLElement, options: ToolbarOptions) {
    this.options = options;
    this.isOpen = options.open ?? true;

    this.el = document.createElement("div");
    this.el.className = "toolbar";
    // A group rather than a `toolbar` role: the buttons are seven states of one
    // setting, and `aria-pressed` on each is how that reads out.
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", "tools");

    this.tools = document.createElement("div");
    this.tools.className = "toolbar-tools";
    for (const tool of RAIL) {
      const button = this.button(tool);
      this.buttons.set(tool.id, button);
      this.tools.append(button);
    }

    this.handle = document.createElement("button");
    this.handle.className = "toolbar-handle";
    this.handle.type = "button";
    this.handle.tabIndex = -1;
    this.handle.setAttribute("aria-label", "tools");
    this.inert(this.handle);
    this.handle.addEventListener("click", () => {
      this.setOpen(!this.isOpen);
      options.toggled?.(this.isOpen);
    });

    this.el.append(this.tools, this.handle);
    this.paintOpen();
    host.append(this.el);
  }

  /**
   * One button: the glyph over the letter.
   *
   * `innerHTML` for the glyph and only for the glyph. The markup is this
   * module's own constants and never a caller's, and an inline `<svg>` built
   * element by element needs `createElementNS` at every node — which is four
   * lines per path to say what one string already says legibly.
   */
  private button(tool: RailTool): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "toolbar-btn";
    button.type = "button";
    button.tabIndex = -1;
    button.setAttribute("aria-label", `${tool.label} (${tool.key})`);
    button.setAttribute("aria-pressed", "false");
    button.innerHTML =
      '<svg class="toolbar-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
      `stroke-linejoin="round">${tool.glyph}</svg>` +
      `<span class="toolbar-key">${tool.key}</span>`;
    this.inert(button);
    // Reports, never decides — see this module's header.
    button.addEventListener("click", () => this.pick(tool.id));
    return button;
  }

  /**
   * Keep the press off the button.
   *
   * `mousedown` rather than `pointerdown`, because focus is what is being
   * refused and focus follows the mouse event. The button still gets its
   * `click`; what it does not get is the caret. A focused rail would eat the
   * space bar, which is the pan.
   */
  private inert(button: HTMLButtonElement): void {
    const onDown = (e: MouseEvent): void => e.preventDefault();
    button.addEventListener("mousedown", onDown);
    this.disposers.push(() => button.removeEventListener("mousedown", onDown));
  }

  private pick(id: string): void {
    this.options.pick(id);
  }

  /**
   * Which tool is in hand — called from the OVERLAY phase, where the rest of
   * the chrome repaints.
   *
   * An id the rail does not have (the `Shift+E` smudge is the only one) turns
   * every button off, which is the honest picture: none of the seven is what
   * you are holding.
   */
  sync(active: string): void {
    if (active === this.written) return;
    this.written = active;
    for (const [id, button] of this.buttons) {
      const on = id === active;
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** Open or shut without going through the handle — the caller's stored
   *  preference arriving after construction. Silent when nothing changes. */
  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    this.isOpen = open;
    this.paintOpen();
  }

  /**
   * Closed, the seven go and the handle stays — so what stands over the cork is
   * as small as the affordance can be.
   *
   * `hidden` and nothing else. `base.css` may not animate (ARCHITECTURE section
   * 3: the frame loop owns all motion), which is why `.hud` and `.tuning`
   * collapse the same instant way.
   */
  private paintOpen(): void {
    this.tools.hidden = !this.isOpen;
    this.el.classList.toggle("is-shut", !this.isOpen);
    this.handle.setAttribute("aria-expanded", this.isOpen ? "true" : "false");
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.el.remove();
  }
}
