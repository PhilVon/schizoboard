/**
 * The scene must be testable with no document at all — ARCHITECTURE 2.1, and
 * AC-43. Nothing in this file imports yjs, and the lint rules would stop it.
 */

import { describe, expect, it } from "vitest";

import { DirtySets } from "@/state/dirty";
import { Scene, type ItemCold, type ItemPose } from "@/state/scene";

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
    scene.putPin(pin("p3", null, 5, 0));
    expect(scene.pinCount("a")).toBe(2);
  });
});

/**
 * The index is derived, so every test here is really the same question asked
 * of a different edit: does it still agree with `pin.parent`, which is the
 * only source of truth (AC-56)?
 */
describe("the reverse pin index", () => {
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
    expect([...scene.pinsOf("a")]).toEqual(["p"]);

    scene.putPin(pin("p", "b"));
    expect(scene.pinCount("a")).toBe(0);
    expect([...scene.pinsOf("b")]).toEqual(["p"]);
  });

  it("follows a pin dragged off onto bare cork, and back on", () => {
    const scene = new Scene();
    scene.putPin(pin("p", "a"));
    scene.putPin(pin("p", null));
    expect(scene.pinCount("a")).toBe(0);
    scene.putPin(pin("p", "a"));
    expect(scene.pinCount("a")).toBe(1);
  });

  it("does not double-count a pin whose parent did not change", () => {
    const scene = new Scene();
    scene.putPin(pin("p", "a"));
    scene.putPin(pin("p", "a"));
    expect(scene.pinCount("a")).toBe(1);
  });

  it("forgets a deleted pin", () => {
    const scene = new Scene();
    scene.putPin(pin("p1", "a"));
    scene.putPin(pin("p2", "a"));
    expect(scene.removePin("p1")).toBe(true);
    expect(scene.removePin("p1")).toBe(false);
    expect([...scene.pinsOf("a")]).toEqual(["p2"]);
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
    expect(scene.pinCount("a")).toBe(1);
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
