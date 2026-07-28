/**
 * The receiving half of DATA-MODEL section 9.1.
 *
 * The most valuable test in here is the one that does not stub anything: a real
 * `WetWire` publishing into a real `PeerInk`, because the two halves of a
 * protocol can each be self-consistently wrong and a double proves only that I
 * held the same belief twice.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_INK_SIZE, type InkSample, type WetStroke } from "@/lib/ink";
import { INK_STEPS_PER_UNIT, PRESSURE_STEPS } from "@/lib/strokepack";
import { PeerInk, readWet } from "@/render/presence/wetpeer";
import { WET_WINDOW, WetWire } from "@/state/wetwire";

/** A readable wire run, for the tests that are about one field being wrong. */
function wire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-1",
    item: null,
    tool: "marker",
    color: "#1f1b17",
    size: DEFAULT_INK_SIZE,
    opacity: 1,
    base: 0,
    pts: [0, 0, 128, 80, 0, 128],
    ...over,
  };
}

/** A sender's run, for the round-trip tests. */
function run(id: string, samples: InkSample[], over: Partial<WetStroke> = {}): WetStroke {
  return {
    id,
    tool: "marker",
    color: "#1f1b17",
    size: DEFAULT_INK_SIZE,
    opacity: 1,
    item: null,
    samples,
    ...over,
  };
}

/** The x of every sample of the one run being drawn, in board units. */
function xs(ink: PeerInk): number[] {
  const runs = [...ink.drawable()];
  return runs.length === 0 ? [] : runs[0]!.samples.map((s) => s.x);
}

describe("what it refuses to take off the wire", () => {
  it("takes a run that is entirely in order", () => {
    expect(readWet([wire()])).toHaveLength(1);
  });

  it("drops a run whose colour the canvas would silently ignore", () => {
    // The sharp one. `ctx.fillStyle = "rgb(oops)"` leaves the previous colour in
    // place, so an unvalidated mark is painted in whatever was last set — and a
    // mark in the wrong colour is worse than no mark, which is the opposite of
    // the call `peers.ts` makes for an identity.
    expect(readWet([wire({ color: "red" })])).toHaveLength(0);
    expect(readWet([wire({ color: "#12345" })])).toHaveLength(0);
    expect(readWet([wire({ color: 16711680 })])).toHaveLength(0);
  });

  it("drops a smudge, which would punch a hole through the chrome underneath", () => {
    // `erase` is a real InkTool and is drawn destination-out. Nothing publishes
    // one — `app/main.ts` sends the pen's runs and never the smudge — and this
    // is what makes that a property rather than a promise about another machine.
    expect(readWet([wire({ tool: "erase" })])).toHaveLength(0);
    expect(readWet([wire({ tool: "crayon" })])).toHaveLength(0);
  });

  it("drops a run whose numbers are not numbers", () => {
    expect(readWet([wire({ pts: [0, 0, 128, Number.NaN, 0, 128] })])).toHaveLength(0);
    expect(readWet([wire({ pts: [0, 0, 128, 80, 0] })])).toHaveLength(0);
    expect(readWet([wire({ pts: [] })])).toHaveLength(0);
    expect(readWet([wire({ base: -1 })])).toHaveLength(0);
    expect(readWet([wire({ base: 1.5 })])).toHaveLength(0);
    expect(readWet([wire({ size: 0 })])).toHaveLength(0);
    expect(readWet([wire({ opacity: 4 })])).toHaveLength(0);
  });

  it("refuses a window longer than the protocol has", () => {
    const pts = new Array((WET_WINDOW + 1) * 3).fill(0);
    expect(readWet([wire({ pts })])).toHaveLength(0);
  });

  it("takes board space as null and refuses it as an empty string", () => {
    expect(readWet([wire({ item: null })])).toHaveLength(1);
    expect(readWet([wire({ item: "photo-1" })])[0]!.item).toBe("photo-1");
    expect(readWet([wire({ item: "" })])).toHaveLength(0);
  });

  it("drops one bad run and keeps the rest, like locks", () => {
    const got = readWet([wire({ id: "a" }), wire({ id: "b", color: "nope" }), wire({ id: "c" })]);
    expect(got.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("reads an absent, null or unrecognisable field as no ink", () => {
    // A peer not holding a pen is much the likeliest reason for each of these.
    expect(readWet(undefined)).toEqual([]);
    expect(readWet(null)).toEqual([]);
    expect(readWet("wet")).toEqual([]);
    expect(readWet([])).toEqual([]);
    expect(readWet([1, "x", null])).toEqual([]);
  });
});

describe("the splice, against the real sender", () => {
  it("rebuilds the line the other machine drew", () => {
    const sender = new WetWire();
    const ink = new PeerInk();
    const samples: InkSample[] = [];

    // Six hundred samples in batches of ten, published after each — a long
    // stroke watched by a peer who missed nothing.
    for (let batch = 0; batch < 60; batch += 1) {
      for (let i = 0; i < 10; i += 1) samples.push({ x: samples.length * 10, y: 0, pressure: 0.5 });
      sender.update([run("r1", samples)], 1);
      ink.splice(readWet(sender.payload()));
    }

    const line = xs(ink);
    expect(line).toHaveLength(600);
    for (let i = 0; i < line.length; i += 1) expect(line[i]).toBe(i * 10);
  });

  it("retires the sender's provisional tip instead of leaving a whisker", () => {
    const sender = new WetWire();
    const ink = new PeerInk();
    const samples: InkSample[] = [{ x: 0, y: 0, pressure: 0.5 }];
    sender.update([run("r1", samples)], 1);
    ink.splice(readWet(sender.payload()));

    // Under the six-unit spacing, so this rides as the tip.
    samples.push({ x: 2, y: 0, pressure: 0.5 });
    sender.update([run("r1", samples)], 1);
    ink.splice(readWet(sender.payload()));
    expect(xs(ink)).toEqual([0, 2]);

    // Past it, so it is committed — and takes the index the tip was on.
    samples.push({ x: 20, y: 0, pressure: 0.5 });
    sender.update([run("r1", samples)], 1);
    ink.splice(readWet(sender.payload()));

    // Two points. A receiver that only appended would have three, with a kink
    // at x=2 — and there is one of those in every stroke anybody watches.
    expect(xs(ink)).toEqual([0, 20]);
  });

  it("heals a gap the window covers, and the drawn line is the same one", () => {
    const whole = new WetWire();
    const lossy = new WetWire();
    const good = new PeerInk();
    const patchy = new PeerInk();
    const a: InkSample[] = [];
    const b: InkSample[] = [];

    for (let batch = 0; batch < 40; batch += 1) {
      for (let i = 0; i < 8; i += 1) {
        a.push({ x: a.length * 10, y: 0, pressure: 0.5 });
        b.push({ x: b.length * 10, y: 0, pressure: 0.5 });
      }
      whole.update([run("r1", a)], 1);
      lossy.update([run("r1", b)], 1);
      good.splice(readWet(whole.payload()));
      // Four messages in five thrown away: 32 points against a 64-point window,
      // which is inside what section 9.1 promises to survive.
      const dropped = lossy.payload();
      if (batch % 5 === 0 || batch === 39) patchy.splice(readWet(dropped));
    }

    expect(xs(patchy)).toEqual(xs(good));
  });

  it("keeps only what is contiguous when the gap is wider than the window", () => {
    const sender = new WetWire();
    const ink = new PeerInk();
    const samples: InkSample[] = [];
    const take = (): void => void ink.splice(readWet(sender.payload()));

    for (let i = 0; i < 10; i += 1) samples.push({ x: i * 10, y: 0, pressure: 0.5 });
    sender.update([run("r1", samples)], 1);
    take();
    expect(xs(ink)).toHaveLength(10);

    // Two hundred more points arrive while nothing is delivered — far past the
    // window — and then one message gets through.
    for (let i = 0; i < 200; i += 1) {
      samples.push({ x: (10 + i) * 10, y: 0, pressure: 0.5 });
    }
    sender.update([run("r1", samples)], 1);
    take();

    const line = xs(ink);
    // The first ten are gone rather than being joined to the new window by a
    // straight line across two thousand units that nobody drew.
    expect(line[0]).toBeGreaterThan(1000);
    for (let i = 1; i < line.length; i += 1) expect(line[i]! - line[i - 1]!).toBeLessThan(50);
  });

  it("takes up a stroke that was already under way when it arrived", () => {
    const sender = new WetWire();
    const samples: InkSample[] = [];
    for (let i = 0; i < 200; i += 1) samples.push({ x: i * 10, y: 0, pressure: 0.5 });
    sender.update([run("r1", samples)], 1);

    // The peer's first ever sight of this run, and its `base` is a long way in.
    const late = new PeerInk();
    const first = readWet(sender.payload());
    expect(first[0]!.base).toBeGreaterThan(0);
    late.splice(first);

    const line = xs(late);
    expect(line.length).toBe(WET_WINDOW);
    for (let i = 1; i < line.length; i += 1) expect(line[i]!).toBeGreaterThan(line[i - 1]!);

    // And it goes on from there rather than restarting every message.
    samples.push({ x: 2000, y: 0, pressure: 0.5 });
    sender.update([run("r1", samples)], 1);
    late.splice(readWet(sender.payload()));
    expect(xs(late).length).toBeGreaterThanOrEqual(line.length);
  });

  it("carries the ink's own tool, colour, size and strength — D-29", () => {
    const sender = new WetWire();
    const ink = new PeerInk();
    sender.update(
      [
        run(
          "r1",
          [
            { x: 0, y: 0, pressure: 1 },
            { x: 80, y: 0, pressure: 1 },
          ],
          { tool: "highlighter", color: "#f2d024", size: 22, opacity: 0.4, item: "note-9" },
        ),
      ],
      1,
    );
    ink.splice(readWet(sender.payload()));

    const [stroke] = [...ink.drawable()];
    // Not the peer's identity colour. The mark is content, and it is the same
    // mark the document record will replace it with.
    expect(stroke!.color).toBe("#f2d024");
    expect(stroke!.tool).toBe("highlighter");
    expect(stroke!.size).toBe(22);
    expect(stroke!.opacity).toBe(0.4);
    expect(stroke!.item).toBe("note-9");
  });
});

describe("the numbers coming back", () => {
  it("divides out of the grid the sender quantised onto", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire({ pts: [1, 3, 128, 643, -8, 255] })]));
    const [stroke] = [...ink.drawable()];
    expect(stroke!.samples[0]).toEqual({
      x: 1 / INK_STEPS_PER_UNIT,
      y: 3 / INK_STEPS_PER_UNIT,
      pressure: 128 / PRESSURE_STEPS,
    });
    expect(stroke!.samples[1]!.x).toBe(643 / INK_STEPS_PER_UNIT);
    expect(stroke!.samples[1]!.pressure).toBe(1);
  });

  it("clamps a pressure a stranger sent out of range", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire({ pts: [0, 0, -900, 80, 0, 9000] })]));
    const [stroke] = [...ink.drawable()];
    // `perfect-freehand` handed a negative pressure draws a mark that turns
    // itself inside out.
    expect(stroke!.samples.map((s) => s.pressure)).toEqual([0, 1]);
  });
});

describe("what it holds on to", () => {
  it("keeps a run the newest message did not mention", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire({ id: "a" }), wire({ id: "b" })]));
    expect([...ink.drawable()]).toHaveLength(2);

    // The sender caps how many runs it publishes, and section 9.2 keeps the
    // ghost up until the document holds the id — so falling off the wire is not
    // the same as being over.
    ink.splice(readWet([wire({ id: "b" })]));
    expect([...ink.ids()]).toEqual(["a", "b"]);
  });

  it("lets one go when it is told to, and says whether it had it", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire({ id: "a" })]));
    expect(ink.forget("a")).toBe(true);
    expect(ink.forget("a")).toBe(false);
    expect([...ink.drawable()]).toHaveLength(0);
  });

  it("will not let one peer grow without end", () => {
    const ink = new PeerInk();
    for (let i = 0; i < 40; i += 1) ink.splice(readWet([wire({ id: `r${i}` })]));
    const held = [...ink.ids()];
    expect(held.length).toBeLessThanOrEqual(16);
    // The oldest go: their records are the longest overdue anyway.
    expect(held.at(-1)).toBe("r39");
  });

  it("bounds a single run, and keeps the numbering true while it does", () => {
    const ink = new PeerInk();
    // Windows marching forward for far longer than any hand draws.
    for (let base = 0; base < 4000; base += 2) {
      ink.splice(readWet([wire({ base, pts: [base * 8, 0, 128, (base + 1) * 8, 0, 128] })]));
    }
    const line = xs(ink);
    expect(line.length).toBeLessThanOrEqual(2048);
    // And still nearly all of it. The ceiling drops the oldest points, and
    // `origin` has to move with them — a trim that forgot to would leave every
    // later window looking like a gap, and the ghost would collapse to the
    // couple of points of whichever message arrived last. That failure keeps
    // the run contiguous, in order and ending in the right place, so only its
    // *length* tells the two apart.
    expect(line.length).toBeGreaterThan(2000);
    // Still one contiguous run of the real thing, in order, and ending where
    // the sender ended.
    for (let i = 1; i < line.length; i += 1) expect(line[i]!).toBeGreaterThan(line[i - 1]!);
    expect(line.at(-1)).toBe(3999);
  });

  it("holds back a run nobody could draw", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire({ pts: [0, 0, 128] })]));
    // One point is a press that has not moved. `render/ink/wet.ts` declines it
    // at either end of the wire, and `any` has to agree with `drawable`.
    expect([...ink.drawable()]).toHaveLength(0);
    expect(ink.any).toBe(false);
  });
});

describe("what counts as a change", () => {
  it("is silent when the same window arrives twice", () => {
    const ink = new PeerInk();
    const message = readWet([wire()]);
    expect(ink.splice(message)).toBe(true);
    // Awareness republishes on its own clock, and a peer holding a pen still
    // must not restroke a full-viewport canvas thirty times a second.
    expect(ink.splice(message)).toBe(false);
    expect(ink.splice(readWet([wire()]))).toBe(false);
  });

  it("notices a line that grew", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire()]));
    expect(ink.splice(readWet([wire({ pts: [0, 0, 128, 80, 0, 128, 160, 0, 128] })]))).toBe(true);
  });

  it("notices the tip moving in place, which is most frames of a stroke", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire()]));
    expect(ink.splice(readWet([wire({ pts: [0, 0, 128, 90, 0, 128] })]))).toBe(true);
  });

  it("notices a line that got shorter, which is a tip being retired", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire({ pts: [0, 0, 128, 80, 0, 128, 160, 0, 128] })]));
    expect(ink.splice(readWet([wire({ pts: [0, 0, 128, 80, 0, 128] })]))).toBe(true);
  });

  it("notices a run it had never seen", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire({ id: "a" })]));
    expect(ink.splice(readWet([wire({ id: "a" }), wire({ id: "b" })]))).toBe(true);
  });
});
