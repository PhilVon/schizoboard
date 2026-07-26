/**
 * The rope set: what exists, what is awake, and what it costs when nothing is.
 *
 * AC-64 is the sleep rule and AC-65 is what sleeping buys, and the second is
 * the one worth being strict about — "zero simulation" has to mean a sleeping
 * rope is not stepped, not marked dirty, and not even *asked* whether it
 * should wake. So several tests below assert on `dirty.ropes` being empty
 * rather than on positions, because an empty dirty set is what lets
 * `render/ropes/` keep the Path2D it already baked.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { RopeSet } from "@/sim/ropes";
import { ROPE_SLEEP_STEPS, SIM_STEP_MS } from "@/sim/tuning";
import { DirtySets } from "@/state/dirty";
import { Scene, type Bounds, type ItemPose } from "@/state/scene";

let scene: Scene;
let dirty: DirtySets;
let ropes: RopeSet;

/** One 60fps frame, which is two fixed steps. */
const FRAME = 1000 / 60;

function pin(id: string, wx: number, wy: number, parent: string | null = null): void {
  scene.putPin({ id, parent, lx: wx, ly: wy, kind: "pushpin", color: "#c8352f", wx, wy });
}

function item(id: string, pose: Partial<ItemPose> = {}): void {
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x: 0, y: 0, rot: 0, w: 240, h: 200, ...pose },
  );
}

/** A two-pin string with the given slack. */
function string(id: string, slack = 0.2): void {
  ropes.setString(scene, dirty, id, ["p1", "p2"], [slack]);
}

function frame(n = 1): void {
  for (let i = 0; i < n; i++) {
    ropes.step(scene, dirty, FRAME);
    dirty.clear();
  }
}

/** Run frames until nothing is awake, and report how many it took. */
function untilAsleep(limit = 2000): number {
  for (let i = 0; i < limit; i++) {
    frame();
    if (ropes.awake === 0) return i + 1;
  }
  return limit;
}

function points(id: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const pool = ropes.positions;
  ropes.visit(id, (at, count) => {
    for (let i = 0; i < count; i++) out.push([pool[at + i * 2], pool[at + i * 2 + 1]]);
  });
  return out;
}

const box: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

beforeEach(() => {
  scene = new Scene();
  dirty = new DirtySets();
  ropes = new RopeSet();
  pin("p1", 0, 0);
  pin("p2", 200, 0);
});

describe("building a string", () => {
  it("makes one rope per gap between pins", () => {
    pin("p3", 400, 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3"], [0.2, 0.2]);
    let segments = 0;
    ropes.visit("s1", () => segments++);
    expect(segments).toBe(2);
    expect(ropes.size).toBe(2);
  });

  /** > closed: Loops the last node back to the first. — DATA-MODEL section 5 */
  it("closes the loop with one more rope than an open run has", () => {
    pin("p3", 200, 200);
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3"], [0.2, 0.2, 0.2], true);
    let segments = 0;
    ropes.visit("s1", () => segments++);
    expect(segments).toBe(3);
  });

  it("holds nothing for a string with fewer than two nodes", () => {
    ropes.setString(scene, dirty, "s1", ["p1"], []);
    expect(ropes.size).toBe(0);
    expect(ropes.boundsOf("s1", box)).toBeNull();
  });

  it("replaces a string's ropes rather than accumulating them", () => {
    pin("p3", 400, 0);
    string("s1");
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3"], [0.2, 0.2]);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.2]);
    expect(ropes.size).toBe(1);
  });

  it("takes its ropes with it when the string goes", () => {
    string("s1");
    ropes.removeString(dirty, "s1");
    expect(ropes.size).toBe(0);
    let segments = 0;
    ropes.visit("s1", () => segments++);
    expect(segments).toBe(0);
  });

  it("spaces particles at roughly the design figure", () => {
    string("s1", 0.2);
    const pts = points("s1");
    // Rest length is 240 board units at 12 apart, so around 21 particles.
    expect(pts.length).toBeGreaterThan(15);
    expect(pts.length).toBeLessThan(28);
  });
});

describe("a string that has just been made", () => {
  /** AC-62 again, one layer up: seeded at rest, and asleep on the frame it
   *  was created, so a board full of them opens perfectly still. */
  it("is asleep before it has ever been stepped", () => {
    string("s1");
    expect(ropes.awake).toBe(0);
  });

  it("hangs where the catenary says, not along the chord", () => {
    string("s1", 0.3);
    const bounds = ropes.boundsOf("s1", box)!;
    // Both pins are at y=0 and the string has 30% slack, so it must sag well
    // below them and not at all above.
    expect(bounds.maxY).toBeGreaterThan(30);
    expect(bounds.minY).toBeCloseTo(0, 6);
    expect(bounds.minX).toBeCloseTo(0, 6);
    expect(bounds.maxX).toBeCloseTo(200, 6);
  });

  it("starts and ends exactly on its pins", () => {
    string("s1");
    const pts = points("s1");
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([200, 0]);
  });

  it("stays asleep through a frame in which nothing moved", () => {
    string("s1");
    frame(5);
    expect(ropes.awake).toBe(0);
    ropes.step(scene, dirty, FRAME);
    expect(dirty.ropes.size).toBe(0);
  });
});

describe("waking", () => {
  it("wakes the ropes on a pin that moved, and only those", () => {
    pin("p3", 400, 0);
    pin("p4", 600, 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.2]);
    ropes.setString(scene, dirty, "s2", ["p3", "p4"], [0.2]);
    dirty.clear();

    const p1 = scene.pins.get("p1")!;
    p1.lx = -40;
    dirty.pin("p1");
    ropes.step(scene, dirty, FRAME);

    expect(ropes.awake).toBe(1);
    expect(dirty.ropes.has("s1")).toBe(true);
    expect(dirty.ropes.has("s2")).toBe(false);
  });

  /** > moving one pin only wakes the two segments adjacent to it
   *  > — DESIGN section 2.3 */
  it("wakes only the two gaps either side of a pin in a long run", () => {
    for (let i = 3; i <= 5; i++) pin(`p${i}`, 200 * (i - 1), 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3", "p4", "p5"], [0.2, 0.2, 0.2, 0.2]);
    dirty.clear();
    expect(ropes.size).toBe(4);

    const p3 = scene.pins.get("p3")!;
    p3.ly = 60;
    dirty.pin("p3");
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(2);
  });

  /** A hub pin is the case the "two" in that sentence is not a rule. */
  it("wakes every string through a hub pin", () => {
    pin("p3", 0, 200);
    pin("p4", 0, -200);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.2]);
    ropes.setString(scene, dirty, "s2", ["p1", "p3"], [0.2]);
    ropes.setString(scene, dirty, "s3", ["p1", "p4"], [0.2]);
    dirty.clear();

    scene.pins.get("p1")!.lx = -30;
    dirty.pin("p1");
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(3);
  });

  /**
   * A parented pin moves when its photograph does, and the item is what is
   * dirty then — the pin never appears in `dirty.pins` at all.
   */
  it("wakes a rope whose pin rides on an item that moved", () => {
    item("i1");
    pin("p3", 0, 0, "i1");
    scene.layoutPins();
    ropes.setString(scene, dirty, "s1", ["p2", "p3"], [0.2]);
    dirty.clear();

    scene.setPose("i1", { x: 90, y: 40 });
    dirty.item("i1");
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(1);
  });

  /**
   * The guard that keeps a collaborator's cursor from holding a board awake.
   * A pose arriving every frame for something that is not really moving marks
   * the item dirty, and must not be enough on its own.
   */
  it("ignores a pin that was dirtied but did not actually move", () => {
    string("s1");
    dirty.clear();
    dirty.pin("p1");
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(0);
    expect(dirty.ropes.size).toBe(0);
  });

  it("wakes on request, for a pluck or an impulse", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    expect(ropes.awake).toBe(1);
  });
});

describe("sleeping", () => {
  /** AC-64. Twelve consecutive quiet frames, and the counter restarts the
   *  moment anything moves it again. */
  it("takes twelve quiet frames to drop off", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    // Settle first, so what is being counted is the sleep rule and not the
    // rope still moving.
    for (let i = 0; i < 400 && ropes.awake > 0; i++) frame();
    expect(ropes.awake).toBe(0);

    ropes.wake("s1");
    let frames = 0;
    while (ropes.awake > 0 && frames < 100) {
      frame();
      frames++;
    }
    // A rope woken where it already rests is quiet immediately, so the only
    // thing left to count is the twelve.
    expect(frames).toBe(ROPE_SLEEP_STEPS);
  });

  it("restarts the count when something disturbs it again", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    frame(ROPE_SLEEP_STEPS - 1);
    expect(ropes.awake).toBe(1);

    scene.pins.get("p1")!.ly = 50;
    dirty.pin("p1");
    frame(ROPE_SLEEP_STEPS - 1);
    expect(ropes.awake).toBe(1);
  });

  /** AC-65. Not stepped, not marked dirty, and the pose it went to sleep
   *  holding is the pose it still has — which is what the renderer's cached
   *  Path2D is banking on. */
  it("costs nothing at all once asleep", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    untilAsleep();
    const settled = points("s1");

    for (let i = 0; i < 50; i++) {
      ropes.step(scene, dirty, FRAME);
      expect(dirty.ropes.size).toBe(0);
      dirty.clear();
    }
    expect(points("s1")).toEqual(settled);
  });

  it("sleeps a whole board of strings after one disturbance", () => {
    for (let i = 0; i < 12; i++) {
      pin(`q${i}`, i * 50, 0);
      pin(`r${i}`, i * 50, 300);
      ropes.setString(scene, dirty, `s${i}`, [`q${i}`, `r${i}`], [0.25]);
    }
    dirty.clear();
    for (let i = 0; i < 12; i++) ropes.wake(`s${i}`);
    expect(ropes.awake).toBe(12);
    untilAsleep();
    expect(ropes.awake).toBe(0);
  });
});

describe("bounds", () => {
  it("covers the sag rather than just the pins", () => {
    string("s1", 0.5);
    const bounds = ropes.boundsOf("s1", box)!;
    expect(bounds.maxY).toBeGreaterThan(50);
  });

  it("unions every gap of a multi-pin run", () => {
    pin("p3", 400, -100);
    ropes.setString(scene, dirty, "s1", ["p1", "p2", "p3"], [0.2, 0.2]);
    const bounds = ropes.boundsOf("s1", box)!;
    expect(bounds.minX).toBeCloseTo(0, 6);
    expect(bounds.maxX).toBeCloseTo(400, 6);
    expect(bounds.minY).toBeCloseTo(-100, 6);
  });

  it("finds the strings that meet a rectangle and skips the rest", () => {
    pin("p3", 5000, 0);
    pin("p4", 5200, 0);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.2]);
    ropes.setString(scene, dirty, "s2", ["p3", "p4"], [0.2]);

    expect(ropes.stringsIn({ minX: -10, minY: -10, maxX: 300, maxY: 300 }, [])).toEqual(["s1"]);
    expect(ropes.stringsIn({ minX: 4900, minY: -10, maxX: 5300, maxY: 300 }, [])).toEqual(["s2"]);
    expect(ropes.stringsIn({ minX: -10, minY: -10, maxX: 6000, maxY: 300 }, [])).toHaveLength(2);
    expect(ropes.stringsIn({ minX: 1000, minY: 1000, maxX: 2000, maxY: 2000 }, [])).toEqual([]);
  });

  it("follows the rope as it moves", () => {
    string("s1", 0.2);
    const before = ropes.boundsOf("s1", { ...box })!.maxY;
    dirty.clear();
    scene.pins.get("p2")!.ly = 400;
    dirty.pin("p2");
    frame(20);
    expect(ropes.boundsOf("s1", box)!.maxY).toBeGreaterThan(before);
  });
});

describe("a document restore", () => {
  /** Load and undo both set `dirty.all`, and both are a state restore rather
   *  than an event: everything goes back to its analytic pose, asleep. */
  it("puts every rope back at rest and asleep", () => {
    string("s1", 0.3);
    dirty.clear();
    ropes.wake("s1");
    frame(3);
    expect(ropes.awake).toBe(1);

    dirty.everything();
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(0);
    expect(dirty.ropes.has("s1")).toBe(true);
  });
});

describe("pins that are not there", () => {
  /** > A string node pointing at a missing pin is skipped at render time.
   *  > — DATA-MODEL section 8.1 */
  it("holds no particles for a rope whose pin has not arrived", () => {
    ropes.setString(scene, dirty, "s1", ["p1", "ghost"], [0.2]);
    expect(points("s1")).toEqual([]);
    expect(ropes.boundsOf("s1", box)).toBeNull();
  });

  /** Nodes can arrive before the pins they name under concurrent editing, so
   *  the pin turning up has to be what gives the rope its shape. */
  it("takes shape when the pin finally turns up", () => {
    ropes.setString(scene, dirty, "s1", ["p1", "ghost"], [0.2]);
    dirty.clear();

    pin("ghost", 300, 100);
    dirty.pin("ghost");
    ropes.step(scene, dirty, FRAME);

    expect(points("s1").length).toBeGreaterThan(2);
    expect(ropes.awake).toBe(0);
    expect(dirty.ropes.has("s1")).toBe(true);
  });

  it("stops stepping a rope whose pin vanishes mid-swing", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    frame();
    expect(ropes.awake).toBe(1);

    scene.removePin("p2");
    ropes.step(scene, dirty, FRAME);
    expect(ropes.awake).toBe(0);
  });
});

describe("the particle pool", () => {
  it("reuses the space a deleted string gave back", () => {
    string("s1");
    const used = ropes.positions.length;
    for (let i = 0; i < 40; i++) {
      ropes.removeString(dirty, "s1");
      string("s1");
    }
    expect(ropes.positions.length).toBe(used);
  });

  it("keeps each rope's particles to itself", () => {
    pin("p3", 0, 400);
    pin("p4", 200, 400);
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.2]);
    ropes.setString(scene, dirty, "s2", ["p3", "p4"], [0.2]);
    for (const [, y] of points("s1")) expect(y).toBeLessThan(200);
    for (const [, y] of points("s2")) expect(y).toBeGreaterThan(200);
  });

  it("survives a great many strings without losing any of them", () => {
    for (let i = 0; i < 200; i++) {
      pin(`a${i}`, i * 30, 0);
      pin(`b${i}`, i * 30, 250);
      ropes.setString(scene, dirty, `s${i}`, [`a${i}`, `b${i}`], [0.2]);
    }
    expect(ropes.size).toBe(200);
    for (let i = 0; i < 200; i++) {
      const pts = points(`s${i}`);
      expect(pts[0]).toEqual([i * 30, 0]);
      expect(pts[pts.length - 1]).toEqual([i * 30, 250]);
    }
  });

  it("forgets everything on a clear", () => {
    string("s1");
    ropes.clear();
    expect(ropes.size).toBe(0);
    expect(points("s1")).toEqual([]);
  });
});

describe("the frame clock", () => {
  /** The accumulator lives here so every rope on the board agrees what time
   *  it is — two strings on the same pin stepping different amounts would
   *  disagree about where that pin was. */
  it("does no work at all on a frame worth less than one fixed step", () => {
    string("s1");
    dirty.clear();
    ropes.wake("s1");
    ropes.step(scene, dirty, SIM_STEP_MS / 4);
    expect(dirty.ropes.size).toBe(0);
    // Still awake — nothing has been stepped, so nothing has settled either.
    expect(ropes.awake).toBe(1);
  });
});
