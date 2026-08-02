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
import { Scene } from "@/state/scene";
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
    page: null,
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

  it("reads a run with no page as being on the object itself", () => {
    // Absent is what `state/wetwire.ts` sends for the overwhelmingly common
    // stroke — the key is left off rather than written as null, to save four
    // characters thirty times a second — so it has to arrive here as an answer
    // and not as a hole.
    expect(readWet([wire()])[0]!.page).toBe(null);
    // The same statement said out loud. Nothing this repository sends writes it
    // this way, but it means exactly what the absence means and there is no
    // reason to throw a stranger's mark away for saying so.
    expect(readWet([wire({ page: null })])[0]!.page).toBe(null);
  });

  it("reads the page a folder's mark was made on", () => {
    expect(readWet([wire({ item: "folder-1", page: 4 })])[0]!.page).toBe(4);
    expect(readWet([wire({ item: "folder-1", page: 1 })])[0]!.page).toBe(1);
  });

  it("drops a run whose page is not a page, rather than falling back to the cover", () => {
    // Deliberately unlike every *other* field with a sensible default, and for
    // the reason the colour above is dropped rather than substituted: there is
    // no nearly-right answer here. The two candidates are different surfaces,
    // and reading an unusable page as "the object itself" is exactly how a
    // peer's redaction of page four ends up painted across the kraft cover of a
    // folder that is lying shut on this screen.
    expect(readWet([wire({ page: "4" })])).toHaveLength(0);
    expect(readWet([wire({ page: 0 })])).toHaveLength(0);
    expect(readWet([wire({ page: -1 })])).toHaveLength(0);
    expect(readWet([wire({ page: 2.5 })])).toHaveLength(0);
    expect(readWet([wire({ page: Number.NaN })])).toHaveLength(0);
  });

  it("drops only the run with the bad page, so the rest of the pen survives", () => {
    const got = readWet([wire({ id: "a" }), wire({ id: "b", page: 0 }), wire({ id: "c", page: 2 })]);
    expect(got.map((r) => r.id)).toEqual(["a", "c"]);
    // And the good ones keep their own answers rather than the dropped one's.
    expect(got.map((r) => r.page)).toEqual([null, 2]);
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

  it("carries the face of the folder the mark was made on — T-278", () => {
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
          { item: "folder-1", page: 4 },
        ),
      ],
      1,
    );
    ink.splice(readWet(sender.payload()));

    // Through the real sender rather than a hand-written message, because the
    // page is the one field the two halves disagree about in shape: it is
    // omitted on the wire and null here, so a double would only prove I held
    // the same belief twice. What the painter is handed has to be the page.
    const [stroke] = [...ink.drawable()];
    expect(stroke!.page).toBe(4);
    expect(stroke!.item).toBe("folder-1");

    // And the other half of the same round trip: a mark on the bare cork comes
    // out as no page at all, not as a page that went missing.
    const cork = new WetWire();
    const bare = new PeerInk();
    cork.update(
      [
        run("r2", [
          { x: 0, y: 0, pressure: 1 },
          { x: 80, y: 0, pressure: 1 },
        ]),
      ],
      1,
    );
    bare.splice(readWet(cork.payload()));
    expect([...bare.drawable()][0]!.page).toBe(null);
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

    // And they stay gone. An eviction that only deleted would be undone by the
    // next message naming the same run, and the cap would be a per-message
    // churn rather than a ceiling on what a stranger can make this client hold.
    ink.splice(readWet([wire({ id: "r0" })]));
    expect([...ink.ids()]).not.toContain("r0");
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

describe("the handoff — section 9.2", () => {
  /** The document holds nothing at all, which is every frame of a live stroke. */
  const nothing = (): boolean => false;
  /** The document holds these, and their canvases are showing them. */
  const landed =
    (...ids: string[]) =>
    (id: string): boolean =>
      ids.includes(id);

  it("keeps the ghost up while the pen is down and the document is empty", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire()]));
    // A whole second of frames. Nothing here is a timer: the pen is down, and a
    // stroke being drawn has no record to wait for yet.
    for (let i = 0; i < 60; i += 1) expect(ink.retire(16, nothing)).toBe(false);
    expect([...ink.drawable()]).toHaveLength(1);
  });

  it("retires the ghost the frame the record reaches the canvas", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire()]));
    // The document has it, but that surface's canvas has not rastered it —
    // `awaitingInk` is still true, so the ghost is the only thing holding the
    // mark up and going now would open a hole.
    expect(ink.retire(16, nothing)).toBe(false);
    expect(ink.retire(16, landed("run-1"))).toBe(true);
    expect([...ink.drawable()]).toHaveLength(0);
  });

  it("does not start the grace on a run that only fell off the wire", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire({ id: "a" }), wire({ id: "b" })]));
    // `WET_MAX_RUNS` caps the payload, so a gesture across enough surfaces drops
    // its oldest run while the hand is still moving — and the whole gesture
    // commits in one go at pen-up, so that record is seconds away. The message
    // is not empty, so no pen came up and no clock starts.
    for (let i = 0; i < 60; i += 1) {
      ink.splice(readWet([wire({ id: "b" })]));
      ink.retire(16, nothing);
    }
    expect([...ink.ids()]).toEqual(["a", "b"]);
  });

  it("retires a run that never reaches the document, once the pen is up", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire()]));
    // The pen came up and this client's copy is all that is left of the mark:
    // the ink op refused it, or the paper left the board mid-stroke.
    ink.splice(readWet([]));
    // Right up to the line, and over it on the next millisecond — the grace is
    // 250 ms and not 250 ms plus whatever a frame happened to be.
    expect(ink.retire(249, nothing)).toBe(false);
    expect([...ink.drawable()]).toHaveLength(1);
    expect(ink.retire(1, nothing)).toBe(true);
    expect([...ink.drawable()]).toHaveLength(0);
  });

  it("cannot have its grace put back by a state from before the release", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire()]));
    ink.splice(readWet([]));
    // Awareness re-delivers whatever it holds on a resync, and what it holds can
    // be older than what has already been seen. A clock that restarted here
    // would leave a stranger's stroke on the board for as long as they kept
    // reconnecting.
    for (let i = 0; i < 5; i += 1) {
      ink.splice(readWet([wire()]));
      ink.retire(50, nothing);
    }
    expect([...ink.drawable()]).toHaveLength(0);

    // And the other half of the same clause: a peer sitting with the pen up
    // republishes an empty field, and each of those has to leave the clock
    // where it is rather than setting it back to nought.
    const idle = new PeerInk();
    idle.splice(readWet([wire()]));
    for (let i = 0; i < 4; i += 1) {
      idle.splice(readWet([]));
      expect(idle.retire(50, nothing)).toBe(false);
    }
    // Two hundred milliseconds have passed on a ghost whose pen came up, and
    // fifty more are all it has left — not another two hundred and fifty.
    expect(idle.retire(49, nothing)).toBe(false);
    expect(idle.retire(1, nothing)).toBe(true);
    expect([...idle.drawable()]).toHaveLength(0);
  });

  it("cannot be resurrected by a message naming a retired run", () => {
    const ink = new PeerInk();
    ink.splice(readWet([wire()]));
    ink.retire(16, landed("run-1"));
    // The ordinary case, not an odd one: the sender goes on publishing a run it
    // has committed until its *own* overlay copy retires, so the very next
    // message still names it. Putting it back would draw the ghost on top of
    // the record that replaced it — the frame section 9.2 exists to prevent.
    expect(ink.splice(readWet([wire()]))).toBe(false);
    expect([...ink.ids()]).toEqual([]);
    expect(ink.any).toBe(false);
  });

  it("is correct with the record first, and with the awareness clear first", () => {
    // Both orderings, because that is the whole claim: "no flash, no
    // double-draw" has to hold whichever channel wins the race.
    const first = new PeerInk();
    first.splice(readWet([wire()]));
    // Record first. The ghost is up until it rasters, and goes on that frame —
    // and the awareness clear that follows finds nothing to do.
    expect(first.retire(16, landed("run-1"))).toBe(true);
    expect(first.splice(readWet([]))).toBe(false);
    expect(first.any).toBe(false);

    const second = new PeerInk();
    second.splice(readWet([wire()]));
    // Clear first. The grace is running, but the mark stays on the screen for
    // every frame of it — this is the ordering that would flash.
    second.splice(readWet([]));
    for (let i = 0; i < 10; i += 1) {
      expect(second.retire(16, nothing)).toBe(false);
      expect(second.any).toBe(true);
    }
    expect(second.retire(16, landed("run-1"))).toBe(true);
    expect(second.any).toBe(false);
  });

  it("does not call a run nobody could see going a change", () => {
    const ink = new PeerInk();
    // One point is a press that has not moved, and was never drawn. Retiring it
    // must not bump the store's version, because the version is what restrokes
    // a full-viewport canvas.
    ink.splice(readWet([wire({ pts: [0, 0, 128] })]));
    ink.splice(readWet([]));
    expect(ink.retire(500, nothing)).toBe(false);
    expect([...ink.ids()]).toEqual([]);
  });

  it("costs nothing on a peer holding no pen, which is nearly all of them", () => {
    expect(new PeerInk().retire(16, nothing)).toBe(false);
  });

  it("does not remember every id a peer ever drew", () => {
    const ink = new PeerInk();
    // A session is thousands of strokes long, and the set that stops a ghost
    // coming back only has to outlive the messages still describing it. An
    // uncapped one would be the longest-lived thing this client holds about a
    // stranger — so far enough back, a run may be taken at face value again.
    for (let i = 0; i < 200; i += 1) {
      ink.splice(readWet([wire({ id: `r${i}` })]));
      ink.retire(16, () => true);
    }
    expect([...ink.ids()]).toEqual([]);
    ink.splice(readWet([wire({ id: "r0" })]));
    expect([...ink.ids()]).toEqual(["r0"]);
  });

  /**
   * A real `WetWire` publishing into a real `PeerInk`, handed over against a
   * real `Scene` — the same three objects `app/main.ts` wires together, and the
   * predicate below is that file's `inkLanded` written out.
   *
   * The one stand-in is the layer's "has the canvas caught up" set, because a
   * `DomItemLayer` wants a document to mount into; what it answers with is an
   * `inkPending` set exactly like this one, and `DomItemLayer.awaitingInk` is
   * its own tests' subject.
   */
  it("finds the record where the document filed it, not under where the ghost sits", () => {
    const sender = new WetWire();
    const scene = new Scene();
    const ink = new PeerInk();
    /** The surfaces whose canvases are behind their strokes. */
    const behind = new Set<string>();
    // `app/main.ts`, four lines of it.
    const inkLanded = (id: string): boolean => {
      const surface = scene.strokeSurface(id);
      if (surface === null) return false;
      return !behind.has(surface.kind === "item" ? surface.id : surface.key);
    };

    // One long mark on the bare cork, a hundred board units to the sample —
    // well past the six-pixel decimation, so every sample is committed and the
    // sender's sequence is 129 points long.
    const samples: InkSample[] = [];
    for (let i = 0; i <= 128; i += 1) samples.push({ x: i * 100, y: 0, pressure: 0.5 });
    sender.update([run("mark", samples)], 1);

    // A peer that arrived in the middle of it. The window is 64 points, so what
    // is held is the last half of the mark and nothing before it.
    ink.splice(readWet(sender.payload()));
    const held = xs(ink);
    expect(held).toEqual([...Array(64)].map((_, i) => 6500 + i * 100));

    // Which is the whole point of this test. A board stroke is filed by the
    // bounding-box centre of *all* its points — 6400, in tile 3 — and the piece
    // this client is holding has its own centre at 9650, in tile 4. Any
    // predicate that worked the tile out from the ghost would look in the wrong
    // one forever, and the ghost would sit on the board until its grace expired
    // and then blink out over a mark that had been there all along.
    const filed = "3,0";
    expect(Math.floor(9650 / 2048)).toBe(4);
    scene.putBoardStrokes(filed, [
      {
        id: "mark",
        tool: "marker",
        color: "#1f1b17",
        size: DEFAULT_INK_SIZE,
        opacity: 1,
        seed: 1,
        z: "a0",
        page: null,
        bbox: [0, 0, 12800, 0],
        samples,
      },
    ]);

    // The record is in the document but that tile's canvas has not been
    // repainted yet: the ghost is still the only thing holding the mark up.
    behind.add(filed);
    expect(ink.retire(16, inkLanded)).toBe(false);
    expect(ink.any).toBe(true);

    // And the frame the raster lands.
    behind.delete(filed);
    expect(ink.retire(16, inkLanded)).toBe(true);
    expect(ink.any).toBe(false);

    // The sender is still publishing it — its own overlay copy has not retired
    // yet — and that must not put the ghost back over the record.
    sender.update([run("mark", samples)], 1);
    expect(ink.splice(readWet(sender.payload()))).toBe(false);
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
