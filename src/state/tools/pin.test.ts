/**
 * The pin tool, with no document, no renderer and no browser — same seam the
 * select and note tools' tests use.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemPose } from "@/state/scene";
import { Selection } from "@/state/selection";
import { PinTool } from "@/state/tools/pin";
import type { PointerSample, ToolContext, WritePose } from "@/state/tools/tool";
import { Torsion } from "@/sim/torsion";

interface Placed {
  parent: string | null;
  x: number;
  y: number;
}

let placed: Placed[];
let settles: Map<string, WritePose>[];
let done: number;
let scene: Scene;
let tool: PinTool;
let ctx: ToolContext;

function at(x: number, y: number): PointerSample {
  return { x, y, shift: false, ctrl: false, alt: false };
}
function down(x: number, y: number): void {
  tool.handle({ kind: "down", at: at(x, y) }, ctx);
}
function up(x: number, y: number): void {
  tool.handle({ kind: "up", at: at(x, y) }, ctx);
}

function put(id: string, pose: Partial<ItemPose> = {}): void {
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x: 0, y: 0, rot: 0, w: 100, h: 100, ...pose },
  );
}

/** Insertion order is paint order, as in the real layer for equal z. */
function hitTest(bx: number, by: number): string | null {
  for (const id of [...scene.itemIds()].reverse()) {
    const slot = scene.slotOf(id)!;
    if (
      Math.abs(bx - scene.x[slot]!) <= scene.w[slot]! / 2 &&
      Math.abs(by - scene.y[slot]!) <= scene.h[slot]! / 2
    ) {
      return id;
    }
  }
  return null;
}

beforeEach(() => {
  placed = [];
  settles = [];
  done = 0;
  scene = new Scene();
  const camera = new Camera();
  camera.resize(1000, 800);
  tool = new PinTool({ onDone: () => done++ });
  ctx = {
    scene,
    dirty: new DirtySets(),
    camera,
    selection: new Selection(),
    hitTest,
    inkHitTest: hitTest,
    hitPin: () => null,
    hitString: () => null,
    // Nothing to put a caret in, in a harness with no presentation (T-179).
    edit: () => undefined,
    open: () => undefined,
    held: new Set<string>(),
    write: {
      setPoses: () => {},
      setSizes: () => {},
      deleteItems: () => {},
      setItemStyle: () => {},
      bringToFront: () => {},
      sendToBack: () => {},
      createNote: () => {},
      placePin: () => {},
    createString: () => {},
    insertPin: () => {},
    setNodeSlack: () => {},
    scaleNodeSlack: () => {},
    setStringSlack: () => {},
    scaleStringSlack: () => {},
    setStringLayer: () => {},
    deleteStrings: () => {},
    setStringStyle: () => {},
    movePins: () => {},
    commitStrokes: () => {},
    eraseStrokes: () => {},
      deletePins: () => {},
      // Kept beside `placed` rather than in it, so the placement assertions
      // above stay about placement.
      createPin: (parent, x, y, settle) => {
        placed.push({ parent, x, y });
        settles.push(new Map(settle));
      },
    },
  };
});

/**
 * The three placement rows of DESIGN section 3.3 are one rule: the click lands
 * on whatever is under it, and `parent` is either that item or null.
 */
describe("placing a pin", () => {
  it("parents it to the item under the click", () => {
    put("a");
    down(20, 10);
    up(20, 10);
    expect(placed).toEqual([{ parent: "a", x: 20, y: 10 }]);
  });

  it("leaves it free in the cork when the click is on nothing", () => {
    down(400, 400);
    up(400, 400);
    expect(placed).toEqual([{ parent: null, x: 400, y: 400 }]);
  });

  it("takes the topmost item, not the first one on the board", () => {
    put("under");
    put("over");
    down(0, 0);
    up(0, 0);
    expect(placed[0]!.parent).toBe("over");
  });

  it("puts it where the press went down, not where the hand drifted to", () => {
    down(200, 200);
    up(213, 190);
    expect(placed).toEqual([{ parent: null, x: 200, y: 200 }]);
  });

  it("converts through the camera, so it lands under the cursor at any zoom", () => {
    ctx.camera.zoomTo(2.5, 0, 0);
    ctx.camera.panByBoard(-120, 400);
    const expected = ctx.camera.screenToBoard(640, 220);
    down(640, 220);
    up(640, 220);
    expect(placed[0]!.x).toBeCloseTo(expected.x, 9);
    expect(placed[0]!.y).toBeCloseTo(expected.y, 9);
  });

  /** Nothing on screen says which tool is active, so a sticky one is a trap —
   *  the argument in `state/tools/note.ts`, and it applies here too. */
  it("hands the board back after one pin", () => {
    down(10, 10);
    up(10, 10);
    expect(done).toBe(1);
  });

  it("ignores a release that had no press before it", () => {
    up(50, 50);
    expect(placed).toEqual([]);
    expect(done).toBe(0);
  });
});

describe("giving up", () => {
  it("places nothing on Escape, and goes back to select", () => {
    down(10, 10);
    tool.handle({ kind: "key", code: "Escape", shift: false, ctrl: false, alt: false }, ctx);
    up(10, 10);
    expect(placed).toEqual([]);
    expect(done).toBe(1);
  });

  it("forgets a lost pointer without switching tool underneath the user", () => {
    down(10, 10);
    tool.handle({ kind: "cancel" }, ctx);
    up(10, 10);
    expect(placed).toEqual([]);
    expect(done).toBe(0);
  });
});

/**
 * A pin into a hanging item is the pin that stops it hanging, and the pose it
 * was hanging at is not in the document — `state/tools/frame.ts`.
 */
describe("pinning an item that hangs", () => {
  /** One pin at the top left of a 200-square, which hangs it a long way from
   *  its authored rotation, and settled with no motion the way a load is. */
  function hang(id: string): number {
    put(id, { w: 200, h: 200 });
    scene.putPin({
      id: `${id}-hook`,
      parent: id,
      lx: -80,
      ly: -60,
      kind: "pushpin",
      color: "#c8352f",
      wx: -80,
      wy: -60,
    });
    ctx.dirty.all = true;
    new Torsion().step(scene, ctx.dirty, 16);
    scene.layoutPins();
    return scene.slotOf(id)!;
  }

  it("writes the pose it was drawn at, so the paper does not spin when it goes rigid", () => {
    const slot = hang("a");
    expect(Math.abs(scene.swing[slot]!)).toBeGreaterThan(0.5);

    down(0, 0);
    up(0, 0);

    expect(placed[0]!.parent).toBe("a");
    const settle = settles[0]!;
    expect(settle.get("a")).toEqual({
      x: scene.renderX(slot),
      y: scene.renderY(slot),
      rot: scene.rot[slot]! + scene.swing[slot]!,
    });
  });

  /** Nought to one starts an item hanging, which is a swing from where it
   *  already is rather than a jump. Nothing to settle, and settling it anyway
   *  would put a pose write on the undo stack that undoes nothing visible. */
  it("settles nothing when the item had no pin at all", () => {
    put("a", { w: 200, h: 200 });
    down(0, 0);
    up(0, 0);
    expect(placed[0]!.parent).toBe("a");
    expect(settles[0]!.size).toBe(0);
  });

  /** Two to three is rigid either way. */
  it("settles nothing when the item was already rigid", () => {
    put("a", { w: 200, h: 200 });
    for (const [id, lx] of [["p1", -80], ["p2", 80]] as const) {
      scene.putPin({ id, parent: "a", lx, ly: -60, kind: "pushpin", color: "#c8352f", wx: lx, wy: -60 });
    }
    down(0, 0);
    up(0, 0);
    expect(settles[0]!.size).toBe(0);
  });

  it("settles nothing for a pin pushed into bare cork", () => {
    hang("a");
    down(400, 400);
    up(400, 400);
    expect(placed[0]!.parent).toBeNull();
    expect(settles[0]!.size).toBe(0);
  });
});
