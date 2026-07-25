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
