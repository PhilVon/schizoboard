/**
 * The eraser, with no document, no renderer and no browser — the same seam the
 * marker's test uses.
 *
 * What is worth pinning down is which records it hands over and which surface it
 * names them on. Both fail quietly: erase the wrong surface and the ink you were
 * aiming at is still there, erase through a photograph and something you cannot
 * see disappears.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ERASER_SIZE, INK_SIZES, type InkSample, type InkSurface } from "@/lib/ink";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene, type SceneStroke } from "@/state/scene";
import { Selection } from "@/state/selection";
import { EraserTool } from "@/state/tools/eraser";
import type { PointerSample, ToolContext } from "@/state/tools/tool";

let erased: { surface: InkSurface; ids: readonly string[] }[];
let tool: EraserTool;
let ctx: ToolContext;
let camera: Camera;
let scene: Scene;
let under: string | null;
let done: number;

function at(x: number, y: number, ctrl = false): PointerSample {
  return { x, y, shift: false, ctrl, alt: false };
}

/** A horizontal run of ink in whatever space the caller is putting it in. */
function stroke(id: string, x0: number, y: number, x1: number, size = 6): SceneStroke {
  const samples: InkSample[] = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    samples.push({ x: x0 + ((x1 - x0) * i) / steps, y, pressure: 0.5 });
  }
  return {
    id,
    tool: "marker",
    color: "#000",
    size,
    opacity: 1,
    seed: 1,
    z: "a0",
    bbox: [Math.min(x0, x1), y, Math.max(x0, x1), y],
    samples,
  };
}

function photo(id: string, x: number, y: number, rot = 0): void {
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x, y, rot, w: 400, h: 400 },
  );
  under = id;
}

function down(x: number, y: number, ctrl = false): void {
  tool.handle({ kind: "down", at: at(x, y, ctrl) }, ctx);
}
function move(trail: readonly PointerSample[]): void {
  tool.handle({ kind: "move", at: trail[trail.length - 1]!, trail }, ctx);
}
function up(x: number, y: number): void {
  tool.handle({ kind: "up", at: at(x, y) }, ctx);
}

/** Every id handed over, in order, flattened across the calls. */
function ids(): string[] {
  return erased.flatMap((e) => [...e.ids]);
}

beforeEach(() => {
  erased = [];
  done = 0;
  camera = new Camera();
  camera.resize(1000, 800);
  // Board (0, 0) sits at screen (500, 400) — the viewport centre — so a screen
  // point in these tests is a board point offset by that and nothing else.
  camera.setView(-500, -400, 1);
  scene = new Scene();
  under = null;
  tool = new EraserTool({ onDone: () => done++ });
  ctx = {
    scene,
    dirty: new DirtySets(),
    camera,
    selection: new Selection(),
    hitTest: () => under,
    inkHitTest: () => under,
    hitPin: () => null,
    hitString: () => null,
    // Nothing to put a caret in, in a harness with no presentation (T-179).
    edit: () => undefined,
    held: new Set<string>(),
    write: {
      setPoses: () => {},
      setSizes: () => {},
      deleteItems: () => {},
      setItemStyle: () => {},
      bringToFront: () => {},
      sendToBack: () => {},
      createNote: () => {},
      createPin: () => {},
      placePin: () => {},
      deletePins: () => {},
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
      commitStrokes: () => {
        throw new Error("the eraser draws no ink");
      },
      eraseStrokes: (surface, list) => erased.push({ surface, ids: list }),
    },
  };
});

describe("erasing an item's ink", () => {
  beforeEach(() => {
    // A photograph at the board origin, 400 across, so its local space and the
    // board's differ only by the centring.
    photo("p", 0, 0);
    scene.putStrokes("p", [stroke("a", -100, 0, 100), stroke("b", -100, 150, 100)]);
  });

  it("hands over the stroke under the cursor, named on its item", () => {
    // Screen (500, 400) is board (0, 0) with this camera and viewport, which is
    // the photograph's centre and therefore its local origin.
    down(500, 400);
    up(500, 400);

    expect(ids()).toEqual(["a"]);
    expect(erased[0]!.surface).toEqual({ kind: "item", id: "p" });
  });

  it("leaves ink the rubber never reached", () => {
    down(500, 400);
    up(500, 400);
    expect(ids()).not.toContain("b");
  });

  it("takes each record once however many samples touch it", () => {
    down(450, 400);
    move([at(460, 400), at(470, 400), at(480, 400), at(490, 400)]);
    up(500, 400);

    expect(ids()).toEqual(["a"]);
  });

  /** A fast sweep is a dozen samples a frame; reading only the position leaves
   *  untouched ink between them, which is worse than a cut corner on a curve. */
  it("walks the whole trail, not just where the pointer ended up", () => {
    scene.putStrokes("p", [stroke("a", -20, 0, 20), stroke("b", -20, 150, 20)]);
    down(500, 700);
    // Straight up through both runs in one frame. Only the middle samples are
    // ever on them.
    move([at(500, 620), at(500, 550), at(500, 480), at(500, 400)]);
    up(500, 400);

    expect(ids().sort()).toEqual(["a", "b"]);
  });

  it("erases nothing at all on an item with no ink", () => {
    scene.putStrokes("p", []);
    down(500, 400);
    up(500, 400);
    expect(erased).toHaveLength(0);
  });

  /**
   * Through the item's *rendered* pose. A photograph hanging on one pin is drawn
   * at an angle that is in nobody's document, and testing against the stored pose
   * would put the rubber as far from the mark as the swing has taken the paper.
   */
  it("follows the paper's rotation", () => {
    scene.putItem(
      { id: "p", type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
      { x: 0, y: 0, rot: Math.PI / 2, w: 400, h: 400 },
    );
    scene.putStrokes("p", [stroke("a", -100, 0, 100)]);
    // The run is horizontal in the item's frame, so a quarter turn puts it
    // vertical on the board: 80 units *above* the centre is on it now, and 80
    // units to the side is not.
    down(500, 320);
    up(500, 320);
    expect(ids()).toEqual(["a"]);

    erased = [];
    down(420, 400);
    up(420, 400);
    expect(erased).toHaveLength(0);
  });
});

describe("erasing ink on the cork", () => {
  beforeEach(() => {
    scene.putBoardStrokes("0,0", [stroke("c", 0, 200, 300)]);
    scene.putBoardStrokes("1,1", [stroke("d", 2200, 2200, 2500)]);
  });

  it("names the tile the record is filed under", () => {
    down(650, 600); // board (150, 200)
    up(650, 600);

    expect(ids()).toEqual(["c"]);
    expect(erased[0]!.surface).toEqual({ kind: "tile", key: "0,0" });
  });

  it("leaves the other buckets alone", () => {
    down(650, 600);
    up(650, 600);
    expect(ids()).not.toContain("d");
  });

  /**
   * A stroke is filed by its bounding-box centre and can hang half its length
   * into a neighbouring cell, so the tile under the cursor is not necessarily the
   * tile the mark under the cursor belongs to.
   */
  it("finds a mark filed in one cell and drawn into another", () => {
    // A run from x 0 to x 4200: its centre is at 2100, which is cell 1, and it
    // reaches all the way back across cell 0.
    scene.putBoardStrokes("1,0", [stroke("long", 0, 200, 4200)]);
    down(1100, 600); // board (600, 200) — cell (0,0), and past the end of "c"
    up(1100, 600);

    expect(ids()).toEqual(["long"]);
    expect(erased[0]!.surface).toEqual({ kind: "tile", key: "1,0" });
  });
});

describe("which surface the sweep is on", () => {
  it("is fixed at the press, so a sweep off the paper does not start on the cork", () => {
    photo("p", 0, 0);
    scene.putStrokes("p", [stroke("a", -100, 0, 100)]);
    scene.putBoardStrokes("0,0", [stroke("c", 300, 0, 900)]);

    down(500, 400); // on the photograph
    move([at(700, 400), at(900, 400)]); // out over the cork, across "c"
    up(900, 400);

    expect(ids()).toEqual(["a"]);
  });

  /**
   * `Ctrl` at the press forces the cork — the pens' escape hatch (DESIGN section
   * 3.9), and the only way to reach a mark a photograph is lying on top of.
   * Without it that mark is unreachable, and erasing "whatever is nearest on any
   * surface" instead would make it *always* reachable, through the paper, with
   * nothing on screen to say so.
   */
  it("takes the cork when Ctrl is held at the press, through the paper", () => {
    photo("p", 0, 0);
    scene.putStrokes("p", [stroke("a", -100, 0, 100)]);
    scene.putBoardStrokes("0,0", [stroke("c", -100, 0, 100)]);

    down(500, 400, true);
    up(500, 400);

    expect(ids()).toEqual(["c"]);
    expect(erased[0]!.surface).toEqual({ kind: "tile", key: "0,0" });
  });

  it("does not take the cork without it", () => {
    photo("p", 0, 0);
    scene.putStrokes("p", [stroke("a", -100, 0, 100)]);
    scene.putBoardStrokes("0,0", [stroke("c", -100, 0, 100)]);

    down(500, 400);
    up(500, 400);

    expect(ids()).toEqual(["a"]);
  });
});

describe("the rubber itself", () => {
  it("starts at the size lib/ink names and walks the shared ladder", () => {
    expect(tool.size).toBe(DEFAULT_ERASER_SIZE);
    tool.step(1);
    expect(INK_SIZES).toContain(tool.size);
    expect(tool.size).toBeGreaterThan(DEFAULT_ERASER_SIZE);
  });

  it("clamps at both ends rather than wrapping", () => {
    for (let i = 0; i < 20; i++) tool.step(1);
    expect(tool.size).toBe(INK_SIZES[INK_SIZES.length - 1]);
    for (let i = 0; i < 20; i++) tool.step(-1);
    expect(tool.size).toBe(INK_SIZES[0]);
  });

  it("takes more of the board when it is wider", () => {
    photo("p", 0, 0);
    scene.putStrokes("p", [stroke("a", -100, 20, 100, 2)]);

    // 20 units off a hairline: out of reach of the finest rubber and inside the
    // widest.
    tool.step(-10);
    down(500, 400);
    up(500, 400);
    expect(erased).toHaveLength(0);

    tool.step(10);
    down(500, 400);
    up(500, 400);
    expect(ids()).toEqual(["a"]);
  });

  it("ignores a move with no button down", () => {
    photo("p", 0, 0);
    scene.putStrokes("p", [stroke("a", -100, 0, 100)]);
    move([at(500, 400)]);
    expect(erased).toHaveLength(0);
    expect(tool.sweeping).toBe(false);
  });

  it("hands the board back on Escape", () => {
    tool.handle({ kind: "key", code: "Escape", shift: false, ctrl: false, alt: false }, ctx);
    expect(done).toBe(1);
  });

  /** A cancel has nothing to revert — the records went as they were swept — so
   *  all it does is forget that a pointer was down. */
  it("forgets the gesture on a lost pointer, keeping what it already erased", () => {
    photo("p", 0, 0);
    scene.putStrokes("p", [stroke("a", -100, 0, 100)]);
    down(500, 400);
    expect(ids()).toEqual(["a"]);

    tool.handle({ kind: "cancel" }, ctx);
    expect(tool.sweeping).toBe(false);
    expect(ids()).toEqual(["a"]);
  });
});
