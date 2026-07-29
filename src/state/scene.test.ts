/**
 * The scene must be testable with no document at all — ARCHITECTURE 2.1, and
 * AC-43. Nothing in this file imports yjs, and the lint rules would stop it.
 */

import { describe, expect, it } from "vitest";

import { Torsion } from "@/sim/torsion";
import { DirtySets } from "@/state/dirty";
import { drawnPose } from "@/state/tools/frame";
import {
  Scene,
  type ItemCold,
  type ItemPose,
  type SceneStroke,
  type StringNodes,
} from "@/state/scene";

function cold(id: string, over: Partial<ItemCold> = {}): ItemCold {
  return {
    id,
    type: "polaroid",
    z: "a0",
    seed: 1,
    assetId: null,
    createdBy: 1,
    createdAt: 0,
    text: "",
    ...over,
  };
}

function pose(over: Partial<ItemPose> = {}): ItemPose {
  return { x: 0, y: 0, rot: 0, w: 100, h: 100, ...over };
}

describe("Scene slots", () => {
  it("hands out dense slots and reuses them after deletion", () => {
    const scene = new Scene();
    const a = scene.putItem(cold("a"), pose());
    const b = scene.putItem(cold("b"), pose());
    expect([a, b]).toEqual([0, 1]);

    scene.removeItem("a");
    expect(scene.size).toBe(1);
    expect(scene.idAt(a)).toBeNull();

    const c = scene.putItem(cold("c"), pose());
    expect(c).toBe(0); // reused
    expect(scene.idAt(0)).toBe("c");
  });

  it("does not resurrect a deleted item through its old slot", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 5 }));
    scene.removeItem("a");
    scene.putItem(cold("b"), pose({ x: 9 }));
    expect(scene.has("a")).toBe(false);
    expect(scene.poseOf("a")).toBeNull();
    expect(scene.poseOf("b")!.x).toBe(9);
  });

  it("grows past its initial capacity without losing anything", () => {
    const scene = new Scene();
    for (let i = 0; i < 1000; i++) {
      scene.putItem(cold(`i${i}`), pose({ x: i, y: -i }));
    }
    expect(scene.size).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      const p = scene.poseOf(`i${i}`)!;
      expect(p.x).toBe(i);
      expect(p.y).toBe(-i);
    }
  });

  it("updates in place without changing slot", () => {
    const scene = new Scene();
    const slot = scene.putItem(cold("a"), pose());
    scene.setPose("a", { x: 42 });
    expect(scene.slotOf("a")).toBe(slot);
    expect(scene.x[slot]).toBe(42);
    expect(scene.setPose("missing", { x: 1 })).toBe(false);
  });

  it("clears everything", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose());
    scene.putPin({ id: "p", parent: "a", lx: 0, ly: 0, kind: "pushpin", color: "#f00", wx: 0, wy: 0 });
    scene.clear();
    expect(scene.size).toBe(0);
    expect(scene.pins.size).toBe(0);
    expect(scene.slotLimit).toBe(0);
  });
});

describe("pin layout", () => {
  const pin = (id: string, parent: string | null, lx: number, ly: number) => ({
    id,
    parent,
    lx,
    ly,
    kind: "pushpin",
    color: "#c8352f",
    wx: 0,
    wy: 0,
  });

  it("carries a parented pin through its item's rotation", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 100, y: 100, rot: Math.PI / 2 }));
    scene.putPin(pin("p", "a", 10, 0));
    scene.layoutPins();
    const p = scene.pins.get("p")!;
    expect(p.wx).toBeCloseTo(100, 5);
    expect(p.wy).toBeCloseTo(110, 5);
  });

  it("includes the swing, so a pin stays on a photograph that is swinging", () => {
    const scene = new Scene();
    const slot = scene.putItem(cold("a"), pose({ x: 0, y: 0, rot: 0 }));
    scene.putPin(pin("p", "a", 10, 0));
    scene.layoutPins();
    const still = { ...scene.pins.get("p")! };

    scene.swing[slot] = Math.PI / 2;
    scene.layoutPins();
    const swung = scene.pins.get("p")!;
    expect(still.wy).toBeCloseTo(0, 5);
    expect(swung.wy).toBeCloseTo(10, 5);
  });

  it("leaves a free pin at its board coordinates", () => {
    const scene = new Scene();
    scene.putPin(pin("p", null, -30, 70));
    scene.layoutPins();
    expect(scene.pins.get("p")).toMatchObject({ wx: -30, wy: 70 });
  });

  it("treats a pin whose parent vanished as free-floating, not as an error", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 500, y: 500 }));
    scene.putPin(pin("p", "a", 5, 5));
    scene.removeItem("a");
    scene.layoutPins();
    const p = scene.pins.get("p")!;
    expect(Number.isFinite(p.wx)).toBe(true);
    expect(p.wx).toBe(5);
  });

  it("skips pins whose item did not move", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 0, y: 0 }));
    scene.putItem(cold("b"), pose({ x: 0, y: 0 }));
    scene.putPin(pin("pa", "a", 0, 0));
    scene.putPin(pin("pb", "b", 0, 0));
    scene.layoutPins();

    scene.setPose("a", { x: 100 });
    scene.setPose("b", { x: 200 });
    scene.layoutPins(new Set(["a"]));

    expect(scene.pins.get("pa")!.wx).toBe(100);
    expect(scene.pins.get("pb")!.wx).toBe(0); // stale on purpose — not dirty
  });

  it("counts the pins holding an item, which is its physics", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose());
    expect(scene.pinCount("a")).toBe(0);
    scene.putPin(pin("p1", "a", 0, 0));
    expect(scene.pinCount("a")).toBe(1);
    scene.putPin(pin("p2", "a", 5, 0));
    expect(scene.pinCount("a")).toBe(2);
    // A free pin inside the paper holds it too (T-176). It used to be invisible
    // here, because the count was of pins that *named* this item as a parent —
    // which is why an item with a pin plainly sitting on it lay flat.
    scene.putPin(pin("p3", null, 5, 0));
    expect(scene.pinCount("a")).toBe(3);
    // And a free pin outside it does not.
    scene.putPin(pin("p4", null, 9000, 0));
    expect(scene.pinCount("a")).toBe(3);
  });
});

/**
 * Geometry, not parentage (T-176).
 *
 * > a pin may end up over two items if a pin or an item with a pin was moved
 * > or an item rotated. my thinking is a pin should effect any item under it.
 *
 * `parent` still says whose coordinate frame a pin's numbers are in, and DESIGN
 * 2.2 is right that it must stay singular. What it stopped saying is what the
 * pin *holds*.
 */
describe("which items a pin is pushed through", () => {
  const pin = (id: string, parent: string | null, lx: number, ly: number) => ({
    id,
    parent,
    lx,
    ly,
    kind: "pushpin",
    color: "#c8352f",
    wx: 0,
    wy: 0,
  });

  it("holds every item it lies inside, not only the one it is parented to", () => {
    const scene = new Scene();
    scene.putItem(cold("under"), pose({ x: 0, y: 0, w: 200, h: 200 }));
    scene.putItem(cold("over"), pose({ x: 60, y: 0, w: 200, h: 200 }));
    // Parented to `over`, at a point that also lands inside `under`.
    scene.putPin(pin("p", "over", -40, 0));
    expect([...scene.pinsOf("over")]).toEqual(["p"]);
    expect([...scene.pinsOf("under")]).toEqual(["p"]);
    // And the frame is still singular, which is the half DESIGN 2.2 is about.
    expect([...scene.pinsParentedTo("over")]).toEqual(["p"]);
    expect([...scene.pinsParentedTo("under")]).toEqual([]);
  });

  it("lets an item dragged over a stationary pin be held by it", () => {
    // The case the human described, and the one a parent index cannot see: no
    // pin was written to at all.
    const scene = new Scene();
    scene.putPin(pin("p", null, 500, 500));
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 200, h: 200 }));
    expect(scene.pinCount("a")).toBe(0);

    scene.setPose("a", { x: 500, y: 500 });
    expect(scene.pinCount("a")).toBe(1);
    expect(scene.solePin("a")?.id).toBe("p");
  });

  it("lets go when the item is dragged out from under it", () => {
    const scene = new Scene();
    scene.putPin(pin("p", null, 0, 0));
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 200, h: 200 }));
    expect(scene.pinCount("a")).toBe(1);
    scene.setPose("a", { x: 5000 });
    expect(scene.pinCount("a")).toBe(0);
  });

  it("counts a corner the rotation swung away, and not one it swung under", () => {
    // The exact test is against the rotated rectangle, not the box round it, so
    // a pin near a corner changes hands as the paper turns.
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 200, h: 40, rot: 0 }));
    scene.putPin(pin("p", null, 0, 60));
    expect(scene.pinCount("a")).toBe(0);
    scene.setPose("a", { rot: Math.PI / 2 });
    expect(scene.pinCount("a")).toBe(1);
  });

  it("stops holding anything once the item is gone", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ w: 200, h: 200 }));
    scene.putPin(pin("p", null, 0, 0));
    expect(scene.pinCount("a")).toBe(1);
    scene.removeItem("a");
    // Not a stale set left behind by a rebuild that no longer visits it.
    expect(scene.pinCount("a")).toBe(0);
    expect([...scene.pinsOf("a")]).toEqual([]);
  });
});

/**
 * The index is derived, so every test here is really the same question asked
 * of a different edit: does it still agree with `pin.parent`, which is the
 * only source of truth (AC-56)?
 */
describe("the reverse pin index", () => {
  /**
   * The size of the *parent* index. Every test in this block is about that one
   * — none of these items exists in the scene at all, which is the point: the
   * index tracks `pin.parent`, a name, whether or not it resolves. `pinCount`
   * is the geometric question now (T-176) and would answer nothing here.
   */
  const parentCount = (scene: Scene, itemId: string): number =>
    scene.pinsParentedTo(itemId).size;

  const pin = (id: string, parent: string | null) => ({
    id,
    parent,
    lx: 0,
    ly: 0,
    kind: "pushpin",
    color: "#c8352f",
    wx: 0,
    wy: 0,
  });

  it("follows a pin re-parented from one item to another", () => {
    const scene = new Scene();
    scene.putPin(pin("p", "a"));
    expect([...scene.pinsParentedTo("a")]).toEqual(["p"]);

    scene.putPin(pin("p", "b"));
    expect(parentCount(scene, "a")).toBe(0);
    expect([...scene.pinsParentedTo("b")]).toEqual(["p"]);
  });

  it("follows a pin dragged off onto bare cork, and back on", () => {
    const scene = new Scene();
    scene.putPin(pin("p", "a"));
    scene.putPin(pin("p", null));
    expect(parentCount(scene, "a")).toBe(0);
    scene.putPin(pin("p", "a"));
    expect(parentCount(scene, "a")).toBe(1);
  });

  it("does not double-count a pin whose parent did not change", () => {
    const scene = new Scene();
    scene.putPin(pin("p", "a"));
    scene.putPin(pin("p", "a"));
    expect(parentCount(scene, "a")).toBe(1);
  });

  it("forgets a deleted pin", () => {
    const scene = new Scene();
    scene.putPin(pin("p1", "a"));
    scene.putPin(pin("p2", "a"));
    expect(scene.removePin("p1")).toBe(true);
    expect(scene.removePin("p1")).toBe(false);
    expect([...scene.pinsParentedTo("a")]).toEqual(["p2"]);
  });

  /**
   * Pins outlive items (DESIGN section 3.8). The pin is still parented to the
   * id it always was; the item is what has gone, and undo can bring it back.
   */
  it("keeps holding pins whose item was deleted", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose());
    scene.putPin(pin("p", "a"));
    scene.removeItem("a");
    expect(parentCount(scene, "a")).toBe(1);
  });

  it("hands an unpinned item an empty set rather than nothing", () => {
    const scene = new Scene();
    expect(scene.pinsOf("nobody").size).toBe(0);
  });

  it("empties with the scene", () => {
    const scene = new Scene();
    scene.putPin(pin("p", "a"));
    scene.clear();
    expect(scene.pinCount("a")).toBe(0);
  });
});

/**
 * The other direction: which strings run through a pin.
 *
 * > A pin hosting six different strings works — with no special cases, because
 * > a string just holds pin ids and a pin doesn't know or care how many strings
 * > reference it. — DESIGN section 2.3
 *
 * Which is exactly why the index has to exist: the relationship is recorded
 * entirely on the string side, so the question "what hangs off this pin" has no
 * cheap answer without one — and hovering a pin asks it on every frame the
 * cursor moves.
 */
describe("the reverse string index", () => {
  const run = (id: string, ...pins: string[]): StringNodes => ({
    id,
    nodes: pins.map((p, i) => ({ nodeId: `${id}-n${i}`, pin: p, slackAfter: 0.2 })),
    color: "#a8322c",
    thickness: 3,
    material: "string",
    layer: "over",
    closed: false,
  });

  it("answers which strings run through a pin", () => {
    const scene = new Scene();
    scene.putString(run("s0", "p0", "p1"));
    scene.putString(run("s1", "p1", "p2"));
    expect([...scene.stringsThrough("p0")]).toEqual(["s0"]);
    expect([...scene.stringsThrough("p1")].sort()).toEqual(["s0", "s1"]);
    expect([...scene.stringsThrough("p2")]).toEqual(["s1"]);
  });

  /** The hub pin of DESIGN section 2.3, which is the case the whole index is
   *  for and which needs no special handling anywhere. */
  it("holds a hub pin hosting six strings", () => {
    const scene = new Scene();
    for (let i = 0; i < 6; i++) scene.putString(run(`s${i}`, "hub", `p${i}`));
    expect(scene.stringsThrough("hub").size).toBe(6);
  });

  /**
   * The failure this index exists to avoid, and the one a plain
   * `scene.strings.set` would reintroduce: a run re-read by the binding after a
   * pin was pulled out of its middle still names the old pin in the old node
   * list, and an index that only ever *adds* would go on claiming the string
   * runs through a pin it no longer touches.
   */
  it("drops the pins a re-read run no longer names", () => {
    const scene = new Scene();
    scene.putString(run("s", "p0", "gone", "p1"));
    expect([...scene.stringsThrough("gone")]).toEqual(["s"]);

    scene.putString(run("s", "p0", "p1"));
    expect(scene.stringsThrough("gone").size).toBe(0);
    expect([...scene.stringsThrough("p0")]).toEqual(["s"]);
  });

  it("forgets a deleted string, and says whether there was one", () => {
    const scene = new Scene();
    scene.putString(run("s0", "p", "q"));
    scene.putString(run("s1", "p", "r"));
    expect(scene.removeString("s0")).toBe(true);
    expect(scene.removeString("s0")).toBe(false);
    expect([...scene.stringsThrough("p")]).toEqual(["s1"]);
  });

  /** A loop closed back through the pin it started at names that pin twice.
   *  The entry is the string, not the visit — and removing it must not leave
   *  half an entry behind. */
  it("counts a pin named twice by one run once", () => {
    const scene = new Scene();
    scene.putString(run("s", "p", "q", "p"));
    expect([...scene.stringsThrough("p")]).toEqual(["s"]);
    scene.removeString("s");
    expect(scene.stringsThrough("p").size).toBe(0);
  });

  it("hands a bare pin an empty set rather than nothing", () => {
    const scene = new Scene();
    expect(scene.stringsThrough("nobody").size).toBe(0);
  });

  it("empties with the scene", () => {
    const scene = new Scene();
    scene.putString(run("s", "p", "q"));
    scene.clear();
    expect(scene.stringsThrough("p").size).toBe(0);
  });
});

describe("bounds", () => {
  it("expands for rotation rather than using the raw rectangle", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 100, h: 20, rot: Math.PI / 4 }));
    const b = scene.boundsOf("a")!;
    const expected = (100 + 20) / 2 / Math.SQRT2;
    expect(b.maxX).toBeCloseTo(expected, 4);
    expect(b.maxY).toBeCloseTo(expected, 4);
  });

  it("pads", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ w: 100, h: 100 }));
    expect(scene.boundsOf("a", 10)!.maxX).toBeCloseTo(60, 5);
  });

  it("frames all content, including free pins", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 100, h: 100 }));
    scene.putPin({
      id: "p",
      parent: null,
      lx: 900,
      ly: -400,
      kind: "pushpin",
      color: "#f00",
      wx: 900,
      wy: -400,
    });
    const b = scene.contentBounds()!;
    expect(b.minX).toBeCloseTo(-50, 5);
    expect(b.maxX).toBeCloseTo(900, 5);
    expect(b.minY).toBeCloseTo(-400, 5);
  });

  it("has no bounds when the board is empty", () => {
    expect(new Scene().contentBounds()).toBeNull();
  });

  /**
   * T-135. The trap under the bug rather than the bug: these bounds are the
   * box the board is *drawn* in, so they are a function of `swing` and `drift`
   * — which phase 3 owns and which do not exist until it has run once. Anyone
   * framing the board before then frames every hanging item un-hung, which is
   * what made the opening view and `Ctrl+0` disagree on a real board.
   */
  it("moves with the swing, so it is only true after phase 3 has run", () => {
    const scene = new Scene();
    scene.putItem(
      { id: "a", type: "note", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
      { x: 0, y: 0, rot: 0.9, w: 300, h: 100 },
    );
    scene.putPin({
      id: "p",
      parent: "a",
      lx: 0,
      ly: -50,
      kind: "pushpin",
      color: "#f00",
      wx: 0,
      wy: -50,
    });

    const unhung = { ...scene.contentBounds()! };

    const dirty = new DirtySets();
    dirty.everything();
    new Torsion().step(scene, dirty, 0);

    const hung = scene.contentBounds()!;

    // Tilted at 0.9 rad the 300x100 note's expanded box is 300|cos| + 100|sin|
    // wide; hanging plumb it is exactly 300. Thirty-five units of difference on
    // one small note, in the direction that makes the board bigger.
    expect(unhung.maxX - unhung.minX).toBeCloseTo(264.8, 1);
    expect(hung.maxX - hung.minX).toBeCloseTo(300, 6);
  });
});

describe("Scene.intersectsRect", () => {
  it("answers the marquee question for an unrotated item", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 100, h: 100 }));

    expect(scene.intersectsRect("a", { minX: -10, minY: -10, maxX: 10, maxY: 10 })).toBe(true);
    // Clipping one corner is still touching it.
    expect(scene.intersectsRect("a", { minX: 40, minY: 40, maxX: 200, maxY: 200 })).toBe(true);
    expect(scene.intersectsRect("a", { minX: 60, minY: 60, maxX: 200, maxY: 200 })).toBe(false);
    // A rectangle that swallows the item whole.
    expect(scene.intersectsRect("a", { minX: -500, minY: -500, maxX: 500, maxY: 500 })).toBe(true);
  });

  it("uses the item's real corners, not its expanded box", () => {
    const scene = new Scene();
    // A bar running corner to corner. Its expanded box is a square of about
    // 311 units; the bar itself is 40 units thick.
    scene.putItem(cold("bar"), pose({ x: 0, y: 0, w: 400, h: 40, rot: Math.PI / 4 }));

    // Inside the box, well off the bar.
    expect(scene.intersectsRect("bar", { minX: -190, minY: 100, maxX: -120, maxY: 170 })).toBe(
      false,
    );
    // On the bar.
    expect(scene.intersectsRect("bar", { minX: -40, minY: -40, maxX: 40, maxY: 40 })).toBe(true);
    // Past the end of it, along its own axis.
    expect(scene.intersectsRect("bar", { minX: 200, minY: 200, maxX: 260, maxY: 260 })).toBe(false);
  });

  it("follows the rendered rotation, so a swinging item is where it looks", () => {
    const scene = new Scene();
    const slot = scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 400, h: 20 }));
    const rect = { minX: -10, minY: 100, maxX: 10, maxY: 140 };
    expect(scene.intersectsRect("a", rect)).toBe(false);

    scene.swing[slot] = Math.PI / 2;
    expect(scene.intersectsRect("a", rect)).toBe(true);
  });

  it("takes a rectangle dragged backwards", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 100, h: 100 }));
    expect(scene.intersectsRect("a", { minX: 10, minY: 10, maxX: -10, maxY: -10 })).toBe(true);
  });

  it("says no for an item that is not there", () => {
    expect(
      new Scene().intersectsRect("ghost", { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }),
    ).toBe(false);
  });
});

/**
 * T-177. The angle an item is drawn at had been spelled out as `rot + swing` at
 * a dozen call sites, and T-107 is what came of one of them being missed — the
 * chrome, the marquee and the rotate pivot each re-derived it and then
 * disagreed with the paint.
 *
 * These tests do not check the arithmetic; they check that every geometry
 * answer is derived *from `renderRot`* rather than re-derived beside it. That
 * matters for what comes next: T-178 bends this angle to lay a note flat while
 * it is being written on, and anything still doing its own sum would be left
 * pointing at the tilted paper.
 */
describe("Scene.renderRot", () => {
  it("is the angle the bounds, the marquee and the pin layout all use", () => {
    const scene = new Scene();
    const slot = scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 400, h: 20, rot: 0.3 }));
    scene.putPin({
      id: "p",
      parent: "a",
      lx: 100,
      ly: 0,
      kind: "pushpin",
      color: "#f00",
      wx: 0,
      wy: 0,
    });
    scene.swing[slot] = -0.7;

    // One angle, asked for once, and then every answer checked against it.
    const angle = scene.renderRot(slot);
    expect(angle).toBeCloseTo(-0.4, 6);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const b = scene.boundsOf("a")!;
    expect(b.maxX).toBeCloseTo((400 * Math.abs(cos) + 20 * Math.abs(sin)) / 2, 4);
    expect(b.maxY).toBeCloseTo((400 * Math.abs(sin) + 20 * Math.abs(cos)) / 2, 4);

    const pin = scene.pins.get("p")!;
    scene.layoutPin(pin);
    expect(pin.wx).toBeCloseTo(100 * cos, 4);
    expect(pin.wy).toBeCloseTo(100 * sin, 4);

    // A thin rectangle laid on the bar's far end, positioned from the same
    // angle: the marquee has to find it there and nowhere else.
    const ex = 190 * cos;
    const ey = 190 * sin;
    expect(
      scene.intersectsRect("a", { minX: ex - 4, minY: ey - 4, maxX: ex + 4, maxY: ey + 4 }),
    ).toBe(true);
    // And not at the end the item would have had without the swing.
    const wx = 190 * Math.cos(0.3);
    const wy = 190 * Math.sin(0.3);
    expect(
      scene.intersectsRect("a", { minX: wx - 4, minY: wy - 4, maxX: wx + 4, maxY: wy + 4 }),
    ).toBe(false);
  });

  it("is what drawnPose flattens, so a gesture leaves paper where it looks", () => {
    const scene = new Scene();
    const slot = scene.putItem(cold("a"), pose({ x: 0, y: 0, rot: 0.3 }));
    scene.swing[slot] = -0.7;
    expect(drawnPose(scene, "a")!.rot).toBeCloseTo(scene.renderRot(slot), 6);
  });
});

describe("Scene.boundsOfMany", () => {
  it("combines the bounds of a selection and ignores what has gone", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: -100, y: 0, w: 100, h: 100 }));
    scene.putItem(cold("b"), pose({ x: 300, y: 200, w: 100, h: 100 }));

    const b = scene.boundsOfMany(["a", "b", "gone"])!;
    expect(b.minX).toBeCloseTo(-150, 5);
    expect(b.maxX).toBeCloseTo(350, 5);
    expect(b.minY).toBeCloseTo(-50, 5);
    expect(b.maxY).toBeCloseTo(250, 5);

    expect(scene.boundsOfMany([])).toBeNull();
    expect(scene.boundsOfMany(["gone"])).toBeNull();
  });
});

describe("DirtySets", () => {
  it("starts clean and reports what it holds", () => {
    const dirty = new DirtySets();
    expect(dirty.isClean).toBe(true);
    dirty.item("a");
    expect(dirty.isClean).toBe(false);
    dirty.clear();
    expect(dirty.isClean).toBe(true);
    dirty.camera = true;
    expect(dirty.isClean).toBe(false);
  });

  it("everything() sets the coarse flags together", () => {
    const dirty = new DirtySets();
    dirty.everything();
    expect(dirty.all).toBe(true);
    expect(dirty.camera).toBe(true);
    expect(dirty.culling).toBe(true);
    dirty.clear();
    expect(dirty.all).toBe(false);
  });
});

/**
 * The reverse index behind DATA-MODEL section 9.2's handoff: a peer's wet run
 * carries the id its record will be filed under, and this is how a client asks
 * whether that record has arrived — and on which surface, since only the layer
 * that owns the surface can say whether its canvas is showing it yet.
 */
describe("Scene stroke surfaces", () => {
  function stroke(id: string, over: Partial<SceneStroke> = {}): SceneStroke {
    return {
      id,
      tool: "marker",
      color: "#1f1b17",
      size: 4,
      opacity: 1,
      seed: 1,
      z: "a0",
      bbox: [0, 0, 10, 10],
      samples: [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 10, y: 10, pressure: 0.5 },
      ],
      ...over,
    };
  }

  it("names the item a stroke is glued to", () => {
    const scene = new Scene();
    scene.putStrokes("note", [stroke("s1"), stroke("s2")]);
    expect(scene.strokeSurface("s1")).toEqual({ kind: "item", id: "note" });
    expect(scene.strokeSurface("s2")).toEqual({ kind: "item", id: "note" });
  });

  it("names the tile a board stroke was filed in", () => {
    const scene = new Scene();
    // The one the caller could not work out for itself: a board stroke is
    // bucketed by the bounding-box centre of *all* its points, and a peer
    // watching it be drawn may hold a shorter piece of the mark.
    scene.putBoardStrokes("0,0", [stroke("s1")]);
    expect(scene.strokeSurface("s1")).toEqual({ kind: "tile", key: "0,0" });
  });

  it("says nothing about a stroke this board has never held", () => {
    expect(new Scene().strokeSurface("nope")).toBeNull();
  });

  it("forgets a stroke an erase took out", () => {
    const scene = new Scene();
    scene.putStrokes("note", [stroke("s1"), stroke("s2")]);
    // An erase arrives as a shorter list, so the id it dropped is nameable only
    // from the list being replaced. An index that filed the new one without
    // unfiling the old would go on telling a ghost that its record is still
    // there — and the mark would never come back on the overlay either.
    scene.putStrokes("note", [stroke("s2")]);
    expect(scene.strokeSurface("s1")).toBeNull();
    expect(scene.strokeSurface("s2")).toEqual({ kind: "item", id: "note" });

    scene.putBoardStrokes("0,0", [stroke("b1"), stroke("b2")]);
    scene.putBoardStrokes("0,0", [stroke("b2")]);
    expect(scene.strokeSurface("b1")).toBeNull();
    expect(scene.strokeSurface("b2")).toEqual({ kind: "tile", key: "0,0" });
  });

  it("forgets the ink of an item that left the board", () => {
    const scene = new Scene();
    scene.putItem(cold("note"), pose());
    scene.putStrokes("note", [stroke("s1")]);
    scene.removeItem("note");
    // The ink went with the item, which is the document's answer and not an
    // omission — so a ghost still up for that stroke waits out its grace and
    // goes, rather than being told the record is on a surface that is gone.
    expect(scene.strokeSurface("s1")).toBeNull();
  });

  it("forgets everything a tile or an item emptied", () => {
    const scene = new Scene();
    scene.putStrokes("note", [stroke("s1")]);
    scene.putBoardStrokes("0,0", [stroke("b1")]);
    scene.putStrokes("note", []);
    scene.putBoardStrokes("0,0", []);
    expect(scene.strokeSurface("s1")).toBeNull();
    expect(scene.strokeSurface("b1")).toBeNull();

    scene.putStrokes("note", [stroke("s1")]);
    scene.clear();
    expect(scene.strokeSurface("s1")).toBeNull();
  });
});
