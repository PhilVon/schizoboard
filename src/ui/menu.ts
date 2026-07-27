/**
 * The context menu — a list of verbs at a point, and nothing else.
 *
 * > | Tuck behind | Context menu → *Tuck behind* | …
 * > | Restyle | Context menu | …
 * > | Cut | Scissors modifier, or context menu → *Delete* | …
 * > — DESIGN section 3.4
 *
 * DESIGN names a context menu in five rows across three sections and the
 * application has never had one. `state/tools/select.ts` has been standing in
 * for one of those rows with a `B` keybinding, which says in a comment that it
 * is interim; this is what retires it.
 *
 * ## It knows nothing about the board
 *
 * Rows arrive as labels and closures. That is not fastidiousness — it is what
 * lets the *policy* (which verbs a right-click on a string offers, and what
 * each one writes) live in `ui/boardmenu.ts` as a pure function of ids, with no
 * DOM in it and therefore a real test. This file is the widget: where it opens,
 * how it closes, and which keys it owns.
 *
 * ## Chrome, so the board never sees it
 *
 * It mounts in the `ui` layer, which `state/input.ts`'s `isChromeTarget`
 * already excludes from every pointer listener the board has — the tool machine
 * and navigation both ask before they act. So a press on a row cannot also
 * start a marquee underneath it, and none of that needed a new rule.
 *
 * Keys are the exception, because those listen on `window` and never had a
 * target worth filtering. An open menu owns exactly the keys it uses — Escape,
 * the arrows, Home/End, Tab — and it takes them in the capture phase so the
 * board's own listeners never run. Everything else passes straight through: a
 * menu that swallowed `Ctrl+Z` while it happened to be open would be a strictly
 * worse board than one with no menu at all.
 *
 * The one that matters is `Escape`. `SelectTool.onKey` clears the selection on
 * it, and a menu that dismissed *and* dropped the selection it was about to act
 * on would make the escape hatch destructive.
 */

/** A verb. `run` is called after the menu has closed — see `activate`. */
export interface MenuRow {
  readonly label: string;
  readonly run: () => void;
  /** Draw a rule above this row. */
  readonly divided?: boolean;
  /** Destructive; drawn in the warning colour. */
  readonly danger?: boolean;
}

/**
 * How close to the viewport edge the menu may sit, in CSS pixels.
 *
 * A menu opened near the bottom right flips back along whichever axis has run
 * out rather than being clamped flat against the edge, because a right-click
 * at 4 px from the corner is a deliberate click on the thing in the corner and
 * the menu must not cover it.
 */
const EDGE = 8;

export class ContextMenu {
  private readonly host: HTMLElement;
  private el: HTMLDivElement | null = null;
  private rows: readonly MenuRow[] = [];
  private readonly disposers: (() => void)[] = [];

  constructor(host: HTMLElement) {
    this.host = host;
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  /**
   * Open at a screen point. Opening while already open replaces the menu,
   * which is what a second right-click somewhere else means.
   *
   * An empty row list opens nothing rather than an empty box — the caller
   * decides there is no menu here by handing over nothing, and does not also
   * have to remember not to call.
   */
  openAt(screenX: number, screenY: number, rows: readonly MenuRow[]): void {
    this.close();
    if (rows.length === 0) return;

    const el = document.createElement("div");
    el.className = "menu";
    el.setAttribute("role", "menu");

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.divided === true && i > 0) {
        const rule = document.createElement("div");
        rule.className = "menu-rule";
        el.append(rule);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = row.danger === true ? "menu-row menu-danger" : "menu-row";
      button.setAttribute("role", "menuitem");
      button.dataset.row = String(i);
      button.textContent = row.label;
      el.append(button);
    }

    this.host.append(el);
    this.el = el;
    this.rows = rows;
    this.place(el, screenX, screenY);
    this.listen(el);

    // Focused so the arrows and `Enter` have somewhere to start. A `<button>`
    // rather than a div with a handler, so activation on `Enter` and `Space` is
    // the platform's and not a keymap of ours to get subtly wrong.
    el.querySelector<HTMLButtonElement>(".menu-row")?.focus();
  }

  close(): void {
    const el = this.el;
    if (el === null) return;
    this.el = null;
    this.rows = [];
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    el.remove();
  }

  destroy(): void {
    this.close();
  }

  /**
   * Place the box, having measured it.
   *
   * The measurement is a synchronous layout read, which everywhere else in this
   * application is a sin — the frame loop's whole discipline is that reads and
   * writes do not interleave (ARCHITECTURE section 3). It is fine here for the
   * reason the rule exists: this runs from a `contextmenu` listener, outside
   * the loop entirely, on a frame the user has just spent a gesture arriving
   * at. It is one read, once, per menu.
   */
  private place(el: HTMLDivElement, screenX: number, screenY: number): void {
    const box = el.getBoundingClientRect();
    const w = window.innerWidth;
    const h = window.innerHeight;

    /**
     * Flip rather than clamp: a menu shoved back inside the viewport would sit
     * over the thing that was right-clicked.
     *
     * `EDGE` governs the *free* edge only — the one away from the cursor. The
     * corner the menu is anchored by is at the cursor by definition, and a
     * right-click 5 px from the edge of the window is a deliberate click on the
     * thing 5 px from the edge of the window. Holding the anchored corner off
     * the edge as well would slide the menu away from what it is about.
     *
     * The remaining `max` is the case flipping cannot fix: a menu wider than
     * the space on the other side of the cursor, which is to say a viewport
     * barely wider than the menu.
     */
    const x = Math.max(EDGE, screenX + box.width > w - EDGE ? screenX - box.width : screenX);
    const y = Math.max(EDGE, screenY + box.height > h - EDGE ? screenY - box.height : screenY);

    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }

  private listen(el: HTMLDivElement): void {
    const add = (
      target: EventTarget,
      type: string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    add(el, "click", (e: MouseEvent) => {
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(".menu-row");
      const at = row?.dataset.row;
      if (at === undefined) return;
      this.activate(Number(at));
    });

    /**
     * A press anywhere else dismisses — and is otherwise left entirely alone.
     *
     * Not swallowed, deliberately. On a direct-manipulation surface the click
     * that dismisses a menu is nearly always also a click *at* something, and
     * making the user click twice to reach it is the behaviour of a dialog
     * rather than of a menu. The board is not modal while this is open.
     */
    add(
      window,
      "pointerdown",
      (e: PointerEvent) => {
        if (el.contains(e.target as Node)) return;
        this.close();
      },
      { capture: true },
    );

    add(
      window,
      "keydown",
      (e: KeyboardEvent) => {
        switch (e.code) {
          case "Escape":
            break;
          case "ArrowDown":
            this.move(el, 1);
            break;
          case "ArrowUp":
            this.move(el, -1);
            break;
          case "Home":
            this.focusAt(el, 0);
            break;
          case "End":
            this.focusAt(el, -1);
            break;
          case "Tab":
            break;
          default:
            // Not ours. `Ctrl+Z`, `1`-`9`, the tool keys — all of them still
            // belong to the board while a menu happens to be open.
            return;
        }
        // Escape and Tab both just dismiss; the movers have already moved.
        if (e.code === "Escape" || e.code === "Tab") this.close();
        // Capture phase, so this is what keeps `SelectTool`'s Escape — which
        // clears the selection — from also firing.
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true },
    );

    // The window losing focus takes the menu with it, exactly as `Navigation`
    // drops a held space bar for the same reason: state that survives a blur
    // is state the user comes back to and does not expect.
    add(window, "blur", () => this.close());
  }

  /**
   * Close first, then run.
   *
   * A verb may open another menu, move the selection, or delete the very
   * strings this menu's labels were computed from. Tearing the menu down before
   * any of that happens means none of those cases is a case.
   */
  private activate(index: number): void {
    const row = this.rows[index];
    if (row === undefined) return;
    this.close();
    row.run();
  }

  private move(el: HTMLDivElement, delta: number): void {
    const rows = [...el.querySelectorAll<HTMLButtonElement>(".menu-row")];
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    // Wrapping, because a menu is a ring: `ArrowUp` on the first row is the
    // fastest way to reach a Delete sitting at the bottom.
    const next = (at + delta + rows.length) % rows.length;
    rows[at < 0 && delta < 0 ? rows.length - 1 : at < 0 ? 0 : next]!.focus();
  }

  private focusAt(el: HTMLDivElement, index: number): void {
    const rows = [...el.querySelectorAll<HTMLButtonElement>(".menu-row")];
    if (rows.length === 0) return;
    rows[index < 0 ? rows.length - 1 : Math.min(index, rows.length - 1)]!.focus();
  }
}
