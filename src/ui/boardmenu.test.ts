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
import type { BoardWriter } from "@/state/tools/tool";
import { stringMenuRows } from "@/ui/boardmenu";

type Write =
  | { kind: "layer"; stringIds: string[]; layer: "over" | "under" }
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

/** Pick a row by label prefix and run it. */
function pick(rows: ReturnType<typeof stringMenuRows>, label: string): void {
  const row = rows.find((r) => r.label.startsWith(label));
  if (row === undefined) throw new Error(`no row starting "${label}" in ${rows.map((r) => r.label).join(", ")}`);
  row.run();
}

beforeEach(() => {
  scene = new Scene();
  writes = [];
  const partial: Pick<BoardWriter, "setStringLayer" | "deleteStrings"> = {
    setStringLayer: (stringIds, layer) =>
      writes.push({ kind: "layer", stringIds: [...stringIds], layer }),
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
    expect(stringMenuRows(scene, write, ["s", "vanished"])).toHaveLength(2);
    expect(stringMenuRows(scene, write, ["vanished"])).toEqual([]);
  });

  describe("tuck behind", () => {
    it("puts a string under the items", () => {
      span("s", 0);
      const rows = stringMenuRows(scene, write, ["s"]);
      expect(rows[0]!.label).toBe("Tuck behind");
      pick(rows, "Tuck");
      expect(writes).toEqual([{ kind: "layer", stringIds: ["s"], layer: "under" }]);
    });

    it("brings it back over when it is already under, and says so", () => {
      span("s", 0, "under");
      const rows = stringMenuRows(scene, write, ["s"]);
      expect(rows[0]!.label).toBe("Bring in front");
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
      expect(rows[1]!.label).toBe("Delete 2 strings");
    });

    it("is drawn as destructive and set apart from the rows above it", () => {
      span("s", 0);
      const rows = stringMenuRows(scene, write, ["s"]);
      expect(rows[1]!.danger).toBe(true);
      expect(rows[1]!.divided).toBe(true);
    });
  });
});
