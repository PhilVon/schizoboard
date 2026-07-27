/**
 * @vitest-environment happy-dom
 *
 * The widget, not the verbs — `boardmenu.test.ts` covers what the rows mean.
 * What matters here is the part that has burned every context menu ever
 * written: when it closes, and which keys it is allowed to take.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextMenu, type MenuEntry, type MenuRow } from "@/ui/menu";

let host: HTMLDivElement;
let menu: ContextMenu;
/** Keys that reached a listener on `window`, the way the board's do. */
let heard: string[];

function labels(): string[] {
  return [...host.querySelectorAll(".menu-row")].map((el) => el.textContent ?? "");
}

function rows(...items: (string | MenuEntry)[]): MenuEntry[] {
  return items.map((item) =>
    typeof item === "string" ? ({ label: item, run: () => {} } as MenuRow) : item,
  );
}

/** A colour picker with three swatches, the middle one current. */
function picker(): MenuEntry {
  return {
    label: "Colour",
    choices: ["Red", "Blue", "Green"].map((label, i) => ({
      label,
      swatch: ["#a8322c", "#2c5aa8", "#4a7a4e"][i]!,
      current: i === 1,
      run: () => {},
    })),
  };
}

function key(code: string): boolean {
  const event = new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true });
  return window.dispatchEvent(event);
}

function press(target: EventTarget): void {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  menu = new ContextMenu(host);
  heard = [];
  window.addEventListener("keydown", onKey);
});

afterEach(() => {
  window.removeEventListener("keydown", onKey);
  menu.destroy();
  host.remove();
});

function onKey(e: KeyboardEvent): void {
  heard.push(e.code);
}

describe("the context menu", () => {
  it("shows its rows, and a rule above a divided one", () => {
    menu.openAt(10, 10, rows("Tuck behind", { label: "Delete", run: () => {}, divided: true }));
    expect(labels()).toEqual(["Tuck behind", "Delete"]);
    expect(host.querySelectorAll(".menu-rule")).toHaveLength(1);
    expect(menu.isOpen).toBe(true);
  });

  /** The caller decides there is no menu here by handing over nothing, and does
   *  not also have to remember not to call. */
  it("opens nothing for no rows", () => {
    menu.openAt(10, 10, []);
    expect(menu.isOpen).toBe(false);
    expect(host.children).toHaveLength(0);
  });

  it("replaces itself rather than stacking, on a second right-click", () => {
    menu.openAt(10, 10, rows("Tuck behind"));
    menu.openAt(80, 40, rows("Bring in front"));
    expect(host.querySelectorAll(".menu")).toHaveLength(1);
    expect(labels()).toEqual(["Bring in front"]);
  });

  /**
   * Closed *before* the verb runs, because a verb may delete the very strings
   * the labels were computed from — or open another menu.
   */
  it("closes before it runs the row", () => {
    const openWhenRun: boolean[] = [];
    menu.openAt(10, 10, rows({ label: "Delete", run: () => openWhenRun.push(menu.isOpen) }));
    host.querySelector<HTMLButtonElement>(".menu-item")!.click();
    expect(openWhenRun).toEqual([false]);
    expect(menu.isOpen).toBe(false);
  });

  describe("closing", () => {
    it("dismisses on a press outside, and leaves that press alone", () => {
      const board = document.createElement("div");
      document.body.append(board);
      let reached = 0;
      board.addEventListener("pointerdown", () => reached++);

      menu.openAt(10, 10, rows("Tuck behind"));
      press(board);

      expect(menu.isOpen).toBe(false);
      // Not swallowed. On a direct-manipulation surface the click that
      // dismisses a menu is nearly always also a click *at* something.
      expect(reached).toBe(1);
      board.remove();
    });

    it("stays open for a press on itself", () => {
      menu.openAt(10, 10, rows("Tuck behind"));
      press(host.querySelector(".menu-item")!);
      expect(menu.isOpen).toBe(true);
    });

    it("goes with the window's focus", () => {
      menu.openAt(10, 10, rows("Tuck behind"));
      window.dispatchEvent(new Event("blur"));
      expect(menu.isOpen).toBe(false);
    });

    it("stops listening once closed", () => {
      menu.openAt(10, 10, rows("Tuck behind"));
      menu.close();
      // Would throw or reopen something if a listener had outlived the menu.
      key("Escape");
      press(document.body);
      expect(heard).toEqual(["Escape"]);
      expect(menu.isOpen).toBe(false);
    });
  });

  describe("keys", () => {
    /**
     * The one that matters. `SelectTool.onKey` clears the selection on Escape,
     * so a menu that dismissed *and* dropped the selection it was about to act
     * on would make the escape hatch destructive.
     */
    it("takes Escape entirely — the board never hears it", () => {
      menu.openAt(10, 10, rows("Tuck behind"));
      const notCancelled = key("Escape");
      expect(menu.isOpen).toBe(false);
      expect(heard).toEqual([]);
      expect(notCancelled).toBe(false);
    });

    /** A menu that swallowed `Ctrl+Z` while it happened to be open would be a
     *  strictly worse board than one with no menu at all. */
    it("lets every other key through, and stays open", () => {
      menu.openAt(10, 10, rows("Tuck behind"));
      key("KeyZ");
      key("Digit3");
      expect(heard).toEqual(["KeyZ", "Digit3"]);
      expect(menu.isOpen).toBe(true);
    });

    it("moves the focus down and up, and wraps", () => {
      menu.openAt(10, 10, rows("Tuck behind", "Restyle", "Delete"));
      const buttons = [...host.querySelectorAll<HTMLButtonElement>(".menu-item")];
      expect(document.activeElement).toBe(buttons[0]);

      key("ArrowDown");
      expect(document.activeElement).toBe(buttons[1]);
      key("ArrowUp");
      key("ArrowUp");
      expect(document.activeElement).toBe(buttons[2]);
      key("End");
      expect(document.activeElement).toBe(buttons[2]);
      key("Home");
      expect(document.activeElement).toBe(buttons[0]);
    });

    it("dismisses on Tab rather than walking out of itself", () => {
      menu.openAt(10, 10, rows("Tuck behind"));
      key("Tab");
      expect(menu.isOpen).toBe(false);
    });
  });

  describe("pickers", () => {
    it("draws a caption and one chip per choice", () => {
      menu.openAt(10, 10, rows(picker(), "Delete"));
      expect(host.querySelector(".menu-cap")?.textContent).toBe("Colour");
      const swatches = [...host.querySelectorAll<HTMLElement>(".menu-chip .menu-swatch")];
      expect(swatches.map((el) => el.style.background)).toEqual([
        "#a8322c",
        "#2c5aa8",
        "#4a7a4e",
      ]);
    });

    /** A swatch has no text of its own, so the name has to be somewhere a
     *  screen reader can reach it. */
    it("names each chip out loud, and says which one is on", () => {
      menu.openAt(10, 10, rows(picker()));
      const chips = [...host.querySelectorAll<HTMLElement>(".menu-chip")];
      expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["Red", "Blue", "Green"]);
      expect(chips.map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
      expect(chips.filter((c) => c.classList.contains("menu-on"))).toHaveLength(1);
    });

    it("runs the chip that was clicked, and closes first", () => {
      const picked: string[] = [];
      const open: boolean[] = [];
      menu.openAt(10, 10, [
        {
          label: "Colour",
          choices: ["Red", "Blue"].map((label) => ({
            label,
            swatch: "#000000",
            run: () => {
              picked.push(label);
              open.push(menu.isOpen);
            },
          })),
        },
      ]);
      host.querySelectorAll<HTMLButtonElement>(".menu-chip")[1]!.click();
      expect(picked).toEqual(["Blue"]);
      expect(open).toEqual([false]);
    });

    /**
     * Up and down between lines, left and right within one. A single ring
     * would put Delete three presses further away for every picker above it,
     * and six for a real colour strip.
     */
    it("navigates in two axes", () => {
      menu.openAt(10, 10, rows(picker(), "Tuck behind", "Delete"));
      const chips = [...host.querySelectorAll<HTMLButtonElement>(".menu-chip")];
      const verbs = [...host.querySelectorAll<HTMLButtonElement>(".menu-row")];
      expect(document.activeElement).toBe(chips[0]);

      key("ArrowRight");
      expect(document.activeElement).toBe(chips[1]);
      // Down leaves the strip from wherever in it the focus was.
      key("ArrowDown");
      expect(document.activeElement).toBe(verbs[0]);
      key("ArrowDown");
      expect(document.activeElement).toBe(verbs[1]);
      // And wraps back to the picker's first chip.
      key("ArrowDown");
      expect(document.activeElement).toBe(chips[0]);
      // Left wraps within the strip.
      key("ArrowLeft");
      expect(document.activeElement).toBe(chips[2]);
    });

    /** A verb row is its own only item, so sideways does nothing there rather
     *  than jumping into the picker above it. */
    it("does not walk out of a verb row sideways", () => {
      menu.openAt(10, 10, rows(picker(), "Delete"));
      key("ArrowDown");
      const verb = host.querySelector<HTMLButtonElement>(".menu-row");
      expect(document.activeElement).toBe(verb);
      key("ArrowRight");
      expect(document.activeElement).toBe(verb);
    });
  });

  describe("placement", () => {
    const W = 160;
    const H = 90;

    beforeEach(() => {
      // happy-dom has no layout, so the box is stated rather than measured.
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
        width: W,
        height: H,
      } as DOMRect);
    });

    afterEach(() => vi.restoreAllMocks());

    it("sits at the cursor when there is room", () => {
      menu.openAt(100, 200, rows("Tuck behind"));
      const el = host.querySelector<HTMLElement>(".menu")!;
      expect([el.style.left, el.style.top]).toEqual(["100px", "200px"]);
    });

    /** Flipped rather than clamped: a menu shoved back inside the viewport
     *  would sit over the thing that was right-clicked. */
    it("flips back from the bottom-right corner", () => {
      menu.openAt(window.innerWidth - 5, window.innerHeight - 5, rows("Tuck behind"));
      const el = host.querySelector<HTMLElement>(".menu")!;
      expect([el.style.left, el.style.top]).toEqual([
        `${window.innerWidth - 5 - W}px`,
        `${window.innerHeight - 5 - H}px`,
      ]);
    });

    it("flips one axis at a time", () => {
      menu.openAt(window.innerWidth - 5, 100, rows("Tuck behind"));
      const el = host.querySelector<HTMLElement>(".menu")!;
      expect([el.style.left, el.style.top]).toEqual([`${window.innerWidth - 5 - W}px`, "100px"]);
    });
  });
});
