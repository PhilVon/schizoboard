/**
 * @vitest-environment happy-dom
 *
 * The rail: that all seven are there in the keyboard's order, that a click
 * reports rather than decides, that the active button follows `sync` and costs
 * nothing when it has not changed, that the handle leaves itself behind, and —
 * the one that is not cosmetic — that pressing a button never focuses it.
 *
 * That last one is the reason for half of this file. A focused button eats the
 * space bar, which is the pan, and `Delete`, which is the erase; and a swallowed
 * key looks exactly like a feature that has quietly stopped working, which is a
 * failure this board has paid for twice already.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { RAIL, Toolbar } from "@/ui/toolbar";

let host: HTMLElement;
let picked: string[];

function build(open?: boolean): Toolbar {
  return new Toolbar(host, { pick: (id) => picked.push(id), ...(open === undefined ? {} : { open }) });
}

function buttons(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>(".toolbar-btn")];
}

function handle(): HTMLButtonElement {
  return host.querySelector(".toolbar-handle") as HTMLButtonElement;
}

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  picked = [];
});

describe("the tool drawer", () => {
  it("is the seven tools of DESIGN 3.9, in its order", () => {
    build();
    expect(buttons().map((b) => b.querySelector(".toolbar-key")?.textContent)).toEqual([
      "V",
      "P",
      "S",
      "N",
      "M",
      "H",
      "E",
    ]);
    expect(RAIL.map((t) => t.id)).toEqual([
      "select",
      "pin",
      "string",
      "note",
      "marker",
      "highlighter",
      "eraser",
    ]);
  });

  /** Every one of them, so a glyph that was never written shows up here rather
   *  than as an empty square on the board. */
  it("draws a glyph on every button", () => {
    build();
    for (const button of buttons()) {
      const svg = button.querySelector(".toolbar-glyph");
      expect(svg, button.getAttribute("aria-label") ?? "").not.toBeNull();
      expect(svg!.innerHTML.length).toBeGreaterThan(0);
    }
  });

  it("reports a click by id and touches no tool state", () => {
    build();
    buttons()[3]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    buttons()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(picked).toEqual(["note", "select"]);
  });

  it("lights the tool in hand, and only that one", () => {
    const bar = build();
    bar.sync("marker");
    const on = buttons().filter((b) => b.classList.contains("is-on"));
    expect(on).toHaveLength(1);
    expect(on[0]!.getAttribute("aria-label")).toBe("Marker (M)");
    expect(on[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(buttons()[0]!.getAttribute("aria-pressed")).toBe("false");
  });

  it("moves the light when the tool changes", () => {
    const bar = build();
    bar.sync("marker");
    bar.sync("pin");
    expect(buttons().filter((b) => b.classList.contains("is-on"))).toHaveLength(1);
    expect(buttons()[1]!.classList.contains("is-on")).toBe(true);
  });

  /**
   * The smudge is `Shift+E` and is not one of the seven (D-44). Every button off
   * is the honest picture — the alternative is the eraser sitting lit while you
   * are holding something else.
   */
  it("turns everything off for a tool that is not on the rail", () => {
    const bar = build();
    bar.sync("eraser");
    bar.sync("erase");
    expect(buttons().some((b) => b.classList.contains("is-on"))).toBe(false);
  });

  /** `sync` runs once a frame from the OVERLAY phase and the tool is the same on
   *  almost all of them. */
  it("writes no DOM when the tool has not changed", () => {
    const bar = build();
    bar.sync("string");
    const target = buttons()[2]!;
    const toggle = vi.spyOn(target.classList, "toggle");
    const attr = vi.spyOn(target, "setAttribute");
    bar.sync("string");
    bar.sync("string");
    expect(toggle).not.toHaveBeenCalled();
    expect(attr).not.toHaveBeenCalled();
  });

  describe("the handle", () => {
    it("opens by default, and is what the caller was told", () => {
      expect(build().open).toBe(true);
      document.body.innerHTML = "";
      host = document.createElement("div");
      document.body.append(host);
      expect(build(false).open).toBe(false);
    });

    it("takes the seven away and stays behind", () => {
      const bar = build();
      const tools = host.querySelector(".toolbar-tools") as HTMLElement;
      expect(tools.hidden).toBe(false);

      handle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(bar.open).toBe(false);
      expect(tools.hidden).toBe(true);
      // Still there and still drawn — a rail that took its own handle away with
      // the buttons would be a rail nothing could reopen.
      expect(handle().isConnected).toBe(true);
      expect(handle().hidden).toBe(false);
      expect(handle().getAttribute("aria-expanded")).toBe("false");

      handle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(bar.open).toBe(true);
      expect(tools.hidden).toBe(false);
      expect(handle().getAttribute("aria-expanded")).toBe("true");
    });

    it("tells the caller, which is what remembers it", () => {
      const seen: boolean[] = [];
      const bar = new Toolbar(host, { pick: () => {}, toggled: (open) => seen.push(open) });
      handle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      handle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(seen).toEqual([false, true]);
      expect(bar.open).toBe(true);
    });

    /** A stored preference arriving after construction, and the no-op that a
     *  second identical write is. */
    it("can be set without a click, and says nothing when nothing changed", () => {
      const seen: boolean[] = [];
      const bar = new Toolbar(host, { pick: () => {}, toggled: (open) => seen.push(open) });
      bar.setOpen(false);
      bar.setOpen(false);
      expect(bar.open).toBe(false);
      // `setOpen` is the caller telling the panel, not the panel telling the
      // caller — echoing it back would write the preference it just read.
      expect(seen).toEqual([]);
    });
  });

  describe("keeping out of the keyboard's way", () => {
    it("puts nothing in the tab order", () => {
      build();
      for (const button of [...buttons(), handle()]) {
        expect(button.tabIndex).toBe(-1);
      }
    });

    /**
     * The press is refused, not the click. `preventDefault` on `mousedown` is
     * what stops focus landing; the `click` still arrives, which the pick test
     * above proves.
     */
    it("refuses the press that would focus it", () => {
      build();
      for (const button of [...buttons(), handle()]) {
        const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        button.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
      }
    });
  });

  it("goes away completely", () => {
    const bar = build();
    bar.destroy();
    expect(host.querySelector(".toolbar")).toBeNull();
  });
});
