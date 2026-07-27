/**
 * What the menu offers, and what each row writes.
 *
 * No DOM here at all — that is the whole reason the rows are a pure function of
 * ids. The three tuck-behind cases came from `select.test.ts`, where they were
 * testing the interim `B` keybinding; the behaviour they pin down did not
 * change when the verb moved into a menu, and that is worth being able to see.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Scene, type ItemPose } from "@/state/scene";
import type { BoardWriter, StringStyle, WritePose } from "@/state/tools/tool";
import { STRING_MATERIALS } from "@/lib/material";
import { DEFAULT_STRING_COLOR, STRING_COLORS, STRING_THICKNESSES } from "@/lib/palette";
import { itemMenuRows, pinMenuRows, stringMenuRows } from "@/ui/boardmenu";
import type { MenuChoice, MenuEntry, MenuRow } from "@/ui/menu";

type Settle = [string, WritePose][];

type Write =
  | { kind: "layer"; stringIds: string[]; layer: "over" | "under" }
  | { kind: "style"; stringIds: string[]; style: StringStyle }
  | { kind: "delete"; stringIds: string[] }
  | { kind: "deleteItems"; ids: string[]; keepPins: boolean }
  | { kind: "createPin"; parent: string | null; lx: number; ly: number; settle: Settle }
  | { kind: "deletePins"; ids: string[]; settle: Settle };

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

/** An item at a pose. 100x100 at the origin unless told otherwise. */
function put(id: string, pose: Partial<ItemPose> = {}): void {
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x: 0, y: 0, rot: 0, w: 100, h: 100, ...pose },
  );
}

/** A pin in an item, or in the bare cork when `parent` is null. */
function pin(id: string, parent: string | null, lx = 0, ly = 0): void {
  scene.putPin({ id, parent, lx, ly, kind: "pushpin", color: "#c8352c", wx: lx, wy: ly });
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
  const partial: Pick<
    BoardWriter,
    "setStringLayer" | "setStringStyle" | "deleteStrings" | "deleteItems" | "createPin" | "deletePins"
  > = {
    setStringLayer: (stringIds, layer) =>
      writes.push({ kind: "layer", stringIds: [...stringIds], layer }),
    setStringStyle: (stringIds, style) =>
      writes.push({ kind: "style", stringIds: [...stringIds], style: { ...style } }),
    deleteStrings: (stringIds) => writes.push({ kind: "delete", stringIds: [...stringIds] }),
    deleteItems: (ids, keepPins) => writes.push({ kind: "deleteItems", ids: [...ids], keepPins }),
    createPin: (parent, lx, ly, settle) =>
      writes.push({ kind: "createPin", parent, lx, ly, settle: [...(settle ?? [])] }),
    deletePins: (ids, settle) =>
      writes.push({ kind: "deletePins", ids: [...ids], settle: [...(settle ?? [])] }),
  };
  // The rows only ever reach these five. Everything else on the interface is a
  // write no menu offers, and stubbing eleven of them would say otherwise.
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

describe("the item context menu", () => {
  it("offers nothing when the item is no longer on the board", () => {
    expect(itemMenuRows(scene, write, "gone", ["gone"], 0, 0)).toEqual([]);
  });

  describe("add pin", () => {
    /** > | Add without switching tools | Item context menu -> *Add pin* | Pin at
     *  > the click point - DESIGN section 3.2 */
    it("pushes a pin into the clicked item, at the click point in its own frame", () => {
      put("i", { x: 100, y: 50 });
      pick(itemMenuRows(scene, write, "i", ["i"], 130, 90), "Add pin");
      expect(writes).toEqual([{ kind: "createPin", parent: "i", lx: 30, ly: 40, settle: [] }]);
    });

    /**
     * The conversion goes through the pose the item is *drawn* at, which for a
     * hanging one is neither its stored centre nor its stored angle. Aiming at
     * the top-left corner of a photograph swung a quarter turn has to put the
     * pin in that corner of the paper, not in the corner the document says it
     * would have if it were not hanging.
     */
    it("converts through the rendered pose, so a swinging item takes the pin where it looks", () => {
      put("i");
      const slot = scene.slotOf("i")!;
      scene.swing[slot] = Math.PI / 2;
      scene.driftX[slot] = 200;

      pick(itemMenuRows(scene, write, "i", ["i"], 200, 40), "Add pin");
      const [written] = writes as [Extract<Write, { kind: "createPin" }>];
      // A quarter turn: the point 40 above the drawn centre is 40 to the *left*
      // of it in the item's own frame.
      expect(written.lx).toBeCloseTo(40);
      expect(written.ly).toBeCloseTo(0);
    });

    /**
     * One pin hangs and two are rigid (DESIGN section 5.5), so the second pin
     * is the one that ends the swing - and `sim/torsion.ts` ends it by zeroing
     * transients the document has never held. The pose the item was drawn at,
     * written in the same transaction, is what stops the paper (and the pin
     * just placed in it) jumping.
     */
    it("settles an item that was hanging by its one pin", () => {
      put("i");
      pin("p", "i");
      const slot = scene.slotOf("i")!;
      scene.swing[slot] = 0.3;
      scene.driftX[slot] = 7;
      scene.driftY[slot] = -4;

      pick(itemMenuRows(scene, write, "i", ["i"], 0, 0), "Add pin");
      const [written] = writes as [Extract<Write, { kind: "createPin" }>];
      // The angle comes back through a `Float32Array`, so it is the rotation
      // that was set to within a float's worth of it and not to the bit.
      expect(written.settle).toEqual([["i", { x: 7, y: -4, rot: expect.closeTo(0.3) }]]);
    });

    it("settles nothing for an item that was already rigid", () => {
      put("i");
      pin("p0", "i");
      pin("p1", "i", 10);
      pick(itemMenuRows(scene, write, "i", ["i"], 0, 0), "Add pin");
      expect((writes[0] as Extract<Write, { kind: "createPin" }>).settle).toEqual([]);
    });

    /**
     * The one row here that is about the *clicked* item rather than the
     * targets: a pin goes somewhere, and a menu opened over four selected
     * photographs still only has one cursor.
     */
    it("pins only the item under the cursor, however many are selected", () => {
      put("i0", { x: 100 });
      put("i1", { x: 400 });
      pick(itemMenuRows(scene, write, "i1", ["i0", "i1"], 400, 0), "Add pin");
      expect(writes).toEqual([{ kind: "createPin", parent: "i1", lx: 0, ly: 0, settle: [] }]);
    });

    /** A peer deleted the item under the cursor between the press and the menu.
     *  The verbs against the rest of the selection survive; the row that needs
     *  a place to put a pin does not. */
    it("is dropped when the clicked item is gone but the selection is not", () => {
      put("i0");
      const rows = itemMenuRows(scene, write, "gone", ["i0", "gone"], 0, 0);
      expect(verbs(rows).map((r) => r.label)).toEqual(["Delete"]);
      expect(verbs(rows)[0]!.divided).toBe(false);
    });
  });

  describe("delete", () => {
    /** > `Delete` | Removes the item and its pins; strings through those pins
     *  > heal - DESIGN section 3.8 */
    it("deletes the item, and does not keep its pins", () => {
      put("i");
      pick(itemMenuRows(scene, write, "i", ["i"], 0, 0), "Delete");
      expect(writes).toEqual([{ kind: "deleteItems", ids: ["i"], keepPins: false }]);
    });

    it("counts them in the label, and is drawn as destructive", () => {
      put("i0");
      put("i1", { x: 300 });
      const rows = itemMenuRows(scene, write, "i0", ["i0", "i1"], 0, 0);
      expect(verbs(rows)[1]!.label).toBe("Delete 2 items");
      expect(verbs(rows)[1]!.danger).toBe(true);
      expect(verbs(rows)[1]!.divided).toBe(true);
    });

    it("drops ids the scene no longer has", () => {
      put("i");
      pick(itemMenuRows(scene, write, "i", ["i", "vanished"], 0, 0), "Delete");
      expect(writes).toEqual([{ kind: "deleteItems", ids: ["i"], keepPins: false }]);
    });
  });
});

describe("the pin context menu", () => {
  it("offers nothing when the pin is no longer on the board", () => {
    expect(pinMenuRows(scene, write, ["gone"])).toEqual([]);
  });

  /** > | Remove | `Alt`+click, or context menu | Strings through it heal
   *  > - DESIGN section 3.3 */
  it("removes the pin", () => {
    pin("p", null);
    const rows = pinMenuRows(scene, write, ["p"]);
    expect(verbs(rows).map((r) => r.label)).toEqual(["Remove"]);
    expect(verbs(rows)[0]!.danger).toBe(true);
    pick(rows, "Remove");
    expect(writes).toEqual([{ kind: "deletePins", ids: ["p"], settle: [] }]);
  });

  it("counts them in the label, and drops ids the scene no longer has", () => {
    pin("p0", null);
    pin("p1", null, 40);
    expect(verbs(pinMenuRows(scene, write, ["p0", "p1"]))[0]!.label).toBe("Remove 2 pins");
    pick(pinMenuRows(scene, write, ["p0", "vanished"]), "Remove");
    expect(writes).toEqual([{ kind: "deletePins", ids: ["p0"], settle: [] }]);
  });

  /**
   * The mirror of the settle above, and the one that T-107 was: an item hanging
   * by the pin about to go is drawn at an angle the document has never held, so
   * without this the paper snaps back to its authored rotation the instant the
   * pin leaves.
   */
  it("settles an item that was hanging by the pin being removed", () => {
    put("i");
    pin("p", "i");
    const slot = scene.slotOf("i")!;
    scene.swing[slot] = -0.2;
    scene.driftY[slot] = 12;

    pick(pinMenuRows(scene, write, ["p"]), "Remove");
    expect(writes).toEqual([
      { kind: "deletePins", ids: ["p"], settle: [["i", { x: 0, y: 12, rot: expect.closeTo(-0.2) }]] },
    ]);
  });

  /** Two of two going at once is a rigid item becoming a free one, which has no
   *  transient to lose - so the count of one is the whole test even here. */
  it("settles nothing when a rigid item loses both its pins", () => {
    put("i");
    pin("p0", "i");
    pin("p1", "i", 10);
    pick(pinMenuRows(scene, write, ["p0", "p1"]), "Remove");
    expect((writes[0] as Extract<Write, { kind: "deletePins" }>).settle).toEqual([]);
  });
});
