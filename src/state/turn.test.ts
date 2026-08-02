/**
 * T-178. The note laid flat to be written on, and the two things that are easy
 * to get wrong about it:
 *
 * - the pin does not move, because a pin is stuck in the cork; and
 * - the document never learns about any of it, because the whole thing is
 *   taken back on blur.
 *
 * No document and no DOM, like the rest of `state/` — ARCHITECTURE 2.1.
 */

import { describe, expect, it } from "vitest";

import { DirtySets } from "@/state/dirty";
import { FLATTEN_MS, PaperTurn } from "@/state/turn";
import { Scene, type ItemColdInput, type ItemPose, type PinNode } from "@/state/scene";
import { drawnPose } from "@/state/tools/frame";

function cold(id: string, over: Partial<ItemColdInput> = {}): ItemColdInput {
  return {
    id,
    type: "note",
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
  return { x: 0, y: 0, rot: 0, w: 200, h: 120, ...over };
}

function pin(over: Partial<PinNode> = {}): PinNode {
  return {
    id: "p",
    parent: "a",
    lx: 0,
    ly: -60,
    kind: "pushpin",
    color: "#f00",
    wx: 0,
    wy: 0,
    ...over,
  };
}

/** Run the clock to a stop, or give up — a stepper that never lands is a bug. */
function settle(flat: PaperTurn, scene: Scene, dirty: DirtySets): number {
  for (let frame = 0; frame < 100; frame++) {
    flat.step(scene, dirty, 16);
    if (!flat.moving) return frame;
  }
  throw new Error("the flatten never stopped moving");
}

describe("laying a note flat", () => {
  it("ends square to the screen whatever angle the paper was at", () => {
    for (const rot of [0.2, -0.9, 2.4, -3.0]) {
      const scene = new Scene();
      const slot = scene.putItem(cold("a"), pose({ rot }));
      scene.setFlatten("a", 1);
      expect(scene.renderRot(slot)).toBeCloseTo(0, 6);
    }
  });

  it("turns the short way, so paper past upside down comes back the near side", () => {
    const scene = new Scene();
    // 189 degrees: nine degrees past upside down. Turning to square should
    // take the 171 back the way it came, not the 189 forwards.
    const slot = scene.putItem(cold("a"), pose({ rot: (189 * Math.PI) / 180 }));
    scene.setFlatten("a", 0.5);
    expect(scene.renderRot(slot)).toBeCloseTo((-171 * Math.PI) / 180 / 2, 6);
  });

  it("leaves the pin exactly where it was, all the way down", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 40, y: -25, rot: 0.35 }));
    const p = pin({ lx: 55, ly: -40 });
    scene.putPin(p);
    scene.layoutPin(p);
    const wx = p.wx;
    const wy = p.wy;

    for (const t of [0.1, 0.25, 0.5, 0.75, 1]) {
      scene.setFlatten("a", t);
      scene.layoutPin(p);
      expect(p.wx).toBeCloseTo(wx, 4);
      expect(p.wy).toBeCloseTo(wy, 4);
    }
  });

  it("holds the pin still even while the note is still swinging under it", () => {
    const scene = new Scene();
    const slot = scene.putItem(cold("a"), pose({ rot: 0.35 }));
    const p = pin({ lx: 55, ly: -40 });
    scene.putPin(p);

    // A note double-clicked mid-swing: the settled angle is different on every
    // frame, and the translation is derived from it, so it has to be recomputed
    // rather than captured at the moment the editor opened.
    for (const [swing, t] of [
      [0, 0],
      [-0.4, 0.3],
      [-0.7, 0.7],
      [-0.9, 1],
    ] as const) {
      scene.swing[slot] = swing;
      // Where the pin is with that swing and no flatten at all.
      scene.setFlatten(null, 0);
      scene.layoutPin(p);
      const wx = p.wx;
      const wy = p.wy;

      scene.setFlatten("a", t);
      scene.layoutPin(p);
      expect(p.wx).toBeCloseTo(wx, 4);
      expect(p.wy).toBeCloseTo(wy, 4);
    }
  });

  it("turns about the centre when there is no single pin to turn about", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 40, y: -25, rot: 0.35 }));
    const slot = scene.slotOf("a")!;
    // None: lying on the cork.
    scene.setFlatten("a", 1);
    expect(scene.renderX(slot)).toBeCloseTo(40, 5);
    expect(scene.renderY(slot)).toBeCloseTo(-25, 5);

    // Two: rigid, and no pivot either.
    scene.putPin(pin({ id: "p1", lx: -50, ly: -40 }));
    scene.putPin(pin({ id: "p2", lx: 50, ly: -40 }));
    scene.setFlatten("a", 1);
    expect(scene.renderX(slot)).toBeCloseTo(40, 5);
    expect(scene.renderY(slot)).toBeCloseTo(-25, 5);
  });

  it("takes the marquee and the bounds with it", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 400, h: 20, rot: Math.PI / 2 }));
    // Standing on end: 20 wide, 400 tall.
    expect(scene.boundsOf("a")!.maxX).toBeCloseTo(10, 4);
    const rect = { minX: 150, minY: -6, maxX: 190, maxY: 6 };
    expect(scene.intersectsRect("a", rect)).toBe(false);

    scene.setFlatten("a", 1);
    expect(scene.boundsOf("a")!.maxX).toBeCloseTo(200, 4);
    expect(scene.intersectsRect("a", rect)).toBe(true);
  });
});

describe("what the document is told about it", () => {
  it("is nothing: drawnPose writes the pose the paper goes back to", () => {
    const scene = new Scene();
    const slot = scene.putItem(cold("a"), pose({ x: 40, y: -25, rot: 0.35 }));
    scene.swing[slot] = -0.2;
    scene.driftX[slot] = 7;
    scene.driftY[slot] = -3;
    const before = drawnPose(scene, "a")!;

    scene.putPin(pin({ lx: 55, ly: -40 }));
    scene.setFlatten("a", 1);

    // The paper is visibly square...
    expect(scene.renderRot(slot)).toBeCloseTo(0, 6);
    // ...and what a pin change would bake is untouched, swing and drift and all.
    const after = drawnPose(scene, "a")!;
    expect(after.rot).toBeCloseTo(before.rot!, 9);
    expect(after.x).toBeCloseTo(before.x!, 9);
    expect(after.y).toBeCloseTo(before.y!, 9);
    expect(after.rot).toBeCloseTo(0.15, 6);
  });
});

describe("the clock", () => {
  it("reaches square in about 120ms and stops moving", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const slot = scene.putItem(cold("a"), pose({ rot: 0.4 }));
    const flat = new PaperTurn();

    flat.open("a");
    expect(flat.square).toBe(false);
    let elapsed = 0;
    for (let i = 0; i < 100 && !flat.square; i++) {
      flat.step(scene, dirty, 8);
      elapsed += 8;
    }
    expect(flat.square).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(FLATTEN_MS);
    expect(elapsed).toBeLessThanOrEqual(FLATTEN_MS + 8);
    expect(scene.renderRot(slot)).toBeCloseTo(0, 6);
    expect(flat.moving).toBe(false);
  });

  it("puts the paper back exactly as it was, and lets the slot go", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const slot = scene.putItem(cold("a"), pose({ rot: 0.4 }));
    const flat = new PaperTurn();

    flat.open("a");
    settle(flat, scene, dirty);
    flat.close();
    settle(flat, scene, dirty);

    expect(flat.itemId).toBeNull();
    expect(flat.idle).toBe(true);
    expect(scene.renderRot(slot)).toBe(scene.settledRot(slot));
    expect(scene.renderRot(slot)).toBeCloseTo(0.4, 6);
    expect(scene.flattenOf(slot)).toBe(0);
  });

  it("reverses from wherever it got to, so a quick in-and-out does not jump", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const slot = scene.putItem(cold("a"), pose({ rot: 0.4 }));
    const flat = new PaperTurn();

    flat.open("a");
    flat.step(scene, dirty, 40);
    const partway = scene.renderRot(slot);
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThan(0.4);

    flat.close();
    // The very next frame carries on from the angle it was at, rather than
    // starting again from square.
    flat.step(scene, dirty, 8);
    const next = scene.renderRot(slot);
    expect(next).toBeGreaterThan(partway);
    expect(next).toBeLessThan(0.4);
  });

  it("costs a note nothing once it is lying still", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    scene.putItem(cold("a"), pose({ rot: 0.4 }));
    scene.putPin(pin());
    const flat = new PaperTurn();

    flat.open("a");
    settle(flat, scene, dirty);
    dirty.items.clear();

    // Square, hanging still, nobody typing: sixty frames of this must not
    // dirty the item sixty times.
    for (let i = 0; i < 60; i++) flat.step(scene, dirty, 16);
    expect(dirty.items.size).toBe(0);
  });

  it("gives up on a note that was deleted underneath it", () => {
    const scene = new Scene();
    const dirty = new DirtySets();
    const slot = scene.putItem(cold("a"), pose({ rot: 0.4 }));
    const flat = new PaperTurn();

    flat.open("a");
    settle(flat, scene, dirty);
    scene.removeItem("a");
    flat.step(scene, dirty, 16);

    expect(flat.idle).toBe(true);
    expect(flat.itemId).toBeNull();
    // And the freed slot is not handed to the next item still laid flat.
    const reused = scene.putItem(cold("b"), pose({ rot: 0.4 }));
    expect(reused).toBe(slot);
    expect(scene.flattenOf(reused)).toBe(0);
    expect(scene.renderRot(reused)).toBeCloseTo(0.4, 6);
  });
});
