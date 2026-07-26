/**
 * The swing, with no document, no renderer and no browser â€” `sim/` reads the
 * scene mirror and nothing else, and the lint rules say so.
 *
 * AC-60 is "swing angle is a local visual offset, never stored, never synced",
 * and the shape of this file is the argument for it: every test below drives a
 * plain `Scene` and reads `scene.swing`, and there is nothing here that could
 * be written to a `Y.Doc` even if someone wanted to.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { equilibriumSwing, naturalRate, Torsion } from "@/sim/torsion";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemPose } from "@/state/scene";

let scene: Scene;
let dirty: DirtySets;
let sim: Torsion;

function put(id: string, pose: Partial<ItemPose> = {}): number {
  return scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x: 0, y: 0, rot: 0, w: 240, h: 200, ...pose },
  );
}

function pin(id: string, parent: string | null, lx: number, ly: number): void {
  scene.putPin({ id, parent, lx, ly, kind: "pushpin", color: "#c8352f", wx: 0, wy: 0 });
}

/** One frame at 60 fps, with the item marked as having changed. */
function frame(dirtyIds: string[] = [], held: string[] = [], lag = 0): void {
  for (const id of dirtyIds) dirty.item(id);
  sim.step(scene, dirty, 1000 / 60, new Set(held), lag);
  dirty.clear();
}

/**
 * Run until nothing is moving. The first frame is unconditional: the item is
 * asleep until something dirties it, which is the whole point of the module.
 *
 * `swing` is a `Float32Array`, so nothing read out of it is worth asserting
 * past about six decimal places â€” 0.35 comes back as 0.3499999940395355.
 */
function settle(id: string): void {
  frame([id]);
  for (let i = 0; i < 900 && sim.awake > 0; i++) frame([id]);
}

beforeEach(() => {
  scene = new Scene();
  dirty = new DirtySets();
  sim = new Torsion();
});

describe("the hanging equilibrium", () => {
  /** The pivot is the pin and the weight is at the centre, so the vector from
   *  one to the other has to end up pointing straight down. */
  it("is zero for a pin directly above the centre of an unrotated item", () => {
    expect(equilibriumSwing(0, -80, 0)).toBeCloseTo(0, 9);
  });

  it("cancels the authored rotation exactly, so the item hangs straight", () => {
    expect(equilibriumSwing(0, -80, 0.4)).toBeCloseTo(-0.4, 9);
    expect(equilibriumSwing(0, -80, -1.1)).toBeCloseTo(1.1, 9);
  });

  it("leans the item when the pin is off to one side", () => {
    // Pin up and to the right of the centre: the weight swings under it, which
    // turns the item anticlockwise in a y-down space.
    expect(equilibriumSwing(80, -80, 0)).toBeCloseTo(-Math.PI / 4, 9);
    expect(equilibriumSwing(-80, -80, 0)).toBeCloseTo(Math.PI / 4, 9);
  });

  /** Otherwise an item authored at 3 radians would take the long way round to
   *  arrive at the same place. */
  it("always takes the short way round", () => {
    for (const rot of [3.0, -3.0, 6.5, -12.7]) {
      expect(Math.abs(equilibriumSwing(0, -80, rot))).toBeLessThanOrEqual(Math.PI);
    }
  });

  it("turns a pin below the centre upside down, because that is where it hangs", () => {
    expect(Math.abs(equilibriumSwing(0, 80, 0))).toBeCloseTo(Math.PI, 9);
  });
});

describe("the natural frequency", () => {
  it("is zero for a pin through the centre of mass, which has no way up", () => {
    expect(naturalRate(0, 0, 240, 200)).toBe(0);
  });

  it("rises as the pin moves away from the centre", () => {
    expect(naturalRate(0, -20, 240, 200)).toBeLessThan(naturalRate(0, -90, 240, 200));
  });

  it("stays inside the range where a swing still reads as a swing", () => {
    expect(naturalRate(0, -0.001, 4, 4)).toBeLessThanOrEqual(14);
    expect(naturalRate(2, 2, 1, 1)).toBeLessThanOrEqual(14);
  });
});

describe("pin count is the item's physics", () => {
  it("hangs an item on one pin", () => {
    const slot = put("a", { rot: 0.35 });
    pin("p", "a", 0, -80);
    settle("a");
    expect(scene.swing[slot]).toBeCloseTo(-0.35, 3);
  });

  it("holds an item on two pins rigid, at its authored rotation", () => {
    const slot = put("a", { rot: 0.35 });
    pin("p1", "a", -60, -80);
    pin("p2", "a", 60, -80);
    scene.swing[slot] = 0.2;
    frame(["a"]);
    expect(scene.swing[slot]).toBe(0);
    expect(sim.awake).toBe(0);
  });

  it("lets an item with no pins lie flat", () => {
    const slot = put("a", { rot: 0.35 });
    scene.swing[slot] = 0.2;
    frame(["a"]);
    expect(scene.swing[slot]).toBe(0);
    expect(sim.awake).toBe(0);
  });

  it("goes rigid the moment a second pin arrives", () => {
    const slot = put("a", { rot: 0.35 });
    pin("p1", "a", 0, -80);
    settle("a");
    expect(scene.swing[slot]).toBeCloseTo(-0.35, 3);

    pin("p2", "a", 60, -80);
    frame(["a"]);
    expect(scene.swing[slot]).toBe(0);
  });

  it("starts hanging the moment it is down to one pin again", () => {
    const slot = put("a", { rot: 0.35 });
    pin("p1", "a", 0, -80);
    pin("p2", "a", 60, -80);
    frame(["a"]);
    expect(scene.swing[slot]).toBe(0);

    scene.removePin("p2");
    settle("a");
    expect(scene.swing[slot]).toBeCloseTo(-0.35, 3);
  });

  it("ignores an item pinned exactly through its own centre of mass", () => {
    const slot = put("a", { rot: 0.35 });
    pin("p", "a", 0, 0);
    scene.swing[slot] = 0.1;
    frame(["a"]);
    // No restoring torque and no preferred way up, so it stays where it is put.
    expect(scene.swing[slot]).toBeCloseTo(0.1, 6);
    expect(sim.awake).toBe(0);
  });
});

describe("swinging and settling", () => {
  /**
   * "Drop the item and it swings, twice or three times, and settles."
   *
   * Counted while the swing is still big enough to see — a tenth of where it
   * started, which on a 240-unit photograph is a corner moving four pixels.
   * Counting every zero crossing all the way to the sleep threshold would be
   * measuring how long the *tail* is, which is a different number and not the
   * one DESIGN is talking about.
   */
  it("overshoots the equilibrium and comes back, two or three times", () => {
    const slot = put("a", { rot: 0 });
    pin("p", "a", 0, -80);
    const start = 0.6;
    scene.swing[slot] = start;

    let visible = 0;
    let sign = 1;
    frame(["a"]);
    for (let i = 0; i < 900 && sim.awake > 0; i++) {
      frame(["a"]);
      const theta = scene.swing[slot]!;
      if (Math.abs(theta) < start * 0.1) continue;
      const next = Math.sign(theta);
      if (next !== sign) visible++;
      sign = next;
    }
    expect(visible).toBeGreaterThanOrEqual(2);
    expect(visible).toBeLessThanOrEqual(4);
  });

  it("is visibly finished in about two seconds, and asleep soon after", () => {
    const slot = put("a", { rot: 0 });
    pin("p", "a", 0, -80);
    scene.swing[slot] = 0.6;
    frame(["a"]);

    // Two seconds: down to under a fiftieth of where it started, which on a
    // 240-unit photograph is a corner moving less than a pixel.
    for (let i = 0; i < 120; i++) frame(["a"]);
    expect(Math.abs(scene.swing[slot]!)).toBeLessThan(0.6 / 50);

    settle("a");
    expect(sim.awake).toBe(0);
    expect(scene.swing[slot]).toBeCloseTo(0, 6);

    // Asleep: an untouched frame does not put it back on the books.
    frame();
    expect(sim.awake).toBe(0);
  });

  /**
   * Nothing about an item's position changes where it hangs, so a collaborator
   * dragging a photograph across the board â€” which dirties it on every frame â€”
   * must not wake the simulation.
   */
  it("does not wake for an item that only moved", () => {
    put("a", { rot: 0.35 });
    pin("p", "a", 0, -80);
    settle("a");
    for (let i = 0; i < 10; i++) {
      scene.setPose("a", { x: i * 40 });
      frame(["a"]);
      expect(sim.awake).toBe(0);
    }
  });

  it("wakes when the pin holding it moves, and re-hangs", () => {
    const slot = put("a", { rot: 0 });
    pin("p", "a", 0, -80);
    settle("a");
    expect(scene.swing[slot]).toBeCloseTo(0, 4);

    // Dragged round to the side of the photograph: it should now hang askew.
    pin("p", "a", 80, -80);
    frame(["a"]);
    expect(sim.awake).toBe(1);
    settle("a");
    expect(scene.swing[slot]).toBeCloseTo(-Math.PI / 4, 3);
  });

  /**
   * A load or an undo is a state restore, not an event. Simulating into place
   * would whip every photograph on the board every time the file opens â€”
   * DESIGN section 5.3's argument for seeding ropes analytically.
   */
  it("opens a board perfectly still", () => {
    const slot = put("a", { rot: 0.35 });
    pin("p", "a", 0, -80);
    dirty.everything();
    sim.step(scene, dirty, 1000 / 60);
    dirty.clear();
    expect(scene.swing[slot]).toBeCloseTo(-0.35, 6);
    expect(sim.awake).toBe(0);
  });

  it("survives a frame gap without exploding", () => {
    const slot = put("a", { rot: 0 });
    pin("p", "a", 0, -80);
    scene.swing[slot] = 0.6;
    // A backgrounded tab. The accumulator is capped at four substeps, so this
    // is a third of a second of catching up, not thirty.
    for (let i = 0; i < 10; i++) {
      dirty.item("a");
      sim.step(scene, dirty, 30_000, new Set(), 0);
      dirty.clear();
      expect(Math.abs(scene.swing[slot]!)).toBeLessThan(1);
    }
  });
});

/**
 * A pin is stuck in the cork. It does not move, and an item hanging from one
 * turns about *it* — which, since a parented pin's world position is derived
 * from the item's pose, is only true if the swing carries a translation too.
 */
describe("turning about the pin", () => {
  function pinWorld(): { x: number; y: number } {
    scene.layoutPins();
    const p = scene.pins.get("p")!;
    return { x: p.wx, y: p.wy };
  }

  it("leaves the pin exactly where it was, through the whole swing", () => {
    put("a", { rot: 0.9 });
    pin("p", "a", -70, -50);
    // Where the pin is before anything swings: the stored pose, which is what
    // every peer agrees about and what the cork is holding.
    const before = pinWorld();

    frame(["a"]);
    expect(sim.awake).toBe(1);
    for (let i = 0; i < 40; i++) {
      frame(["a"]);
      const now = pinWorld();
      expect(now.x).toBeCloseTo(before.x, 3);
      expect(now.y).toBeCloseTo(before.y, 3);
    }

    settle("a");
    const after = pinWorld();
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
  });

  it("moves the item's drawn centre, and never its stored one", () => {
    const slot = put("a", { x: 100, y: 100, rot: 0.9 });
    pin("p", "a", -70, -50);
    settle("a");

    expect(scene.x[slot]).toBe(100);
    expect(scene.y[slot]).toBe(100);
    expect(scene.renderX(slot)).not.toBeCloseTo(100, 2);
  });

  it("keeps a rigid item's drawn centre on its stored one", () => {
    const slot = put("a", { x: 100, y: 100, rot: 0.9 });
    pin("p1", "a", -70, -50);
    pin("p2", "a", 70, -50);
    frame(["a"]);
    expect(scene.renderX(slot)).toBe(100);
    expect(scene.renderY(slot)).toBe(100);
  });

  /** Turning it about a pin at its own centre is turning it about its centre. */
  it("needs no translation when the pin is at the centre", () => {
    const slot = put("a", { x: 100, y: 100, rot: 0 });
    pin("p", "a", 0, 0);
    scene.swing[slot] = 0.3;
    frame(["a"]);
    expect(scene.driftX[slot]).toBe(0);
    expect(scene.driftY[slot]).toBe(0);
  });
});

describe("handing over to and from a gesture", () => {
  it("freezes the swing while a gesture holds the item, and adds the carry lag", () => {
    const slot = put("a", { rot: 0.35 });
    pin("p", "a", 0, -80);
    settle("a");
    const hanging = scene.swing[slot]!;

    frame([], ["a"], 0.05);
    expect(scene.swing[slot]).toBeCloseTo(hanging + 0.05, 6);
    expect(sim.awake).toBe(0);
  });

  /**
   * Turning a hanging photograph with the rotation handle: `rot` changes under
   * a frozen swing, so it follows the cursor â€” and then swings back, because
   * where it hangs was never a function of `rot` in the first place.
   */
  it("lets a held item be turned, and swings it back when it is let go", () => {
    const slot = put("a", { rot: 0 });
    pin("p", "a", 0, -80);
    settle("a");

    frame([], ["a"]);
    scene.setPose("a", { rot: 0.5 });
    frame([], ["a"]);
    // Rendered rotation followed the hand.
    expect(scene.rot[slot]! + scene.swing[slot]!).toBeCloseTo(0.5, 6);

    frame(["a"]);
    expect(sim.awake).toBe(1);
    settle("a");
    expect(scene.rot[slot]! + scene.swing[slot]!).toBeCloseTo(0, 3);
  });

  it("swings from the angle the hand let go at, not from nowhere", () => {
    const slot = put("a", { rot: 0 });
    pin("p", "a", 0, -80);
    settle("a");

    frame([], ["a"], 0.08);
    expect(scene.swing[slot]).toBeCloseTo(0.08, 6);
    frame(["a"]);
    expect(sim.awake).toBe(1);
    // Still near where it was released, one frame later.
    expect(scene.swing[slot]).toBeGreaterThan(0.05);
    settle("a");
    expect(scene.swing[slot]).toBeCloseTo(0, 4);
  });

  it("leaves a two-pinned item's carry rotation to the tool", () => {
    const slot = put("a", { rot: 0 });
    pin("p1", "a", -60, -80);
    pin("p2", "a", 60, -80);
    scene.swing[slot] = 0.07;
    frame([], ["a"], 0.07);
    // Untouched: `consider` skips held items and `applyHeld` skips rigid ones.
    expect(scene.swing[slot]).toBeCloseTo(0.07, 6);
  });
});

/**
 * Letting go is an event in its own right.
 *
 * `consider` is the only thing that notices an item's pin count has changed,
 * and it runs over `dirty.items` and skips whatever a gesture is holding. Those
 * two rules meet badly in one place: an item whose physics changed *while* it
 * was held spends its only dirty flag on a frame this module is contractually
 * ignoring, and the flag does not survive the frame (`dirty.clear()` is phase
 * 9). Nothing dirties it again, so nothing ever tells it.
 *
 * `state/tools/pindrag.ts` is where that actually happens, and it cannot be
 * fixed from there: it dirties the item a pin is leaving by reading the pin's
 * parent, and once the pin has left there is no parent left to name.
 */
describe("letting go", () => {
  it("examines an item released from a hold, even when nothing dirtied it", () => {
    const slot = put("a", { rot: 0.35 });
    pin("p", "a", 0, -80);
    settle("a");
    // Hanging: both transients are carrying a real difference from `rot`.
    expect(scene.swing[slot]).toBeCloseTo(-0.35, 6);
    expect(scene.driftX[slot]).not.toBeCloseTo(0, 3);

    // The gesture takes hold, and drags the pin off. The item is dirtied on
    // the frame the pin leaves — and that frame is one this module ignores.
    frame([], ["a"]);
    scene.removePin("p");
    frame(["a"], ["a"]);
    expect(scene.swing[slot]).toBeCloseTo(-0.35, 6);

    // Let go, with nothing to dirty it. No pins means no swing and no drift.
    frame();
    expect(scene.swing[slot]).toBe(0);
    expect(scene.driftX[slot]).toBe(0);
    expect(scene.driftY[slot]).toBe(0);
  });

  /** The other end of a re-parent: the item that *gained* the pin that made
   *  two, which stops hanging just as surely and by the same route. */
  it("makes an item rigid when the pin that made two arrived while it was held", () => {
    const slot = put("a", { rot: 0.35 });
    pin("p1", "a", 0, -80);
    settle("a");
    expect(scene.swing[slot]).toBeCloseTo(-0.35, 6);

    frame([], ["a"]);
    pin("p2", "a", 60, -80);
    frame(["a"], ["a"]);
    expect(scene.swing[slot]).toBeCloseTo(-0.35, 6);

    frame();
    expect(scene.swing[slot]).toBe(0);
    expect(scene.driftX[slot]).toBe(0);
  });

  /** Releasing an item whose physics did not change is not an event. A hanging
   *  item let go of is exactly where it was, and must not be nudged. */
  it("leaves a released item alone when nothing about it changed", () => {
    const slot = put("a", { rot: 0.35 });
    pin("p", "a", 0, -80);
    settle("a");
    const hanging = scene.swing[slot]!;

    frame([], ["a"]);
    frame();
    expect(scene.swing[slot]).toBeCloseTo(hanging, 6);
    expect(sim.awake).toBe(0);
  });
});
