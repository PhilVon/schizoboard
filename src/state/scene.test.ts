/**
 * The scene must be testable with no document at all — ARCHITECTURE 2.1, and
 * AC-43. Nothing in this file imports yjs, and the lint rules would stop it.
 */

import { describe, expect, it } from "vitest";

import { Torsion } from "@/sim/torsion";
import { DirtySets } from "@/state/dirty";
import { shortest as shortestAngle } from "@/lib/angle";
import { drawnPose } from "@/state/tools/frame";
import {
  Scene,
  type ItemColdInput,
  type ItemPose,
  type SceneStroke,
  type StringNodes,
} from "@/state/scene";

function cold(id: string, over: Partial<ItemColdInput> = {}): ItemColdInput {
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

describe("turning a case file up to read it", () => {
  /** T-273. The turn is the whole of the in-place open, so these are about the
   *  angle and about what must not see it. */
  const open = (rot: number, t: number) => {
    const scene = new Scene();
    scene.putItem(cold("f"), pose({ w: 480, h: 344, rot }));
    scene.setOpen("f", t);
    return { scene, slot: scene.slotOf("f")! };
  };

  it("ends square on its side, which is what stands the sheets up", () => {
    const { scene, slot } = open(0.1, 1);
    expect(scene.renderRot(slot)).toBeCloseTo(Math.PI / 2);
  });

  it("always arrives at the same place, by the shortest route to it", () => {
    // Every folder on a board opens the same way round. The first version of
    // this picked whichever quarter was nearer, and a wall of folders with a
    // seeded jitter either side of square then opened in two directions at
    // random - and half of them upside down, since only one quarter puts the
    // page the right way up.
    for (let rot = -Math.PI; rot <= Math.PI; rot += 0.25) {
      const { scene, slot } = open(rot, 1);
      const landed = scene.renderRot(slot);
      expect(Math.abs(shortestAngle(landed - Math.PI / 2))).toBeCloseTo(0);
      // And never the long way round to get there.
      expect(Math.abs(shortestAngle(landed - rot))).toBeLessThanOrEqual(Math.PI + 1e-9);
    }

    // The case the old rule got wrong, kept as its own assertion because it is
    // two folders a person would see side by side on one board.
    expect(open(-0.08, 1).scene.renderRot(open(-0.08, 1).slot)).toBeCloseTo(Math.PI / 2);
    expect(open(0.08, 1).scene.renderRot(open(0.08, 1).slot)).toBeCloseTo(Math.PI / 2);
  });

  it("is a continuous turn rather than a flag", () => {
    // The frame loop owns all motion, so there is no CSS transition to soften
    // this and the halfway point has to be a real angle.
    const half = open(0, 0.5);
    expect(half.scene.renderRot(half.slot)).toBeCloseTo(Math.PI / 4);
  });

  it("is never baked, because it is a lie taken back on Escape", () => {
    // The rule `settledRot` exists for. Bake it and a folder somebody read
    // would be left lying on its side in the document for every peer.
    const { scene, slot } = open(0.1, 1);
    expect(scene.settledRot(slot)).toBeCloseTo(0.1);
    expect(scene.openOf(slot)).toBe(1);
    expect(drawnPose(scene, "f")?.rot).toBeCloseTo(0.1);
  });

  it("lets go when the item does", () => {
    // Slots are reused. Left behind, the next item into this one would be born
    // with a quarter turn nobody asked for.
    const { scene, slot } = open(0, 1);
    scene.removeItem("f");
    scene.putItem(cold("g"), pose({ w: 100, h: 100 }));
    expect(scene.slotOf("g")).toBe(slot);
    expect(scene.renderRot(slot)).toBeCloseTo(0);
    expect(scene.openOf(slot)).toBe(0);
  });

  it("leaves every other item bit-identical", () => {
    // The comparison in `renderRot` is what keeps a board nobody is reading
    // paying nothing for this.
    const scene = new Scene();
    scene.putItem(cold("f"), pose({ rot: 0.1 }));
    scene.putItem(cold("other"), pose({ x: 900, rot: 0.2 }));
    const slot = scene.slotOf("other")!;
    const before = scene.renderRot(slot);
    scene.setOpen("f", 1);
    expect(scene.renderRot(slot)).toBe(before);
  });

  it("says nothing changed when nothing did", () => {
    const scene = new Scene();
    scene.putItem(cold("f"), pose({ rot: 0.1 }));
    expect(scene.setOpen("f", 1)).toBe(true);
    expect(scene.setOpen("f", 1)).toBe(false);
    expect(scene.setOpen(null, 0)).toBe(true);
    expect(scene.setOpen(null, 0)).toBe(false);
    // An item that is not there is not an open one either.
    expect(scene.setOpen("gone", 1)).toBe(false);
  });

  /**
   * Where an open folder is going to be, asked before it gets there — T-323.
   *
   * The camera has to aim at this: `readItem` starts the turn and fires the
   * flight in the same tick, so the drawn box still belongs to a closed folder
   * for the 300 ms the two take to disagree.
   */
  describe("where it will be when it is open", () => {
    const pinned = (lx: number, ly: number) => {
      const scene = new Scene();
      scene.putItem(cold("f"), pose({ x: 200, y: -60, w: 480, h: 344, rot: 0.12 }));
      scene.putPin({
        id: "p",
        parent: "f",
        lx,
        ly,
        kind: "pushpin",
        color: "#c8352f",
        wx: 0,
        wy: 0,
      });
      return scene;
    };
    const centreOf = (b: { minX: number; minY: number; maxX: number; maxY: number }) => ({
      x: (b.minX + b.maxX) / 2,
      y: (b.minY + b.maxY) / 2,
    });

    it("is where the folder actually lands, pin or no pin", () => {
      // The assertion that matters, and the reason it is written as a
      // comparison rather than as numbers: a prediction and the thing it
      // predicts drifting apart IS the bug. Numbers would let both be wrong
      // together.
      for (const [lx, ly] of [
        [0, 0],
        [-144, -136],
        [200, 90],
      ] as const) {
        const scene = pinned(lx, ly);
        const predicted = { ...scene.openBoundsOf("f")! };
        scene.setOpen("f", 1);
        expect(centreOf(predicted)).toEqual(centreOf(scene.boundsOf("f")!));
        expect(predicted).toEqual(scene.boundsOf("f")!);
      }
    });

    it("moves the box for a pinned folder and not for a loose one", () => {
      // The half of it that went unnoticed for three tasks: an unpinned folder
      // turns about its own centre, so aiming at the closed box was right, and
      // every driven run of T-273, T-319 and T-321 was on a pasted folder.
      const loose = new Scene();
      loose.putItem(cold("f"), pose({ x: 200, y: -60, w: 480, h: 344, rot: 0.12 }));
      // `toBeCloseTo` rather than `toEqual`: the two boxes are the same centre
      // at different angles, and half-extents that differ round the mean of the
      // two edges by a tenth of a femtometre.
      const still = centreOf(loose.openBoundsOf("f")!);
      const shut = centreOf(loose.boundsOf("f")!);
      expect(still.x).toBeCloseTo(shut.x, 9);
      expect(still.y).toBeCloseTo(shut.y, 9);

      const hung = pinned(-144, -136);
      const before = centreOf(hung.boundsOf("f")!);
      const after = centreOf(hung.openBoundsOf("f")!);
      expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(100);
    });

    it("is null for an item that is not there", () => {
      expect(new Scene().openBoundsOf("gone")).toBeNull();
    });
  });

  it("does not fight the lay-flat over one board", () => {
    // Both are at most one item and they are not exclusive of each other: a
    // folder can be open while a note is being written on somewhere else.
    const scene = new Scene();
    scene.putItem(cold("f"), pose({ rot: 0.1 }));
    scene.putItem(cold("n"), pose({ x: 900, rot: 0.2 }));
    scene.setOpen("f", 1);
    scene.setFlatten("n", 1);
    expect(scene.renderRot(scene.slotOf("f")!)).toBeCloseTo(Math.PI / 2);
    expect(scene.renderRot(scene.slotOf("n")!)).toBeCloseTo(0);
  });
});

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

  /**
   * T-194's amplifier, and the reason it was a P1 rather than a cosmetic glitch.
   *
   * An item whose transient pose has gone non-finite gives `layoutOver` a `NaN`
   * bounding box. `CellGrid.place` cannot compute a cell count for one, so it
   * files the slot under `oversized` — and `oversized` is offered *every pin on
   * the board*, on the understanding that the exact containment test will
   * reject whatever the grid over-claims. Stated as a rejection (`> w/2`) that
   * test accepted `NaN` instead, because every comparison against `NaN` is
   * false. So one sick item quietly became the thing every pin was pushed
   * through, which drives `pinCount`, `solePin`, and therefore where every
   * hanging item on the board decides it hangs.
   */
  it("holds nothing at all when its own pose is not finite", () => {
    const scene = new Scene();
    scene.putItem(cold("sick"), pose({ x: 0, y: 0, w: 100, h: 100 }));
    scene.putItem(cold("well"), pose({ x: 5000, y: 5000, w: 100, h: 100 }));
    // One pin, five thousand units away, pushed through `well` and nothing else.
    scene.putPin(pin("far", "well", 0, 0));
    scene.layoutPins();
    expect(scene.pinCount("sick")).toBe(0);
    expect(scene.pinCount("well")).toBe(1);

    // The swing is the transient T-194 left non-finite. Since T-189 the index
    // does not read it at all, so this can no longer reach the grid - asserted
    // here anyway, because it is what a caller would try first and a silent
    // change of reason is worth pinning.
    scene.swing[scene.slotOf("sick")!] = NaN;
    scene.setPose("sick", {});

    expect(scene.pinCount("sick")).toBe(0);
    expect(scene.solePin("sick")).toBeNull();
    // And it has not taken the pin away from the item that really holds it.
    expect(scene.pinCount("well")).toBe(1);

    // The route that is still open, and the one the guard in `fileOver` is now
    // solely responsible for: a tool writing a non-finite *stored* pose. The
    // document cannot carry one - `crdt/schema.ts` drops it - but `setPose`
    // takes what it is given.
    scene.setPose("sick", { x: NaN });
    expect(scene.pinCount("sick")).toBe(0);
    expect(scene.solePin("sick")).toBeNull();
    expect(scene.pinCount("well")).toBe(1);
  });

  /**
   * T-189, Q-146: the index is a function of the *stored* pose and of nothing
   * else. `setPose(id, {})` throughout is how a rebuild is forced without
   * changing anything - the same idiom the NaN test above uses - because the
   * point of every one of these is that the answer came out of the pose rather
   * than out of a cache nothing had invalidated.
   */
  describe("and a swing cannot change what holds what", () => {
    it("keeps the pin an item has swung a long way from", () => {
      const scene = new Scene();
      scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 200, h: 200 }));
      scene.putPin(pin("p", null, 0, 0));
      expect(scene.pinCount("a")).toBe(1);

      // What `sim/torsion.ts` writes, exactly as it writes it: straight into the
      // typed arrays, past every setter. T-188's repro ended 23,000 units out.
      scene.driftX[scene.slotOf("a")!] = 23_000;
      scene.setPose("a", {});

      // Off the drawn pose this is 0, and the note it is hanging from would let
      // go of the pin holding it up because it had swung.
      expect(scene.pinCount("a")).toBe(1);
      expect(scene.solePin("a")?.id).toBe("p");
    });

    it("does not let a note swing itself onto a second pin and go rigid", () => {
      const scene = new Scene();
      scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 100, h: 100 }));
      scene.putPin(pin("hangs", null, 0, 0));
      // Well outside the paper where it is stored, and inside where a swing of
      // 300 units would draw it.
      scene.putPin(pin("cork", null, 300, 0));
      expect(scene.pinCount("a")).toBe(1);

      scene.driftX[scene.slotOf("a")!] = 300;
      scene.setPose("a", {});

      // The count alone would not catch this - it is 1 either way. Which pin is
      // the loop: off the drawn pose the item hangs from `cork`, so torsion
      // takes its pivot from a pin the swing put there, and the swing is
      // computed from the pivot.
      expect(scene.solePin("a")?.id).toBe("hangs");
      expect([...scene.pinsOf("a")]).toEqual(["hangs"]);
    });

    /**
     * A pin riding a swinging item is the case the two poses can genuinely put
     * in different places - the sole pin of a hanging note cannot, because
     * `drift` is defined as the translation that holds it still. So this is the
     * one that says the *pin* side of the containment test is settled too, and
     * not only the box it is tested against.
     */
    it("does not let a pin swing into an item on its parent's drift", () => {
      const scene = new Scene();
      scene.putItem(cold("swinger"), pose({ x: 0, y: 0, w: 100, h: 100 }));
      scene.putPin(pin("p", "swinger", 0, 0));
      scene.putItem(cold("target"), pose({ x: 300, y: 0, w: 100, h: 100 }));
      expect(scene.pinCount("target")).toBe(0);

      // The pin is drawn 300 units to the right of where it is stored, which is
      // the middle of `target`.
      scene.driftX[scene.slotOf("swinger")!] = 300;
      scene.setPose("target", {});
      expect(scene.renderX(scene.slotOf("swinger")!)).toBe(300);

      expect(scene.pinCount("target")).toBe(0);
      expect([...scene.pinsOf("target")]).toEqual([]);
    });

    it("gives every caller in one frame the same answer", () => {
      const scene = new Scene();
      scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 200, h: 200 }));
      scene.putPin(pin("p", null, 0, 0));
      scene.putItem(cold("elsewhere"), pose({ x: 9_000, y: 0 }));

      // Phase 3: torsion asks, then writes the drift its answer produced.
      const asked = scene.pinCount("a");
      scene.driftX[scene.slotOf("a")!] = 5_000;
      // And something unrelated moves in the same frame, which is what puts a
      // rebuild between the two questions. Without it they agree for the
      // uninteresting reason that nothing rebuilt.
      scene.setPose("elsewhere", { x: 9_100 });
      scene.layoutPins();

      // Phase 5's paper curl, asking what phase 3 asked.
      expect(scene.pinCount("a")).toBe(asked);
    });

    /**
     * The largest visual offset on this board, and the one nobody would defend
     * as physics: T-82/T-178 lay a note flat to be written on, un-rotating it
     * about its pin over 120ms. A note that picked up pins from the cork while
     * its editor was open, and dropped them again on blur, would be the whole
     * hazard in one gesture.
     *
     * The pin is placed *after* the flatten and at the drawn centre, computed
     * rather than guessed, because the offset depends on the pin's own offset
     * and the angle. Placing it first would also have made the item two-pinned,
     * and `setFlatten` reads `solePin` - so the flatten would have produced no
     * offset at all and the test would have proved nothing.
     */
    it("is not moved by the turn that opens a case file", () => {
      // T-273, and the same hazard as the flatten below: a folder that picked
      // up pins from the cork while it was open would be that whole problem in
      // one gesture. Written separately rather than parameterised because the
      // target angle is the thing under test.
      const scene = new Scene();
      scene.putItem(cold("f"), pose({ x: 0, y: 0, w: 480, h: 344, rot: 0.1 }));
      scene.putPin(pin("p", "f", -200, -150));
      scene.layoutPins();

      expect(scene.setOpen("f", 1)).toBe(true);
      const slot = scene.slotOf("f")!;
      expect(scene.renderRot(slot)).toBeCloseTo(Math.PI / 2);
      const drawnX = scene.renderX(slot);
      const drawnY = scene.renderY(slot);
      expect(Math.hypot(drawnX, drawnY)).toBeGreaterThan(100);

      scene.putPin(pin("swept", null, drawnX, drawnY));
      expect(scene.pinCount("f")).toBe(1);
      expect(scene.topOver("swept")).toBeNull();
    });

    it("is not moved by the un-rotate that opens a text editor", () => {
      const scene = new Scene();
      // Off-centre pin and a real angle: a note pinned through its middle hangs
      // plumb, and un-rotating it about its own centre moves nothing at all.
      scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 100, h: 100, rot: 2 }));
      scene.putPin(pin("p", "a", -45, -45));
      scene.layoutPins();
      expect(scene.pinCount("a")).toBe(1);

      expect(scene.setFlatten("a", 1)).toBe(true);
      const slot = scene.slotOf("a")!;
      const drawnX = scene.renderX(slot);
      const drawnY = scene.renderY(slot);
      expect(scene.renderRot(slot)).toBeCloseTo(0);
      // The sheet really is drawn somewhere else - far enough that its own
      // centre is now outside where the document says the paper is.
      expect(Math.hypot(drawnX, drawnY)).toBeGreaterThan(71);

      // Dead centre of the paper as drawn, and well clear of it as stored.
      scene.putPin(pin("swept", null, drawnX, drawnY));

      expect(scene.pinCount("a")).toBe(1);
      expect([...scene.pinsOf("a")]).toEqual(["p"]);
      // And the cork keeps it: it is over nothing, which is what it looks like
      // in the document.
      expect(scene.topOver("swept")).toBeNull();
    });

    it("still moves when the item really moves", () => {
      // The other half, and the reason this is not simply "freeze the index":
      // a drag writes the pose, so a drag still changes what holds what.
      const scene = new Scene();
      scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 100, h: 100 }));
      scene.putPin(pin("p", null, 300, 0));
      expect(scene.pinCount("a")).toBe(0);
      scene.setPose("a", { x: 300 });
      expect(scene.pinCount("a")).toBe(1);
    });
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
      page: null,
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

/**
 * T-278: which of an item's marks are on the face you are looking at.
 *
 * The rule is one sentence and these are the four surfaces it has to be right
 * about at once - a shut folder, an open one, a photograph, and an item whose
 * ink is on two pages. Written against `strokesOn` rather than against the
 * renderer because this is where the rule lives; what the renderer does with
 * the answer is `render/items/dom.test.ts`.
 */
describe("Scene.strokesOn - the face that is showing", () => {
  function stroke(id: string, page: number | null, z = "a0"): SceneStroke {
    return {
      id,
      tool: "marker",
      color: "#1f1b17",
      size: 4,
      opacity: 1,
      seed: 1,
      z,
      bbox: [0, 0, 10, 10],
      page,
      samples: [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 10, y: 10, pressure: 0.5 },
      ],
    };
  }

  it("shows an ordinary item's ink whole, and shows none of it on a page", () => {
    const scene = new Scene();
    scene.putStrokes("photo", [stroke("a", null), stroke("b", null, "a1")]);

    // A photograph has one face and always will, so the whole list comes back -
    // and it is the *same array*, which is the cost claim this rule rests on.
    expect(scene.strokesOn("photo", null)).toBe(scene.strokesOf("photo"));
    // And the other half of the same sentence: ask about a page and a surface
    // with no pages has nothing on it. Not a shortcut past the filter - it is
    // what keeps a folder's cover marks off the page you opened it to read.
    expect(scene.strokesOn("photo", 1)).toHaveLength(0);
  });

  it("splits a case file's ink between its cover and its pages", () => {
    const scene = new Scene();
    scene.putStrokes("folder", [
      stroke("cover", null),
      stroke("p1", 1, "a1"),
      stroke("p4a", 4, "a2"),
      stroke("p4b", 4, "a3"),
    ]);

    expect(scene.strokesOn("folder", null).map((s) => s.id)).toEqual(["cover"]);
    expect(scene.strokesOn("folder", 1).map((s) => s.id)).toEqual(["p1"]);
    expect(scene.strokesOn("folder", 4).map((s) => s.id)).toEqual(["p4a", "p4b"]);
    // A page nobody has marked shows nothing, rather than showing the cover.
    expect(scene.strokesOn("folder", 3)).toHaveLength(0);
    // And every mark is still on the item, which is what shutting it gives back.
    expect(scene.strokesOf("folder")).toHaveLength(4);
  });

  it("keeps paint order inside a page", () => {
    const scene = new Scene();
    // Handed over out of order, because the binding's map order is not the
    // document's - `putStrokes` sorts and the filter must not undo that.
    scene.putStrokes("folder", [stroke("top", 2, "a9"), stroke("bottom", 2, "a1")]);
    expect(scene.strokesOn("folder", 2).map((s) => s.id)).toEqual(["bottom", "top"]);
  });

  it("stops filtering when the last paged mark is erased", () => {
    const scene = new Scene();
    scene.putStrokes("folder", [stroke("cover", null), stroke("p1", 1, "a1")]);
    expect(scene.strokesOn("folder", null)).not.toBe(scene.strokesOf("folder"));

    // The page mark rubbed out. The item is an ordinary one again, and has to
    // go back to the free answer rather than staying on the filtered path for
    // the rest of the session.
    scene.putStrokes("folder", [stroke("cover", null)]);
    expect(scene.strokesOn("folder", null)).toBe(scene.strokesOf("folder"));
  });

  it("forgets an item's pages when the item goes", () => {
    const scene = new Scene();
    scene.putItem(
      { id: "f", type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
      { x: 0, y: 0, rot: 0, w: 100, h: 100 },
    );
    scene.putStrokes("f", [stroke("p1", 1)]);
    scene.removeItem("f");

    // The id is free to be reused, and a fresh item wearing it must not inherit
    // a rule about pages from an item that has gone.
    scene.putStrokes("f", [stroke("plain", null)]);
    expect(scene.strokesOn("f", null)).toBe(scene.strokesOf("f"));
  });

  it("has nothing to say about an item with no ink", () => {
    const scene = new Scene();
    expect(scene.strokesOn("nobody", null)).toHaveLength(0);
    expect(scene.strokesOn("nobody", 2)).toHaveLength(0);
  });
});

/**
 * T-193, the second clause of the pin request: a pin travels with the topmost
 * item it is pushed through, not with whoever placed it.
 *
 * `pinsOf` above answers "what does this pin hold". These answer "whose frame
 * should it be in", which is the same query read the other way round and
 * reduced to one item — and the two must never disagree about which items are
 * in play, only about how many of them matter.
 */
describe("the item a pin should travel with", () => {
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

  it("is the one that paints over the others, not the one it is parented to", () => {
    const scene = new Scene();
    scene.putItem(cold("under", { z: "a0" }), pose({ x: 0, y: 0, w: 200, h: 200 }));
    scene.putItem(cold("over", { z: "a1" }), pose({ x: 60, y: 0, w: 200, h: 200 }));
    scene.putPin(pin("p", "under", 40, 0));
    expect([...scene.pinsOf("over")]).toEqual(["p"]);
    expect(scene.topOver("p")).toBe("over");
  });

  it("is nothing at all when the pin is in bare cork", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 100, h: 100 }));
    scene.putPin(pin("p", null, 500, 500));
    expect(scene.topOver("p")).toBeNull();
  });

  it("breaks a z tie the way the renderer does", () => {
    // Two peers minting the same key is invariant 9's case, and the whole point
    // of the tie-break is that every client resolves it identically. A topmost
    // that disagreed with `render/items/dom.ts` would re-home a pin onto the
    // item the user can see it is not on top of.
    const scene = new Scene();
    scene.putItem(cold("a", { z: "a0", createdBy: 7 }), pose({ w: 200, h: 200 }));
    scene.putItem(cold("b", { z: "a0", createdBy: 9 }), pose({ w: 200, h: 200 }));
    expect(scene.topOver("p")).toBeNull();
    scene.putPin(pin("p", null, 0, 0));
    expect(scene.topOver("p")).toBe("b");
  });

  it("changes answer when the stack is reordered and nothing moves", () => {
    const scene = new Scene();
    scene.putItem(cold("a", { z: "a0" }), pose({ w: 200, h: 200 }));
    scene.putItem(cold("b", { z: "a1" }), pose({ w: 200, h: 200 }));
    scene.putPin(pin("p", null, 0, 0));
    expect(scene.topOver("p")).toBe("b");
    // What `sendToBack` does: a new key, no coordinate touched anywhere.
    scene.putItem(cold("b", { z: "Zz" }), pose({ w: 200, h: 200 }));
    expect(scene.topOver("p")).toBe("a");
  });

  it("forgets a pin that has left the board", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ w: 200, h: 200 }));
    scene.putPin(pin("p", null, 0, 0));
    expect(scene.topOver("p")).toBe("a");
    scene.removePin("p");
    expect(scene.topOver("p")).toBeNull();
  });
});

describe("Scene.rehomes", () => {
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

  it("says nothing about a board that already agrees", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ w: 200, h: 200 }));
    scene.putPin(pin("p", "a", 10, 10));
    expect(scene.rehomes([])).toEqual([]);
  });

  it("adopts a free pin an item has been dragged over, without moving it", () => {
    const scene = new Scene();
    scene.putPin(pin("p", null, 500, 500));
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 200, h: 200 }));
    expect(scene.rehomes([])).toEqual([]);

    scene.setPose("a", { x: 480, y: 460 });
    const [home] = scene.rehomes([]);
    expect(home).toEqual({ id: "p", parent: "a", lx: 20, ly: 40 });
    // The whole safety argument in one assertion: the numbers change frame and
    // the pin does not move.
    scene.putPin(pin("p", home!.parent, home!.lx, home!.ly));
    scene.layoutPins();
    const moved = scene.pins.get("p")!;
    expect(moved.wx).toBeCloseTo(500);
    expect(moved.wy).toBeCloseTo(500);
  });

  it("hands a pin back to the cork when the paper shrinks off it", () => {
    // A parented pin cannot be left behind by its own paper *moving* — that is
    // the whole point of item-local coordinates. It comes off when the paper
    // stops reaching it, which a resize does.
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 200, h: 200 }));
    scene.putPin(pin("p", "a", 80, 0));
    expect(scene.rehomes([])).toEqual([]);

    scene.setPose("a", { w: 100, h: 100 });
    // Board coordinates, and the ones the pin is actually drawn at — not the
    // item-local pair reinterpreted.
    expect(scene.rehomes([])).toEqual([{ id: "p", parent: null, lx: 80, ly: 0 }]);
  });

  it("hands a pin back to the cork when the paper it names is gone", () => {
    // DATA-MODEL 8.1: a pin whose parent has left "renders as free-floating at
    // its last known board position". This writes that down rather than
    // re-deriving it on every read.
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ x: 300, y: 0, w: 200, h: 200 }));
    scene.putPin(pin("p", "a", 20, 40));
    expect(scene.rehomes([])).toEqual([]);

    scene.removeItem("a");
    expect(scene.rehomes([])).toEqual([{ id: "p", parent: null, lx: 20, ly: 40 }]);
  });

  it("converts through the new parent's rotation", () => {
    const scene = new Scene();
    scene.putPin(pin("p", null, 100, 0));
    scene.putItem(cold("a"), pose({ x: 0, y: 0, w: 400, h: 400, rot: Math.PI / 2 }));
    const [home] = scene.rehomes([]);
    // A quarter turn puts the board's +x on the item's -y.
    expect(home!.parent).toBe("a");
    expect(home!.lx).toBeCloseTo(0);
    expect(home!.ly).toBeCloseTo(-100);
  });

  it("empties the array it is given rather than minting one", () => {
    const scene = new Scene();
    scene.putItem(cold("a"), pose({ w: 200, h: 200 }));
    scene.putPin(pin("p", null, 0, 0));
    const out = scene.rehomes([]);
    expect(out).toHaveLength(1);
    scene.putPin(pin("p", "a", 0, 0));
    expect(scene.rehomes(out)).toBe(out);
    expect(out).toHaveLength(0);
  });
});

describe("tape holds a string to the paper and the paper to nothing", () => {
  /** An item with one real pin through it, plus however many tapes. */
  function pinned(scene: Scene, id: string, kinds: readonly string[]): void {
    scene.putItem(
      { id, type: "note", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
      { x: 0, y: 0, rot: 0, w: 400, h: 300 },
    );
    kinds.forEach((kind, i) => {
      scene.putPin({
        id: `p${i}`,
        parent: id,
        lx: -100 + i * 20,
        ly: -50,
        kind,
        color: "#c8352f",
        wx: -100 + i * 20,
        wy: -50,
      });
    });
  }

  it("does not count toward the item's physics", () => {
    // DESIGN 2.2: zero pins lies loose, one hangs, two are rigid. A quote card
    // taped to a page must not make the page rigid.
    const scene = new Scene();
    pinned(scene, "a", ["pushpin", "tape", "tape"]);
    expect(scene.pinCount("a")).toBe(1);
  });

  it("leaves an item hanging from the one pin it really has", () => {
    // The bug this exists for, one level down (T-328): solePin is what the open
    // turn is measured about, so a tape counted here would move the folder.
    const scene = new Scene();
    pinned(scene, "a", ["pushpin", "tape"]);
    expect(scene.solePin("a")?.id).toBe("p0");
  });

  it("does not make an unpinned item hang", () => {
    const scene = new Scene();
    pinned(scene, "a", ["tape"]);
    expect(scene.pinCount("a")).toBe(0);
    expect(scene.solePin("a")).toBeNull();
  });

  it("still leaves two real pins rigid", () => {
    const scene = new Scene();
    pinned(scene, "a", ["pushpin", "tape", "nail"]);
    expect(scene.pinCount("a")).toBe(2);
    expect(scene.solePin("a")).toBeNull();
  });

  it("is still on the item as far as the index is concerned", () => {
    // pinsOf must stay complete: sim/ropes.ts rouses a rope through it when the
    // item moves, so a tape missing from the index would leave the very thread
    // it anchors un-simulated.
    const scene = new Scene();
    pinned(scene, "a", ["pushpin", "tape"]);
    expect([...scene.pinsOf("a")].sort()).toEqual(["p0", "p1"]);
  });
});
