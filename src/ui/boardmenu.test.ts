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
import {
  DEFAULT_HIGHLIGHTER_COLOR,
  DEFAULT_HIGHLIGHTER_SIZE,
  DEFAULT_INK_SIZE,
  DEFAULT_MARKER_COLOR,
  HIGHLIGHTER_COLORS,
  INK_SIZES,
  MARKER_COLORS,
} from "@/lib/ink";
import {
  boardMenuRows,
  itemMenuRows,
  penMenuRows,
  pinMenuRows,
  stringMenuRows,
  type Pen,
} from "@/ui/boardmenu";
import type { MenuChoice, MenuEntry, MenuRow } from "@/ui/menu";

type Settle = [string, WritePose][];

type Write =
  | { kind: "layer"; stringIds: string[]; layer: "over" | "under" }
  | { kind: "style"; stringIds: string[]; style: StringStyle }
  | { kind: "delete"; stringIds: string[] }
  | { kind: "deleteItems"; ids: string[]; keepPins: boolean }
  | { kind: "createPin"; parent: string | null; lx: number; ly: number; settle: Settle }
  | { kind: "deletePins"; ids: string[]; settle: Settle }
  | { kind: "stack"; ids: string[]; end: "front" | "back" };

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
    | "setStringLayer"
    | "setStringStyle"
    | "deleteStrings"
    | "deleteItems"
    | "createPin"
    | "deletePins"
    | "bringToFront"
    | "sendToBack"
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
    bringToFront: (ids) => writes.push({ kind: "stack", ids: [...ids], end: "front" }),
    sendToBack: (ids) => writes.push({ kind: "stack", ids: [...ids], end: "back" }),
  };
  // The rows only ever reach these. Everything else on the interface is a
  // write no menu offers, and stubbing the rest would say otherwise.
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

  /**
   * T-181. Q-92 made writing on a note a double-click, which is the fastest way
   * in and the least discoverable - nothing on the board says the gesture is
   * there. This row is what says it.
   */
  describe("edit text", () => {
    it("puts the caret in the item that was right-clicked", () => {
      put("i", { x: 0, y: 0 });
      const edits: string[] = [];
      pick(itemMenuRows(scene, write, "i", ["i"], 0, 0, (id) => edits.push(id)), "Edit text");
      expect(edits).toEqual(["i"]);
      // And it is not a document write, so nothing went to the board.
      expect(writes).toEqual([]);
    });

    /**
     * The clicked one alone, like *Add pin* and for the same reason: there is
     * one caret, and a menu opened over four selected notes cannot put it in
     * all of them.
     */
    it("names the clicked item even when several are selected", () => {
      put("i0", { x: 0, y: 0 });
      put("i1", { x: 400, y: 0 });
      const edits: string[] = [];
      pick(
        itemMenuRows(scene, write, "i1", ["i0", "i1"], 400, 0, (id) => edits.push(id)),
        "Edit text",
      );
      expect(edits).toEqual(["i1"]);
    });

    it("is absent when nothing can take a caret", () => {
      put("i", { x: 0, y: 0 });
      const labels = itemMenuRows(scene, write, "i", ["i"], 0, 0).map((r) => r.label);
      expect(labels).not.toContain("Edit text");
      // The rest of the menu is unaffected by its absence.
      expect(labels).toContain("Add pin");
      expect(labels).toContain("Delete");
    });
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
      // *Add pin* is the row that goes. It is about a point on the item under
      // the cursor and there is no such item; the verbs that act on the rest of
      // the selection are unaffected by that.
      expect(verbs(rows).map((r) => r.label)).toEqual([
        "Bring to front",
        "Send to back",
        "Delete",
      ]);
      expect(verbs(rows)[0]!.divided).toBe(false);
    });
  });

  describe("z-order", () => {
    it("offers both ends, always, and groups them away from delete", () => {
      // Both rows whichever end the item is already at. A menu that hid *Bring
      // to front* on the topmost item would change shape as it was used, and
      // the op declines a write that would move nothing, so the row costs
      // nothing to leave in.
      put("i");
      const rows = itemMenuRows(scene, write, "i", ["i"], 0, 0);
      const labels = verbs(rows).map((r) => r.label);
      expect(labels).toContain("Bring to front");
      expect(labels).toContain("Send to back");
      // A rule above the pair and another above Delete: place, then order, then
      // the destructive one on its own.
      const front = verbs(rows).find((r) => r.label === "Bring to front")!;
      const back = verbs(rows).find((r) => r.label === "Send to back")!;
      expect(front.divided).toBe(true);
      expect(back.divided).toBeUndefined();
      expect(front.danger).toBeUndefined();
    });

    it("raises and lowers the whole selection, not just the clicked item", () => {
      put("i0");
      put("i1", { x: 300 });
      pick(itemMenuRows(scene, write, "i0", ["i0", "i1"], 0, 0), "Bring");
      pick(itemMenuRows(scene, write, "i0", ["i0", "i1"], 0, 0), "Send");
      expect(writes).toEqual([
        { kind: "stack", ids: ["i0", "i1"], end: "front" },
        { kind: "stack", ids: ["i0", "i1"], end: "back" },
      ]);
    });

    it("counts them in the label", () => {
      put("i0");
      put("i1", { x: 300 });
      const labels = verbs(itemMenuRows(scene, write, "i0", ["i0", "i1"], 0, 0)).map((r) => r.label);
      expect(labels).toContain("Bring 2 to front");
      expect(labels).toContain("Send 2 to back");
    });

    it("drops ids the scene no longer has", () => {
      put("i");
      pick(itemMenuRows(scene, write, "i", ["i", "vanished"], 0, 0), "Bring");
      expect(writes).toEqual([{ kind: "stack", ids: ["i"], end: "front" }]);
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
      // By label rather than by position: this row has moved down the menu once
      // already and the assertion is about the row, not about where it sits.
      const del = verbs(rows).find((r) => r.label.startsWith("Delete"))!;
      expect(del.label).toBe("Delete 2 items");
      expect(del.danger).toBe(true);
      expect(del.divided).toBe(true);
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

/**
 * The pen menu (T-134) — the fourth menu, and the only one that writes nothing.
 *
 * DESIGN section 3.9 gives each pen a palette and binds no key to it, so this is
 * the only way to pick a colour. What is worth pinning down is that the rows are
 * the *pen's* palette rather than a shared one, that the current choice is
 * marked, and that picking loads the pen rather than editing the board.
 */
describe("the pen menu", () => {
  /** A stand-in for `MarkerTool`, which is what `Pen` exists to avoid needing. */
  function pen(kind: "marker" | "highlighter"): Pen & { color: string; size: number } {
    const held = {
      kind,
      color: kind === "highlighter" ? DEFAULT_HIGHLIGHTER_COLOR : DEFAULT_MARKER_COLOR,
      size: kind === "highlighter" ? DEFAULT_HIGHLIGHTER_SIZE : DEFAULT_INK_SIZE,
      load(next: { color?: string; size?: number }) {
        if (next.color !== undefined) held.color = next.color;
        if (next.size !== undefined) held.size = next.size;
      },
    };
    return held;
  }

  it("offers each pen its own palette, not a shared one", () => {
    expect(chips(penMenuRows(pen("marker")), "Marker").map((c) => c.swatch)).toEqual(
      MARKER_COLORS.map((c) => c.hex),
    );
    expect(chips(penMenuRows(pen("highlighter")), "Highlighter").map((c) => c.swatch)).toEqual(
      HIGHLIGHTER_COLORS.map((c) => c.hex),
    );
    // A marker's green is ink read at full strength and a highlighter's is a
    // film at 0.4 over a photograph. The same hex cannot be both.
    expect(MARKER_COLORS.map((c) => c.hex)).not.toEqual(HIGHLIGHTER_COLORS.map((c) => c.hex));
  });

  it("marks what the pen is loaded with, in both rows", () => {
    const held = pen("marker");
    const current = (label: string): (string | number | undefined)[] =>
      chips(penMenuRows(held), label).filter((c) => c.current).map((c) => c.swatch ?? c.weight);

    expect(current("Marker")).toEqual([DEFAULT_MARKER_COLOR]);
    expect(current("Size")).toEqual([DEFAULT_INK_SIZE]);
  });

  it("loads the pen and writes nothing at all", () => {
    const held = pen("highlighter");
    const pink = HIGHLIGHTER_COLORS.find((c) => c.label === "Pink")!.hex;
    chips(penMenuRows(held), "Highlighter").find((c) => c.swatch === pink)!.run();
    chips(penMenuRows(held), "Size").find((c) => c.weight === 48)!.run();

    expect(held.color).toBe(pink);
    expect(held.size).toBe(48);
    // Changing pens is not an edit to the board, which is why this menu takes no
    // writer and why there is no undo entry for it.
    expect(writes).toEqual([]);
  });

  it("offers every rung of the ladder, so the keys and the chips agree", () => {
    // `[` and `]` walk INK_SIZES and the chips are INK_SIZES: two ways to the
    // same set, rather than a menu with its own idea of what the sizes are.
    expect(chips(penMenuRows(pen("marker")), "Size").map((c) => c.weight)).toEqual([...INK_SIZES]);
    expect(INK_SIZES).toContain(DEFAULT_INK_SIZE);
    expect(INK_SIZES).toContain(DEFAULT_HIGHLIGHTER_SIZE);
  });
});

describe("the board menu on bare cork", () => {
  const LINK = "schizo://join?board=demo&secret=8f14e45fceea167a5a36dedd4bea2543";
  /** A board with an invite to give away, recording what gets copied. */
  const sharing = (link: string | null) => {
    const copied: string[] = [];
    return { invite: { link, copy: (l: string) => copied.push(l) }, copied };
  };
  /** The ageing switch, recording which way it was thrown. */
  const switching = (on: boolean) => {
    const set: boolean[] = [];
    return { ageing: { on, set: (next: boolean) => set.push(next) }, set };
  };
  /** A shell that can read and write a file, recording what it was asked for. */
  const exporting = () => {
    const asked: string[] = [];
    return {
      board: {
        export: () => void asked.push("export"),
        open: () => void asked.push("open"),
        pdf: () => void asked.push("pdf"),
        image: () => void asked.push("image"),
      },
      asked,
    };
  };
  const AGE_ON = "Stop the board ageing";
  const AGE_OFF = "Let the board age";
  const EXPORT = "Export board…";
  const PDF = "Export the board as PDF…";
  const PDF_SELECTION = "Export the selection as PDF…";
  const IMAGE = "Export the board as an image…";
  const IMAGE_SELECTION = "Export the selection as an image…";
  const OPEN = "Open a board…";

  it("offers the invite on empty cork, which used to open nothing at all", () => {
    // The whole of Q-76: a right-click here reached for something and found
    // nothing, which made it the one free surface on the board.
    const { invite } = sharing(LINK);
    const rows = boardMenuRows(scene, write, [], [], invite, switching(true).ageing, null) as MenuRow[];
    expect(rows.map((r) => r.label)).toEqual([AGE_ON, "Copy invite link"]);
  });

  it("hands over the link the board was opened with", () => {
    const { invite, copied } = sharing(LINK);
    const rows = boardMenuRows(scene, write, [], [], invite, switching(true).ageing, null) as MenuRow[];
    rows.find((r) => r.label === "Copy invite link")!.run();
    expect(copied).toEqual([LINK]);
    // Sharing a board is not an edit to it.
    expect(writes).toEqual([]);
  });

  it("drops the invite entirely when there is nothing to give away", () => {
    // A plain browser, or a shell that never started a relay. Removed rather
    // than disabled: a row you cannot use is a question nothing on screen can
    // answer.
    const { invite } = sharing(null);
    const rows = boardMenuRows(scene, write, [], [], invite, switching(true).ageing, null) as MenuRow[];
    expect(rows.map((r) => r.label)).toEqual([AGE_ON]);
  });

  it("keeps the string rows, and puts the board's own below them behind a rule", () => {
    // A right-click on cork near a string is a right-click that missed, and a
    // selection of strings is the much likelier thing to have meant.
    span("s", 0);
    const { invite } = sharing(LINK);
    const rows = boardMenuRows(scene, write, ["s"], [], invite, switching(true).ageing, null);
    const labels = rows.map((r) => r.label);
    expect(labels).toEqual([
      ...stringMenuRows(scene, write, ["s"]).map((r) => r.label),
      AGE_ON,
      "Copy invite link",
    ]);
    // One rule, under the strings, rather than one above every board row.
    expect((rows.find((r) => r.label === AGE_ON) as MenuRow).divided).toBe(true);
    expect((rows.at(-1) as MenuRow).divided).toBeUndefined();
  });

  it("still offers the board rows when the selected strings are gone", () => {
    // The rows are a snapshot and a peer may have deleted the selection since.
    // That empties the string half and must not take the board half with it.
    const { invite } = sharing(LINK);
    const rows = boardMenuRows(scene, write, ["ghost"], [], invite, switching(true).ageing, null) as MenuRow[];
    expect(rows.map((r) => r.label)).toEqual([AGE_ON, "Copy invite link"]);
    // Nothing to divide it from, so no rule.
    expect(rows[0]!.divided).toBe(false);
  });

  it("offers the export under the invite, because both hand the board over", () => {
    const { invite } = sharing(LINK);
    const rows = boardMenuRows(
      scene,
      write,
      [],
      [],
      invite,
      switching(true).ageing,
      exporting().board,
    ) as MenuRow[];
    expect(rows.map((r) => r.label)).toEqual([AGE_ON, "Copy invite link", EXPORT, PDF, IMAGE, OPEN]);
  });

  it("asks the shell to export, and does not write to the document", () => {
    const { invite } = sharing(null);
    const shell = exporting();
    const rows = boardMenuRows(
      scene,
      write,
      [],
      [],
      invite,
      switching(true).ageing,
      shell.board,
    ) as MenuRow[];
    rows.find((r) => r.label === EXPORT)!.run();
    rows.find((r) => r.label === OPEN)!.run();
    expect(shell.asked).toEqual(["export", "open"]);
    // Handing a board over, or taking one, is not an edit to this one.
    expect(writes).toEqual([]);
  });

  it("drops the export in a plain browser, where nothing can write a file", () => {
    // Removed rather than disabled, on the invite's terms: a row you cannot use
    // is a question nothing on screen can answer.
    const { invite } = sharing(LINK);
    const rows = boardMenuRows(scene, write, [], [], invite, switching(true).ageing, null) as MenuRow[];
    expect(rows.map((r) => r.label)).not.toContain(EXPORT);
    expect(rows.map((r) => r.label)).not.toContain(OPEN);
  });

  it("keeps the export when there is no invite to give away", () => {
    // The two are independent: a board with no relay is still a board you can
    // hand somebody as a file, which is the case the bundle exists for.
    const { invite } = sharing(null);
    const rows = boardMenuRows(
      scene,
      write,
      [],
      [],
      invite,
      switching(true).ageing,
      exporting().board,
    ) as MenuRow[];
    expect(rows.map((r) => r.label)).toEqual([AGE_ON, EXPORT, PDF, IMAGE, OPEN]);
  });

  /**
   * Q-111 made *Open a board…* the one row here that destroys a board, so it
   * goes last — below the row somebody reading down wants far more often, and
   * below the one that makes it survivable if they take it first.
   */
  it("puts opening a board last, under the export that would have saved it", () => {
    const { invite } = sharing(LINK);
    const rows = boardMenuRows(
      scene,
      write,
      [],
      [],
      invite,
      switching(true).ageing,
      exporting().board,
    ) as MenuRow[];
    const labels = rows.map((r) => r.label);
    expect(labels.at(-1)).toBe(OPEN);
    expect(labels.indexOf(EXPORT)).toBeLessThan(labels.indexOf(OPEN));
  });

  /**
   * DESIGN section 4.7's "ageing can be turned off entirely for anyone who finds
   * it precious", which is the one row this menu always has — a board with no
   * relay and no string selected used to open nothing at all.
   */
  it("always offers the ageing switch, and names what will happen rather than what is", () => {
    const { invite } = sharing(null);
    const running = switching(true);
    const stopped = switching(false);
    expect((boardMenuRows(scene, write, [], [], invite, running.ageing, null)[0] as MenuRow).label).toBe(
      AGE_ON,
    );
    expect((boardMenuRows(scene, write, [], [], invite, stopped.ageing, null)[0] as MenuRow).label).toBe(
      AGE_OFF,
    );
  });

  it("throws the switch the other way, and does not write to the document", () => {
    const { invite } = sharing(null);
    const running = switching(true);
    (boardMenuRows(scene, write, [], [], invite, running.ageing, null)[0] as MenuRow).run();
    expect(running.set).toEqual([false]);

    const stopped = switching(false);
    (boardMenuRows(scene, write, [], [], invite, stopped.ageing, null)[0] as MenuRow).run();
    expect(stopped.set).toEqual([true]);

    // A preference is not an edit. Nothing here has an undo entry.
    expect(writes).toEqual([]);
  });

  /**
   * The PDF row (T-209), whose only interesting property is its *label*.
   *
   * A right-click on bare cork does not clear the item selection, so this menu
   * can be open over a board with three notes held — and the export would then
   * cover those three and their neighbours (Q-127) rather than the wall. A row
   * that said "the board" while writing a file of three notes would be lying in
   * exactly the case where nothing else on screen would correct it.
   */
  it("says which of the board and the selection the PDF will cover", () => {
    const { invite } = sharing(null);
    const labels = (held: readonly string[]): string[] =>
      (
        boardMenuRows(
          scene,
          write,
          [],
          held,
          invite,
          switching(true).ageing,
          exporting().board,
        ) as MenuRow[]
      ).map((r) => r.label);

    expect(labels([])).toContain(PDF);
    expect(labels(["i1", "i2", "i3"])).toContain(PDF_SELECTION);
    // One row either way — the selection changes what it says, never how many.
    expect(labels(["i1"]).filter((l) => l.endsWith("as PDF…"))).toHaveLength(1);
  });

  /**
   * The image row sits directly under the PDF one, and the two have to agree
   * about what they cover. One saying *the board* while its neighbour said
   * *the selection* would read as a difference in what goes in the file rather
   * than in what kind of file it is (T-206).
   */
  it("words the image row off the same selection as the PDF row beside it", () => {
    const { invite } = sharing(null);
    const labels = (held: readonly string[]): string[] =>
      (
        boardMenuRows(
          scene,
          write,
          [],
          held,
          invite,
          switching(true).ageing,
          exporting().board,
        ) as MenuRow[]
      ).map((r) => r.label);

    expect(labels([])).toContain(IMAGE);
    expect(labels(["i1", "i2", "i3"])).toContain(IMAGE_SELECTION);
    expect(labels(["i1"]).filter((l) => l.endsWith("as an image…"))).toHaveLength(1);
    // Neither of them names a count, for Q-127's reason: the file is a region.
    expect(labels(["i1", "i2", "i3"]).filter((l) => /\d/.test(l))).toEqual([]);
  });

  /**
   * The picture is composited and written by the shell, and the document is not
   * touched — the same standing every other row on this menu is held to.
   */
  it("asks the shell for the image, and writes nothing", () => {
    const { invite } = sharing(null);
    const shell = exporting();
    const rows = boardMenuRows(
      scene,
      write,
      [],
      [],
      invite,
      switching(true).ageing,
      shell.board,
    ) as MenuRow[];

    rows.find((r) => r.label === IMAGE)!.run();
    expect(shell.asked).toEqual(["image"]);
    expect(writes).toEqual([]);
  });

  it("does not name a count, because the file is a region and not a cutout", () => {
    // Q-127 exports the selection's *bounds*, so the file has whatever else is
    // inside them. "Export 3 items…" is the one wording that would make the
    // neighbours in the file look like a bug.
    const { invite } = sharing(null);
    const rows = boardMenuRows(
      scene,
      write,
      [],
      ["i1", "i2", "i3"],
      invite,
      switching(true).ageing,
      exporting().board,
    ) as MenuRow[];
    expect(rows.find((r) => r.label === PDF_SELECTION)!.label).not.toMatch(/\d/);
  });

  it("asks the shell for a PDF, and writes nothing to the document", () => {
    const { invite } = sharing(null);
    const shell = exporting();
    const rows = boardMenuRows(
      scene,
      write,
      [],
      [],
      invite,
      switching(true).ageing,
      shell.board,
    ) as MenuRow[];
    rows.find((r) => r.label === PDF)!.run();
    expect(shell.asked).toEqual(["pdf"]);
    expect(writes).toEqual([]);
  });

  it("drops the PDF row with the other two in a plain browser", () => {
    // A browser can print, and cannot answer whether a file was saved or shape
    // the page to the board — the same reason Q-128 turned the print dialog
    // down as the route. Removed rather than disabled, like the invite.
    const { invite } = sharing(null);
    const rows = boardMenuRows(
      scene,
      write,
      [],
      ["i1"],
      invite,
      switching(true).ageing,
      null,
    ) as MenuRow[];
    expect(rows.map((r) => r.label)).toEqual([AGE_ON]);
  });

  /**
   * Under *Export board…* because a `.schizo` is the board — everything on it,
   * reopenable — and a PDF is what it looked like. And above *Open a board…*,
   * which is the row that destroys one.
   */
  it("puts the picture under the board and above the row that replaces it", () => {
    const { invite } = sharing(null);
    const labels = (
      boardMenuRows(
        scene,
        write,
        [],
        [],
        invite,
        switching(true).ageing,
        exporting().board,
      ) as MenuRow[]
    ).map((r) => r.label);
    expect(labels.indexOf(EXPORT)).toBeLessThan(labels.indexOf(PDF));
    expect(labels.indexOf(PDF)).toBeLessThan(labels.indexOf(OPEN));
  });

  /**
   * T-210, Q-139. A shell that cannot write a PDF is not a shell that cannot
   * export: `PrintToPdf` is WebView2's, and everything else here — the bundle,
   * the image, opening a board — is a save dialog and a `write` that macOS and
   * Linux have. So this is one row leaving and not the group.
   */
  describe("a shell that cannot print a PDF", () => {
    const withoutPdf = () => {
      const shell = exporting();
      return { board: { ...shell.board, pdf: null }, asked: shell.asked };
    };

    it("drops only the PDF row, and keeps the other three", () => {
      const { invite } = sharing(null);
      const labels = (
        boardMenuRows(
          scene,
          write,
          [],
          [],
          invite,
          switching(true).ageing,
          withoutPdf().board,
        ) as MenuRow[]
      ).map((r) => r.label);
      expect(labels).not.toContain(PDF);
      expect(labels).toEqual(expect.arrayContaining([EXPORT, IMAGE, OPEN]));
    });

    /** The wording is off the selection either way — with the PDF row gone the
     *  image row has no neighbour to agree with, and still has to be honest
     *  about what the file will cover (Q-127). */
    it("still says the image covers the selection when there is one", () => {
      const { invite } = sharing(null);
      const labels = (
        boardMenuRows(
          scene,
          write,
          [],
          ["i1", "i2"],
          invite,
          switching(true).ageing,
          withoutPdf().board,
        ) as MenuRow[]
      ).map((r) => r.label);
      expect(labels).toContain(IMAGE_SELECTION);
      expect(labels).not.toContain(PDF_SELECTION);
    });

    /** The row that is left has to be the one that works. */
    it("asks the shell for an image and never for a PDF", () => {
      const { invite } = sharing(null);
      const shell = withoutPdf();
      const rows = boardMenuRows(
        scene,
        write,
        [],
        [],
        invite,
        switching(true).ageing,
        shell.board,
      ) as MenuRow[];
      rows.find((r) => r.label === IMAGE)!.run();
      expect(shell.asked).toEqual(["image"]);
    });
  });
});
