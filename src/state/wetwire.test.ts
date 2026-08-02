/**
 * The sliding window of DATA-MODEL section 9.1.
 *
 * Three claims worth testing and they are not the same claim: the payload is
 * bounded however long the stroke is, the decimation throws away only what
 * nobody could see, and the sequence `base` counts into never changes under a
 * receiver's feet. The last one is the one a bug would be silent about — a
 * window that renumbered itself still looks like a window, and the damage shows
 * up as a line with a kink in it on somebody else's machine.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_INK_SIZE, type InkSample, type WetStroke } from "@/lib/ink";
import { INK_STEPS_PER_UNIT, PRESSURE_STEPS } from "@/lib/strokepack";
import { WET_MAX_RUNS, WET_SPACING_PX, WET_WINDOW, WetWire } from "@/state/wetwire";

/** A run whose sample array is the one handed in, mutated by the tests exactly
 *  as `MarkerTool` mutates its own while a hand is moving. */
function run(id: string, samples: InkSample[], over: Partial<WetStroke> = {}): WetStroke {
  return {
    id,
    tool: "marker",
    color: "#1f1b17",
    size: DEFAULT_INK_SIZE,
    opacity: 1,
    item: null,
    page: null,
    samples,
    ...over,
  };
}

/** A straight line of samples `step` board units apart, starting at the origin. */
function line(count: number, step: number, pressure = 0.5): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i += 1) out.push({ x: i * step, y: 0, pressure });
  return out;
}

/** What a pressure reading comes back as. Half force is 128 of 255 rather than
 *  127.5, and the tests say the number on the wire rather than pretending the
 *  quantisation is invisible. */
const HALF = Math.round(0.5 * PRESSURE_STEPS);

/**
 * The points of a payload entry, as `[x, y, pressure]` triples — x and y
 * divided back into board units, which is the receiver's half of the
 * quantisation, and pressure left in 255ths because that is a grid a test
 * should be reading rather than rounding off.
 */
function points(pts: readonly number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < pts.length; i += 3) {
    out.push([pts[i]! / INK_STEPS_PER_UNIT, pts[i + 1]! / INK_STEPS_PER_UNIT, pts[i + 2]!]);
  }
  return out;
}

/**
 * Splice a payload into what a receiver already holds, which is the rule
 * [`PresenceWetRun.base`] states: overwrite from `base`, and drop whatever was
 * past the end of what arrived.
 */
function splice(held: number[], base: number, pts: readonly number[]): number[] {
  const out = held.slice(0, base * 3);
  for (const value of pts) out.push(value);
  return out;
}

describe("the window", () => {
  it("sends every point of a stroke shorter than the window", () => {
    const wire = new WetWire();
    // Ten units apart at 100% zoom is well past the six-pixel spacing, so
    // nothing is decimated away and the arithmetic below is about the window
    // alone.
    wire.update([run("r1", line(10, 10))], 1);

    const [payload] = wire.payload();
    expect(payload!.base).toBe(0);
    expect(points(payload!.pts)).toHaveLength(10);
  });

  it("stops growing once the stroke passes the window, and says where it starts", () => {
    const wire = new WetWire();
    const samples = line(WET_WINDOW * 4, 10);
    wire.update([run("r1", samples)], 1);

    const [payload] = wire.payload();
    // Constant-size is the whole point of section 9.1: a stroke four times the
    // window long is the same number of bytes as one exactly the window long.
    expect(points(payload!.pts)).toHaveLength(WET_WINDOW);
    expect(payload!.base).toBe(WET_WINDOW * 3);
    // And `base` names where they are, so the receiver can put them in the
    // right place: the first point sent is the 193rd of the stroke.
    expect(points(payload!.pts)[0]).toEqual([WET_WINDOW * 3 * 10, 0, HALF]);
  });

  it("never sends more than the window, tip included", () => {
    const wire = new WetWire();
    const samples = line(WET_WINDOW * 2, 10);
    wire.update([run("r1", samples)], 1);
    // One more, too close to be committed — so it rides as the tip and has to
    // come out of the window's allowance rather than on top of it.
    samples.push({ x: samples.at(-1)!.x + 0.5, y: 0, pressure: 0.5 });
    wire.update([run("r1", samples)], 1);

    expect(points(wire.payload()[0]!.pts)).toHaveLength(WET_WINDOW);
  });
});

describe("splicing, which is what base is for", () => {
  it("rebuilds the whole line from windows a receiver saw one at a time", () => {
    const wire = new WetWire();
    const samples: InkSample[] = [];
    let held: number[] = [];

    // Six hundred samples handed over ten at a time, published after each —
    // a long stroke seen by a peer who missed nothing.
    for (let batch = 0; batch < 60; batch += 1) {
      for (let i = 0; i < 10; i += 1) {
        samples.push({ x: samples.length * 10, y: 0, pressure: 0.5 });
      }
      wire.update([run("r1", samples)], 1);
      const payload = wire.payload()[0]!;
      held = splice(held, payload.base, payload.pts);
    }

    const line = points(held);
    expect(line).toHaveLength(600);
    // Every point where the hand put it, in order, with no gap and no repeat.
    for (let i = 0; i < line.length; i += 1) expect(line[i]![0]).toBe(i * 10);
  });

  it("heals a gap the window covers, and the receiver cannot tell", () => {
    const complete = new WetWire();
    const lossy = new WetWire();
    const a: InkSample[] = [];
    const b: InkSample[] = [];
    let good: number[] = [];
    let patchy: number[] = [];

    for (let batch = 0; batch < 40; batch += 1) {
      for (let i = 0; i < 8; i += 1) {
        a.push({ x: a.length * 10, y: 0, pressure: 0.5 });
        b.push({ x: b.length * 10, y: 0, pressure: 0.5 });
      }
      complete.update([run("r1", a)], 1);
      lossy.update([run("r1", b)], 1);
      const whole = complete.payload()[0]!;
      const dropped = lossy.payload()[0]!;
      good = splice(good, whole.base, whole.pts);
      // Four messages in five are thrown away — 32 points of a 64-point window,
      // which is inside what section 9.1 promises to survive.
      if (batch % 5 === 0 || batch === 39) patchy = splice(patchy, dropped.base, dropped.pts);
    }

    expect(patchy).toEqual(good);
  });
});

describe("the decimation", () => {
  it("keeps roughly one point per six screen pixels", () => {
    const wire = new WetWire();
    // A thousand units of line sampled every unit — a slow hand on a fast
    // digitiser, which is where the naive payload goes unbounded.
    wire.update([run("r1", line(1000, 1))], 1);

    const [payload] = wire.payload();
    const kept = payload!.base + points(payload!.pts).length;
    // 1000 units at six units a point, and the tip.
    expect(kept).toBeGreaterThanOrEqual(1000 / WET_SPACING_PX);
    expect(kept).toBeLessThanOrEqual(1000 / WET_SPACING_PX + 2);
  });

  it("measures in screen pixels, so a zoomed-in hand sends finer points", () => {
    const near = new WetWire();
    const far = new WetWire();
    // Sampled every quarter unit, so it is the six-pixel spacing that decides
    // how many points survive and not how fast the digitiser reports.
    near.update([run("r1", line(1600, 0.25))], 4);
    far.update([run("r1", line(1600, 0.25))], 1);

    const closer = near.payload()[0]!;
    const wider = far.payload()[0]!;
    // Six *pixels* is a quarter of the board distance at 400% zoom, so four
    // times as many points survive — the discarded ones are the ones the person
    // drawing could not have seen, and at 400% they could.
    const keptNear = closer.base + points(closer.pts).length;
    const keptFar = wider.base + points(wider.pts).length;
    expect(keptNear).toBeGreaterThan(keptFar * 3);
  });

  it("never revisits a point it has already committed, however the zoom moves", () => {
    const steady = new WetWire();
    const zoomed = new WetWire();
    const a: InkSample[] = [];
    const b: InkSample[] = [];
    let fixed: number[] = [];
    let moved: number[] = [];

    for (let batch = 0; batch < 20; batch += 1) {
      for (let i = 0; i < 6; i += 1) {
        a.push({ x: a.length * 4, y: 0, pressure: 0.5 });
        b.push({ x: b.length * 4, y: 0, pressure: 0.5 });
      }
      steady.update([run("r1", a)], 1);
      // The wheel under a pen that is still down — legal, and it changes the
      // spacing the decimation is working to.
      zoomed.update([run("r1", b)], 1 + batch * 0.4);
      const one = steady.payload()[0]!;
      const two = zoomed.payload()[0]!;
      fixed = splice(fixed, one.base, one.pts);
      moved = splice(moved, two.base, two.pts);
    }

    // The two lines are different — that is the zoom doing its job. What has to
    // hold is that the zoomed one is still a line: every point of it is one the
    // hand actually made, in order, with x strictly increasing. A sequence that
    // renumbered itself under a `base` would show up here as a point out of
    // order or a duplicate.
    const drawn = points(moved).map((p) => p[0]);
    expect(drawn.length).toBeGreaterThan(10);
    for (let i = 1; i < drawn.length; i += 1) expect(drawn[i]!).toBeGreaterThan(drawn[i - 1]!);
    expect(points(fixed).map((p) => p[0])).toEqual(
      points(fixed)
        .map((p) => p[0])
        .sort((x, y) => x - y),
    );
  });
});

describe("the tip", () => {
  it("draws a mark too short for the decimation to keep two points of", () => {
    const wire = new WetWire();
    // Four units across at 100% zoom: under the six-pixel spacing, so the
    // decimation commits the first point and turns down the rest.
    wire.update([run("r1", line(5, 1))], 1);

    const [payload] = wire.payload();
    // Without the tip this is one point, and one point is not a line — a tick
    // mark somebody else made would simply not appear until it committed.
    expect(points(payload!.pts)).toEqual([
      [0, 0, HALF],
      [4, 0, HALF],
    ]);
  });

  it("is replaced by the point that overtakes it, not left behind it", () => {
    const wire = new WetWire();
    const samples: InkSample[] = [{ x: 0, y: 0, pressure: 0.5 }];
    wire.update([run("r1", samples)], 1);
    samples.push({ x: 2, y: 0, pressure: 0.5 });
    wire.update([run("r1", samples)], 1);
    let held = splice([], wire.payload()[0]!.base, wire.payload()[0]!.pts);

    // Now past the spacing, so this one is committed — and it takes the index
    // the tip was occupying.
    samples.push({ x: 20, y: 0, pressure: 0.5 });
    wire.update([run("r1", samples)], 1);
    const payload = wire.payload()[0]!;
    held = splice(held, payload.base, payload.pts);

    // Two points, not three. A tip that survived its own replacement would put
    // a kink at x=2 in every stroke anybody watched.
    expect(points(held)).toEqual([
      [0, 0, HALF],
      [20, 0, HALF],
    ]);
  });

  it("goes when the hand comes back to the point already laid down", () => {
    const wire = new WetWire();
    const samples: InkSample[] = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 3, y: 0, pressure: 0.5 },
    ];
    wire.update([run("r1", samples)], 1);
    expect(points(wire.payload()[0]!.pts)).toHaveLength(2);

    samples.push({ x: 0, y: 0, pressure: 0.5 });
    wire.update([run("r1", samples)], 1);
    // One point again: a whisker pointing at where the pen no longer is would
    // be worse than the mark being a moment short.
    expect(wire.payload()).toHaveLength(0);
  });
});

describe("what a change is", () => {
  it("is silent when no samples arrived", () => {
    const wire = new WetWire();
    const samples = line(20, 10);
    wire.update([run("r1", samples)], 1);
    wire.payload();

    // A pen resting on the tablet: pointer events stop, the array stops growing.
    wire.update([run("r1", samples)], 1);
    expect(wire.changed).toBe(false);
  });

  it("notices a stroke that grew", () => {
    const wire = new WetWire();
    const samples = line(20, 10);
    wire.update([run("r1", samples)], 1);
    wire.payload();

    samples.push({ x: 1000, y: 0, pressure: 0.5 });
    wire.update([run("r1", samples)], 1);
    expect(wire.changed).toBe(true);
  });

  it("notices the tip moving, which nothing else on presence would", () => {
    const wire = new WetWire();
    const samples = line(20, 10);
    samples.push({ x: samples.at(-1)!.x + 1, y: 0, pressure: 0.5 });
    wire.update([run("r1", samples)], 1);
    wire.payload();

    samples.push({ x: samples.at(-1)!.x + 1, y: 0, pressure: 0.5 });
    wire.update([run("r1", samples)], 1);
    expect(wire.changed).toBe(true);
  });

  it("notices the gesture ending, so the last word is an empty list", () => {
    const wire = new WetWire();
    wire.update([run("r1", line(20, 10))], 1);
    wire.payload();

    wire.update([], 1);
    expect(wire.changed).toBe(true);
    expect(wire.payload()).toHaveLength(0);
  });
});

describe("a gesture that crossed an edge", () => {
  it("sends every run of it, each windowed on its own", () => {
    const wire = new WetWire();
    wire.update(
      [
        run("r1", line(10, 10), { item: "photo-1" }),
        run("r2", line(10, 10), { item: null }),
        run("r3", line(10, 10), { item: "note-2", tool: "highlighter", opacity: 0.4 }),
      ],
      1,
    );

    const payload = wire.payload();
    expect(payload.map((entry) => entry.id)).toEqual(["r1", "r2", "r3"]);
    // Each names the space its points are in — T-137 made one gesture several
    // records, and a receiver draws each through the frame its own `item` names.
    expect(payload.map((entry) => entry.item)).toEqual(["photo-1", null, "note-2"]);
    // And its own ink, which is D-29: a peer's mark is drawn in the colour,
    // size and strength the person drawing chose, never tinted by whose it is.
    expect(payload[2]!.tool).toBe("highlighter");
    expect(payload[2]!.opacity).toBe(0.4);
  });

  it("bounds the payload when a scribble crosses more surfaces than the cap", () => {
    const wire = new WetWire();
    const runs: WetStroke[] = [];
    for (let i = 0; i < 12; i += 1) runs.push(run(`r${i}`, line(10, 10), { item: `note-${i}` }));
    wire.update(runs, 1);

    const payload = wire.payload();
    expect(payload).toHaveLength(WET_MAX_RUNS);
    // The newest, because those are the ones still being added to. The older
    // ones went out in full while they were live — section 9.2 has the receiver
    // keeping them up until the document holds their ids.
    expect(payload.map((entry) => entry.id)).toEqual(["r8", "r9", "r10", "r11"]);
  });

  it("forgets a run once it is out of flight, so a session does not accumulate", () => {
    const wire = new WetWire();
    wire.update([run("r1", line(200, 10))], 1);
    wire.payload();

    wire.update([], 1);
    wire.payload();
    // The same id back again would be a new gesture with a reused name, which
    // cannot happen — but if the window had been kept, its old points would
    // arrive as the start of the new mark.
    wire.update([run("r1", line(3, 10))], 1);
    const payload = wire.payload()[0]!;
    expect(payload.base).toBe(0);
    expect(points(payload.pts)).toHaveLength(3);
  });
});

describe("what it refuses to send", () => {
  it("drops a sample that is not a number rather than publishing the origin", () => {
    const wire = new WetWire();
    // Newest, which is the case that reaches the wire: a bad sample in the
    // middle is overtaken by the next good one and never leaves the machine,
    // so a guard tested only there is a guard tested against nothing.
    wire.update(
      [
        run("r1", [
          { x: 0, y: 0, pressure: 0.5 },
          { x: 80, y: 0, pressure: 0.5 },
          { x: Number.NaN, y: Number.NaN, pressure: 0.5 },
        ]),
      ],
      1,
    );

    // `JSON.stringify` writes a NaN as `null`, which arrives as a zero — the
    // line shoots to the origin and stays there for the rest of the stroke.
    const [payload] = wire.payload();
    for (const value of payload!.pts) expect(Number.isFinite(value)).toBe(true);
    expect(points(payload!.pts)).toEqual([
      [0, 0, HALF],
      [80, 0, HALF],
    ]);
  });

  it("clamps a pressure reading to what a pressure can be", () => {
    const wire = new WetWire();
    wire.update(
      [
        run("r1", [
          { x: 0, y: 0, pressure: -3 },
          { x: 80, y: 0, pressure: 9 },
        ]),
      ],
      1,
    );

    expect(points(wire.payload()[0]!.pts).map((p) => p[2])).toEqual([0, PRESSURE_STEPS]);
  });

  it("holds back a run nobody could draw yet", () => {
    const wire = new WetWire();
    wire.update([run("r1", [{ x: 0, y: 0, pressure: 0.5 }])], 1);

    // One point is a press that has not moved. `render/ink/wet.ts` declines to
    // draw it locally for the same reason, and sending it would put a peer's
    // renderer in the position of having to know that.
    expect(wire.payload()).toHaveLength(0);
  });

  it("sends whole numbers, which is what makes the window small", () => {
    const wire = new WetWire();
    wire.update([run("r1", line(20, 10, 0.37))], 1);

    for (const value of wire.payload()[0]!.pts) expect(Number.isInteger(value)).toBe(true);
  });

  it("puts the points on the grid the committed record will land on", () => {
    const wire = new WetWire();
    wire.update(
      [
        run("r1", [
          { x: 0.07, y: 0, pressure: 0.5 },
          { x: 80.31, y: 0, pressure: 0.5 },
        ]),
      ],
      1,
    );

    // Eighths, like `lib/strokepack.ts` — so the ghost does not shift when the
    // document record replaces it (section 9.2).
    expect(points(wire.payload()[0]!.pts).map((p) => p[0])).toEqual([0.125, 80.25]);
  });
});
