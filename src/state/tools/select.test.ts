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
import { DEFAULT_SLACK, MIN_SLACK, presetSlack, splitSlack } from "@/lib/slack";
import { Torsion } from "@/sim/torsion";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";
import { Selection } from "@/state/selection";
import { MIN_RESIZE, LIVE_WRITE_MS, SelectTool } from "@/state/tools/select";
import type { Vec2 } from "@/state/camera";
import type {
  SegmentSplit, StringAnchor, PointerSample, StringHit, ToolContext, WritePose, WriteSize } from "@/state/tools/tool";

type Write =
  | { kind: "poses"; phase: "live" | "final"; poses: Map<string, WritePose> }
  | { kind: "sizes"; phase: "live" | "final"; sizes: Map<string, WriteSize> }
  | { kind: "delete"; ids: string[]; keepPins: boolean }
  | { kind: "deleteStrings"; stringIds: string[] }
  | { kind: "place"; pinId: string; parent: string | null; x: number; y: number }
  | { kind: "unpin"; ids: string[]; settle: [string, WritePose][] }
  | { kind: "string"; anchors: StringAnchor[]; closed: boolean }
  | {
      kind: "insert";
      stringId: string;
      index: number;
      anchor: StringAnchor;
      split: SegmentSplit;
      settle: Map<string, WritePose>;
    }
  | { kind: "nodeSlack"; stringId: string; nodeId: string; slack: number }
  | { kind: "scaleNode"; stringId: string; nodeId: string; factor: number }
  | { kind: "stringSlack"; stringIds: string[]; slack: number }
  | { kind: "scaleString"; stringIds: string[]; factor: number }
  | { kind: "layer"; stringIds: string[]; layer: "over" | "under" }
  | { kind: "pins"; phase: "live" | "final"; positions: Map<string, Vec2> };

let scene: Scene;
let dirty: DirtySets;
let camera: Camera;
let selection: Selection;
let tool: SelectTool;
let writes: Write[];
/**
 * The settle maps that came with `placePin` and `createString`, kept beside
 * `writes` rather than in it — the assertions above compare whole write records
 * with `toEqual`, and those are about placement rather than about physics.
 */
let placeSettles: Array<Map<string, WritePose>>;
let stringSettles: Array<Map<string, WritePose>>;
let held: Set<string>;
let plucks: { stringId: string; x: number; y: number }[];
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

function putPin(id: string, parent: string | null, wx: number, wy: number): void {
  // `lx`/`ly` are the same numbers for a free pin, and for a parented one the
  // tests below place the item at the origin unrotated, so they still are.
  scene.putPin({ id, parent, lx: wx, ly: wy, kind: "pushpin", color: "#c8352f", wx, wy });
}

/**
 * Screen space, like the real one in `render/pins/dom.ts`, and with a radius in
 * the same neighbourhood as its floor. The tool is handed this rather than
 * reaching for the renderer's â€” which is the whole point of the seam.
 */
const PIN_GRAB = 10;
function hitPin(sx: number, sy: number): string | null {
  let best: string | null = null;
  let bestDist = PIN_GRAB * PIN_GRAB;
  for (const [id, pin] of scene.pins) {
    const p = camera.boardToScreen(pin.wx, pin.wy);
    const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
    if (d > bestDist) continue;
    bestDist = d;
    best = id;
  }
  return best;
}

/**
 * The nearest point on a string, standing in for `RopeSet.nearest`.
 *
 * Against the straight chord between each pair of pins rather than against
 * simulated particles, which is the same answer for a taut string and is all
 * these tests need: what is being exercised here is which node the insert lands
 * at and what the tool does with `t`, not the sag. The real one hit-tests the
 * particles, and `sim/ropes.test.ts` is where that is proved.
 */
/** How many times it has been asked — the wheel's no-selection fast path is
 *  about *not* asking, which is not observable from the answer. */
let stringHits = 0;

function hitString(bx: number, by: number, reach: number): StringHit | null {
  stringHits++;
  let best: StringHit | null = null;
  let bestDistance = reach;
  for (const [id, run] of scene.strings) {
    const spans = run.closed ? run.nodes.length : run.nodes.length - 1;
    for (let i = 0; i < spans; i++) {
      const a = scene.pins.get(run.nodes[i]!.pin);
      const b = scene.pins.get(run.nodes[(i + 1) % run.nodes.length]!.pin);
      if (!a || !b) continue;
      const dx = b.wx - a.wx;
      const dy = b.wy - a.wy;
      const span = dx * dx + dy * dy;
      const u = span > 0 ? Math.min(1, Math.max(0, ((bx - a.wx) * dx + (by - a.wy) * dy) / span)) : 0;
      const x = a.wx + dx * u;
      const y = a.wy + dy * u;
      const distance = Math.hypot(bx - x, by - y);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = { string: id, node: i, t: u, x, y, distance };
    }
  }
  return best;
}

function at(x: number, y: number, mods: Partial<PointerSample> = {}): PointerSample {
  return { x, y, shift: false, ctrl: false, alt: false, ...mods };
}

function down(x: number, y: number, mods?: Partial<PointerSample>): void {
  tool.handle({ kind: "down", at: at(x, y, mods) }, ctx);
}
/** The second press of a double-click, which `machine.ts` decides from the time
 *  and the distance since the last one and flags on the press itself. */
function downAgain(x: number, y: number, mods?: Partial<PointerSample>): void {
  tool.handle({ kind: "down", at: at(x, y, mods), double: true }, ctx);
}
function move(x: number, y: number, mods?: Partial<PointerSample>): void {
  tool.handle({ kind: "move", at: at(x, y, mods) }, ctx);
}
function up(x: number, y: number): void {
  tool.handle({ kind: "up", at: at(x, y) }, ctx);
}
function key(
  code: string,
  mods: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {},
): void {
  tool.handle(
    {
      kind: "key",
      code,
      shift: mods.shift ?? false,
      ctrl: mods.ctrl ?? false,
      alt: mods.alt ?? false,
    },
    ctx,
  );
}
function tick(dt = 16): void {
  tool.tick(dt, ctx);
}
/** One notch of the wheel, offered and — if the tool claims it — delivered,
 *  which is the pair `state/tools/machine.ts` makes of it in one call. */
function wheel(x: number, y: number, dy: number, mods?: Partial<PointerSample>): boolean {
  const sample = at(x, y, mods);
  if (!tool.claimsWheel(sample, ctx)) return false;
  tool.handle({ kind: "wheel", at: sample, dy }, ctx);
  return true;
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
  plucks = [];
  placeSettles = [];
  stringSettles = [];
  held = new Set<string>();
  ctx = {
    scene,
    dirty,
    camera,
    selection,
    hitTest,
    hitPin,
    hitString,
    // Not a question: a pluck is transient physics and writes nothing, so it
    // is recorded here rather than pushed onto `writes`.
    pluck: (stringId, x, y) => plucks.push({ stringId, x, y }),
    held,
    write: {
      setPoses: (poses, phase) => writes.push({ kind: "poses", phase, poses: new Map(poses) }),
      setSizes: (sizes, phase) => writes.push({ kind: "sizes", phase, sizes: new Map(sizes) }),
      deleteItems: (ids, keepPins) => writes.push({ kind: "delete", ids: [...ids], keepPins }),
      placePin: (pinId, parent, x, y, settle) => {
        writes.push({ kind: "place", pinId, parent, x, y });
        placeSettles.push(new Map(settle));
      },
      deletePins: (ids, settle) =>
        writes.push({ kind: "unpin", ids: [...ids], settle: [...(settle ?? [])] }),
      // The select tool never creates anything; a sheet arrives from the note
      // tool or from paste, and a pin from the pin tool.
      createNote: () => {
        throw new Error("select must not create items");
      },
      createPin: () => {
        throw new Error("select must not create pins");
      },
      // `Alt`+drag from a pin pulls a new string out without switching tools
      // (DESIGN section 3.4, T-44). It is the one thing select creates.
      createString: (anchors, closed, settle) => {
        writes.push({ kind: "string", anchors: anchors.map((a) => ({ ...a })), closed });
        stringSettles.push(new Map(settle));
      },
      // The other one: a loop pulled out of the middle of a string, which makes
      // a pin and the node that carries it in one transaction (DESIGN 3.4).
      insertPin: (stringId, index, anchor, split, settle) => {
        writes.push({
          kind: "insert",
          stringId,
          index,
          anchor: { ...anchor },
          split: { ...split },
          settle: new Map(settle),
        });
      },
      // The four slack writes (DESIGN section 3.4's editing table). The scaling
      // pair carries a factor rather than a value on purpose — see
      // `crdt/ops/strings.ts`.
      setNodeSlack: (stringId, nodeId, slack) =>
        writes.push({ kind: "nodeSlack", stringId, nodeId, slack }),
      scaleNodeSlack: (stringId, nodeId, factor) =>
        writes.push({ kind: "scaleNode", stringId, nodeId, factor }),
      setStringSlack: (stringIds, slack) =>
        writes.push({ kind: "stringSlack", stringIds: [...stringIds], slack }),
      scaleStringSlack: (stringIds, factor) =>
        writes.push({ kind: "scaleString", stringIds: [...stringIds], factor }),
      // Tuck behind (DESIGN section 3.4), which is the same shape: the tool
      // names one absolute layer for the whole selection.
      setStringLayer: (stringIds, layer) =>
        writes.push({ kind: "layer", stringIds: [...stringIds], layer }),
      // DESIGN section 3.4's Delete row, and the Delete key on a selected
      // string — which until now went to `deleteItems` and was dropped.
      deleteStrings: (stringIds) =>
        writes.push({ kind: "deleteStrings", stringIds: [...stringIds] }),
      // Restyle is the context menu's (ui/boardmenu.ts); no gesture reaches it.
      setStringStyle: () => {},
      // The free pins a dragged or rotated thread carries with it (DESIGN 3.8).
      movePins: (positions, phase) =>
        writes.push({ kind: "pins", phase, positions: new Map(positions) }),
      // Ink is the marker's (`state/tools/marker.ts`); select draws nothing.
      commitStrokes: () => {},
      eraseStrokes: () => {},
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
    // left â€” a clockwise turn in a y-down space, so a positive angle.
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
    // A quarter turn puts the paper's top edge â€” and its handle â€” due east.
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

  it("leaves a photograph alone â€” its edge is somewhere to pick it up", () => {
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
    // is not enough â€” and the revert has to go back through the resize op, or
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

  /**
   * `Selection.toArray` is items, and a selected string lives in its own set —
   * so `Delete` read the item half, deleted it, and cleared the whole thing.
   * Every string went on existing while the halo saying it was selected
   * disappeared, which reads as the string having come back rather than as a
   * delete that missed. Invisible until follow-the-thread made a selection of
   * every kind at once ordinary, and then it was every double-click.
   */
  describe("a selection that is not all items", () => {
    function span(id: string, y: number): void {
      putPin(`${id}-a`, null, 0, y);
      putPin(`${id}-b`, null, 200, y);
      scene.putString({
        id,
        nodes: [
          { nodeId: `${id}-n0`, pin: `${id}-a`, slackAfter: 0.2 },
          { nodeId: `${id}-n1`, pin: `${id}-b`, slackAfter: 0.2 },
        ],
        color: "#a8322c",
        thickness: 3,
        material: "string",
        layer: "over",
        closed: false,
      });
    }

    beforeEach(() => {
      selection.clear();
      span("s", 400);
    });

    it("deletes a selected string", () => {
      selection.replaceStrings(["s"]);
      key("Delete");
      expect(writes).toEqual([{ kind: "deleteStrings", stringIds: ["s"] }]);
      expect(selection.isEmpty).toBe(true);
    });

    /** The one gesture that produces a selection of every kind at once, which
     *  is what made this bug ordinary rather than theoretical. */
    it("splits a followed thread into the three writes it actually is", () => {
      selection.replaceThread(["a"], ["s"], ["s-a"]);
      key("Delete");
      expect(writes).toEqual([
        { kind: "delete", ids: ["a"], keepPins: false },
        { kind: "deleteStrings", stringIds: ["s"] },
        { kind: "unpin", ids: ["s-a"], settle: [] },
      ]);
    });

    /** `Shift` means "keep the pins", which is an *item's* cascade. A string
     *  has no pins to keep - it references them (D-1) - so the modifier does
     *  not reach the string write at all. */
    it("deletes the string on Shift+Delete too", () => {
      selection.replaceThread(["a"], ["s"], []);
      key("Delete", { shift: true });
      expect(writes).toEqual([
        { kind: "delete", ids: ["a"], keepPins: true },
        { kind: "deleteStrings", stringIds: ["s"] },
      ]);
    });

    /** Q-24. The strings through it heal, which is the op's cascade and the
     *  same one `Alt`+click reaches. */
    it("removes a selected pin", () => {
      selection.replaceThread([], [], ["s-a"]);
      key("Delete");
      expect(writes).toEqual([{ kind: "unpin", ids: ["s-a"], settle: [] }]);
      expect(selection.isEmpty).toBe(true);
    });

    /**
     * An item hanging by the pin about to go is drawn at `rot + swing` about a
     * shifted centre, and neither transient is in the document — so without
     * this the paper snaps back to an angle nobody chose the instant the pin
     * leaves. The same map `Alt`+click and the pin context menu send.
     */
    it("settles an item that was hanging by the pin it takes", () => {
      put("hung", 0, 0);
      putPin("only", "hung", 0, 0);
      const slot = scene.slotOf("hung")!;
      scene.swing[slot] = 0.25;
      selection.replaceThread([], [], ["only"]);
      key("Delete");
      expect(writes).toEqual([
        { kind: "unpin", ids: ["only"], settle: [["hung", { x: 0, y: 0, rot: expect.closeTo(0.25) }]] },
      ]);
    });

    /**
     * `Shift` means "keep the pins" for the whole selection, not only for the
     * item cascade. On a followed thread the selected pins *are* the items'
     * pins, so a `Shift` that reached the cascade alone would delete every one
     * of them anyway and the modifier would be a lie exactly where it matters.
     */
    it("keeps every pin on Shift+Delete, including the ones in the selection", () => {
      selection.replaceThread(["a"], ["s"], ["s-a"]);
      key("Delete", { shift: true });
      expect(writes).toEqual([
        { kind: "delete", ids: ["a"], keepPins: true },
        { kind: "deleteStrings", stringIds: ["s"] },
      ]);
    });

    /** Which leaves one contradiction with nowhere to go: "delete these pins,
     *  but keep the pins". Nothing happens, and the selection stays. */
    it("does nothing on Shift+Delete over a selection of nothing but pins", () => {
      selection.replaceThread([], [], ["s-a"]);
      key("Delete", { shift: true });
      expect(writes).toEqual([]);
      expect(selection.pins.has("s-a")).toBe(true);
    });

    /**
     * A pin its own item is about to take with it. `deleteItems` cascades to
     * it, so naming it again would be a write against something already gone —
     * and worse, the settle would carry a pose for a deleted item, which in a
     * CRDT is how you bring one back.
     */
    it("does not name a pin the item cascade is already taking", () => {
      put("hung", 0, 0);
      putPin("its-own", "hung", 0, 0);
      putPin("free", null, 500, 500);
      selection.replaceThread(["hung"], [], ["its-own", "free"]);
      key("Delete");
      expect(writes).toEqual([
        { kind: "delete", ids: ["hung"], keepPins: false },
        { kind: "unpin", ids: ["free"], settle: [] },
      ]);
    });
  });
});

describe("the crash-safety write", () => {
  it("lands inside the undo manager's capture window", () => {
    // The two halves of DESIGN section 7.3 â€” "a throttled write every half
    // second", "merged into the same undo entry" â€” are in conflict, because
    // DATA-MODEL section 11 fixes the window at 400 ms and merging is purely a
    // matter of the gap between transactions. At 500 ms every live write lands
    // outside it and a three-second drag becomes seven undo entries.
    expect(LIVE_WRITE_MS).toBeLessThan(CAPTURE_TIMEOUT_MS);
  });
});

/**
 * Pins are grabbable here rather than only in the pin tool - DESIGN section 3.3
 * names the tool for the rows that place a pin and for none of the rows that
 * move one, and 6.2 puts pins in a layer of their own labelled "hit targets".
 */
describe("dragging a pin", () => {
  it("parents a free pin to the item it is dropped on", () => {
    put("a", 300, 300);
    putPin("p", null, 0, 0);

    down(0, 0);
    move(300, 300);
    up(300, 300);

    expect(scene.pins.get("p")!.parent).toBe("a");
    // Item-local, not board: the write is in the frame the parent implies, and
    // the point it was dropped on is `a`'s own centre.
    expect(writes).toEqual([{ kind: "place", pinId: "p", parent: "a", x: 0, y: 0 }]);
  });

  it("frees a parented pin dragged off onto bare cork", () => {
    put("a", 0, 0);
    putPin("p", "a", 10, 10);

    down(10, 10);
    move(600, 600);
    up(600, 600);

    expect(scene.pins.get("p")!.parent).toBeNull();
    expect(writes).toEqual([{ kind: "place", pinId: "p", parent: null, x: 600, y: 600 }]);
  });

  /** "Hold Ctrl while dragging - stays within the current parent". */
  it("keeps its parent while Ctrl is held, even over another item", () => {
    put("a", 0, 0);
    put("b", 300, 300);
    putPin("p", "a", 10, 10);
    held.add("ControlLeft");

    down(10, 10);
    move(300, 300);
    up(300, 300);

    expect(scene.pins.get("p")!.parent).toBe("a");
    expect(writes).toEqual([{ kind: "place", pinId: "p", parent: "a", x: 300, y: 300 }]);
  });

  it("constrains a free pin to staying free", () => {
    put("a", 300, 300);
    putPin("p", null, 0, 0);
    held.add("ControlRight");

    down(0, 0);
    move(300, 300);
    up(300, 300);

    expect(scene.pins.get("p")!.parent).toBeNull();
  });

  /** The only feedback that says whether the drop has taken. */
  it("names the candidate item while the drag is in flight, and nothing after", () => {
    put("a", 300, 300);
    putPin("p", null, 0, 0);
    expect(tool.pinCandidate).toBeNull();

    down(0, 0);
    move(300, 300);
    expect(tool.pinCandidate).toBe("a");
    move(900, 900);
    expect(tool.pinCandidate).toBeNull();

    up(900, 900);
    expect(tool.pinCandidate).toBeNull();
  });

  /** A press that takes hold of a pin is routinely a few pixels off its centre,
   *  because the grab radius is deliberately wider than the head. */
  it("keeps the offset between the pin and the press", () => {
    putPin("p", null, 0, 0);
    down(6, 0);
    move(106, 0);
    up(106, 0);
    expect(scene.pins.get("p")!.wx).toBe(100);
  });

  it("takes the pin rather than the item beneath it, and leaves the selection alone", () => {
    put("a", 0, 0);
    putPin("p", "a", 0, 0);

    down(0, 0);
    move(200, 200);
    up(200, 200);

    expect(selection.toArray()).toEqual([]);
    expect(scene.poseOf("a")).toMatchObject({ x: 0, y: 0 });
  });

  it("writes nothing for a click that never became a drag", () => {
    put("a", 0, 0);
    putPin("p", "a", 0, 0);
    down(0, 0);
    up(0, 0);
    expect(writes).toEqual([]);
    expect(scene.pins.get("p")!.parent).toBe("a");
  });

  it("writes nothing for a drag that came back to where it started", () => {
    put("a", 0, 0);
    putPin("p", "a", 0, 0);
    down(0, 0);
    move(200, 200);
    move(0, 0);
    up(0, 0);
    expect(writes).toEqual([]);
  });

  /** Nothing was written, so the revert is the scene and nothing else. */
  it("puts the pin back on Escape and never writes", () => {
    put("a", 300, 300);
    putPin("p", null, 0, 0);
    down(0, 0);
    move(300, 300);
    expect(scene.pins.get("p")!.parent).toBe("a");

    key("Escape");
    expect(scene.pins.get("p")).toMatchObject({ parent: null, lx: 0, ly: 0 });
    expect(writes).toEqual([]);
  });

  it("does the same when the window takes the gesture away", () => {
    put("a", 300, 300);
    putPin("p", null, 0, 0);
    down(0, 0);
    move(300, 300);
    tool.handle({ kind: "cancel" }, ctx);
    expect(scene.pins.get("p")!.parent).toBeNull();
    expect(writes).toEqual([]);
  });

  /** Both ends of a re-parent, because pin count is an item's physics. */
  it("dirties the item it left as well as the one it arrived at", () => {
    put("a", 0, 0);
    put("b", 300, 300);
    putPin("p", "a", 0, 0);

    down(0, 0);
    move(300, 300);
    expect(dirty.items.has("a")).toBe(true);
    expect(dirty.items.has("b")).toBe(true);
    expect(dirty.pins.has("p")).toBe(true);
  });
});

/**
 * A pin is stuck in the cork, so an item hanging from one turns about it â€”
 * `sim/torsion.ts` follows that rule for the swing and this is the one place
 * the gesture was not following it.
 */
describe("turning a hanging item", () => {
  /** Where the pin ends up once the gesture's pose is applied: the stored
   *  centre plus the pin's local offset through the item's rotation. */
  function pinWorld(itemId: string, pinId: string): { x: number; y: number } {
    const slot = scene.slotOf(itemId)!;
    const pin = scene.pins.get(pinId)!;
    const rot = scene.rot[slot]!;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return {
      x: scene.x[slot]! + pin.lx * cos - pin.ly * sin,
      y: scene.y[slot]! + pin.lx * sin + pin.ly * cos,
    };
  }

  it("turns about the pin, leaving it exactly where it was", () => {
    put("a", 0, 0, 200, 200);
    // Top left of the item, so turning about it is visibly not turning about
    // the centre.
    scene.putPin({
      id: "p",
      parent: "a",
      lx: -80,
      ly: -60,
      kind: "pushpin",
      color: "#c8352f",
      wx: -80,
      wy: -60,
    });
    down(0, 0);
    up(0, 0);
    const before = pinWorld("a", "p");

    held.add("KeyR");
    // Out from the pin, then a quarter turn about it. The first move is what
    // anchors the reference angle; the second is the turn.
    down(0, 0);
    move(40, 0);
    move(-80, 140);
    up(-80, 140);

    // Four decimals of a board unit, because the pose round-trips through the
    // scene's `Float32Array`s and nothing survives more than about seven
    // significant digits of that.
    const after = pinWorld("a", "p");
    expect(after.x).toBeCloseTo(before.x, 4);
    expect(after.y).toBeCloseTo(before.y, 4);
    // It really did turn, and it really did move.
    expect(scene.poseOf("a")!.rot).not.toBeCloseTo(0, 3);
    expect(scene.poseOf("a")!.x).not.toBeCloseTo(0, 3);
  });

  it("turns a rigid item about its own centre, as before", () => {
    put("a", 0, 0, 200, 200);
    for (const [id, lx] of [["p1", -80], ["p2", 80]] as const) {
      scene.putPin({
        id,
        parent: "a",
        lx,
        ly: -60,
        kind: "pushpin",
        color: "#c8352f",
        wx: lx,
        wy: -60,
      });
    }
    down(0, 0);
    up(0, 0);

    held.add("KeyR");
    down(0, 0);
    move(80, 0);
    move(0, 80);
    up(0, 80);

    expect(scene.poseOf("a")!.rot).toBeCloseTo(Math.PI / 2, 3);
    expect(scene.poseOf("a")!.x).toBeCloseTo(0, 6);
    expect(scene.poseOf("a")!.y).toBeCloseTo(0, 6);
  });

  /** A group has no single pin to turn about, and asking two pinned
   *  photographs to turn about one of their pins would fling the other. */
  it("turns a group about the middle of the group, as before", () => {
    put("a", -100, 0, 100, 100);
    put("b", 100, 0, 100, 100);
    for (const [id, parent] of [["pa", "a"], ["pb", "b"]] as const) {
      scene.putPin({
        id,
        parent,
        lx: 0,
        ly: -40,
        kind: "pushpin",
        color: "#c8352f",
        wx: 0,
        wy: -40,
      });
    }
    down(-100, 0);
    up(-100, 0);
    down(100, 0, { shift: true });
    up(100, 0);

    held.add("KeyR");
    down(100, 0);
    move(140, 0);
    move(0, 140);
    up(0, 140);

    // Half a turn about the origin would swap them; any turn about it keeps
    // them the same distance from it and from each other.
    const a = scene.poseOf("a")!;
    const b = scene.poseOf("b")!;
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(100, 4);
    expect(Math.hypot(b.x, b.y)).toBeCloseTo(100, 4);
  });
});

/**
 * > | Quick pull | `Alt`+drag from a pin, in any tool | Pulls a new string out
 * > without switching tools | — DESIGN section 3.4
 *
 * The same modifier as removal, told apart by whether the pointer moved. That
 * is why the press can no longer act: removing the pin on pointer-down, which
 * is what this tool used to do, makes the drag unreachable.
 */
describe("Alt+drag from a pin", () => {
  it("pulls a string to the pin it was dragged onto", () => {
    putPin("from", null, 0, 0);
    putPin("to", null, 300, 120);
    down(0, 0, { alt: true });
    move(160, 60);
    up(300, 120);
    expect(writes).toEqual([
      { kind: "string", anchors: [{ pin: "from" }, { pin: "to" }], closed: false },
    ]);
  });

  /** The fast path, reached without the string tool: drop on bare paper and
   *  the pin that anchors the far end is made for you. */
  it("pulls a string onto a bare item, pinning it", () => {
    putPin("from", null, 0, 0);
    put("note", 400, 0);
    down(0, 0, { alt: true });
    move(200, 0);
    up(400, 0);
    expect(writes).toEqual([
      { kind: "string", anchors: [{ pin: "from" }, { parent: "note", lx: 0, ly: 0 }], closed: false },
    ]);
  });

  it("pulls a string into bare cork, pushing a free pin in", () => {
    putPin("from", null, 0, 0);
    down(0, 0, { alt: true });
    move(120, 90);
    up(260, 180);
    expect(writes).toEqual([
      { kind: "string", anchors: [{ pin: "from" }, { parent: null, lx: 260, ly: 180 }], closed: false },
    ]);
  });

  /** A pull is not a removal, so the pin it started on stays where it is. */
  it("leaves the pin it came from alone", () => {
    putPin("from", null, 0, 0);
    down(0, 0, { alt: true });
    move(200, 200);
    up(200, 200);
    expect(writes.some((w) => w.kind === "unpin")).toBe(false);
    expect(scene.pins.has("from")).toBe(true);
  });

  /** Dragged out and brought back is a string of one node, which is not a
   *  string — and it was a drag, so it was not a click either. */
  it("writes nothing when the pull ends where it started", () => {
    putPin("from", null, 0, 0);
    down(0, 0, { alt: true });
    move(200, 200);
    up(0, 0);
    expect(writes).toEqual([]);
    expect(scene.pins.has("from")).toBe(true);
  });

  it("writes nothing at all if the gesture is taken away", () => {
    putPin("from", null, 0, 0);
    down(0, 0, { alt: true });
    move(200, 200);
    tool.cancel(ctx);
    up(300, 300);
    expect(writes).toEqual([]);
    expect(scene.pins.has("from")).toBe(true);
  });

  it("draws the pull from the pin to the cursor while it is in flight", () => {
    putPin("from", null, 40, 20);
    expect(tool.pullPreview({ x: 1, y: 1 })).toBeNull();
    down(40, 20, { alt: true });
    move(200, 200);
    expect(tool.pullPreview({ x: 260, y: 180 })).toEqual([
      { x: 40, y: 20 },
      { x: 260, y: 180 },
    ]);
    up(260, 180);
    expect(tool.pullPreview({ x: 260, y: 180 })).toBeNull();
  });
});

describe("Alt+click on a pin", () => {
  it("removes it", () => {
    putPin("p", null, 0, 0);
    down(0, 0, { alt: true });
    up(0, 0);
    expect(writes).toEqual([{ kind: "unpin", ids: ["p"], settle: [] }]);
  });

  it("does not also select or drag the item under it", () => {
    put("a", 0, 0);
    putPin("p", "a", 0, 0);
    down(0, 0, { alt: true });
    up(0, 0);
    expect(selection.toArray()).toEqual([]);
    expect(scene.poseOf("a")).toMatchObject({ x: 0, y: 0 });
    // The settle rides along, because `a` has just lost the pin it hangs from —
    // here it is already where it is drawn, so it writes what was there.
    expect(writes).toEqual([
      { kind: "unpin", ids: ["p"], settle: [["a", { x: 0, y: 0, rot: 0 }]] },
    ]);
  });

  /**
   * T-107. An item on one pin is drawn at `rot + swing` about a shifted centre,
   * and neither is in the document — so taking the pin out would snap the paper
   * to an authored angle that has been invisible since it started hanging. The
   * settle pose goes with the delete, in one transaction.
   */
  it("settles the item it was holding, so the paper does not jump", () => {
    put("a", 40, -20, 200, 200, 0.9);
    putPin("p", "a", 40, -20);
    const slot = scene.slotOf("a")!;
    scene.swing[slot] = -0.9;
    scene.driftX[slot] = 12;
    scene.driftY[slot] = -7;

    down(40, -20, { alt: true });
    up(40, -20);

    const write = writes[0]!;
    expect(write.kind).toBe("unpin");
    if (write.kind !== "unpin") throw new Error("expected an unpin");
    expect(write.settle).toEqual([["a", { x: 52, y: -27, rot: 0 }]]);
  });

  it("settles nothing when the item still has another pin holding it", () => {
    put("a", 0, 0, 200, 200);
    putPin("p1", "a", 0, 0);
    putPin("p2", "a", 60, 60);

    down(0, 0, { alt: true });
    up(0, 0);

    const write = writes[0]!;
    if (write.kind !== "unpin") throw new Error("expected an unpin");
    expect(write.settle).toEqual([]);
  });

  it("settles nothing for a free pin, which was holding nothing", () => {
    putPin("p", null, 0, 0);
    down(0, 0, { alt: true });
    up(0, 0);
    const write = writes[0]!;
    if (write.kind !== "unpin") throw new Error("expected an unpin");
    expect(write.settle).toEqual([]);
  });

  it("is an ordinary press when there is no pin under it", () => {
    put("a", 0, 0);
    down(0, 0, { alt: true });
    up(0, 0);
    expect(selection.toArray()).toEqual(["a"]);
  });
});


/**
 * The headline gesture: grab a string in the middle and pull a loop of it out
 * to a new pin (DESIGN section 3.4).
 *
 * Nothing here needs a rope simulation. `hitString` above answers against the
 * chord, which for a taut string is the same point the real one finds, and the
 * tool's job starts from that answer: which node the insert lands at, where the
 * pin goes, and how the sag divides.
 */
describe("pulling a pin out of a string", () => {
  const SLACK = 0.2;

  function putString(
    id: string,
    pins: readonly string[],
    { closed = false, layer = "over" }: { closed?: boolean; layer?: string } = {},
  ): void {
    scene.putString({
      id,
      nodes: pins.map((pin, i) => ({ nodeId: `${id}-n${i}`, pin, slackAfter: SLACK })),
      color: "#a8322c",
      thickness: 3,
      material: "string",
      layer,
      closed,
    });
  }

  /** Two pins 200 apart, a string between them, and the midpoint at (100, 0). */
  function taut(): void {
    putPin("p0", null, 0, 0);
    putPin("p1", null, 200, 0);
    putString("s", ["p0", "p1"]);
  }

  function lastInsert(): Extract<Write, { kind: "insert" }> {
    const write = writes[writes.length - 1];
    if (write?.kind !== "insert") throw new Error("expected an insert");
    return write;
  }

  it("makes the pin and its node in one write, after the node it hangs from", () => {
    taut();
    down(100, 0);
    move(100, 20);
    up(100, 20);

    const write = lastInsert();
    expect(writes).toHaveLength(1);
    expect(write.stringId).toBe("s");
    // The segment starts at node 0, so the new node goes between it and node 1.
    expect(write.index).toBe(1);
    expect(write.anchor).toEqual({ parent: null, lx: 100, ly: 20 });
  });

  /**
   * AC-73, from the tool's side — and the tool's side is now only the chords.
   *
   * The division itself moved into `crdt/ops/strings.ts`, which does it against
   * the slack read in its own transaction (DATA-MODEL section 5.4), so what is
   * left to prove here is that the numbers it is handed are measured to where
   * the pin was actually *dropped* rather than to where the string was grabbed.
   * Running `splitSlack` over them is how that is checked: given the right
   * chords the two halves conserve the rest length, and given the wrong ones
   * they cannot.
   */
  it("measures the chords the split needs to the point the pin was dropped", () => {
    taut();
    down(100, 0);
    move(100, 20);
    up(100, 20);

    const { split } = lastInsert();
    expect(split.chord).toBeCloseTo(200, 6);
    expect(split.first).toBeCloseTo(Math.hypot(100, 20), 6);
    expect(split.second).toBeCloseTo(Math.hypot(100, 20), 6);

    const [before, after] = splitSlack(split.chord, SLACK, split.first, split.second, split.t);
    expect(split.first * (1 + before) + split.second * (1 + after)).toBeCloseTo(
      200 * (1 + SLACK),
      6,
    );
  });

  it("divides the sag where the string was grabbed, not down the middle", () => {
    taut();
    // A quarter of the way along, and pulled straight down from there.
    down(50, 0);
    move(50, 20);
    up(50, 20);

    const { split } = lastInsert();
    // `t` is the whole of "where it was grabbed", and it is the tool's to
    // report — the op has no idea where the cursor was.
    expect(split.t).toBeCloseTo(0.25, 6);

    const [before, after] = splitSlack(split.chord, SLACK, split.first, split.second, split.t);
    // A quarter of the rest length went to the near side, so its own chord is
    // proportionally the tauter of the two.
    expect(split.first * (1 + before)).toBeCloseTo(200 * (1 + SLACK) * 0.25, 6);
    expect(split.second * (1 + after)).toBeCloseTo(200 * (1 + SLACK) * 0.75, 6);
  });

  it("drops the new pin into an item, so it travels with it", () => {
    taut();
    put("a", 100, 120, 100, 100);
    down(100, 0);
    move(100, 120);
    up(100, 120);
    expect(lastInsert().anchor).toEqual({ parent: "a", lx: 0, ly: 0 });
  });

  /**
   * The mirror of T-107, and the one real failure mode this drop has.
   *
   * The drop is measured against the pose the paper is *drawn* at — it has to
   * be, or the pin lands where the paper is not (`state/tools/frame.ts`). But
   * the pin it places makes two, two pins are rigid, and rigid means the swing
   * and the drift stop existing. So unless the pose it was drawn at is written
   * down in the same breath, the paper spins back to an authored rotation that
   * has been invisible ever since it started hanging, and takes the pin you
   * just placed with it.
   */
  it("leaves the new pin where it was dropped on a hanging item", () => {
    // A 200-square on one pin at its top left: it hangs a long way from its
    // authored rotation, so what follows is a snap rather than a degree.
    put("a", 0, 0, 200, 200);
    putPin("hook", "a", -80, -60);
    putPin("far", null, 400, -60);
    putString("s", ["hook", "far"]);

    // `dirty.all` is the load path: everything at its equilibrium, no motion.
    dirty.all = true;
    new Torsion().step(scene, dirty, 16);
    scene.layoutPins();
    const slot = scene.slotOf("a")!;
    expect(Math.abs(scene.swing[slot]!)).toBeGreaterThan(0.5);

    // Grab the string clear of the paper, drop it on the paper's middle —
    // where the paper looks, which is the only place a cursor can aim.
    const dropX = scene.renderX(slot);
    const dropY = scene.renderY(slot);
    down(200, -60);
    move(dropX, dropY);
    up(dropX, dropY);

    const anchor = lastInsert().anchor;
    if (!("parent" in anchor)) throw new Error("expected the drop to parent");
    expect(anchor.parent).toBe("a");

    // Where that pin ends up once the second pin has made the item rigid: its
    // local offset through the *stored* pose, which is all a rigid item has.
    const pose = lastInsert().settle?.get("a") ?? scene.poseOf("a")!;
    const cos = Math.cos(pose.rot ?? 0);
    const sin = Math.sin(pose.rot ?? 0);
    expect(pose.x + anchor.lx * cos - anchor.ly * sin).toBeCloseTo(dropX, 3);
    expect(pose.y + anchor.lx * sin + anchor.ly * cos).toBeCloseTo(dropY, 3);
  });

  it("puts the wrap segment's node at the end of a closed run", () => {
    putPin("p0", null, 0, 0);
    putPin("p1", null, 200, 0);
    putPin("p2", null, 100, 200);
    putString("s", ["p0", "p1", "p2"], { closed: true });

    // The middle of the leg from p2 back round to p0.
    down(50, 100);
    move(20, 100);
    up(20, 100);
    expect(lastInsert().index).toBe(3);
  });

  /** AC-71. Nothing is written until the release, so the revert is that there
   *  was never anything to revert. */
  it("reverts completely on Esc mid-drag", () => {
    taut();
    down(100, 0);
    move(100, 20);
    key("Escape");
    up(100, 20);

    expect(writes).toEqual([]);
    expect(scene.strings.get("s")!.nodes).toHaveLength(2);
    // And the gesture is over rather than merely paused: the next move must not
    // pick it back up.
    move(100, 60);
    up(100, 60);
    expect(writes).toEqual([]);
  });

  it("reverts the same way when the pointer is taken away", () => {
    taut();
    down(100, 0);
    move(100, 20);
    tool.handle({ kind: "cancel" }, ctx);
    expect(writes).toEqual([]);
  });

  it("writes nothing when the loop is dropped back on a pin it already runs between", () => {
    taut();
    down(100, 0);
    move(150, 0);
    up(200, 0);
    expect(writes).toEqual([]);
  });

  /** AC-72. */
  it("selects the string when the press never became a drag", () => {
    taut();
    down(100, 0);
    up(100, 0);

    expect([...selection.strings]).toEqual(["s"]);
    expect(writes).toEqual([]);
  });

  it("selects the string instead of whatever was selected before, and back again", () => {
    taut();
    put("a", 400, 400);

    down(400, 400);
    up(400, 400);
    expect(selection.toArray()).toEqual(["a"]);

    down(100, 0);
    up(100, 0);
    expect([...selection.strings]).toEqual(["s"]);
    expect(selection.isEmpty).toBe(true);

    down(400, 400);
    up(400, 400);
    expect(selection.toArray()).toEqual(["a"]);
    expect(selection.strings.size).toBe(0);
  });

  it("leaves the selection alone when the press turned into a pull", () => {
    taut();
    put("a", 400, 400);
    down(400, 400);
    up(400, 400);

    down(100, 0);
    move(100, 20);
    up(100, 20);
    expect(selection.toArray()).toEqual(["a"]);
    expect(selection.strings.size).toBe(0);
  });

  it("drops a selected string a collaborator deleted rather than acting on a ghost", () => {
    taut();
    down(100, 0);
    up(100, 0);
    expect(selection.strings.size).toBe(1);

    scene.removeString("s");
    down(400, 400);
    up(400, 400);
    expect(selection.strings.size).toBe(0);
  });

  it("gives the pin under it the press, because the pin is on top", () => {
    taut();
    // Right on p1, which is also a point on the string.
    down(200, 0);
    move(240, 40);
    up(240, 40);

    expect(selection.strings.size).toBe(0);
    expect(writes.some((w) => w.kind === "insert")).toBe(false);
    expect(writes.some((w) => w.kind === "place")).toBe(true);
  });

  it("cannot be grabbed through a photograph it is tucked behind", () => {
    putPin("p0", null, 0, 0);
    putPin("p1", null, 200, 0);
    putString("s", ["p0", "p1"], { layer: "under" });
    put("a", 100, 0, 80, 80);

    down(100, 0);
    up(100, 0);
    // The press fell through to the photograph on top of it.
    expect(selection.toArray()).toEqual(["a"]);
    expect(selection.strings.size).toBe(0);
  });

  it("still grabs a tucked string where no item covers it", () => {
    putPin("p0", null, 0, 0);
    putPin("p1", null, 200, 0);
    putString("s", ["p0", "p1"], { layer: "under" });
    put("a", 20, 0, 20, 20);

    down(100, 0);
    up(100, 0);
    expect([...selection.strings]).toEqual(["s"]);
  });

  it("draws the loop between the two pins it is being pulled out from", () => {
    taut();
    expect(tool.loopPreview({ x: 100, y: 20 })).toBeNull();

    down(100, 0);
    move(100, 20);
    expect(tool.loopPreview({ x: 100, y: 20 })).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 20 },
      { x: 200, y: 0 },
    ]);

    up(100, 20);
    expect(tool.loopPreview({ x: 100, y: 20 })).toBeNull();
  });

  it("is no gesture at all when the string went away before the pointer moved", () => {
    taut();
    down(100, 0);
    scene.removeString("s");
    move(100, 20);
    up(100, 20);
    expect(writes).toEqual([]);
  });
});

/**
 * Both ends of a re-parent, and the `Alt` pull, against items that hang.
 *
 * Pin count is an item's physics (DESIGN section 5.5), so a gesture that moves
 * a pin between items can change how *two* items hang at once — and every
 * change out of "hanging on exactly one" throws away a swing and a drift the
 * document never held.
 */
describe("moving a pin between items that hang", () => {
  /**
   * A 200-square on one pin at its top left, settled with no motion the way a
   * load is, which leaves it a long way from its authored rotation.
   *
   * Returns the `Torsion` that settled it, because a test stepping phase 3
   * again afterwards has to use *that* one: first sight settles rather than
   * swings (T-110), so a fresh module would treat an item that has been on the
   * board all along as one that had just arrived, and take the load branch in
   * the middle of a gesture.
   */
  function hang(id: string, x: number, y: number): Torsion {
    put(id, x, y, 200, 200);
    scene.putPin({
      id: `${id}-hook`,
      parent: id,
      lx: -80,
      ly: -60,
      kind: "pushpin",
      color: "#c8352f",
      wx: x - 80,
      wy: y - 60,
    });
    dirty.all = true;
    const sim = new Torsion();
    sim.step(scene, dirty, 16);
    scene.layoutPins();
    return sim;
  }

  function drawn(id: string): WritePose {
    const slot = scene.slotOf(id)!;
    return {
      x: scene.renderX(slot),
      y: scene.renderY(slot),
      rot: scene.rot[slot]! + scene.swing[slot]!,
    };
  }

  it("settles the item the pin lands on, when that pin makes two", () => {
    hang("a", 0, 0);
    expect(Math.abs(scene.swing[scene.slotOf("a")!]!)).toBeGreaterThan(0.5);
    putPin("p", null, 400, 400);
    const pose = drawn("a");

    down(400, 400);
    move(0, 0);
    up(0, 0);

    expect(scene.pins.get("p")!.parent).toBe("a");
    expect(placeSettles[0]!.get("a")).toEqual(pose);
  });

  /**
   * T-107's jump, reached by dragging the pin off rather than deleting it —
   * which is why `settleOnUnpin` never caught this one. An item that has lost
   * its last pin has stopped hanging, and stops being drawn at a swing.
   */
  it("settles the item the pin left, when that was its last one", () => {
    hang("a", 0, 0);
    const pose = drawn("a");

    down(-80, -60);
    move(600, 600);
    up(600, 600);

    expect(scene.pins.get("a-hook")!.parent).toBeNull();
    expect(placeSettles[0]!.get("a")).toEqual(pose);
  });

  /** Both ends at once: one item stops hanging because it has two now, the
   *  other because it has none. */
  it("settles both ends of a re-parent", () => {
    hang("a", 0, 0);
    hang("b", 600, 0);
    const from = drawn("a");
    const onto = drawn("b");

    down(-80, -60);
    move(600, 0);
    up(600, 0);

    const settle = placeSettles[0]!;
    expect(settle.get("a")).toEqual(from);
    expect(settle.get("b")).toEqual(onto);
  });

  /** Two to one *starts* an item hanging, which is a swing from where it
   *  already is rather than a jump. */
  it("settles nothing when the item it left still has a pin", () => {
    put("a", 0, 0, 200, 200);
    putPin("p1", "a", -80, -60);
    putPin("p2", "a", 80, -60);

    down(-80, -60);
    move(600, 600);
    up(600, 600);

    expect(placeSettles[0]!.size).toBe(0);
  });

  /** Nought to one, at the far end. */
  it("settles nothing when the item it lands on had no pin", () => {
    put("a", 0, 0, 200, 200);
    putPin("p", null, 400, 400);

    down(400, 400);
    move(0, 0);
    up(0, 0);

    expect(placeSettles[0]!.size).toBe(0);
  });

  /**
   * The other end of the same fault, and the one that is felt first.
   *
   * A press that becomes a drag calls `begin` and then deliberately falls
   * through into `applyGesture`, so that the pin does not sit still for the
   * frame it was picked up in. That means the pin has already moved when phase
   * 3 arrives to freeze the pivot — and freezing it at where the pin has got to
   * turns the paper about a point it was never turning about. `heldPivots` is
   * what carries the answer across that seam.
   *
   * `dt` of zero again: nothing here is allowed to move at all, so there is no
   * swing to leave room for.
   */
  it("does not move the paper on the first frame of a pin drag", () => {
    hang("a", 0, 0);
    dirty.clear();
    const before = drawn("a");
    const sim = new Torsion();

    down(-80, -60);
    move(-40, -20);
    dirty.item("a");
    sim.step(scene, dirty, 0, tool.heldItems, tool.carryLag, tool.heldPivots);

    const after = drawn("a");
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
    expect(after.rot).toBeCloseTo(before.rot!, 3);
    // And the pin went exactly where it was put, which is the same statement
    // read from the other side: the paper carrying the pin is the failure.
    scene.layoutPins();
    expect(scene.pins.get("a-hook")!.wx).toBeCloseTo(-40, 3);
    expect(scene.pins.get("a-hook")!.wy).toBeCloseTo(-20, 3);
  });

  /**
   * Sliding a pin around the paper it is already in changes no count — and for
   * a long time that was read as changing nothing. It changes the point the
   * paper is drawn about, which is most of where the paper *is*: `drift` is a
   * pure function of the pivot, so the same `rot` and the same `swing` draw the
   * item somewhere else the moment the pin lands somewhere else.
   *
   * `dt` of zero is the whole assertion. It runs the handover — the item stops
   * being held, phase 3 goes back to deriving the pivot from the pin — with no
   * substep, so anything that moves here moved by teleporting rather than by
   * swinging.
   */
  it("settles the item for a pin moved within it, so the paper does not jump", () => {
    const sim = hang("a", 0, 0);
    const before = drawn("a");

    down(-80, -60);
    move(40, 40);
    up(40, 40);

    expect(scene.pins.get("a-hook")!.parent).toBe("a");
    expect(placeSettles[0]!.has("a")).toBe(true);

    // `hang` left `dirty.all` up, which is the load path — everything put at
    // its equilibrium, which is the one thing that would hide a jump.
    dirty.clear();
    dirty.item("a");
    sim.step(scene, dirty, 0);
    const after = drawn("a");
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
    // And it has not been stood up at its authored rotation on the way, which
    // is the flatten the other two settles do and this one must not.
    expect(after.rot).toBeCloseTo(before.rot!, 3);
  });

  /** The `Alt` pull ends by the same rule every other string end does, so it
   *  settles by the same rule too. */
  it("settles an item an Alt+drag released a new string onto", () => {
    hang("a", 0, 0);
    putPin("far", null, 600, 600);
    const pose = drawn("a");

    down(600, 600, { alt: true });
    move(300, 300, { alt: true });
    up(0, 0);

    expect(writes.some((w) => w.kind === "string")).toBe(true);
    expect(stringSettles[0]!.get("a")).toEqual(pose);
  });
});

/**
 * Slack controls — DESIGN section 3.4's editing table, and section 3.9's
 * "1-9 slack presets · Alt+wheel whole-string slack".
 *
 * The interesting half of this is not the arithmetic, which lives in
 * `lib/slack.ts` and `crdt/ops/strings.ts`. It is the routing: the wheel is the
 * one input the camera and the board both want, and most of what follows is
 * really asking *which of them gets this notch*. `claimsWheel` is that answer —
 * the camera calls it — and `wheel()` stands in for the pair of calls
 * `state/tools/machine.ts` makes of it, returning whether the board took it.
 */
describe("slack controls", () => {
  const SLACK = 0.2;

  /** A run of pins along y=0, 200 apart, with a string through them and its
   *  gaps addressable by node id the way the binding leaves them. */
  function run(...slacks: number[]): void {
    const count = Math.max(2, slacks.length);
    for (let i = 0; i < count; i++) putPin(`p${i}`, null, i * 200, 0);
    scene.putString({
      id: "s",
      nodes: Array.from({ length: count }, (_, i) => ({
        nodeId: `n${i}`,
        pin: `p${i}`,
        slackAfter: slacks[i] ?? SLACK,
      })),
      color: "#a8322c",
      thickness: 3,
      material: "string",
      layer: "over",
      closed: false,
    });
  }

  /** Two pins 200 apart with one gap between them. */
  function span(...slacks: number[]): void {
    run(...(slacks.length > 0 ? slacks : [SLACK, SLACK]));
  }

  function lastWrite(): Write {
    const write = writes[writes.length - 1];
    if (!write) throw new Error("nothing was written");
    return write;
  }

  /** Move the whole run a long way off, so nothing is under the cursor any
   *  more — a pin dragged, the sag letting out, it makes no difference which. */
  function moveStringAway(): void {
    for (const pin of scene.pins.values()) pin.wy = 900;
  }

  describe("the wheel over a segment", () => {
    /**
     * > | Adjust one segment | Wheel over a **selected** segment | Slack up or
     * > down; the sag responds live | — DESIGN section 3.4
     *
     * Selection is what disambiguates this from a zoom. Without it every wheel
     * notch near a string would stop zooming the board, which is by far the
     * more common thing to want to do near a string.
     */
    it("adjusts the gap under the cursor when its string is selected", () => {
      span();
      selection.replaceStrings(["s"]);
      expect(wheel(100, 0, -100)).toBe(true);
      const write = lastWrite();
      expect(write.kind).toBe("scaleNode");
      if (write.kind !== "scaleNode") return;
      expect(write.stringId).toBe("s");
      expect(write.nodeId).toBe("n0");
      // Away from the user is more sag, which is the sign the zoom already uses
      // for "more" on this board (Q-14).
      expect(write.factor).toBeGreaterThan(1);
    });

    it("runs the other way when the wheel does", () => {
      span();
      selection.replaceStrings(["s"]);
      wheel(100, 0, 100);
      const write = lastWrite();
      expect(write.kind === "scaleNode" && write.factor).toBeLessThan(1);
    });

    /** The camera's, and the tool must not even hear about it. */
    it("leaves the notch to the camera when the string is not selected", () => {
      span();
      expect(wheel(100, 0, -100)).toBe(false);
      expect(writes).toEqual([]);
    });

    /**
     * And declines it without asking where the ropes are.
     *
     * Selection is what disambiguates the gesture, so an empty one is a
     * complete answer on its own. That was merely tidy while the question was
     * asked once per notch; it matters now that `ToolMachine.wheelClaimed` asks
     * it every frame to decide the cursor, on a board whose resting state is
     * nothing selected and the pointer sitting still.
     */
    it("declines without a hit test when no string is selected at all", () => {
      span();
      stringHits = 0;
      expect(tool.claimsWheel(at(100, 0), ctx)).toBe(false);
      expect(stringHits).toBe(0);

      // And the moment there is a selection it does ask, so the fast path is a
      // shortcut through the same rule rather than a second one.
      selection.replaceStrings(["s"]);
      expect(tool.claimsWheel(at(100, 0), ctx)).toBe(true);
      expect(stringHits).toBeGreaterThan(0);
    });

    it("leaves the notch to the camera over bare cork", () => {
      span();
      selection.replaceStrings(["s"]);
      expect(wheel(600, 400, -100)).toBe(false);
      expect(writes).toEqual([]);
    });

    /** `Ctrl`+wheel is a zoom on every engine and is what a trackpad pinch
     *  synthesises, so it is never the board's however well it is aimed. */
    it("leaves Ctrl+wheel to the camera even over a selected segment", () => {
      span();
      selection.replaceStrings(["s"]);
      expect(wheel(100, 0, -100, { ctrl: true })).toBe(false);
      expect(writes).toEqual([]);
    });

    /** The gesture in progress is what the pointer is doing; a wheel arriving
     *  mid-drag belongs to the camera. */
    it("leaves the notch to the camera during a drag", () => {
      span();
      selection.replaceStrings(["s"]);
      put("a", 600, 600);
      const from = camera.boardToScreen(600, 600);
      down(from.x, from.y);
      move(from.x + 40, from.y);
      writes.length = 0;
      expect(wheel(100, 0, -100)).toBe(false);
      expect(writes.every((w) => w.kind !== "scaleNode")).toBe(true);
    });

    /**
     * Which gap, not just which string. A three-pin run has two of them and the
     * wheel means the one the cursor is over.
     */
    it("picks the gap the cursor is actually over", () => {
      run(SLACK, SLACK, SLACK);
      selection.replaceStrings(["s"]);
      wheel(300, 0, -100);
      const write = lastWrite();
      expect(write.kind === "scaleNode" && write.nodeId).toBe("n1");
    });
  });

  /**
   * The latch, which exists because the gesture would otherwise eat itself.
   *
   * Rolling slack *up* lets the rope droop, and the rope drooping is the rope
   * leaving the eight screen pixels either side of the cursor that made it
   * grabbable. Without a latch the board would stop claiming the wheel somewhere
   * mid-roll and the camera would start zooming instead, which reads as the
   * application having lost its mind.
   */
  describe("a roll in progress", () => {
    it("keeps the gap it started on after the sag has moved out from under the cursor", () => {
      span();
      selection.replaceStrings(["s"]);
      expect(wheel(100, 0, -100)).toBe(true);
      moveStringAway();
      writes.length = 0;

      expect(wheel(100, 0, -100)).toBe(true);
      expect(lastWrite()).toMatchObject({ kind: "scaleNode", nodeId: "n0" });
    });

    it("lets go once the wheel stops, and the camera has it again", () => {
      span();
      selection.replaceStrings(["s"]);
      wheel(100, 0, -100);
      moveStringAway();
      // A quarter of a second of no notches ends the roll.
      for (let i = 0; i < 20; i++) tick(16);
      expect(wheel(100, 0, -100)).toBe(false);
    });

    it("holds on across the frames of a continuous roll", () => {
      span();
      selection.replaceStrings(["s"]);
      wheel(100, 0, -100);
      moveStringAway();
      for (let i = 0; i < 30; i++) {
        tick(16);
        expect(wheel(100, 0, -100)).toBe(true);
      }
    });

    it("lets go when the string it was holding is deselected", () => {
      span();
      selection.replaceStrings(["s"]);
      wheel(100, 0, -100);
      moveStringAway();
      selection.clear();
      expect(wheel(100, 0, -100)).toBe(false);
    });

    it("lets go when a collaborator cuts the string mid-roll", () => {
      span();
      selection.replaceStrings(["s"]);
      wheel(100, 0, -100);
      moveStringAway();
      scene.removeString("s");
      expect(wheel(100, 0, -100)).toBe(false);
    });

    it("lets go when the tool is switched away from", () => {
      span();
      selection.replaceStrings(["s"]);
      wheel(100, 0, -100);
      tool.cancel(ctx);
      selection.replaceStrings(["s"]);
      moveStringAway();
      expect(wheel(100, 0, -100)).toBe(false);
    });
  });

  /**
   * > | Adjust the whole string | `Alt`+wheel | All segments together |
   * > — DESIGN section 3.4
   *
   * Unlike the per-segment case it asks nothing about where the cursor is, and
   * that is the whole difference between the two: one needs aiming and one does
   * not.
   */
  describe("Alt+wheel", () => {
    it("scales the whole selected string from anywhere on the board", () => {
      span();
      selection.replaceStrings(["s"]);
      expect(wheel(900, 700, -100, { alt: true })).toBe(true);
      const write = lastWrite();
      expect(write.kind).toBe("scaleString");
      if (write.kind !== "scaleString") return;
      expect(write.stringIds).toEqual(["s"]);
      expect(write.factor).toBeGreaterThan(1);
    });

    /** Scaled, never set: a run that has had a pin pulled out of its middle has
     *  deliberately unequal gaps and `Alt`+wheel must not flatten them. */
    it("never sets the whole string to one value", () => {
      span(0.05, 0.5);
      selection.replaceStrings(["s"]);
      wheel(900, 700, -100, { alt: true });
      expect(writes.every((w) => w.kind !== "stringSlack")).toBe(true);
    });

    it("leaves the notch to the camera when no string is selected", () => {
      span();
      expect(wheel(100, 0, -100, { alt: true })).toBe(false);
      expect(writes).toEqual([]);
    });

    /** The modifier is read once, at the start of the roll, like the handle a
     *  drag took hold of — so letting go of Alt mid-roll does not switch to the
     *  segment under the cursor half way through. */
    it("stays a whole-string roll once it has started", () => {
      span();
      selection.replaceStrings(["s"]);
      wheel(900, 700, -100, { alt: true });
      writes.length = 0;
      expect(wheel(100, 0, -100)).toBe(true);
      expect(lastWrite().kind).toBe("scaleString");
    });
  });

  /**
   * > | Slack presets | `1`-`9` with a string selected | Taut through to
   * > heavily draped | — DESIGN section 3.4
   */
  describe("the 1-9 presets", () => {
    it("sets every gap of the selected string to the preset", () => {
      span();
      selection.replaceStrings(["s"]);
      key("Digit1");
      const write = lastWrite();
      expect(write.kind).toBe("stringSlack");
      if (write.kind !== "stringSlack") return;
      expect(write.stringIds).toEqual(["s"]);
      expect(write.slack).toBe(presetSlack(1));
    });

    it("walks the ladder from taut to heavily draped", () => {
      span();
      selection.replaceStrings(["s"]);
      for (const n of [1, 5, 9]) key(`Digit${n}`);
      const ladder = writes
        .filter((w): w is Extract<Write, { kind: "stringSlack" }> => w.kind === "stringSlack")
        .map((w) => w.slack);
      expect(ladder).toEqual([presetSlack(1), presetSlack(5), presetSlack(9)]);
      expect(ladder[0]).toBeLessThan(ladder[1]!);
      expect(ladder[1]).toBeLessThan(ladder[2]!);
    });

    it("takes the numpad too, since it is the same key by code", () => {
      span();
      selection.replaceStrings(["s"]);
      key("Numpad7");
      expect(lastWrite()).toMatchObject({ kind: "stringSlack", slack: presetSlack(7) });
    });

    it("does nothing with no string selected", () => {
      span();
      put("a", 0, 0);
      selection.replace(["a"]);
      key("Digit4");
      expect(writes).toEqual([]);
    });

    /** `Digit0` is only ever seen here as half of the camera's `Ctrl`+`0`, and
     *  the ladder is nine wide. */
    it("ignores 0 and anything that is not a digit", () => {
      span();
      selection.replaceStrings(["s"]);
      key("Digit0");
      key("KeyG");
      expect(writes).toEqual([]);
    });

    /** `Ctrl`+`1` is the camera's actual-size shortcut. The machine filters it
     *  out, but a tool that acted on it anyway would be a bug waiting for the
     *  day something else forwards a key. */
    it("ignores a digit with Ctrl held", () => {
      span();
      selection.replaceStrings(["s"]);
      key("Digit3", { ctrl: true });
      expect(writes).toEqual([]);
    });
  });

  /**
   * > | Pluck | Click and release without dragging, on a taut string | A
   * > travelling wave runs down it and damps out. Purely for joy
   * > — DESIGN section 3.4
   *
   * The wave is `sim/ropes.test.ts`. What is under test here is only which
   * press asks for one, and the answer turns on a line four rows further up the
   * same table — "a plain click without dragging selects the string instead".
   * The two are not in competition: a click selects, and a click on a taut
   * string also plucks.
   */
  describe("plucking", () => {
    it("plucks a taut segment, at the point on it that was clicked", () => {
      span(MIN_SLACK, MIN_SLACK);
      down(100, 0);
      up(100, 0);
      expect(plucks).toHaveLength(1);
      expect(plucks[0]!.stringId).toBe("s");
      expect(plucks[0]!.x).toBeCloseTo(100, 0);
    });

    /** And selects it, which is the other half of the same click. */
    it("selects it as well", () => {
      span(MIN_SLACK, MIN_SLACK);
      down(100, 0);
      up(100, 0);
      expect([...selection.strings]).toEqual(["s"]);
    });

    /** > on a taut string — a draped one has nothing to twang, and a wave in it
     *  would be lost in the sag. */
    it("does not pluck a slack one", () => {
      span();
      down(100, 0);
      up(100, 0);
      expect(plucks).toEqual([]);
      expect([...selection.strings]).toEqual(["s"]);
    });

    /**
     * Not on the second click of a double, because that one is the taut toggle
     * and its whole job is to stop the segment being taut. A pluck there would
     * shake a string on its way to going slack.
     */
    it("does not pluck on the click that toggles it slack", () => {
      span(MIN_SLACK, MIN_SLACK);
      down(100, 0);
      up(100, 0);
      expect(plucks).toHaveLength(1);
      downAgain(100, 0);
      up(100, 0);
      expect(plucks).toHaveLength(1);
      expect(lastWrite()).toMatchObject({ kind: "nodeSlack", slack: DEFAULT_SLACK });
    });

    /** A press that travelled is the headline gesture, not a click. */
    it("does not pluck when the press turns into a loop pull", () => {
      span(MIN_SLACK, MIN_SLACK);
      down(100, 0);
      move(100, 40);
      up(100, 40);
      expect(plucks).toEqual([]);
    });

    /** > Physics never writes to the document — DESIGN section 5.1. Nothing
     *  about a pluck is durable, so a peer sees nothing and undo has nothing to
     *  undo. */
    it("writes nothing", () => {
      span(MIN_SLACK, MIN_SLACK);
      down(100, 0);
      up(100, 0);
      expect(writes).toEqual([]);
    });
  });

  /**
   * > | Toggle taut | Double-click a segment | Snaps between taut and default
   * > slack | — DESIGN section 3.4
   */
  describe("double-clicking a segment", () => {
    /** The first click of the double has already selected the string, so the
     *  toggle and the selection are the same two presses. */
    function doubleClick(x: number, y: number): void {
      down(x, y);
      up(x, y);
      downAgain(x, y);
      up(x, y);
    }

    it("snaps a slack segment taut", () => {
      span();
      doubleClick(100, 0);
      const write = lastWrite();
      expect(write.kind).toBe("nodeSlack");
      if (write.kind !== "nodeSlack") return;
      expect(write.stringId).toBe("s");
      expect(write.nodeId).toBe("n0");
      expect(write.slack).toBe(MIN_SLACK);
    });

    it("snaps a taut segment back to the default", () => {
      span(MIN_SLACK, MIN_SLACK);
      doubleClick(100, 0);
      expect(lastWrite()).toMatchObject({ kind: "nodeSlack", slack: DEFAULT_SLACK });
    });

    it("selects the string as well, which the first click did", () => {
      span();
      doubleClick(100, 0);
      expect([...selection.strings]).toEqual(["s"]);
    });

    /** One gap, not the run: the design says segment, and a three-pin string
     *  with one taut leg is a thing people want. */
    it("toggles only the segment under the cursor", () => {
      run(SLACK, SLACK, SLACK);
      doubleClick(300, 0);
      expect(lastWrite()).toMatchObject({ kind: "nodeSlack", nodeId: "n1" });
      expect(writes.every((w) => w.kind !== "stringSlack")).toBe(true);
    });

    /**
     * The reason the flag is acted on at the release rather than at the press.
     * Pressing twice on a string and *then* pulling means pull a loop out of it
     * — the headline gesture — and not that as well as a toggle.
     */
    it("is a loop pull, not a toggle, when the second press drags", () => {
      span();
      selection.replaceStrings(["s"]);
      downAgain(100, 0);
      move(100, 40);
      up(100, 40);
      expect(writes.some((w) => w.kind === "insert")).toBe(true);
      expect(writes.every((w) => w.kind !== "nodeSlack")).toBe(true);
    });

    it("does nothing on bare cork", () => {
      span();
      doubleClick(600, 400);
      expect(writes).toEqual([]);
    });
  });
});

/**
 * > | Follow the thread | Double-click | Selects the entire connected component
 * > of pins, strings and items | — DESIGN section 3.3
 *
 * The walk itself is `state/thread.test.ts`. What is under test here is only
 * the gesture: which press does it, which press must not, and that it does not
 * collide with the other double-click on this tool.
 */
describe("following the thread", () => {
  /** A photograph on a pin, a string from that pin to a free one. */
  function web(): void {
    put("photo", 0, 0, 80, 80);
    putPin("onPhoto", "photo", 0, 0);
    putPin("far", null, 300, 0);
    scene.putString({
      id: "s",
      nodes: [
        { nodeId: "n0", pin: "onPhoto", slackAfter: 0.2 },
        { nodeId: "n1", pin: "far", slackAfter: 0.2 },
      ],
      color: "#a8322c",
      thickness: 3,
      material: "string",
      layer: "over",
      closed: false,
    });
  }

  it("takes the whole component on a double-click of a pin", () => {
    web();
    down(0, 0);
    up(0, 0);
    // The first press of the double is still a plain click on a pin, which
    // leaves the selection alone. All of it happens on the second.
    expect(selection.pins.size).toBe(0);
    expect(selection.strings.size).toBe(0);

    downAgain(0, 0);
    up(0, 0);

    expect([...selection.members]).toEqual(["photo"]);
    expect([...selection.strings]).toEqual(["s"]);
    expect([...selection.pins].sort()).toEqual(["far", "onPhoto"]);
  });

  /** The same component from the other end of the string, which is what makes
   *  it a component rather than a direction. */
  it("gives the same answer from the far pin", () => {
    web();
    downAgain(300, 0);
    up(300, 0);
    expect([...selection.members]).toEqual(["photo"]);
    expect([...selection.pins].sort()).toEqual(["far", "onPhoto"]);
  });

  /**
   * A single click on a pin still leaves the selection exactly as it found it.
   * That is what makes the double composable: the first press does nothing, so
   * there is no transitional selection to see.
   */
  it("does nothing on a single click", () => {
    web();
    put("elsewhere", 500, 500);
    selection.replace(["elsewhere"]);
    down(0, 0);
    up(0, 0);
    expect([...selection.members]).toEqual(["elsewhere"]);
    expect(selection.pins.size).toBe(0);
  });

  /**
   * The reason it is acted on at the release. Pressing twice on a pin and then
   * pulling means drag the pin — the primary verb a pin has — and it must not
   * select half the board on the way past.
   */
  it("is a pin drag, not a thread, when the second press drags", () => {
    web();
    downAgain(300, 0);
    move(340, 40);
    up(340, 40);
    expect(selection.pins.size).toBe(0);
    expect(writes.some((w) => w.kind === "place")).toBe(true);
  });

  /**
   * The other double-click on this tool. They cannot collide because the press
   * resolves a pin before it resolves a string, but the two live a few lines
   * apart and nothing else says so.
   */
  it("leaves double-clicking a segment to the taut toggle", () => {
    web();
    // Mid-run, well away from either pin.
    downAgain(150, 0);
    up(150, 0);
    expect(selection.pins.size).toBe(0);
    expect([...selection.strings]).toEqual(["s"]);
    expect(writes.some((w) => w.kind === "nodeSlack")).toBe(true);
  });

  it("selects a lone pin, and only it", () => {
    putPin("alone", null, 0, 0);
    downAgain(0, 0);
    up(0, 0);
    expect([...selection.pins]).toEqual(["alone"]);
    expect(selection.members.size).toBe(0);
    expect(selection.strings.size).toBe(0);
  });
});

/**
 * > Group rotation transports parented pins for free — they're in item-local
 * > space — but free pins inside the selection have their board coordinates
 * > transformed as leaves of the same transform. Miss that and rotating a
 * > selection visibly shears the string web. — DESIGN section 3.8
 *
 * A thread you can select and cannot move is the gesture failing at its stated
 * purpose, which section 3.8 gives as "grab an entire thread of an
 * investigation and move it somewhere else".
 */
describe("a thread that is dragged carries its free pins", () => {
  /** A photograph with a pin in it, a free pin out on the cork, and the string
   *  between them — the smallest thing that is a thread. */
  function thread(): void {
    put("photo", 0, 0, 100, 100);
    putPin("onPhoto", "photo", 0, 0);
    putPin("free", null, 300, 0);
    scene.putString({
      id: "s",
      nodes: [
        { nodeId: "n0", pin: "onPhoto", slackAfter: 0.2 },
        { nodeId: "n1", pin: "free", slackAfter: 0.2 },
      ],
      color: "#a8322c",
      thickness: 3,
      material: "string",
      layer: "over",
      closed: false,
    });
    selection.replaceThread(["photo"], ["s"], ["onPhoto", "free"]);
  }

  function lastPins(): Map<string, { x: number; y: number }> {
    for (let i = writes.length - 1; i >= 0; i--) {
      const w = writes[i]!;
      if (w.kind === "pins") return w.positions;
    }
    throw new Error("no pin write");
  }

  it("moves a free pin by the same amount as the photograph", () => {
    thread();
    // On the paper, clear of the pin pushed into it — a press within the pin's
    // grab radius is a pin drag, which is a different gesture entirely.
    down(35, 35);
    move(155, 75);
    up(155, 75);

    expect(scene.pins.get("free")).toMatchObject({ lx: 420, ly: 40, wx: 420, wy: 40 });
    expect(lastPins().get("free")).toEqual({ x: 420, y: 40 });
  });

  /**
   * The pin pushed into the photograph is stored in the photograph's frame and
   * arrives for nothing. Putting it in the write as well would move it twice —
   * once with its item and once on its own.
   */
  it("leaves the parented pin to travel with its item", () => {
    thread();
    // On the paper, clear of the pin pushed into it — a press within the pin's
    // grab radius is a pin drag, which is a different gesture entirely.
    down(35, 35);
    move(155, 75);
    up(155, 75);
    expect(lastPins().has("onPhoto")).toBe(false);
    expect(scene.pins.get("onPhoto")!.lx).toBe(0);
  });

  it("writes the pins and the poses in the same gesture", () => {
    thread();
    // On the paper, clear of the pin pushed into it — a press within the pin's
    // grab radius is a pin drag, which is a different gesture entirely.
    down(35, 35);
    move(155, 75);
    up(155, 75);
    const kinds = writes.map((w) => w.kind);
    expect(kinds).toContain("poses");
    expect(kinds).toContain("pins");
  });

  /**
   * The shear DESIGN section 3.8 names. A rotation that turned the photographs
   * and left the free pins where they were would pull every string in the web
   * out of shape.
   */
  it("turns a free pin about the same pivot as the items", () => {
    thread();
    // A second item, so the pivot is the pair's bounds rather than a sole pin.
    put("other", 200, 0, 100, 100);
    selection.replaceThread(["photo", "other"], ["s"], ["onPhoto", "free"]);

    held.add("KeyR");
    // The pivot is the pair's bounds centre, (100, 0). Out along +x first to
    // anchor the angle, then round to +y — a quarter turn.
    // Off the string's own line as well as clear of the pins: a press on the
    // run between them pulls a loop out of it, which is the other gesture that
    // starts on a photograph.
    down(200, 30);
    move(300, 0);
    move(100, 200);
    up(100, 200);

    const free = scene.pins.get("free")!;
    // (300, 0) turned a quarter turn clockwise about (100, 0) is (100, 200).
    expect(free.lx).toBeCloseTo(100, 3);
    expect(free.ly).toBeCloseTo(200, 3);
    // And it kept its distance from the pivot, which is what "no shear" means.
    expect(Math.hypot(free.lx - 100, free.ly - 0)).toBeCloseTo(200, 3);
  });

  /** > `Esc` mid-drag → the whole thing reverts — DESIGN section 3.4 */
  it("puts a free pin back on cancel", () => {
    thread();
    down(35, 35);
    move(155, 75);
    expect(scene.pins.get("free")!.lx).toBe(420);

    tool.handle({ kind: "cancel" }, ctx);
    expect(scene.pins.get("free")).toMatchObject({ lx: 300, ly: 0, wx: 300, wy: 0 });
  });

  it("writes nothing for a thread whose pins did not move", () => {
    thread();
    down(35, 35);
    up(35, 35);
    expect(writes.every((w) => w.kind !== "pins")).toBe(true);
  });

  /**
   * The pin's world position as well as its stored one, and not left to the
   * LAYOUT phase: `sim/ropes.ts` reads pin world positions in phase 3, one
   * phase *earlier* than `Scene.layoutPins` recomputes them. Setting only the
   * stored pair leaves the whole web anchored a frame behind the thread.
   */
  it("moves the pin's world position too, so the string does not lag", () => {
    thread();
    down(35, 35);
    move(95, 35);
    expect(scene.pins.get("free")).toMatchObject({ wx: 360, wy: 0 });
  });
});
