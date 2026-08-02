/**
 * Somebody else's drag, and the two claims Phase 7 makes about it.
 *
 * AC-84 is that the *interpolated* pose drives the rope anchor and never the raw
 * sample, so the tests that matter most here are the ones that watch what a
 * frame writes on the frame a sample arrives on: the answer must be the peer's
 * position 100 ms ago, not the position that just landed. AC-85 is the escape
 * hatch — a connection that cannot hold the buffer falls back to a
 * critically-damped spring — and the trap there is the false positive, so there
 * is a test for a peer who simply paused.
 *
 * Times are handed in rather than faked. The playhead is an argument
 * (`apply(now, …)`) and so is a sample's arrival (`observe(…, receivedAt)`),
 * which makes every case here a matter of choosing numbers.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { DirtySets } from "@/state/dirty";
import type { PresenceGrab } from "@/state/presence";
import { REMOTE_DELAY_MS, RemoteMotion, criticallyDamped, readGrab } from "@/state/remote";
import { Scene, type ItemPose } from "@/state/scene";

let scene: Scene;
let dirty: DirtySets;
let remote: RemoteMotion;

const PEER = 7;
/** One 60 fps frame. */
const FRAME = 1000 / 60;

function item(id: string, pose: Partial<ItemPose> = {}): void {
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x: 0, y: 0, rot: 0, w: 240, h: 200, ...pose },
  );
}

/** An awareness state carrying one item's grab, as it would arrive over the wire. */
function state(
  t: number,
  x: number,
  y: number,
  options: { rot?: number; seq?: number; phase?: "live" | "final"; id?: string } = {},
): { grab: PresenceGrab } {
  return {
    grab: {
      kind: "items",
      ids: [options.id ?? "a"],
      poses: [{ x, y, rot: options.rot ?? 0 }],
      seq: options.seq ?? t,
      t,
      phase: options.phase ?? "live",
    },
  };
}

/** Deliver a sample, and pretend it took `latency` to arrive. */
function send(
  t: number,
  x: number,
  y: number,
  options: { rot?: number; seq?: number; phase?: "live" | "final"; latency?: number } = {},
): void {
  remote.observe(PEER, state(t, x, y, options), t + (options.latency ?? 0));
}

/**
 * One frame's phase 2, and then phase 9's `dirty.clear()`.
 *
 * The clear is not decoration: `RemoteMotion` reads the dirty set to tell a
 * document write from its own, and that only works because the frame empties it
 * once per frame (`render/loop.ts` phase 9). Returns how many items the phase
 * marked, so a test can assert on the cost without holding the set open.
 */
function apply(now: number, dtMs = FRAME): number {
  remote.apply(now, dtMs, scene, dirty);
  const marked = dirty.items.size;
  dirty.clear();
  return marked;
}

/** What `crdt/binding.ts` does when a document update lands: pose, then flag. */
function fromDocument(id: string, x: number, y: number, rot = 0): void {
  scene.setPose(id, { x, y, rot });
  dirty.item(id);
}

function at(id = "a"): { x: number; y: number; rot: number } {
  const pose = scene.poseOf(id);
  if (pose === null) throw new Error(`no item ${id}`);
  return { x: pose.x, y: pose.y, rot: pose.rot };
}

beforeEach(() => {
  scene = new Scene();
  dirty = new DirtySets();
  remote = new RemoteMotion();
  item("a");
});

describe("reading a grab off the wire", () => {
  it("takes a well-formed one", () => {
    const grab = readGrab(state(100, 5, 6, { rot: 0.25 }));
    expect(grab?.ids).toEqual(["a"]);
    expect(grab?.poses).toEqual([{ x: 5, y: 6, rot: 0.25 }]);
  });

  it("refuses a coordinate that is not a finite number", () => {
    // `NaN` and `Infinity` both survive `JSON.stringify` as `null`, and a `null`
    // written into the scene is an item at an unreachable coordinate with every
    // rope on it dragged along.
    expect(readGrab({ grab: { ...state(1, 0, 0).grab, poses: [{ x: 1, y: null, rot: 0 }] } })).toBeNull();
    expect(
      readGrab({ grab: { ...state(1, 0, 0).grab, poses: [{ x: Number.NaN, y: 0, rot: 0 }] } }),
    ).toBeNull();
  });

  it("refuses parallel arrays that are not parallel", () => {
    // An invariant of the sender, which is exactly why the receiver checks it.
    const grab = { ...state(1, 0, 0).grab, ids: ["a", "b"] };
    expect(readGrab({ grab })).toBeNull();
  });

  it("refuses a kind or a phase it does not know", () => {
    expect(readGrab({ grab: { ...state(1, 0, 0).grab, kind: "pins" } })).toBeNull();
    expect(readGrab({ grab: { ...state(1, 0, 0).grab, phase: "midway" } })).toBeNull();
  });

  it("reads no grab from a state that has none", () => {
    expect(readGrab({ cursor: { x: 1, y: 2, tool: "select" } })).toBeNull();
    expect(readGrab({ grab: null })).toBeNull();
    expect(readGrab(null)).toBeNull();
  });
});

describe("rendering in the past", () => {
  it("puts the item where the peer was 100 ms ago", () => {
    // A peer moving 100 units every 100 ms, on a clock that agrees with ours.
    send(0, 0, 0);
    send(100, 100, 0);
    send(200, 200, 0);

    apply(200);

    // The newest sample says 200. What is drawn is where the peer was at t=100.
    expect(at().x).toBeCloseTo(100, 6);
    expect(REMOTE_DELAY_MS).toBe(100);
  });

  it("interpolates between the straddling samples, not to the nearest one", () => {
    send(0, 0, 0);
    send(100, 100, 0);

    // Playhead at t=25: a quarter of the way along the first segment.
    apply(125);
    expect(at().x).toBeCloseTo(25, 6);

    apply(175);
    expect(at().x).toBeCloseTo(75, 6);
  });

  it("turns a 20 Hz trickle into a different pose on every frame", () => {
    // Samples 50 ms apart, applied at 60 fps. This is section 9.3's whole claim.
    for (let t = 0; t <= 300; t += 50) send(t, t * 2, 0);

    const xs: number[] = [];
    for (let frame = 0; frame < 6; frame += 1) {
      apply(150 + frame * FRAME);
      xs.push(at().x);
    }

    // Six frames, six distinct positions, from samples arriving every third one.
    expect(new Set(xs).size).toBe(6);
    // And monotonic: a lerp along a monotonic path cannot double back.
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
  });

  it("never writes the raw sample that just arrived", () => {
    // AC-84, stated as directly as it can be. Each sample is a 100-unit step,
    // and the frame it lands on must show the previous one.
    send(0, 0, 0);
    send(100, 100, 0);
    apply(100);
    expect(at().x).toBeCloseTo(0, 6);

    send(200, 200, 0);
    apply(200);
    expect(at().x).toBeCloseTo(100, 6);

    send(300, 300, 0);
    apply(300);
    expect(at().x).toBeCloseTo(200, 6);
  });

  it("sits on the oldest sample it has when the playhead is behind the buffer", () => {
    // A peer that just started dragging: there is nothing 100 ms old to show.
    send(1000, 500, 0);
    send(1033, 540, 0);

    apply(1040);

    expect(at().x).toBeCloseTo(500, 6);
  });

  it("drives the rope anchor, because the anchor is derived from the pose", () => {
    // `sim/ropes.ts` reads every anchor through `scene.layoutPin` in phase 3,
    // from whatever phase 2 left in the scene. So this is the anchor.
    scene.putPin({
      id: "p1",
      parent: "a",
      lx: 20,
      ly: 10,
      kind: "pushpin",
      color: "#c8352f",
      page: null,
      wx: 20,
      wy: 10,
    });
    send(0, 0, 0);
    send(100, 100, 0);

    apply(150);
    scene.layoutPins();

    const pin = scene.pins.get("p1");
    expect(at().x).toBeCloseTo(50, 6);
    expect(pin?.wx).toBeCloseTo(70, 6);
  });
});

describe("running past the newest sample", () => {
  it("carries on at the sample velocity across a short gap", () => {
    // 1 unit per ms, then silence.
    send(0, 0, 0);
    send(100, 100, 0);

    // Playhead 40 ms past the newest sample.
    apply(240);

    expect(at().x).toBeCloseTo(140, 6);
  });

  it("stops guessing at 80 ms and freezes", () => {
    send(0, 0, 0);
    send(100, 100, 0);

    apply(280);
    expect(at().x).toBeCloseTo(180, 6);

    // Past the cap, and it stays there however long the silence lasts. A guess
    // carried further has to be taken back, and a snap is worse than a stall.
    apply(400);
    expect(at().x).toBeCloseTo(180, 6);
    apply(5000);
    expect(at().x).toBeCloseTo(180, 6);
  });

  it("will not measure a velocity across a pause", () => {
    // Two samples two seconds apart. The peer did not travel 4000 units at two a
    // millisecond — it sat still and then moved — so there is no current velocity
    // to carry, and 80 ms of the average would be 160 units of invented motion in
    // whatever direction the drag last happened to be going.
    send(0, 0, 0);
    send(2000, 4000, 0);

    apply(2200);

    expect(at().x).toBeCloseTo(4000, 6);
  });

  it("does not guess past a final at all", () => {
    send(0, 0, 0);
    send(100, 100, 0, { phase: "final" });

    apply(240);

    // The gesture is over and the document is about to confirm this exact pose.
    // Overshooting it would only have to be taken back, and the handoff below is
    // waiting on this value.
    expect(at().x).toBeCloseTo(100, 6);
  });
});

describe("two clocks", () => {
  it("interpolates correctly for a peer whose clock is nowhere near ours", () => {
    // The sender's epoch is its own `performance.now()`. A million milliseconds
    // out, with a steady 30 ms of latency.
    send(1_000_000, 0, 0, { latency: 30 });
    send(1_000_100, 100, 0, { latency: 30 });

    // Our clock: the second sample arrived at 1_000_130, so the playhead 100 ms
    // back lands halfway along the segment.
    apply(1_000_180);

    expect(at().x).toBeCloseTo(50, 6);
  });

  it("takes a lower latency as better evidence at once", () => {
    // First sample crawls in, the second is prompt. The prompt one is the better
    // estimate of the offset and there is nothing to weigh against it.
    send(0, 0, 0, { latency: 200 });
    send(100, 100, 0, { latency: 0 });

    apply(180);

    expect(at().x).toBeCloseTo(80, 6);
  });

  it("ignores a sample it has already seen", () => {
    send(0, 0, 0, { seq: 1 });
    send(100, 100, 0, { seq: 2 });
    // A resync re-delivers a state, or a joining peer's query is answered twice.
    remote.observe(PEER, state(100, 999, 999, { seq: 2 }), 100);
    remote.observe(PEER, state(50, 999, 999, { seq: 1 }), 100);

    apply(200);

    expect(at().x).toBeCloseTo(100, 6);
  });
});

describe("what it costs when nothing is happening", () => {
  it("marks nothing dirty for a peer holding an item still", () => {
    send(0, 300, 0);
    send(100, 300, 0);
    apply(200);

    let marked = 0;
    for (let frame = 1; frame < 30; frame += 1) marked += apply(200 + frame * FRAME);

    // A pose identical to the last one is not written, because a dirty item wakes
    // every rope hanging off it (`sim/ropes.ts`, ANCHOR_EPSILON).
    expect(marked).toBe(0);
  });

  it("does not write a fraction of a board unit", () => {
    send(0, 0, 0);
    send(1000, 0.004, 0);

    apply(1100);

    expect(apply(1100 + FRAME)).toBe(0);
  });
});

describe("the handoff", () => {
  it("holds the awareness pose until the document agrees", () => {
    send(0, 0, 0);
    send(100, 100, 0, { phase: "final" });

    apply(200);
    expect(at().x).toBeCloseTo(100, 6);
    expect(remote.heldBy(PEER).has("a")).toBe(true);

    // The peer's `final` document write lands, through `crdt/binding.ts`. Note
    // that it writes the pose this phase had already put there, which is the
    // normal case and the one a value comparison alone cannot see: the flag is
    // what says the document spoke.
    fromDocument("a", 100, 0);
    apply(200 + FRAME);

    expect(remote.heldBy(PEER).has("a")).toBe(false);
    expect(at().x).toBeCloseTo(100, 6);
  });

  it("keeps holding it while the document still disagrees", () => {
    send(0, 0, 0);
    send(100, 100, 0, { phase: "final" });
    apply(200);

    // 200 ms of nothing from the document. Dropping to the document's pose here
    // is the snap-back section 9.2 exists to prevent.
    for (let ms = 0; ms < 200; ms += FRAME) apply(200 + ms);

    expect(at().x).toBeCloseTo(100, 6);
    expect(remote.heldBy(PEER).has("a")).toBe(true);
  });

  it("gives up after the grace period and puts the item on the document's pose", () => {
    send(0, 0, 0);
    send(100, 100, 0, { phase: "final" });
    apply(200);

    apply(200 + 250);

    // Nothing ever confirmed the awareness pose, so it is not where the item is.
    // The mirror goes back to mirroring, and the item moves — visibly, and
    // rightly.
    expect(at().x).toBeCloseTo(0, 6);
    expect(remote.heldBy(PEER).has("a")).toBe(false);
  });

  it("starts the handoff when a peer's grab disappears without a final", () => {
    send(0, 0, 0);
    send(100, 100, 0);
    apply(200);

    // A peer that closed the tab mid-drag: awareness carries the state without a
    // grab, or drops it entirely.
    remote.observe(PEER, { cursor: null }, 210);
    apply(210 + 250);

    expect(remote.heldBy(PEER).has("a")).toBe(false);
    expect(at().x).toBeCloseTo(0, 6);
  });

  it("ends the gesture on the document's pose exactly, not within an epsilon of it", () => {
    send(0, 0, 0);
    send(100, 100, 0, { phase: "final" });
    apply(200);

    // Within the sixty-fourth of a unit that is normally not worth a write. It is
    // worth it here: this is the write that ends the divergence, and skipping it
    // would leave an interpolated coordinate as the item's stored position.
    fromDocument("a", 100.001, 0);
    apply(200 + FRAME);

    expect(at().x).toBe(Math.fround(100.001));
  });

  it("picks up an item that arrives in the scene after the grab did", () => {
    // A photograph created and dragged in one gesture, whose document update has
    // not landed yet.
    send(0, 0, 0, { latency: 0 });
    remote.observe(PEER, state(100, 100, 0, { id: "later" }), 100);
    apply(200);
    expect(remote.heldBy(PEER).has("later")).toBe(false);

    item("later", { x: 0, y: 0 });
    remote.observe(PEER, state(200, 200, 0, { id: "later" }), 200);
    apply(250);

    expect(remote.heldBy(PEER).has("later")).toBe(true);
  });
});

describe("the spring fallback", () => {
  /** A gap long enough to be extrapolating but not yet frozen, repeatedly. */
  function jitter(rounds: number): number {
    let t = 0;
    for (let round = 0; round < rounds; round += 1) {
      send(t, t, 0);
      send(t + 20, t + 20, 0);
      // The playhead runs 20 to 55 ms past the newest sample — inside the
      // extrapolation cap and never frozen, three frames in a row. That is what a
      // connection that cannot hold the buffer looks like, as against one that
      // has gone quiet.
      for (let frame = 0; frame < 3; frame += 1) {
        apply(t + 20 + REMOTE_DELAY_MS + 20 + frame * FRAME);
      }
      t += 120;
    }
    return t;
  }

  it("stays on interpolation for a connection that is behaving", () => {
    for (let t = 0; t <= 600; t += 33) send(t, t, 0);
    for (let frame = 0; frame < 30; frame += 1) apply(200 + frame * FRAME);

    expect(remote.fallback(PEER)).toBe(false);
  });

  it("does not trip on a peer who picked something up and paused", () => {
    // The trap. A peer publishes only when something changed, so a pause is
    // silence, and silence looks exactly like a starved buffer.
    send(0, 0, 0);
    send(100, 100, 0);
    for (let ms = 0; ms < 3000; ms += FRAME) apply(200 + ms);

    expect(remote.fallback(PEER)).toBe(false);
    expect(at().x).toBeCloseTo(180, 6);
  });

  it("trips under sustained jitter", () => {
    jitter(8);
    expect(remote.fallback(PEER)).toBe(true);
  });

  it("comes back to interpolation once the connection recovers", () => {
    jitter(8);
    expect(remote.fallback(PEER)).toBe(true);

    // A healthy stream, long enough to walk the score all the way back to zero —
    // which is the point of the two thresholds being different numbers.
    let t = 2000;
    for (let round = 0; round < 60; round += 1) {
      send(t, t, 0);
      apply(t - 60);
      t += 20;
    }

    expect(remote.fallback(PEER)).toBe(false);
  });

  it("cannot reproduce the jitter it is handed", () => {
    // The property AC-85 is buying, and the one that matters: whatever the input
    // does, the anchor has no way to move faster than the spring, so it cannot
    // pass a per-frame slam through to the rope hanging off it.
    const ended = jitter(8);
    expect(remote.fallback(PEER)).toBe(true);

    // Twenty-four frames, which the score has the headroom to stay tripped
    // through — it decays by one a frame and tripping needs twenty. The first few
    // are the spring catching up from wherever the jitter left it; the claim is
    // about the steady state after that.
    let t = ended;
    let biggest = 0;
    let previous = at().x;
    for (let frame = 0; frame < 24; frame += 1) {
      // 400 units of input movement, reversing every single frame.
      send(t, frame % 2 === 0 ? 0 : 400, 0);
      t += FRAME;
      apply(t + REMOTE_DELAY_MS);
      if (frame >= 4) biggest = Math.max(biggest, Math.abs(at().x - previous));
      previous = at().x;
    }

    expect(remote.fallback(PEER)).toBe(true);
    // About a sixth of the input's swing, and that ratio is the whole point: the
    // spring has one rate and cannot exceed it, so it sits between the two
    // extremes and trembles rather than following. A per-frame reversal of 400
    // units is far past anything a real connection produces — the number to read
    // here is the attenuation, not the residue.
    expect(biggest).toBeLessThan(80);
    expect(biggest).toBeLessThan(400 / 4);
  });
});

describe("the spring itself", () => {
  /** Chase `target` from rest and report every position along the way. */
  function chase(from: number, target: number, v0 = 0, frames = 150): number[] {
    const out: number[] = [];
    let x = from;
    let v = v0;
    for (let i = 0; i < frames; i += 1) {
      ({ x, v } = criticallyDamped(x, v, target, FRAME / 1000));
      out.push(x);
    }
    return out;
  }

  it("never overshoots from rest", () => {
    const path = chase(0, 100);
    for (const x of path) expect(x).toBeLessThanOrEqual(100);
    // Monotonic, too: from rest there is nothing to make it hesitate. Not
    // strictly — the tail is a double at its last representable step below 100.
    for (let i = 1; i < path.length; i += 1) {
      expect(path[i]!).toBeGreaterThanOrEqual(path[i - 1]!);
    }
    expect(path[10]!).toBeGreaterThan(path[9]!);
  });

  it("passes the target at most once when it arrives with speed", () => {
    // Critical damping is the absence of oscillation, not of overshoot. What it
    // must never do is come back a second time — a rope anchor would turn that
    // into a wobble, and a wobble is what the fallback exists to avoid.
    const path = chase(0, 100, 4000);
    let crossings = 0;
    let side = -1;
    for (const x of path) {
      const now = Math.sign(x - 100);
      if (now !== 0 && now !== side) {
        crossings += 1;
        side = now;
      }
    }
    expect(crossings).toBe(1);
  });

  it("arrives, rather than crawling at an asymptote", () => {
    // An anchor that never settles is a rope that never sleeps.
    expect(chase(0, 100).at(-1)).toBeCloseTo(100, 6);
  });

  it("is stable across a dropped frame, however long", () => {
    // The point of the analytic form. A stalled tab is exactly when a fallback
    // for a bad connection must not explode.
    const { x, v } = criticallyDamped(0, 5000, 100, 2);
    expect(x).toBeCloseTo(100, 6);
    expect(Math.abs(v)).toBeLessThan(1e-6);
  });

  it("does nothing at all across no time", () => {
    expect(criticallyDamped(7, 3, 100, 0)).toEqual({ x: 7, v: 3 });
  });
});

describe("more than one of them", () => {
  it("keeps each peer's buffer and clock to itself", () => {
    item("b");
    remote.observe(PEER, state(0, 0, 0), 0);
    remote.observe(PEER, state(100, 100, 0), 100);
    // A second peer, a million milliseconds off on its own clock, dragging `b`.
    remote.observe(9, state(1_000_000, 0, 0, { id: "b" }), 0);
    remote.observe(9, state(1_000_100, 400, 0, { id: "b" }), 100);

    apply(150);

    expect(at("a").x).toBeCloseTo(50, 6);
    expect(at("b").x).toBeCloseTo(200, 6);
  });

  it("ignores this client's own state", () => {
    // Our own state is in `getStates()` like everybody else's. Interpolating our
    // own drag would put a pose from 100 ms ago on top of the gesture making it,
    // and the item would trail the cursor by exactly the buffer.
    remote.ignore(PEER);
    send(0, 0, 0);
    send(100, 100, 0);

    apply(150);

    expect(remote.heldBy(PEER).size).toBe(0);
    expect(at().x).toBe(0);
  });

  it("forgets a peer that disconnected", () => {
    send(0, 0, 0);
    send(100, 100, 0);
    apply(150);
    expect(remote.heldBy(PEER).size).toBe(1);

    remote.forget(PEER);
    apply(200);

    expect(remote.heldBy(PEER).size).toBe(0);
    // And the item is left where the last frame put it, for the document to
    // correct. Awareness dropping is not evidence about where anything is.
    expect(at().x).toBeCloseTo(50, 6);
  });
});

/**
 * The readout the debug overlay draws (T-235) — DESIGN 11.1 risk 2's second
 * mitigation, and the one that makes the other two checkable.
 *
 * The claim under test is not "the numbers are right" — every other test in
 * this file is about that. It is that the readout reports the *two different*
 * poses. A `debug()` that quietly answered with the same pose twice would draw
 * a square exactly on its dot on every frame, and the overlay would then say
 * "the interpolation is perfect" in precisely the case where it had stopped
 * running.
 */
describe("the debug readout", () => {
  it("says nothing at all about a board with no peers", () => {
    expect(remote.debug()).toEqual([]);
  });

  it("reports the raw sample and the interpolated pose as two different poses", () => {
    item("a");
    send(0, 0, 0);
    send(100, 400, 0);
    // The playhead sits 100 ms back, so the scene holds the *older* pose while
    // the newest sample is already 400 away. That gap is the whole subject.
    apply(100);

    const [peer] = remote.debug();
    expect(peer?.clientId).toBe(PEER);
    expect(peer?.items).toHaveLength(1);
    const shown = peer!.items[0]!;
    expect(shown.id).toBe("a");
    expect(shown.raw).toEqual({ x: 400, y: 0, rot: 0 });
    expect(shown.shown?.x).toBe(0);
    // And it agrees with what was actually written, which is the property that
    // makes the dot worth drawing.
    expect(shown.shown?.x).toBe(at().x);
  });

  it("carries the numbers a legend needs, live", () => {
    item("a");
    send(0, 0, 0);
    send(100, 400, 0);
    apply(100);

    const [peer] = remote.debug();
    expect(peer?.buffered).toBe(2);
    expect(peer?.spring).toBe(false);
    expect(peer?.jitter).toBe(0);
    expect(peer?.skew).not.toBeNull();
    expect(peer?.guessed).toBe(false);
  });

  /** The flags say *why* the two poses differ, so they have to move when the
   *  reason does. A playhead past the newest sample is a guess. */
  it("says when the playhead is guessing rather than interpolating", () => {
    item("a");
    send(0, 0, 0);
    send(100, 400, 0);
    apply(100);
    expect(remote.debug()[0]?.guessed).toBe(false);

    // 100 ms later with nothing new: the playhead is past the newest sample.
    apply(240);
    expect(remote.debug()[0]?.guessed).toBe(true);
  });

  it("reports every peer, not just the first", () => {
    item("a");
    item("b");
    send(0, 0, 0);
    send(100, 400, 0);
    remote.observe(9, state(0, 0, 0, { id: "b" }), 0);
    remote.observe(9, state(100, 40, 0, { id: "b" }), 100);
    apply(100);

    expect(remote.debug().map((p) => p.clientId).sort((x, y) => x - y)).toEqual([7, 9]);
  });
});
