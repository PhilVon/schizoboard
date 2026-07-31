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
 * A caption and a strip of chips — one line of the menu that is a *choice*
 * rather than a verb.
 *
 * This is what stands in for a submenu, and it is a better menu than the one it
 * replaces. DESIGN section 3.4 asks for colour and thickness under *Restyle*,
 * and a nested list of six colour **words** would be the same number of clicks
 * as six swatches to reach a worse answer: nobody knows which red the red is
 * until they see it against the cork. Six swatches is one line, one glance and
 * one click.
 *
 * It also keeps the widget honest. Nesting is the part of a menu that is all
 * edge cases — hover intent, open delay, which submenu closes when the pointer
 * cuts a corner — and none of it is bought here.
 */
export interface MenuPicker {
  readonly label: string;
  readonly choices: readonly MenuChoice[];
  readonly divided?: boolean;
}

/** One chip. Exactly one of `swatch`, `weight` and `fibre` paints it; `label` is
 *  what it is called out loud in every case, because none of the three has any
 *  text of its own. */
export interface MenuChoice {
  readonly label: string;
  /** Painted as a filled square of this colour. */
  readonly swatch?: string;
  /** Painted as a horizontal bar this many pixels thick. */
  readonly weight?: number;
  /**
   * Painted as a short sample of that fibre — `lib/material.ts`'s three ids,
   * each with its own look in the stylesheet.
   *
   * A sample rather than the three words, on the same argument the colour
   * swatches make: the difference between string and yarn is a thing you
   * recognise on sight and cannot reliably picture from a noun. Unlike the
   * swatches it is a *drawing* of the material rather than the material itself,
   * because the real one is three canvas strokes and a menu chip is a 16-pixel
   * box of CSS — so the stylesheet exaggerates, which is what a sample is for.
   */
  readonly fibre?: string;
  /** Already what every target has. Marked, and still pickable — re-picking a
   *  value is a harmless way to say "yes, that one". */
  readonly current?: boolean;
  readonly run: () => void;
}

/**
 * A row that shows a different set of entries in the same box, with a way back.
 *
 * **Not a submenu**, and the difference is the whole reason this is allowed
 * where nesting was not. A submenu is a second box that opens beside the first,
 * and everything expensive about it is the relationship between the two —
 * hover intent, open delay, which one closes when the pointer cuts a corner
 * diagonally across a gap. There is one box here. It is showing a different
 * page, the way the same list would if you had scrolled it.
 *
 * It exists because the item menu grew a set of choices that are real but
 * rarely wanted (T-225, Q-168). Five picker strips flat would roughly double a
 * six-row menu with styling that the whole premise of seed-derived appearance
 * says you should never need — a menu whose choices outnumber its verbs has
 * quietly changed what it is for. One row that opens the rest keeps the verbs
 * where they were and puts the styling one press further away, which is the
 * right distance for something you use once on one note.
 *
 * `page` is a function rather than a list because the chips have to say what is
 * *currently* in force, and that is only knowable at the moment it is opened.
 */
export interface MenuPage {
  readonly label: string;
  readonly page: () => readonly MenuEntry[];
  readonly divided?: boolean;
}

export type MenuEntry = MenuRow | MenuPicker | MenuPage;

function isPicker(entry: MenuEntry): entry is MenuPicker {
  return "choices" in entry;
}

function isPage(entry: MenuEntry): entry is MenuPage {
  return "page" in entry;
}

/** What every page but the first carries at its top. Built here rather than by
 *  the caller: a page that could be entered and not left would be a trap, and
 *  it should not be possible to author one. */
const BACK = "Back";

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
  /**
   * Every clickable thing in the menu, flattened in DOM order.
   *
   * Flattened rather than kept as the tree it was built from, because the only
   * question a click ever asks is "which one" — and a chip inside a picker and
   * a plain verb row are the same answer to it. `data-run` indexes into here.
   */
  private actions: (() => void)[] = [];
  /**
   * Page turns, kept apart from `actions` for one reason: [`activate`] closes
   * the menu before it runs anything, and turning a page must not close it.
   * Two lists rather than a flag on one, so that "does this close the menu"
   * is answered by which attribute the button carries and never by a branch
   * somebody can forget.
   */
  private pages: (() => void)[] = [];
  private readonly disposers: (() => void)[] = [];
  /** Where the menu was opened, so a page turn lands in the same place. */
  private anchorX = 0;
  private anchorY = 0;
  /** The first page, so `Back` has somewhere to go. */
  private root: readonly MenuEntry[] | null = null;

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
  openAt(screenX: number, screenY: number, entries: readonly MenuEntry[]): void {
    this.close();
    if (entries.length === 0) return;
    this.anchorX = screenX;
    this.anchorY = screenY;
    this.root = entries;
    this.paint(entries);
  }

  /**
   * Draw one page of the menu, at the anchor the menu was opened on.
   *
   * Re-placed each time rather than left where it was, because a page is a
   * different height and a menu that fitted going in can run off the bottom of
   * the window coming back — and `place` flips rather than clamps, so a taller
   * page near the bottom edge lands above the cursor instead of under the
   * taskbar.
   */
  private paint(entries: readonly MenuEntry[], sub = false): void {
    this.tearDown();

    const el = document.createElement("div");
    el.className = sub ? "menu menu-sub" : "menu";
    el.setAttribute("role", "menu");
    this.actions = [];
    this.pages = [];

    if (sub) el.append(this.buildBack());

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.divided === true && i > 0) {
        const rule = document.createElement("div");
        rule.className = "menu-rule";
        el.append(rule);
      }
      if (isPicker(entry)) el.append(this.buildPicker(entry));
      else if (isPage(entry)) el.append(this.buildPage(entry));
      else el.append(this.buildRow(entry));
    }

    this.host.append(el);
    this.el = el;
    this.place(el, this.anchorX, this.anchorY);
    this.listen(el);

    // Focused so the arrows and `Enter` have somewhere to start. A `<button>`
    // rather than a div with a handler, so activation on `Enter` and `Space` is
    // the platform's and not a keymap of ours to get subtly wrong.
    el.querySelector<HTMLButtonElement>(".menu-item")?.focus();
  }

  /** The box and its listeners, without forgetting where the menu is or what
   *  its first page was — which is what a page turn needs and a close does not. */
  private tearDown(): void {
    const el = this.el;
    if (el === null) return;
    this.el = null;
    this.actions = [];
    this.pages = [];
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    el.remove();
  }

  close(): void {
    if (this.el === null) return;
    this.tearDown();
    this.root = null;
  }

  destroy(): void {
    this.close();
  }

  /**
   * A verb.
   *
   * `.menu-line` is what the arrows navigate *between* and `.menu-item` what
   * they navigate *within*, which for a plain row is the same element wearing
   * both — see `move`.
   */
  private buildRow(row: MenuRow): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `menu-line menu-item menu-row${row.danger === true ? " menu-danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.dataset.run = String(this.actions.push(row.run) - 1);
    button.textContent = row.label;
    return button;
  }

  /**
   * A row that turns the page, and the `Back` row that turns it home.
   *
   * `data-page` rather than `data-run`, which is what keeps the menu open —
   * see [`pages`]. The chevron is a `::after` in the stylesheet rather than a
   * character here, so the row's `textContent` stays the label a test asserts
   * on and a screen reader reads.
   */
  private buildPage(entry: MenuPage): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-line menu-item menu-row menu-into";
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-haspopup", "menu");
    button.textContent = entry.label;
    // Asked for on the press rather than when the menu opened, so the chips can
    // say what is in force at the moment somebody looks at them.
    button.dataset.page = String(this.pages.push(() => this.paint(entry.page(), true)) - 1);
    return button;
  }

  /** The way out of a page. Its own builder rather than a `MenuPage` with the
   *  root as its `page`, because that would put a second `Back` on the root. */
  private buildBack(): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-line menu-item menu-row menu-back";
    button.setAttribute("role", "menuitem");
    button.textContent = BACK;
    button.dataset.page = String(this.pages.push(() => this.paint(this.root ?? [])) - 1);
    return button;
  }

  /** A caption and a strip of chips. */
  private buildPicker(picker: MenuPicker): HTMLElement {
    const line = document.createElement("div");
    line.className = "menu-line menu-pick";
    line.setAttribute("role", "group");
    line.setAttribute("aria-label", picker.label);

    const caption = document.createElement("span");
    caption.className = "menu-cap";
    caption.textContent = picker.label;
    line.append(caption);

    const strip = document.createElement("div");
    strip.className = "menu-chips";
    for (const choice of picker.choices) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `menu-item menu-chip${choice.current === true ? " menu-on" : ""}`;
      chip.setAttribute("role", "menuitemradio");
      // The chip has no text of its own — it *is* the colour, or the weight —
      // so the name has to be said somewhere a screen reader can reach.
      chip.setAttribute("aria-label", choice.label);
      chip.setAttribute("aria-checked", choice.current === true ? "true" : "false");
      chip.title = choice.label;
      chip.dataset.run = String(this.actions.push(choice.run) - 1);

      const mark = document.createElement("i");
      if (choice.swatch !== undefined) {
        mark.className = "menu-swatch";
        mark.style.background = choice.swatch;
      } else if (choice.fibre !== undefined) {
        // The whole look is in the stylesheet, keyed by the material's id, so
        // that a fibre is described where the other textures on the board are
        // and not as five inline style properties assembled here.
        mark.className = `menu-fibre menu-fibre-${choice.fibre}`;
      } else {
        mark.className = "menu-bar";
        mark.style.height = `${choice.weight ?? 1}px`;
      }
      chip.append(mark);
      strip.append(chip);
    }
    line.append(strip);
    return line;
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
      const item = (e.target as HTMLElement | null)?.closest<HTMLElement>(".menu-item");
      if (item === null || item === undefined) return;
      // A page turn first, and it is not an `activate`: the menu stays open.
      const page = item.dataset.page;
      if (page !== undefined) {
        this.pages[Number(page)]?.();
        return;
      }
      const at = item.dataset.run;
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
          // Down and up step between *lines*; right and left step between the
          // chips within one. Which is what a strip of six colour swatches
          // needs to be usable from the keyboard at all - a single ring would
          // put Delete six presses further away for every picker above it.
          case "ArrowDown":
            this.move(el, 1, "line");
            break;
          case "ArrowUp":
            this.move(el, -1, "line");
            break;
          case "ArrowRight":
            this.move(el, 1, "item");
            break;
          case "ArrowLeft":
            this.move(el, -1, "item");
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
    const run = this.actions[index];
    if (run === undefined) return;
    this.close();
    run();
  }

  /**
   * Move the focus one step, along one of the two axes.
   *
   * `"line"` walks the menu top to bottom, landing on the first item of each
   * line; `"item"` walks the chips of the picker the focus is already in, and
   * on a plain verb row it does nothing, because that row is its own only item.
   * Both wrap, because a menu is a ring - `ArrowUp` on the first line is the
   * fastest way to a Delete sitting at the bottom.
   */
  private move(el: HTMLDivElement, delta: number, axis: "line" | "item"): void {
    const focused = document.activeElement as HTMLElement | null;
    const line = focused?.closest<HTMLElement>(".menu-line") ?? null;

    if (axis === "item") {
      if (line === null) return;
      const chips = [...line.querySelectorAll<HTMLButtonElement>(".menu-item")];
      const at = chips.indexOf(focused as HTMLButtonElement);
      if (chips.length === 0 || at < 0) return;
      chips[(at + delta + chips.length) % chips.length]!.focus();
      return;
    }

    // One stop per line: its first item, which for a verb row is the row.
    const stops = [...el.querySelectorAll<HTMLElement>(".menu-line")].map((l) =>
      l.classList.contains("menu-item") ? (l as HTMLButtonElement) : l.querySelector<HTMLButtonElement>(".menu-item"),
    );
    const live = stops.filter((stop): stop is HTMLButtonElement => stop !== null);
    if (live.length === 0) return;
    const at = live.findIndex((stop) => stop.closest(".menu-line") === line);
    const next = at < 0 ? (delta < 0 ? live.length - 1 : 0) : (at + delta + live.length) % live.length;
    live[next]!.focus();
  }

  private focusAt(el: HTMLDivElement, index: number): void {
    const items = [...el.querySelectorAll<HTMLButtonElement>(".menu-item")];
    if (items.length === 0) return;
    items[index < 0 ? items.length - 1 : Math.min(index, items.length - 1)]!.focus();
  }
}
