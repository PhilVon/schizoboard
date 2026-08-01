/**
 * What the eight tools say about themselves — `Tool.hint`.
 *
 * Whether a row is *true* is not checkable here; it was checked by reading the
 * file each row sits in, which is the whole argument for the declaration living
 * there. What is checkable is that the declarations are complete and internally
 * honest, and one of those has a real failure mode behind it.
 *
 * A row whose `keys` reads `Ctrl+drag a pin` and whose `holds` is empty renders
 * perfectly and simply never lights, on a board where lighting it is the point
 * — D-44's sixth decision: "Holding Ctrl+Alt and watching the cut row light up
 * is the clearest possible teaching of a gesture that nothing currently
 * suggests." Nothing about that failure is visible in a screenshot or in a diff,
 * and it is one forgotten array away at every row. So the sentence and the array
 * are checked against each other, in both directions.
 */

import { describe, expect, it } from "vitest";

import { EraserTool } from "@/state/tools/eraser";
import { MarkerTool } from "@/state/tools/marker";
import { NoteTool } from "@/state/tools/note";
import { PinTool } from "@/state/tools/pin";
import { SelectTool } from "@/state/tools/select";
import { StringTool } from "@/state/tools/string";
import type { Tool } from "@/state/tools/tool";

/** All eight of DESIGN section 3.5's rows, built as `app/main.ts` builds them. */
const TOOLS: readonly Tool[] = [
  new SelectTool(),
  new PinTool(),
  new StringTool(),
  new NoteTool(),
  new MarkerTool(),
  new MarkerTool({ tool: "highlighter" }),
  new MarkerTool({ tool: "erase" }),
  new EraserTool(),
];

/** The word a reader sees, against the name the held set is keyed by. */
const MODIFIERS = [
  { word: /\bShift\b/, holds: "Shift" },
  { word: /\bCtrl\b/, holds: "Control" },
  { word: /\bAlt\b/, holds: "Alt" },
] as const;

describe("every tool declares what it does", () => {
  it("covers all eight, with distinct names", () => {
    const names = TOOLS.map((t) => t.hint.name);
    expect(names).toEqual([
      "Select",
      "Pin",
      "String",
      "Note",
      "Marker",
      "Highlighter",
      "Smudge",
      "Eraser",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  /** DESIGN section 3.9's `Tools` line, plus the one modified row. */
  it("carries the key that picks it", () => {
    expect(TOOLS.map((t) => t.hint.key)).toEqual(["V", "P", "S", "N", "M", "H", "Shift+E", "E"]);
  });

  it.each(TOOLS.map((t): [string, Tool] => [t.hint.name, t]))(
    "%s says something in every field",
    (_name, tool) => {
      expect(tool.hint.verb.length).toBeGreaterThan(0);
      for (const row of tool.hint.rows) {
        expect(row.keys.length).toBeGreaterThan(0);
        expect(row.does.length).toBeGreaterThan(0);
      }
    },
  );

  /**
   * The one that would otherwise fail silently. A sentence and an array that
   * disagree give a row which is either dead — it can never light — or a liar,
   * lighting for a key it does not name.
   */
  it.each(TOOLS.map((t): [string, Tool] => [t.hint.name, t]))(
    "%s's rows hold exactly the modifiers they name",
    (_name, tool) => {
      for (const row of tool.hint.rows) {
        const holds = new Set(row.holds ?? []);
        for (const { word, holds: key } of MODIFIERS) {
          expect(holds.has(key), `"${row.keys}" — ${key} in holds`).toBe(word.test(row.keys));
        }
      }
    },
  );

  /**
   * The three that belong to no tool — `quickpull.ts`'s pull and pin removal,
   * and `scissors.ts`'s cut — are declared once as ambient rows and must not be
   * repeated eight times. Every tool delegates to both before its own switch, so
   * a tool that listed them would be describing somebody else's code.
   */
  it("leaves the gestures that work in every tool to the ambient rows", () => {
    for (const tool of TOOLS) {
      for (const row of tool.hint.rows) {
        expect(row.keys, `${tool.hint.name}`).not.toMatch(/Alt\+(drag|click)|Ctrl\+Alt/);
      }
    }
  });

  /** The pens differ in their nouns and share their gestures — the three are one
   *  class, and the hint is built from `this.tool` exactly as the width and the
   *  colour are. */
  it("gives each pen its own sentences off one class", () => {
    const [marker, highlighter, smudge] = [
      new MarkerTool(),
      new MarkerTool({ tool: "highlighter" }),
      new MarkerTool({ tool: "erase" }),
    ];
    expect(marker.hint.verb).not.toBe(highlighter.hint.verb);
    expect(smudge.hint.verb).not.toBe(marker.hint.verb);
    expect(smudge.hint.rows[1]?.does).toBe("size the smudge");
    expect(marker.hint.rows[1]?.does).toBe("size the nib");
    // Same gesture, so the same keys in the same order.
    expect(highlighter.hint.rows.map((r) => r.keys)).toEqual(marker.hint.rows.map((r) => r.keys));
  });

  /** Select is where everything that is not a pen lives, so it is the one tool
   *  whose readout is worth anything at all if it is thin. */
  it("gives select the ten gestures it alone implements", () => {
    const select = new SelectTool();
    expect(select.hint.rows.map((r) => r.keys)).toEqual([
      "Shift+click",
      "Shift+drag",
      "R+drag",
      "Ctrl+drag a pin",
      "double-click a pin",
      "Enter",
      "wheel",
      "Alt+wheel",
      "1-9",
      "Shift+Delete",
    ]);
  });
});
