/**
 * What the menu offers, and what each row writes.
 *
 * No DOM here at all — that is the whole reason the rows are a pure function of
 * ids. The three tuck-behind cases came from `select.test.ts`, where they were
 * testing the interim `B` keybinding; the behaviour they pin down did not
 * change when the verb moved into a menu, and that is worth being able to see.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Scene } from "@/state/scene";
import type { BoardWriter, StringStyle } from "@/state/tools/tool";
import { STRING_MATERIALS } from "@/lib/material";
import { DEFAULT_STRING_COLOR, STRING_COLORS, STRING_THICKNESSES } from "@/lib/palette";
import { stringMenuRows } from "@/ui/boardmenu";
import type { MenuChoice, MenuEntry, MenuRow } from "@/ui/menu";

type Write =
  | { kind: "layer"; stringIds: string[]; layer: "over" | "under" }
  | { kind: "style"; stringIds: string[]; style: StringStyle }
  | { kind: "delete"; stringIds: string[] };

let scene: Scene;
let writes: Write[];
let write: BoardWriter;

/** A string through two pins, on the layer named. */
function span(id: string, y: number, layer = "over"): void {
  for (const [suffix, x] of [
    ["a", 0],
    ["b", 200],
  ] as const) {
    scene.putPin({
      id: `${id}-${suffix}`,
      parent: null,
      lx: x,
      ly: y,
      kind: "pushpin",
      color: "#c8352c",
      wx: x,
      wy: y,
    });
  }
  scene.putString({
    id,
    nodes: [
      { nodeId: `${id}-n0`, pin: `${id}-a`, slackAfter: 0.2 },
      { nodeId: `${id}-n1`, pin: `${id}-b`, slackAfter: 0.2 },
    ],
    color: "#a8322c",
    thickness: 3,
    material: "string",
    layer,
    closed: false,
  });
}

/** The verb rows, which is everything that is not a picker. */
function verbs(entries: readonly MenuEntry[]): MenuRow[] {
  return entries.filter((e): e is MenuRow => !("choices" in e));
}

/** Pick a verb row by label prefix and run it. */
function pick(entries: readonly MenuEntry[], label: string): void {
  const row = verbs(entries).find((r) => r.label.startsWith(label));
  if (row === undefined) {
    throw new Error(`no row starting "${label}" in ${verbs(entries).map((r) => r.label).join(", ")}`);
  }
  row.run();
}

/** A picker's chips, by its caption. */
function chips(entries: readonly MenuEntry[], label: string): readonly MenuChoice[] {
  const picker = entries.find((e) => "choices" in e && e.label === label);
  if (picker === undefined || !("choices" in picker)) throw new Error(`no "${label}" picker`);
  return picker.choices;
}

beforeEach(() => {
  scene = new Scene();
  writes = [];
  const partial: Pick<BoardWriter, "setStringLayer" | "setStringStyle" | "deleteStrings"> = {
    setStringLayer: (stringIds, layer) =>
      writes.push({ kind: "layer", stringIds: [...stringIds], layer }),
    setStringStyle: (stringIds, style) =>
      writes.push({ kind: "style", stringIds: [...stringIds], style: { ...style } }),
    deleteStrings: (stringIds) => writes.push({ kind: "delete", stringIds: [...stringIds] }),
  };
  // The rows only ever reach these two. Everything else on the interface is a
  // write no menu offers, and stubbing fourteen of them would say otherwise.
  write = partial as BoardWriter;
});

describe("the string context menu", () => {
  it("offers nothing when nothing was hit", () => {
    expect(stringMenuRows(scene, write, [])).toEqual([]);
  });

  /** The rows are built from a snapshot taken at the press. A peer that deleted
   *  one of them in between must not leave a row that writes against a ghost. */
  it("drops ids the scene no longer has, and offers nothing when all of them are gone", () => {
    span("s", 0);
    expect(verbs(stringMenuRows(scene, write, ["s", "vanished"]))).toHaveLength(2);
    expect(stringMenuRows(scene, write, ["vanished"])).toEqual([]);
  });

  describe("tuck behind", () => {
    it("puts a string under the items", () => {
      span("s", 0);
      const rows = stringMenuRows(scene, write, ["s"]);
      expect(verbs(rows)[0]!.label).toBe("Tuck behind");
      pick(rows, "Tuck");
      expect(writes).toEqual([{ kind: "layer", stringIds: ["s"], layer: "under" }]);
    });

    it("brings it back over when it is already under, and says so", () => {
      span("s", 0, "under");
      const rows = stringMenuRows(scene, write, ["s"]);
      expect(verbs(rows)[0]!.label).toBe("Bring in front");
      pick(rows, "Bring");
      expect(writes).toEqual([{ kind: "layer", stringIds: ["s"], layer: "over" }]);
    });

    /**
     * The reason the write carries a layer rather than meaning "invert each of
     * these": independent flips would turn one mixed selection into a different
     * mixed selection, and picking the row again would put it back — a verb
     * that never converges on the thing the eye is asking for.
     */
    it("puts a mixed selection all the way under, and only then all the way back", () => {
      span("s0", 0);
      span("s1", 300, "under");

      pick(stringMenuRows(scene, write, ["s0", "s1"]), "Tuck");
      expect(writes).toEqual([{ kind: "layer", stringIds: ["s0", "s1"], layer: "under" }]);

      // The write is queued to phase 9 and the scene has not seen it yet, so
      // the second menu is built as it would be the frame after it landed.
      scene.strings.get("s0")!.layer = "under";
      pick(stringMenuRows(scene, write, ["s0", "s1"]), "Bring");
      expect(writes[1]).toEqual({ kind: "layer", stringIds: ["s0", "s1"], layer: "over" });
    });
  });

  describe("restyle", () => {
    /** > Colour (red is default - also blue, green, yellow, black, white)
     *  > - DESIGN section 3.4 */
    it("offers all six colours as their real hexes", () => {
      span("s", 0);
      const swatches = chips(stringMenuRows(scene, write, ["s"]), "Colour");
      expect(swatches.map((c) => c.label)).toEqual(STRING_COLORS.map((c) => c.label));
      expect(swatches.map((c) => c.swatch)).toEqual(STRING_COLORS.map((c) => c.hex));
    });

    it("writes only the colour", () => {
      span("s", 0);
      chips(stringMenuRows(scene, write, ["s"]), "Colour")[1]!.run();
      expect(writes).toEqual([
        { kind: "style", stringIds: ["s"], style: { color: STRING_COLORS[1]!.hex } },
      ]);
    });

    it("writes only the thickness", () => {
      span("s", 0);
      chips(stringMenuRows(scene, write, ["s"]), "Weight")[3]!.run();
      expect(writes).toEqual([
        { kind: "style", stringIds: ["s"], style: { thickness: STRING_THICKNESSES[3] } },
      ]);
    });

    /** One write naming every target, so a restyle of four strings is one undo
     *  entry rather than four presses of Ctrl+Z. */
    it("restyles a whole selection in one write", () => {
      span("s0", 0);
      span("s1", 300);
      chips(stringMenuRows(scene, write, ["s0", "s1"]), "Colour")[2]!.run();
      expect(writes).toEqual([
        { kind: "style", stringIds: ["s0", "s1"], style: { color: STRING_COLORS[2]!.hex } },
      ]);
    });

    it("marks what the string already is", () => {
      span("s", 0);
      scene.strings.get("s")!.color = DEFAULT_STRING_COLOR;
      const swatches = chips(stringMenuRows(scene, write, ["s"]), "Colour");
      expect(swatches.filter((c) => c.current).map((c) => c.label)).toEqual(["Red"]);
    });

    /**
     * A selection in three colours has no current colour. Marking the first
     * one's would say the other two were already that, and quietly invite the
     * user not to bother.
     */
    it("marks nothing when the selection disagrees", () => {
      span("s0", 0);
      span("s1", 300);
      scene.strings.get("s0")!.color = STRING_COLORS[0]!.hex;
      scene.strings.get("s1")!.color = STRING_COLORS[1]!.hex;
      const swatches = chips(stringMenuRows(scene, write, ["s0", "s1"]), "Colour");
      expect(swatches.filter((c) => c.current)).toEqual([]);
    });

    /** A colour the palette does not hold - an older board, or a peer on a
     *  later version - marks nothing rather than guessing at the nearest. */
    it("marks nothing for a colour off the palette", () => {
      span("s", 0);
      scene.strings.get("s")!.color = "#ff00ff";
      expect(chips(stringMenuRows(scene, write, ["s"]), "Colour").filter((c) => c.current)).toEqual([]);
    });

    /** > material (string / yarn / wire) — DESIGN section 3.4 */
    it("offers all three materials as fibre samples", () => {
      span("s", 0);
      const samples = chips(stringMenuRows(scene, write, ["s"]), "Material");
      expect(samples.map((c) => c.label)).toEqual(STRING_MATERIALS.map((m) => m.label));
      expect(samples.map((c) => c.fibre)).toEqual(["string", "yarn", "wire"]);
      // A fibre chip, not a swatch or a bar — `ui/menu.ts` paints on exactly
      // one of the three and would silently fall through to a bar.
      expect(samples.every((c) => c.swatch === undefined && c.weight === undefined)).toBe(true);
    });

    it("writes only the material", () => {
      span("s", 0);
      chips(stringMenuRows(scene, write, ["s"]), "Material")[2]!.run();
      expect(writes).toEqual([{ kind: "style", stringIds: ["s"], style: { material: "wire" } }]);
    });

    /** A new board is all plain string, so the first chip is the marked one
     *  until somebody says otherwise. */
    it("marks the material the strings already are", () => {
      span("s", 0);
      scene.strings.get("s")!.material = "yarn";
      const samples = chips(stringMenuRows(scene, write, ["s"]), "Material");
      expect(samples.filter((c) => c.current).map((c) => c.label)).toEqual(["Yarn"]);
    });

    it("marks no material when the selection disagrees", () => {
      span("s0", 0);
      span("s1", 300);
      scene.strings.get("s0")!.material = "wire";
      scene.strings.get("s1")!.material = "yarn";
      expect(
        chips(stringMenuRows(scene, write, ["s0", "s1"]), "Material").filter((c) => c.current),
      ).toEqual([]);
    });

    /**
     * The order of the three pickers, which is a claim rather than a
     * convention: material is the one restyle that moves the string, so it
     * sits below the two that only redraw it.
     */
    it("puts material last of the three pickers", () => {
      span("s", 0);
      const captions = stringMenuRows(scene, write, ["s"])
        .filter((e) => "choices" in e)
        .map((e) => e.label);
      expect(captions).toEqual(["Colour", "Weight", "Material"]);
    });
  });

  describe("delete", () => {
    it("deletes the string", () => {
      span("s", 0);
      pick(stringMenuRows(scene, write, ["s"]), "Delete");
      expect(writes).toEqual([{ kind: "delete", stringIds: ["s"] }]);
    });

    /** So the row cannot be read as "delete the one under the cursor" when the
     *  click landed on a selection of four. */
    it("counts them in the label", () => {
      span("s0", 0);
      span("s1", 300);
      const rows = stringMenuRows(scene, write, ["s0", "s1"]);
      expect(verbs(rows)[1]!.label).toBe("Delete 2 strings");
    });

    it("is drawn as destructive and set apart from the rows above it", () => {
      span("s", 0);
      const rows = stringMenuRows(scene, write, ["s"]);
      expect(verbs(rows)[1]!.danger).toBe(true);
      expect(verbs(rows)[1]!.divided).toBe(true);
    });
  });
});
