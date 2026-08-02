/**
 * @vitest-environment happy-dom
 *
 * The bar as a box: that it rests on its chips, that holding a key swaps them
 * for what that key unlocks, that a frame which changed nothing writes nothing,
 * and that it takes no press.
 *
 * What the rows *say* and which of them rest is `toolhint.test.ts`'s, with no
 * DOM in it. This file only asks whether the box shows them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EraserTool } from "@/state/tools/eraser";
import { MarkerTool } from "@/state/tools/marker";
import { PinTool } from "@/state/tools/pin";
import { SelectTool } from "@/state/tools/select";
import { BOARD, restingRows, UNSAVED_LINE } from "@/ui/toolhint";
import { ToolInfo } from "@/ui/toolinfo";

const SELECT = new SelectTool().hint;
const MARKER = new MarkerTool().hint;
const ERASER = new EraserTool().hint;
const PIN = new PinTool().hint;

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

/** Band 3 when a key is down: the rows it unlocked. */
function liveKeys(): string[] {
  return [...host.querySelectorAll<HTMLElement>(".toolinfo-held .toolinfo-row")]
    .filter((r) => r.classList.contains("is-live"))
    .map((r) => r.querySelector(".toolinfo-keys")?.textContent ?? "");
}

/** Band 3 at rest: the keys worth holding, and which of them are down. */
function chips(): string[] {
  return [...host.querySelectorAll(".toolinfo-chip")].map((c) => c.textContent ?? "");
}

function litChips(): string[] {
  return [...host.querySelectorAll(".toolinfo-chip.is-on")].map((c) => c.textContent ?? "");
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
  });

  /**
   * Q-194, and the whole of why the bar is short. At rest it shows the four
   * gestures no key could reveal and names the three keys that would reveal the
   * rest — not the twelve rows it used to say always.
   */
  it("rests on the gestures no key hides, and names the keys that hide the others", () => {
    bar.sync(SELECT, held());
    expect(toolRows().map((r) => r.querySelector(".toolinfo-keys")?.textContent)).toEqual([
      "R+drag",
      "double-click a pin",
      "Enter",
      "arrows",
      // Held behind no modifier, because it is a bare drag on a page (T-282).
      "drag a page",
      "wheel",
      "1-9",
    ]);
    expect(chips()).toEqual(["Shift", "Ctrl", "Alt"]);
    expect(litChips()).toEqual([]);
    expect(liveKeys()).toEqual([]);
  });

  it("swaps the whole line when the tool changes", () => {
    bar.sync(SELECT, held());
    bar.sync(MARKER, held());
    expect(lead()).toBe(`Marker (M) — draw`);
    // The pen's three plain rows; its Ctrl row is behind the chip. The arrows
    // joined them at T-278, when a page became something a pen can turn.
    expect(toolRows().map((r) => r.querySelector(".toolinfo-keys")?.textContent)).toEqual([
      "[ and ]",
      "arrows",
      "Esc",
    ]);
  });

  describe("a row brightens while its keys are down", () => {
    /** The scissors — the gesture nothing on this board suggests, which is why
     *  the lighting exists at all (D-44). */
    it("brings the cut back only with both of Ctrl and Alt", () => {
      bar.sync(SELECT, held("ControlLeft"));
      expect(liveKeys()).not.toContain("Ctrl+Alt+click a string");
      bar.sync(SELECT, held("ControlLeft", "AltLeft"));
      expect(liveKeys()).toContain("Ctrl+Alt+click a string");
    });

    it("shows every Shift row of the tool in hand, and nothing else", () => {
      bar.sync(SELECT, held("ShiftRight"));
      expect(liveKeys()).toEqual(["Shift+click", "Shift+drag", "Shift+Delete"]);
      // The chips have given the line over to what they were standing for.
      expect(chips()).toEqual([]);
    });

    it("gives the chips back when the key comes up", () => {
      bar.sync(SELECT, held("AltLeft"));
      expect(liveKeys().length).toBeGreaterThan(0);
      bar.sync(SELECT, held());
      expect(liveKeys()).toEqual([]);
      expect(chips()).toEqual(["Shift", "Ctrl", "Alt"]);
    });

    /**
     * Leaning on Shift with a pen in hand. A pen has nothing on Shift and
     * neither do the ambient three, so Shift is not offered as a chip at all —
     * and the line keeps standing rather than going blank, which is what a bar
     * that emptied on an unbound key would read as.
     */
    it("keeps the line standing when a key with nothing behind it goes down", () => {
      bar.sync(MARKER, held("ShiftLeft"));
      expect(liveKeys()).toEqual([]);
      expect(chips()).toEqual(["Ctrl", "Alt"]);
      expect(litChips()).toEqual([]);
    });

    /**
     * The chip lights on a key that is offered but has revealed nothing yet, and
     * the pin tool is where that happens: its only `Ctrl` gesture is the ambient
     * cut, which wants `Alt` as well. So holding `Ctrl` there says *this key is
     * half of something* — press `Alt` and the cut appears — which is the one
     * state a bar without chips could not express at all.
     */
    /**
     * The chip line is already on screen and only which chip is lit changes —
     * so the guard that stops an unchanged frame writing has to count the lit
     * ones, not just which chips exist. Cheaper versions of it compare the chips
     * alone, return early, and leave every chip dark for as long as the key is
     * down.
     */
    it("lights a chip on a line that was already drawn", () => {
      bar.sync(PIN, held());
      expect(litChips()).toEqual([]);
      bar.sync(PIN, held("ControlLeft"));
      expect(litChips()).toEqual(["Ctrl"]);
      bar.sync(PIN, held());
      expect(litChips()).toEqual([]);
    });

    it("lights a chip whose key is offered but has not revealed anything yet", () => {
      bar.sync(PIN, held("ControlLeft"));
      expect(chips()).toEqual(["Ctrl", "Alt"]);
      expect(litChips()).toEqual(["Ctrl"]);
      expect(liveKeys()).toEqual([]);

      // Both down brings the cut back — and the two `Alt` rows with it, since
      // `Alt` is now down too and the chips name keys rather than combinations.
      bar.sync(PIN, held("ControlLeft", "AltLeft"));
      expect(liveKeys()).toEqual([
        "Alt+drag a pin",
        "Alt+click a pin",
        "Ctrl+Alt+click a string",
      ]);
    });

    it("keeps the plain gestures visible under whatever is held", () => {
      bar.sync(SELECT, held("ControlLeft"));
      expect(toolRows().map((r) => r.querySelector(".toolinfo-keys")?.textContent)).toEqual([
        "R+drag",
        "double-click a pin",
        "Enter",
        "arrows",
        "drag a page",
        "wheel",
        "1-9",
      ]);
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
      // That board still takes every gesture, so it rests exactly as usual.
      expect(toolRows()).toHaveLength(restingRows(SELECT).length);
      expect(chips()).toEqual(["Shift", "Ctrl", "Alt"]);
      expect(host.querySelector(".toolinfo-lead")?.classList.contains("is-warning")).toBe(true);
    });

    it("replaces the tool line on a sealed board and offers no gesture at all", () => {
      bar.sync(SELECT, held(), { sealed: { boardVersion: 4, buildVersion: 3 } });
      expect(lead()).toContain("MADE BY A NEWER VERSION");
      expect(lead()).not.toContain(SELECT.verb);
      expect(toolRows()).toEqual([]);
      // Not the chips either: every gesture behind them is a write.
      expect(chips()).toEqual([]);
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

  /**
   * The drawer's handle hides both panels. The rail and the bar are one piece
   * of furniture — which tool you are holding, and what it does — so a handle
   * that took away the first and left the second would hide half a sentence.
   */
  describe("put away with the rail", () => {
    it("hides and comes back", () => {
      const el = host.querySelector(".toolinfo") as HTMLElement;
      expect(el.hidden).toBe(false);
      bar.setVisible(false);
      expect(el.hidden).toBe(true);
      bar.setVisible(true);
      expect(el.hidden).toBe(false);
    });

    /** It keeps up while it is away, so it is right the instant it returns
     *  rather than showing the tool you were holding when you put it away. */
    it("is current the moment it comes back", () => {
      bar.sync(SELECT, held());
      bar.setVisible(false);
      bar.sync(MARKER, held("ControlLeft"));
      bar.setVisible(true);
      expect(lead()).toBe(`Marker (M) — draw`);
      expect(liveKeys()).toEqual(["Ctrl at pen-down"]);
    });
  });

  it("goes away completely", () => {
    bar.sync(SELECT, held());
    bar.destroy();
    expect(host.querySelector(".toolinfo")).toBeNull();
  });
});
