/**
 * @vitest-environment happy-dom
 *
 * The bar as a box: that it draws what the policy hands it, that a modifier
 * going down brightens exactly the rows that need it, that a frame which
 * changed nothing writes nothing, and that it takes no press.
 *
 * What the rows *say* is `toolhint.test.ts`'s, with no DOM in it. This file
 * only asks whether the box shows them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EraserTool } from "@/state/tools/eraser";
import { MarkerTool } from "@/state/tools/marker";
import { SelectTool } from "@/state/tools/select";
import { AMBIENT, BOARD, UNSAVED_LINE } from "@/ui/toolhint";
import { ToolInfo } from "@/ui/toolinfo";

const SELECT = new SelectTool().hint;
const MARKER = new MarkerTool().hint;
const ERASER = new EraserTool().hint;

let host: HTMLElement;
let bar: ToolInfo;

function held(...codes: string[]): ReadonlySet<string> {
  return new Set(codes);
}

function lead(): string {
  return host.querySelector(".toolinfo-lead")?.textContent ?? "";
}

function toolRows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".toolinfo-tool .toolinfo-row")];
}

function liveKeys(): string[] {
  return toolRows()
    .filter((r) => r.classList.contains("is-live"))
    .map((r) => r.querySelector(".toolinfo-keys")?.textContent ?? "");
}

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  bar = new ToolInfo(host);
});

describe("the tool info bar", () => {
  it("builds the standing board line once, and never touches it again", () => {
    const board = [...host.querySelectorAll(".toolinfo-board .toolinfo-row")];
    expect(board).toHaveLength(BOARD.length);
    expect(board[0]?.querySelector(".toolinfo-keys")?.textContent).toBe("space+drag");

    const first = board[0] as HTMLElement;
    const toggle = vi.spyOn(first.classList, "toggle");
    bar.sync(SELECT, held());
    bar.sync(MARKER, held("ControlLeft"));
    expect(toggle).not.toHaveBeenCalled();
  });

  it("says which tool is in hand, and what it plainly does", () => {
    bar.sync(SELECT, held());
    expect(lead()).toBe(`Select (V) — ${SELECT.verb}`);
    expect(toolRows()).toHaveLength(SELECT.rows.length + AMBIENT.length);
  });

  it("swaps the whole line when the tool changes", () => {
    bar.sync(SELECT, held());
    bar.sync(MARKER, held());
    expect(lead()).toBe(`Marker (M) — draw`);
    expect(toolRows()).toHaveLength(MARKER.rows.length + AMBIENT.length);
    expect(toolRows()[0]?.textContent).toContain("Ctrl at pen-down");
  });

  describe("a row brightens while its keys are down", () => {
    /** The scissors — the gesture nothing on this board suggests, which is why
     *  the lighting exists at all (D-44). */
    it("lights the cut only with both of Ctrl and Alt", () => {
      bar.sync(SELECT, held("ControlLeft"));
      expect(liveKeys()).not.toContain("Ctrl+Alt+click a string");
      bar.sync(SELECT, held("ControlLeft", "AltLeft"));
      expect(liveKeys()).toContain("Ctrl+Alt+click a string");
    });

    it("lights every Shift row of the tool in hand, and nothing else", () => {
      bar.sync(SELECT, held("ShiftRight"));
      expect(liveKeys()).toEqual(["Shift+click", "Shift+drag", "Shift+Delete"]);
    });

    it("puts them out again when the key comes up", () => {
      bar.sync(SELECT, held("AltLeft"));
      expect(liveKeys().length).toBeGreaterThan(0);
      bar.sync(SELECT, held());
      expect(liveKeys()).toEqual([]);
    });

    /** Rows are rebuilt when the tool changes, so the live bits have to be
     *  recomputed against the new list rather than carried over by index. */
    it("re-lights correctly across a tool change with the key still down", () => {
      bar.sync(SELECT, held("ControlLeft"));
      expect(liveKeys()).toEqual(["Ctrl+drag a pin"]);
      bar.sync(MARKER, held("ControlLeft"));
      expect(liveKeys()).toEqual(["Ctrl at pen-down"]);
    });

    /**
     * The case the cheap version of this gets wrong, and the reason `sync`
     * forgets what was lit whenever it rebuilds the rows.
     *
     * Two tools whose live rows land on the *same bit* — the eraser's `Ctrl` row
     * and a pen's are both first — make the mask compare equal across a tool
     * change while every element it refers to has just been thrown away. A guard
     * that trusted the mask alone would return early and leave the new line
     * uniformly dark with `Ctrl` still down.
     */
    it("lights the new tool's rows even when the same bits were lit before", () => {
      bar.sync(ERASER, held("ControlLeft"));
      expect(liveKeys()).toEqual(["Ctrl at the press"]);
      bar.sync(MARKER, held("ControlLeft"));
      expect(liveKeys()).toEqual(["Ctrl at pen-down"]);
    });
  });

  describe("what it writes per frame", () => {
    it("writes nothing when neither the tool nor the held keys changed", () => {
      bar.sync(SELECT, held("AltLeft"));
      const row = toolRows()[0]!;
      const toggle = vi.spyOn(row.classList, "toggle");
      const text = vi.spyOn(host.querySelector(".toolinfo-lead") as HTMLElement, "textContent", "set");
      bar.sync(SELECT, held("AltLeft"));
      bar.sync(SELECT, held("AltLeft"));
      expect(toggle).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
    });

    /** A different Set object with the same contents is the ordinary case —
     *  `ToolMachine.held` is one set mutated in place, but a caller passing a
     *  copy must not make every frame a write. */
    it("compares what is held, not which Set it arrived in", () => {
      bar.sync(SELECT, held("ShiftLeft"));
      const row = toolRows()[0]!;
      const toggle = vi.spyOn(row.classList, "toggle");
      bar.sync(SELECT, new Set(["ShiftLeft"]));
      expect(toggle).not.toHaveBeenCalled();
    });
  });

  describe("a board that cannot be written to", () => {
    it("prefixes the not-being-saved sentence and keeps the gestures", () => {
      bar.sync(SELECT, held(), { unsaved: true });
      expect(lead().startsWith(UNSAVED_LINE)).toBe(true);
      expect(lead()).toContain(SELECT.verb);
      expect(toolRows()).toHaveLength(SELECT.rows.length + AMBIENT.length);
      expect(host.querySelector(".toolinfo-lead")?.classList.contains("is-warning")).toBe(true);
    });

    it("replaces the tool line on a sealed board and offers no gesture at all", () => {
      bar.sync(SELECT, held(), { sealed: { boardVersion: 4, buildVersion: 3 } });
      expect(lead()).toContain("MADE BY A NEWER VERSION");
      expect(lead()).not.toContain(SELECT.verb);
      expect(toolRows()).toEqual([]);
      // The board line stays: the camera, the search and the exports are the
      // whole of what you can still do with a board you may only look at.
      expect(host.querySelectorAll(".toolinfo-board .toolinfo-row")).toHaveLength(BOARD.length);
    });

    /** Coming back off a warning has to restore the tool line, not leave the
     *  colour behind — the seal can arrive mid-session (T-224). */
    it("clears the warning when the board is ordinary again", () => {
      bar.sync(SELECT, held(), { unsaved: true });
      bar.sync(SELECT, held());
      expect(host.querySelector(".toolinfo-lead")?.classList.contains("is-warning")).toBe(false);
      expect(lead()).toBe(`Select (V) — ${SELECT.verb}`);
    });
  });

  /**
   * The repair, not a preference. The line this replaces had no
   * `pointer-events: none` and swallowed every press that landed in it, while
   * three source comments asserted it was inert.
   */
  it("is a readout — nothing in it is a target", () => {
    bar.sync(SELECT, held());
    // happy-dom applies no stylesheet, so the assertion is on the class the
    // rule is keyed to plus the absence of anything clickable.
    expect(host.querySelector(".toolinfo")).not.toBeNull();
    expect(host.querySelectorAll("button, input, a")).toHaveLength(0);
  });

  it("goes away completely", () => {
    bar.sync(SELECT, held());
    bar.destroy();
    expect(host.querySelector(".toolinfo")).toBeNull();
  });
});
