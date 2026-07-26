/**
 * The select tool, with no document, no renderer and no browser.
 *
 * That is the point of the seam in `tool.ts`: everything below is the real
 * gesture logic driven by the same `ToolInput`s the machine would hand it, and
 * the only stand-ins are a hit test and a writer that records instead of
 * writing. If a test here needs a DOM, the tool has grown a dependency it is
 * not allowed to have.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { CAPTURE_TIMEOUT_MS } from "@/crdt/undo";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";
import { Selection } from "@/state/selection";
import { MIN_RESIZE, LIVE_WRITE_MS, SelectTool } from "@/state/tools/select";
import type { PointerSample, ToolContext, WritePose, WriteSize } from "@/state/tools/tool";

type Write =
  | { kind: "poses"; phase: "live" | "final"; poses: Map<string, WritePose> }
  | { kind: "sizes"; phase: "live" | "final"; sizes: Map<string, WriteSize> }
  | { kind: "delete"; ids: string[]; keepPins: boolean };

let scene: Scene;
let dirty: DirtySets;
let camera: Camera;
let selection: Selection;
let tool: SelectTool;
let writes: Write[];
let held: Set<string>;
let ctx: ToolContext;

/** Insertion order is paint order, as it is in the real layer for equal z. */
function hitTest(bx: number, by: number): string | null {
  const ids = [...scene.itemIds()].reverse();
  for (const id of ids) {
    const slot = scene.slotOf(id)!;
    const a = -(scene.rot[slot]! + scene.swing[slot]!);
    const dx = bx - scene.x[slot]!;
    const dy = by - scene.y[slot]!;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= scene.w[slot]! / 2 && Math.abs(ly) <= scene.h[slot]! / 2) return id;
  }
  return null;
}

function put(id: string, x: number, y: number, w = 100, h = 100, rot = 0): void {
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x, y, rot, w, h },
  );
}

/** A sheet of paper, which is the only thing that resizes. */
function paper(id: string, x: number, y: number, w = 200, h = 100, rot = 0): void {
  scene.putItem(
    { id, type: "note", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x, y, rot, w, h },
  );
}

function at(x: number, y: number, mods: Partial<PointerSample> = {}): PointerSample {
  return { x, y, shift: false, ctrl: false, alt: false, ...mods };
}

function down(x: number, y: number, mods?: Partial<PointerSample>): void {
  tool.handle({ kind: "down", at: at(x, y, mods) }, ctx);
}
function move(x: number, y: number, mods?: Partial<PointerSample>): void {
  tool.handle({ kind: "move", at: at(x, y, mods) }, ctx);
}
function up(x: number, y: number): void {
  tool.handle({ kind: "up", at: at(x, y) }, ctx);
}
function key(code: string, mods: { shift?: boolean; ctrl?: boolean } = {}): void {
  tool.handle(
    { kind: "key", code, shift: mods.shift ?? false, ctrl: mods.ctrl ?? false, alt: false },
    ctx,
  );
}
function tick(dt = 16): void {
  tool.tick(dt, ctx);
}

function lastPoses(): Map<string, WritePose> {
  for (let i = writes.length - 1; i >= 0; i--) {
    const w = writes[i]!;
    if (w.kind === "poses") return w.poses;
  }
  throw new Error("no pose write");
}

function lastSizes(): Map<string, WriteSize> {
  for (let i = writes.length - 1; i >= 0; i--) {
    const w = writes[i]!;
    if (w.kind === "sizes") return w.sizes;
  }
  throw new Error("no size write");
}

beforeEach(() => {
  scene = new Scene();
  dirty = new DirtySets();
  camera = new Camera();
  camera.resize(1000, 800);
  selection = new Selection();
  tool = new SelectTool();
  writes = [];
  held = new Set<string>();
  ctx = {
    scene,
    dirty,
    camera,
    selection,
    hitTest,
    held,
    write: {
      setPoses: (poses, phase) => writes.push({ kind: "poses", phase, poses: new Map(poses) }),
      setSizes: (sizes, phase) => writes.push({ kind: "sizes", phase, sizes: new Map(sizes) }),
      deleteItems: (ids, keepPins) => writes.push({ kind: "delete", ids: [...ids], keepPins }),
    },
  };
});

describe("selecting", () => {
  it("selects what is under the cursor and deselects on bare cork", () => {
    put("a", 0, 0);
    down(0, 0);
    up(0, 0);
    expect(selection.toArray()).toEqual(["a"]);

    down(400, 400);
    up(400, 400);
    expect(selection.isEmpty).toBe(true);
  });

  it("extends with shift, and shift on a selected item removes it", () => {
    put("a", 0, 0);
    put("b", 300, 0);

    down(0, 0);
    up(0, 0);
    down(300, 0, { shift: true });
    up(300, 0);
    expect(selection.toArray().sort()).toEqual(["a", "b"]);

    down(300, 0, { shift: true });
    up(300, 0);
    expect(selection.toArray()).toEqual(["a"]);
  });

  it("keeps a multiple selection while one of its members is being pressed", () => {
    put("a", 0, 0);
    put("b", 300, 0);
    down(0, 0);
    up(0, 0);
    down(300, 0, { shift: true });
    up(300, 0);

    // Pressing an already-selected item must not collapse the selection to it,
    // or dragging a group would only ever move one of them.
    down(0, 0);
    expect(selection.size).toBe(2);

    // ...but if the press turns out to have been a click, it means that one.
    up(0, 0);
    expect(selection.toArray()).toEqual(["a"]);
  });

  it("does not narrow the selection when the press became a drag", () => {
    put("a", 0, 0);
    put("b", 300, 0);
    down(0, 0);
    up(0, 0);
    down(300, 0, { shift: true });
    up(300, 0);

    down(0, 0);
    move(80, 40);
    up(80, 40);
    expect(selection.size).toBe(2);
    expect(scene.poseOf("b")!.x).toBeCloseTo(380, 4);
  });

  it("drops ids a collaborator deleted rather than dragging ghosts", () => {
    put("a", 0, 0);
    down(0, 0);
    up(0, 0);
    scene.removeItem("a");

    down(400, 400);
    expect(selection.isEmpty).toBe(true);
  });

  it("takes what is on screen for Ctrl+A, not the whole board", () => {
    put("near", 100, 100);
    put("far", 9000, 9000);
    key("KeyA", { ctrl: true });
    expect(selection.toArray()).toEqual(["near"]);
  });
});

describe("dragging", () => {
  beforeEach(() => {
    put("a", 0, 0);
    put("b", 300, 0);
  });

  it("does not move anything for a press that trembles", () => {
    down(0, 0);
    move(2, 1);
    up(2, 1);
    expect(scene.poseOf("a")!.x).toBe(0);
    expect(writes).toEqual([]);
  });

  it("moves the whole selection by the board delta, and lands exactly there", () => {
    down(0, 0);
    up(0, 0);
    down(300, 0, { shift: true });
    up(300, 0);

    // A deliberately unfriendly delta: nothing snaps to anything, so it must
    // arrive at exactly this and not at a tidier number nearby.
    down(0, 0);
    move(37.4, -12.9);
    up(37.4, -12.9);

    expect(scene.poseOf("a")!.x).toBeCloseTo(37.4, 4);
    expect(scene.poseOf("a")!.y).toBeCloseTo(-12.9, 4);
    expect(scene.poseOf("b")!.x).toBeCloseTo(337.4, 4);
    expect(scene.poseOf("b")!.y).toBeCloseTo(-12.9, 4);
  });

  it("measures the delta in board space, so it survives the zoom", () => {
    camera.zoomTo(2, 0, 0);
    down(0, 0);
    up(0, 0);
    down(0, 0);
    // 100 screen pixels at 2x is 50 board units.
    move(100, 0);
    up(100, 0);
    expect(scene.poseOf("a")!.x).toBeCloseTo(50, 4);
  });

  it("leaves the item under the cursor when the camera zooms mid-drag", () => {
    down(0, 0);
    up(0, 0);
    down(0, 0);
    move(200, 0);
    const before = scene.poseOf("a")!.x;

    // Zooming about the cursor keeps the same board point under it, so the
    // delta is unchanged and the item does not jump.
    camera.zoomTo(3, 200, 0);
    move(200, 0);
    expect(scene.poseOf("a")!.x).toBeCloseTo(before, 4);
  });

  it("writes once on release", () => {
    down(0, 0);
    up(0, 0);
    down(0, 0);
    move(50, 50);
    up(50, 50);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "poses", phase: "final" });
    expect(lastPoses().get("a")).toEqual({ x: 50, y: 50 });
    // A plain drag leaves the rotation alone.
    expect(lastPoses().get("a")).not.toHaveProperty("rot");
  });

  it("writes a crash-safety pose while a long drag is still going", () => {
    down(0, 0);
    up(0, 0);
    down(0, 0);
    move(50, 0);
    tick(200);
    expect(writes).toHaveLength(0);
    tick(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ phase: "live" });

    move(80, 0);
    up(80, 0);
    expect(writes[1]).toMatchObject({ phase: "final" });
    expect(lastPoses().get("a")).toEqual({ x: 80, y: 0 });
  });

  it("takes the release position, not the last move sampled before it", () => {
    down(0, 0);
    up(0, 0);
    down(0, 0);
    move(50, 0);
    up(400, 0);
    expect(scene.poseOf("a")!.x).toBeCloseTo(400, 4);
  });

  it("reverts everything on Escape mid-drag", () => {
    down(0, 0);
    up(0, 0);
    down(0, 0);
    move(120, 90);
    expect(scene.poseOf("a")!.x).toBeCloseTo(120, 4);

    key("Escape");
    expect(scene.poseOf("a")!.x).toBe(0);
    expect(scene.poseOf("a")!.y).toBe(0);
    // Nothing had reached the document, so nothing has to be un-written.
    expect(writes).toEqual([]);
  });

  it("writes the revert when a crash-safety pose already landed", () => {
    down(0, 0);
    up(0, 0);
    down(0, 0);
    move(120, 90);
    tick(400);
    expect(writes).toHaveLength(1);

    key("Escape");
    expect(scene.poseOf("a")!.x).toBe(0);
    // Otherwise the document keeps the half-finished pose and the observer
    // pulls the item straight back out again.
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ phase: "final" });
    expect(lastPoses().get("a")).toMatchObject({ x: 0, y: 0 });
  });

  it("abandons the gesture when the pointer is cancelled", () => {
    down(0, 0);
    up(0, 0);
    down(0, 0);
    move(120, 90);
    tool.handle({ kind: "cancel" }, ctx);
    expect(scene.poseOf("a")!.x).toBe(0);
    expect(tool.gesturing).toBe(false);
  });
});

describe("the carry", () => {
  beforeEach(() => {
    put("a", 0, 0);
    down(0, 0);
    up(0, 0);
  });

  it("lifts the item and leans it into the direction of travel", () => {
    const slot = scene.slotOf("a")!;
    down(0, 0);
    move(10, 0);
    tick();
    expect(scene.lift[slot]).toBeGreaterThan(0);

    move(210, 0);
    tick();
    // Carried to the right, an object held above its centre trails to the
    // left — a clockwise turn in a y-down space, so a positive angle.
    expect(scene.swing[slot]).toBeGreaterThan(0);

    move(10, 0);
    tick();
    tick();
    expect(scene.swing[slot]).toBeLessThan(0);
  });

  it("settles back to nothing after it is put down", () => {
    const slot = scene.slotOf("a")!;
    down(0, 0);
    move(10, 0);
    tick();
    move(210, 0);
    tick();
    up(210, 0);

    for (let i = 0; i < 30; i++) tick(100);
    expect(scene.lift[slot]).toBe(0);
    expect(scene.swing[slot]).toBe(0);
  });

  it("leaves nothing lifted when the gesture is abandoned", () => {
    const slot = scene.slotOf("a")!;
    down(0, 0);
    move(10, 0);
    tick();
    move(210, 0);
    tick();
    expect(scene.lift[slot]).toBeGreaterThan(0);

    // Nothing ticks the tool after a switch or a teardown, so a cancel that
    // only started an ease would strand the item scaled up and lit.
    tool.cancel(ctx);
    expect(scene.lift[slot]).toBe(0);
    expect(scene.swing[slot]).toBe(0);
  });

  it("lifts a rotation but does not lean it", () => {
    held.add("KeyR");
    const slot = scene.slotOf("a")!;
    down(30, 0);
    move(60, 120);
    tick();
    expect(scene.lift[slot]).toBeGreaterThan(0);
    expect(scene.swing[slot]).toBe(0);
  });
});

describe("rotating", () => {
  it("spins a single item in place", () => {
    put("a", 0, 0, 200, 200);
    down(0, 0);
    up(0, 0);

    held.add("KeyR");
    // Out along +x, then round to +y: a quarter turn.
    down(80, 0);
    move(120, 0);
    move(0, 120);
    up(0, 120);

    const pose = scene.poseOf("a")!;
    expect(pose.rot).toBeCloseTo(Math.PI / 2, 3);
    expect(pose.x).toBeCloseTo(0, 3);
    expect(pose.y).toBeCloseTo(0, 3);
    expect(lastPoses().get("a")).toMatchObject({ rot: expect.any(Number) });
  });

  it("turns a group about its centre, carrying the members round with it", () => {
    put("a", -200, 0, 100, 100);
    put("b", 200, 0, 100, 100);
    down(-200, 0);
    up(-200, 0);
    down(200, 0, { shift: true });
    up(200, 0);
    expect(selection.size).toBe(2);

    held.add("KeyR");
    down(-200, 0);
    move(-160, 0);
    // The pivot is the centre of the pair, at the origin. Swinging the cursor
    // from due left to due down is a quarter turn, and it has to take both
    // items round with it rather than spinning each where it stands.
    move(0, 300);
    up(0, 300);

    expect(scene.poseOf("a")!.x).toBeCloseTo(0, 2);
    expect(scene.poseOf("a")!.y).toBeCloseTo(200, 2);
    expect(scene.poseOf("b")!.x).toBeCloseTo(0, 2);
    expect(scene.poseOf("b")!.y).toBeCloseTo(-200, 2);
    expect(scene.poseOf("a")!.rot).toBeCloseTo(-Math.PI / 2, 3);
  });

  it("ignores the angle while the cursor is on top of the pivot", () => {
    put("a", 0, 0, 400, 400);
    down(0, 0);
    up(0, 0);

    held.add("KeyR");
    down(0, 0);
    // Inside the dead radius, so waggling about tells us nothing about which
    // way the user wants it turned.
    move(6, 0);
    move(0, 6);
    move(-6, 0);
    expect(scene.poseOf("a")!.rot).toBe(0);
  });

  it("accumulates past half a turn without unwinding at the seam", () => {
    put("a", 0, 0, 100, 100);
    down(0, 0);
    up(0, 0);

    held.add("KeyR");
    down(30, 0);
    move(100, 0);
    // Three quarters round, in steps small enough to be unambiguous.
    move(0, 100);
    move(-100, 0);
    move(0, -100);
    expect(scene.poseOf("a")!.rot).toBeCloseTo((3 * Math.PI) / 2, 3);
  });
});

describe("the rotation handle", () => {
  /** Where the knob sits for a 100x100 item at the board origin: 50 of item,
   *  3.25 of chrome offset, 26 of stalk. */
  const KNOB_Y = -79.25;

  function selectOnly(id: string, x: number, y: number): void {
    down(x, y);
    up(x, y);
    expect(selection.toArray()).toEqual([id]);
  }

  it("turns the item, rather than starting the marquee it is standing on", () => {
    put("a", 0, 0, 100, 100);
    selectOnly("a", 0, 0);

    // The knob is out over bare cork. A press there used to mean "marquee", and
    // a marquee started off an item clears the selection the knob belongs to.
    down(0, KNOB_Y);
    expect(tool.marquee).toBeNull();
    move(100, 0);
    move(0, 100);
    up(0, 100);

    expect(selection.toArray()).toEqual(["a"]);
    const pose = scene.poseOf("a")!;
    expect(pose.rot).toBeCloseTo(Math.PI / 2, 3);
    // A single item turns about its own centre, so it has not travelled.
    expect(pose.x).toBeCloseTo(0, 6);
    expect(pose.y).toBeCloseTo(0, 6);
  });

  it("rides the item's own rotation, so it is always off the top of the paper", () => {
    put("a", 0, 0, 100, 100, Math.PI / 2);
    selectOnly("a", 0, 0);
    // A quarter turn puts the paper's top edge — and its handle — due east.
    down(-KNOB_Y, 0);
    move(-KNOB_Y, 60);
    up(-KNOB_Y, 60);
    expect(scene.poseOf("a")!.rot).toBeGreaterThan(Math.PI / 2);
  });

  it("does nothing at all for a click that never becomes a drag", () => {
    put("a", 0, 0, 100, 100);
    selectOnly("a", 0, 0);
    writes.length = 0;

    down(0, KNOB_Y);
    up(0, KNOB_Y);
    expect(writes).toEqual([]);
    expect(selection.toArray()).toEqual(["a"]);
    expect(scene.poseOf("a")!.rot).toBe(0);
  });

  it("belongs to one item, so a group still has to use R+drag", () => {
    put("a", -200, 0, 100, 100);
    put("b", 200, 0, 100, 100);
    selection.replace(["a", "b"]);

    // Where "a"'s knob would be if it had one on its own. With two items
    // selected there is no chrome to grab, so this is a marquee on bare cork.
    down(-200, KNOB_Y);
    move(-190, KNOB_Y + 10);
    expect(tool.marquee).not.toBeNull();
  });
});

describe("resizing paper from its edges", () => {
  /** A 200x100 note at (200, 200): edges at x 100 and 300, y 150 and 250. */
  function note(): void {
    paper("n", 200, 200, 200, 100);
    down(200, 200);
    up(200, 200);
    writes.length = 0;
  }

  it("moves the edge you have hold of and leaves the opposite one exactly", () => {
    note();
    down(300, 200);
    move(350, 200);
    up(350, 200);

    const pose = scene.poseOf("n")!;
    expect(pose.w).toBeCloseTo(250, 6);
    expect(pose.h).toBeCloseTo(100, 6);
    expect(pose.x - pose.w / 2).toBeCloseTo(100, 6);
    expect(lastSizes().get("n")).toMatchObject({ w: 250, h: 100 });
  });

  it("takes both axes from a corner, and the far corner stays put", () => {
    note();
    down(300, 250);
    move(340, 280);
    up(340, 280);

    const pose = scene.poseOf("n")!;
    expect(pose.w).toBeCloseTo(240, 6);
    expect(pose.h).toBeCloseTo(130, 6);
    expect(pose.x - pose.w / 2).toBeCloseTo(100, 6);
    expect(pose.y - pose.h / 2).toBeCloseTo(150, 6);
  });

  it("grows along the paper's own axes when the paper is turned", () => {
    paper("n", 0, 0, 200, 100, Math.PI / 2);
    down(0, 0);
    up(0, 0);
    // A quarter turn: the note's own east edge points due south, at y = +100.
    down(0, 100);
    move(0, 140);
    up(0, 140);

    const pose = scene.poseOf("n")!;
    expect(pose.w).toBeCloseTo(240, 4);
    // The centre travelled south by half the growth, and nowhere else.
    expect(pose.x).toBeCloseTo(0, 4);
    expect(pose.y).toBeCloseTo(20, 4);
  });

  it("stops at the floor without the anchored edge sliding away", () => {
    note();
    down(300, 200);
    move(0, 200);
    expect(scene.poseOf("n")!.w).toBeCloseTo(MIN_RESIZE, 6);
    expect(scene.poseOf("n")!.x - MIN_RESIZE / 2).toBeCloseTo(100, 6);

    // Dragging further must not ratchet the note off across the board.
    move(-400, 200);
    expect(scene.poseOf("n")!.w).toBeCloseTo(MIN_RESIZE, 6);
    expect(scene.poseOf("n")!.x - MIN_RESIZE / 2).toBeCloseTo(100, 6);
  });

  it("leaves a photograph alone — its edge is somewhere to pick it up", () => {
    put("p", 200, 200, 200, 100);
    down(200, 200);
    up(200, 200);
    writes.length = 0;

    // Just inside the east edge, which on a note would be the resize band.
    down(299, 200);
    move(319, 200);
    up(319, 200);

    const pose = scene.poseOf("p")!;
    expect(pose.w).toBeCloseTo(200, 6);
    expect(pose.x).toBeCloseTo(220, 6);
    expect(writes.every((w) => w.kind !== "sizes")).toBe(true);
  });

  it("writes a crash-safety size while a long resize is still going", () => {
    note();
    down(300, 200);
    move(340, 200);
    tick(LIVE_WRITE_MS);
    expect(writes.filter((w) => w.kind === "sizes" && w.phase === "live")).toHaveLength(1);

    move(360, 200);
    up(360, 200);
    expect(lastSizes().get("n")).toMatchObject({ w: 260 });
    // One entry per gesture: the live write is merged into the release's, which
    // is what the shared undo capture window is for.
    expect(writes.filter((w) => w.kind === "sizes" && w.phase === "final")).toHaveLength(1);
  });

  it("puts the note back on Escape, through the op that moved its pins", () => {
    note();
    down(300, 200);
    move(360, 200);
    tick(LIVE_WRITE_MS);
    key("Escape");

    const pose = scene.poseOf("n")!;
    expect(pose.w).toBeCloseTo(200, 6);
    expect(pose.x).toBeCloseTo(200, 6);
    // The document is holding the intermediate size, so putting the scene back
    // is not enough — and the revert has to go back through the resize op, or
    // the pins it moved on the way out stay moved.
    expect(lastSizes().get("n")).toMatchObject({ x: 200, y: 200, w: 200, h: 100 });
  });
});

describe("the marquee", () => {
  beforeEach(() => {
    put("in", 0, 0, 100, 100);
    put("edge", 160, 0, 100, 100);
    put("out", 600, 600, 100, 100);
  });

  it("takes what it touches and leaves what it misses", () => {
    down(-300, -300);
    move(120, 120);
    expect(tool.marquee).toMatchObject({ minX: -300, minY: -300, maxX: 120, maxY: 120 });
    expect(selection.toArray().sort()).toEqual(["edge", "in"]);
    up(120, 120);
    expect(tool.marquee).toBeNull();
  });

  it("works dragged up and to the left, which is half of all marquees", () => {
    down(120, 120);
    move(-300, -300);
    expect(selection.toArray().sort()).toEqual(["edge", "in"]);
  });

  it("extends the existing selection with shift", () => {
    down(600, 600);
    up(600, 600);
    expect(selection.toArray()).toEqual(["out"]);

    down(-300, -300, { shift: true });
    move(60, 60);
    expect(selection.toArray().sort()).toEqual(["in", "out"]);
  });

  it("puts the selection back when a marquee is abandoned", () => {
    down(600, 600);
    up(600, 600);
    expect(selection.toArray()).toEqual(["out"]);

    down(-300, -300, { shift: true });
    move(60, 60);
    expect(selection.size).toBe(2);

    // Escape, a lost pointer or a lost window all land here. Leaving the sweep
    // committed means the next Delete removes what the user just cancelled.
    key("Escape");
    expect(selection.toArray()).toEqual(["out"]);
    expect(tool.marquee).toBeNull();
    expect(tool.gesturing).toBe(false);
  });

  it("does not grab a tilted item it only appears to overlap", () => {
    scene.clear();
    // A bar turned 45 degrees, so it runs corner to corner. Its rotation-
    // expanded bounding box is a square reaching to about +/-156 on both axes,
    // and the marquee below sits inside that square but well off the bar. A
    // cheaper test against the box would grab it; this must not.
    put("tilted", 0, 0, 400, 40, Math.PI / 4);
    down(-190, 100);
    move(-120, 170);
    expect(selection.isEmpty).toBe(true);

    down(-40, -40);
    move(40, 40);
    expect(selection.toArray()).toEqual(["tilted"]);
  });
});

describe("deleting", () => {
  beforeEach(() => {
    put("a", 0, 0);
    put("b", 300, 0);
    key("KeyA", { ctrl: true });
  });

  it("removes the selection and clears it", () => {
    key("Delete");
    expect(writes).toEqual([{ kind: "delete", ids: ["a", "b"], keepPins: false }]);
    expect(selection.isEmpty).toBe(true);
  });

  it("keeps the pins on Shift+Delete, so the string web keeps its shape", () => {
    key("Delete", { shift: true });
    expect(writes[0]).toMatchObject({ keepPins: true });
  });

  it("does nothing with an empty selection", () => {
    selection.clear();
    key("Delete");
    expect(writes).toEqual([]);
  });

  it("refuses to delete out from under a drag in progress", () => {
    down(0, 0);
    move(60, 60);
    key("Delete");
    expect(writes).toEqual([]);
  });
});

describe("the crash-safety write", () => {
  it("lands inside the undo manager's capture window", () => {
    // The two halves of DESIGN section 7.3 — "a throttled write every half
    // second", "merged into the same undo entry" — are in conflict, because
    // DATA-MODEL section 11 fixes the window at 400 ms and merging is purely a
    // matter of the gap between transactions. At 500 ms every live write lands
    // outside it and a three-second drag becomes seven undo entries.
    expect(LIVE_WRITE_MS).toBeLessThan(CAPTURE_TIMEOUT_MS);
  });
});
