/**
 * The swing, with no document, no renderer and no browser — `sim/` reads the
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
import { Scene, type Bounds, type ItemPose } from "@/state/scene";

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
  scene.putPin({ id, parent, lx, ly, kind: "pushpin", color: "#c8352f", page: null, wx: 0, wy: 0 });
}

/** One frame at 60 fps, with the item marked as having changed. */
function frame(
  dirtyIds: string[] = [],
  held: string[] = [],
  lag = 0,
  pivots?: ReadonlyMap<string, { lx: number; ly: number }>,
): void {
  for (const id of dirtyIds) dirty.item(id);
  sim.step(scene, dirty, 1000 / 60, new Set(held), lag, pivots);
  dirty.clear();
}

/**
 * Let the module see the item once, so that what happens next is a change to
 * something already on the board.
 *
 * First sight settles rather than swings (T-110) — an arriving item has no
 * previous pose to swing away from, and treating one as an event is what made
 * a whole board coming in over sync swing itself into place. Every swing in
 * the app is a *second* thing happening to an item that is already there: you
 * pinned it, you turned it, a collaborator moved its pin. So a test that wants
 * a swing has to arrive first, exactly as the app does.
 */
function arrive(id: string): void {
  frame([id]);
}

/**
 * Run until nothing is moving. The first frame is unconditional: the item is
 * asleep until something dirties it, which is the whole point of the module.
 * It doubles as `arrive` for an item the module has not met.
 *
 * `swing` is a `Float32Array`, so nothing read out of it is worth asserting
 * past about six decimal places — 0.35 comes back as 0.3499999940395355.
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

/**
 * The viewport gate — DESIGN section 6.3 phase 3, "step awake ropes and swings
 * within the viewport margin" (T-223).
 *
 * A swing gates differently from a rope and more simply. A rope is deferred and
 * has to be picked up again; a swing is *finished*, because its equilibrium is
 * where it was going anyway. So the assertions here are all "it is already at
 * rest", and there is no returning case to test — there is nothing left to
 * return to.
 *
 * Every other test in this file passes no view, which is the contract for
 * "simulate everything".
 */
describe("the viewport gate", () => {
  const NEAR: Bounds = { minX: -400, minY: -400, maxX: 400, maxY: 400 };
  const FAR: Bounds = { minX: 9000, minY: 9000, maxX: 9400, maxY: 9400 };

  function seen(view: Bounds | null, ids: string[] = []): void {
    for (const id of ids) dirty.item(id);
    sim.step(scene, dirty, 1000 / 60, new Set(), 0, undefined, view);
    dirty.clear();
  }

  /** An item mid-swing: pin off centre so there is an angle at all, arrived so
   *  the next change is an event rather than first sight. */
  function swinging(): number {
    const slot = put("a", { rot: 0.35 });
    pin("p", "a", 60, -80);
    arrive("a");
    scene.rot[slot] = 1.2;
    frame(["a"]);
    expect(sim.awake).toBe(1);
    return slot;
  }

  it("ends a swing that has left the margin instead of stepping it", () => {
    swinging();
    seen(FAR);
    expect(sim.awake).toBe(0);
  });

  it("puts it at the equilibrium it was heading for, not where it happened to be", () => {
    const slot = swinging();
    const midSwing = scene.swing[slot]!;
    seen(FAR);
    expect(scene.swing[slot]).not.toBeCloseTo(midSwing, 4);
    expect(scene.swing[slot]).toBeCloseTo(equilibriumSwing(60, -80, scene.rot[slot]!), 3);
  });

  it("keeps swinging one the camera can see", () => {
    swinging();
    seen(NEAR);
    expect(sim.awake).toBe(1);
  });

  it("gates nothing when there is no camera to gate by", () => {
    swinging();
    seen(null);
    expect(sim.awake).toBe(1);
  });

  /** The item is where it belongs and still: coming back on screen there is
   *  nothing to resume and nothing to see happen. */
  it("leaves nothing to resume when the item comes back", () => {
    const slot = swinging();
    seen(FAR);
    const settled = scene.swing[slot]!;
    seen(NEAR);
    seen(NEAR);
    expect(scene.swing[slot]).toBe(settled);
    expect(sim.awake).toBe(0);
  });

  /**
   * Landing it is a change and the renderer has to be told — and then it must
   * stop. A gate that wrote the equilibrium every frame instead of ending the
   * swing would look identical on the first frame and repaint the item sixty
   * times a second forever, which is the cost this was meant to avoid.
   */
  it("dirties the item it settled, once, and then nothing", () => {
    swinging();
    sim.step(scene, dirty, 1000 / 60, new Set(), 0, undefined, FAR);
    expect(dirty.items.has("a")).toBe(true);
    dirty.clear();
    sim.step(scene, dirty, 1000 / 60, new Set(), 0, undefined, FAR);
    expect(dirty.items.size).toBe(0);
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
    arrive("a");
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
    arrive("a");
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
   * dragging a photograph across the board — which dirties it on every frame —
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
   * would whip every photograph on the board every time the file opens —
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

  /**
   * T-110. The load path is safe because `binding.start()` resyncs and takes
   * the `dirty.all` branch above. A document that arrives *after* the binding
   * is running — the sync path, T-68 onward — has no such moment: the binding
   * marks each item dirty as it lands, one at a time, and the whole board
   * swings itself into place. That is the whip-crack AC-62 rules out for
   * ropes, one layer up.
   */
  it("places a board that arrives mid-session, one dirty item at a time", () => {
    const ids = ["a", "b", "c"];
    // Spread out, which they were not until T-176 made pin count geometric.
    // Three items at the same coordinates are three items each holding all
    // three pins, so all three came out rigid and none of them swung — a true
    // answer to a question this test is not asking.
    const slots = ids.map((id, i) => {
      const slot = put(id, { x: i * 400, rot: 0.35 + i * 0.1 });
      pin(`pin-${id}`, id, 0, -80);
      return slot;
    });

    // Deliberately not `dirty.everything()`: nothing on the sync path calls it.
    frame(ids);

    expect(sim.awake).toBe(0);
    slots.forEach((slot, i) => {
      expect(scene.swing[slot]).toBeCloseTo(-(0.35 + i * 0.1), 6);
    });
  });

  /** The same shape a frame at a time: the item comes back with its pin in one
   *  undo entry, into a slot whose swing has been reset to zero. */
  it("places an item that comes back from an undo", () => {
    put("a", { rot: 0.35 });
    pin("p", "a", 0, -80);
    settle("a");

    scene.removeItem("a");
    scene.removePin("p");
    frame(["a"]);

    const back = put("a", { rot: 0.35 });
    pin("p", "a", 0, -80);
    frame(["a"]);

    expect(sim.awake).toBe(0);
    expect(scene.swing[back]).toBeCloseTo(-0.35, 6);
  });

  /**
   * And the gesture all of that must not cost: DESIGN section 5.5's "drop the
   * item and it swings". Pinning something already on the board is a change to
   * it, so it swings — first sight is the only thing that does not.
   */
  it("swings an item that gets its first pin while it is on the board", () => {
    const slot = put("a", { rot: 0.5 });
    arrive("a");
    expect(sim.awake).toBe(0);
    expect(scene.swing[slot]).toBe(0);

    pin("p", "a", 0, -80);
    frame(["a"]);
    expect(sim.awake).toBe(1);

    settle("a");
    expect(scene.swing[slot]).toBeCloseTo(-0.5, 3);
  });

  it("survives a frame gap without exploding", () => {
    const slot = put("a", { rot: 0 });
    pin("p", "a", 0, -80);
    arrive("a");
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
    const slot = put("a", { rot: 0.9 });
    pin("p", "a", -70, -50);
    // Where the pin is before anything swings: the stored pose, which is what
    // every peer agrees about and what the cork is holding.
    const before = pinWorld();

    // Arriving puts it at its equilibrium with the drift that keeps the pin
    // still; the swing is the event after that.
    arrive("a");
    expect(pinWorld().x).toBeCloseTo(before.x, 3);
    expect(pinWorld().y).toBeCloseTo(before.y, 3);

    scene.swing[slot] = 0.9;
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
   * a frozen swing, so it follows the cursor — and then swings back, because
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

  /**
   * The pivot is frozen on exactly one frame — the one the item is taken hold
   * of — and for one gesture that frame is already too late. `select.ts`
   * crosses the drag threshold, calls `begin`, and falls straight through into
   * the first `move` so the pin does not sit still for the frame it was picked
   * up in; by the time phase 3 runs, the pin this module would read the pivot
   * from has travelled. So the tool hands over where it was.
   */
  it("freezes a held item at the pivot the gesture hands over, not the one the scene has", () => {
    const slot = put("a", { rot: 0 });
    pin("p", "a", -60, -80);
    settle("a");
    const was = {
      swing: scene.swing[slot]!,
      driftX: scene.driftX[slot]!,
      driftY: scene.driftY[slot]!,
    };

    // The gesture has already dragged the pin across the paper.
    pin("p", "a", 40, -80);
    frame([], ["a"], 0, new Map([["a", { lx: -60, ly: -80 }]]));

    expect(scene.swing[slot]).toBeCloseTo(was.swing, 6);
    expect(scene.driftX[slot]).toBeCloseTo(was.driftX, 6);
    expect(scene.driftY[slot]).toBeCloseTo(was.driftY, 6);
  });

  /**
   * The same frame with nothing handed over, which is what every other gesture
   * gets — and is also this test file's evidence that the one above is testing
   * something. Without it, the pin having moved is the pivot having moved, and
   * the item turns about a point it was never turning about.
   */
  it("falls back to the pin it hangs from when no gesture offers a pivot", () => {
    const slot = put("a", { rot: 0 });
    pin("p", "a", -60, -80);
    settle("a");
    const wasX = scene.driftX[slot]!;

    pin("p", "a", 40, -80);
    frame([], ["a"]);

    expect(Math.abs(scene.driftX[slot]! - wasX)).toBeGreaterThan(1);
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

/**
 * T-188. Since T-176 the pin holding an item need not be the pin it *parents* —
 * a free one, or one belonging to a neighbour the item has been dragged over —
 * and `pin.lx`/`pin.ly` are only a pivot in this item's frame when it is.
 *
 * Phil found it from the board: "a note with no pin dragged over a pin starts to
 * move erratically like movements are multiplied", the same on rotating an item
 * over one, and then a jitter it could not settle out of.
 */
describe("a pin the item does not parent", () => {
  /** Far from the origin, which is the only thing that separates a pin's board
   *  coordinates from its coordinates on the paper. */
  const FAR = 12000;

  it("hangs about where the pin actually is, not about its board coordinates", () => {
    const slot = put("a", { x: 0, y: FAR, rot: 0.25 });
    // Free, and inside the note: 50 above its centre and 40 to the right.
    pin("p", null, 40, FAR - 50);
    scene.layoutPins();
    expect(scene.pinCount("a")).toBe(1);

    for (let i = 0; i < 90; i++) frame(i === 0 ? ["a"] : []);

    // The drift is "put the pivot back where it was", so it cannot exceed twice
    // the pivot's distance from the centre — about 64 units here. It came out at
    // 23,719, because the pivot used was the pin's board y.
    expect(Math.hypot(scene.driftX[slot]!, scene.driftY[slot]!)).toBeLessThan(130);
    // And the note is still on the board, near where it was put.
    expect(Math.abs(scene.renderY(slot) - FAR)).toBeLessThan(130);
  });

  it("comes to rest instead of fighting itself off the pin and back on", () => {
    const slot = put("a", { x: 0, y: FAR, rot: 0.4 });
    pin("p", null, 30, FAR - 60);
    scene.layoutPins();

    for (let i = 0; i < 400; i++) frame(i === 0 ? ["a"] : []);
    const at = scene.renderY(slot);
    const swing = scene.swing[slot]!;
    for (let i = 0; i < 40; i++) frame();
    // A translation big enough to carry the note off its own pin makes solePin
    // null, which zeroes the drift, which drops it back under the pin — the two
    // things Phil saw fighting. Settled, it simply stops.
    expect(scene.renderY(slot)).toBeCloseTo(at, 4);
    expect(scene.swing[slot]).toBeCloseTo(swing, 6);
    expect(scene.pinCount("a")).toBe(1);
    // And it came to rest *here*, rather than coming to rest a long way away.
    // Without this the assertions above pass on the broken pivot too: it flings
    // the note off the board on the first frame and then holds it there, which
    // is stillness of a sort.
    expect(Math.abs(scene.renderY(slot) - FAR)).toBeLessThan(140);
  });

  it("agrees with a parented pin at the same place on the paper", () => {
    // The two are the same physical arrangement written down two ways, so they
    // have to hang identically. This is the assertion that says `pinPivot` is a
    // change of frame rather than a different rule for free pins.
    const rot = 0.3;
    const own = put("own", { x: 0, y: FAR, rot });
    pin("p1", "own", 40, -50);

    // The same point on the paper, written in board coordinates — which means
    // through the item's rotation, since that is what "on the paper" means for a
    // sheet lying at an angle. Placing it at the raw offset instead puts it
    // somewhere else on the paper, and the two would rightly hang differently.
    const over = put("over", { x: 4000, y: FAR, rot });
    pin(
      "p2",
      null,
      4000 + 40 * Math.cos(rot) - -50 * Math.sin(rot),
      FAR + 40 * Math.sin(rot) + -50 * Math.cos(rot),
    );
    scene.layoutPins();
    expect(scene.pinCount("own")).toBe(1);
    expect(scene.pinCount("over")).toBe(1);

    for (let i = 0; i < 120; i++) frame(i === 0 ? ["own", "over"] : []);
    expect(scene.swing[over]).toBeCloseTo(scene.swing[own]!, 6);
    expect(scene.driftX[over]).toBeCloseTo(scene.driftX[own]!, 4);
    expect(scene.driftY[over]).toBeCloseTo(scene.driftY[own]!, 4);
  });
});
