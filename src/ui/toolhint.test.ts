/**
 * What the info bar says — the policy, with no DOM anywhere in it.
 *
 * The `boardmenu.test.ts` argument: the copy and the rules about it are the part
 * most likely to be wrong and the part a DOM test is worst at checking, so they
 * are tested here against plain values, and `toolinfo.dom.test.ts` only checks
 * that the box draws what it is handed.
 */

import { describe, expect, it } from "vitest";

import { SelectTool } from "@/state/tools/select";
import type { ToolHint } from "@/state/tools/tool";
import { AMBIENT, BOARD, live, rows, toolLine, UNSAVED_LINE } from "@/ui/toolhint";

const SELECT = new SelectTool().hint;

/** A tool with one row of each kind, so the merge order is readable. */
const TOY: ToolHint = {
  name: "Toy",
  key: "T",
  verb: "do the toy thing",
  rows: [
    { keys: "click", does: "place one" },
    { keys: "Shift+click", does: "place two", holds: ["Shift"] },
  ],
};

function held(...codes: string[]): ReadonlySet<string> {
  return new Set(codes);
}

describe("rows", () => {
  it("puts the tool's own first and everybody's after", () => {
    expect(rows(TOY).map((r) => r.keys)).toEqual([
      "click",
      "Shift+click",
      ...AMBIENT.map((r) => r.keys),
    ]);
  });

  /**
   * The three ambient rows are `quickpull.ts`'s and `scissors.ts`'s, and every
   * tool delegates to both before its own switch. A tool that declared them
   * would get them twice here.
   */
  it("does not repeat a gesture the tool already declared", () => {
    const merged = rows(SELECT).map((r) => r.keys);
    expect(new Set(merged).size).toBe(merged.length);
  });

  it("carries the ambient three, cut included", () => {
    expect(AMBIENT.map((r) => r.keys)).toEqual([
      "Alt+drag a pin",
      "Alt+click a pin",
      "Ctrl+Alt+click a string",
    ]);
  });

  /** What the old hint line taught that is nobody's tool. Dropping any of these
   *  would lose the only place the application says it. */
  it("keeps the camera, the search and undo on the board line", () => {
    expect(BOARD.map((r) => r.keys)).toEqual([
      "space+drag",
      "wheel",
      "Ctrl+0",
      "F",
      "Ctrl+F",
      "Ctrl+Z",
      "`",
    ]);
  });
});

describe("live", () => {
  it("lights a row whose one modifier is down", () => {
    const row = { keys: "Alt+drag a pin", does: "…", holds: ["Alt"] } as const;
    expect(live(row, held("AltLeft"))).toBe(true);
    expect(live(row, held("AltRight"))).toBe(true);
    expect(live(row, held("ShiftLeft"))).toBe(false);
    expect(live(row, held())).toBe(false);
  });

  /** The scissors, and the reason any of this exists. */
  it("needs every modifier, not any of them", () => {
    const cut = AMBIENT[2]!;
    expect(live(cut, held("ControlLeft"))).toBe(false);
    expect(live(cut, held("AltLeft"))).toBe(false);
    expect(live(cut, held("ControlLeft", "AltLeft"))).toBe(true);
    expect(live(cut, held("ControlRight", "AltRight"))).toBe(true);
  });

  /**
   * A gesture that is always available has nothing to announce. If these lit,
   * the whole readout would be bright and the row that just lit would be
   * indistinguishable from the rest — which is the failure the feature exists
   * to avoid.
   */
  it("never lights a row that needs nothing held", () => {
    expect(live({ keys: "wheel", does: "zoom" }, held("ControlLeft", "AltLeft"))).toBe(false);
    expect(live({ keys: "x", does: "y", holds: [] }, held("ShiftLeft"))).toBe(false);
    for (const row of BOARD) expect(live(row, held("ControlLeft", "AltLeft"))).toBe(false);
  });

  /** Every unheld modifier the row does not name is irrelevant. */
  it("ignores keys the row says nothing about", () => {
    const row = { keys: "Shift+click", does: "…", holds: ["Shift"] } as const;
    expect(live(row, held("ShiftLeft", "ControlLeft", "AltLeft", "KeyR"))).toBe(true);
  });
});

describe("the tool line", () => {
  it("leads with the tool, its key and its plain verb", () => {
    expect(toolLine(TOY).lead).toBe("Toy (T) — do the toy thing");
    expect(toolLine(TOY).warning).toBe(false);
    expect(toolLine(TOY).rows).toHaveLength(TOY.rows.length + AMBIENT.length);
  });

  /**
   * That board still takes every gesture in the list and merely fails to keep
   * them, so the list survives and the warning goes in front of it.
   */
  it("prefixes the not-being-saved sentence and keeps the rows", () => {
    const line = toolLine(TOY, { unsaved: true });
    expect(line.lead.startsWith(UNSAVED_LINE)).toBe(true);
    expect(line.lead).toContain("do the toy thing");
    expect(line.warning).toBe(true);
    expect(line.rows).toHaveLength(TOY.rows.length + AMBIENT.length);
  });

  /**
   * The future-schema board takes *none* of them, and a readout offering "drag
   * to move · Delete removes" on a board that does neither is worse than no
   * readout: the first thing anybody does is try one, and the board says
   * nothing back.
   */
  it("replaces the tool line entirely on a sealed board, rows included", () => {
    const line = toolLine(TOY, { sealed: { boardVersion: 4, buildVersion: 3 } });
    expect(line.lead).toContain("schema 4");
    expect(line.lead).toContain("this build reads 3");
    expect(line.lead).not.toContain("do the toy thing");
    expect(line.warning).toBe(true);
    // Not even the ambient three: `Alt`+click a pin is a write.
    expect(line.rows).toEqual([]);
  });

  /** Sealed wins. A board can be both, and the one that takes no gesture at all
   *  is the one worth saying. */
  it("prefers sealed over unsaved when a board is both", () => {
    const line = toolLine(TOY, { sealed: { boardVersion: 4, buildVersion: 3 }, unsaved: true });
    expect(line.lead).not.toContain(UNSAVED_LINE);
    expect(line.rows).toEqual([]);
  });

  /** The real one, not the toy — the eight tools' copy reaching the bar. */
  it("reads select's own nine rows before the ambient three", () => {
    const line = toolLine(SELECT);
    expect(line.lead).toBe(`Select (V) — ${SELECT.verb}`);
    expect(line.rows.slice(0, 9).map((r) => r.keys)).toEqual(SELECT.rows.map((r) => r.keys));
    expect(line.rows.slice(9)).toEqual(AMBIENT);
  });
});
