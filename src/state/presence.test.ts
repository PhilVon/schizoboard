/**
 * What goes on the wire about this client, and how often.
 *
 * Two questions, and the second one is AC-83: nothing durable ever goes on
 * awareness. That is a claim about the *shape* of what is published, so the
 * tests here read the payload rather than trusting the setters.
 */

import { describe, expect, it } from "vitest";

import type { WetStroke } from "@/lib/ink";
import { Camera } from "@/state/camera";
import { Presence, type PresenceState } from "@/state/presence";
import { Selection } from "@/state/selection";

/** Stands in for `Awareness`, and records every state it is handed. */
class Channel {
  readonly states: (Record<string, unknown> | null)[] = [];

  setLocalState(state: Record<string, unknown> | null): void {
    this.states.push(state);
  }

  get last(): PresenceState {
    const state = this.states.at(-1);
    if (state === null || state === undefined) throw new Error("nothing published");
    return state as unknown as PresenceState;
  }
}

const PHIL = { id: "u1", name: "Phil", color: "#c85" };

/**
 * Stands in for the Scene. A plain map of poses, so a test about what goes on
 * the wire never has to build a board to say what a drag is holding.
 */
class Poses {
  private readonly poses = new Map<string, { x: number; y: number; rot: number }>();

  put(id: string, x: number, y: number, rot = 0): void {
    this.poses.set(id, { x, y, rot });
  }

  drop(id: string): void {
    this.poses.delete(id);
  }

  poseOf(id: string): { x: number; y: number; rot: number } | null {
    return this.poses.get(id) ?? null;
  }
}

function setUp(options?: { everyNthFrame?: number; now?: () => number }) {
  const channel = new Channel();
  const camera = new Camera();
  const selection = new Selection();
  const poses = new Poses();
  const presence = new Presence(channel, camera, selection, poses, PHIL, options);
  return { channel, camera, selection, poses, presence };
}

describe("how often it speaks", () => {
  it("publishes on every other frame, not every frame", () => {
    const { channel, presence } = setUp();

    // The hand, not the camera: since T-226 a camera move is not a change, so a
    // cadence test driven by panning would pass by publishing nothing at all.
    for (let frame = 0; frame < 6; frame += 1) {
      presence.pointerAt(frame * 10, 0, "select");
      presence.flush(frame);
    }

    // Frames 0, 2 and 4. A cursor at 60 Hz is sixty messages a second per peer,
    // fanned out to every other peer, for a position nobody can see move that
    // precisely.
    expect(channel.states).toHaveLength(3);
  });

  it("says nothing at all when nothing has changed", () => {
    const { channel, presence } = setUp();

    presence.flush(0);
    expect(channel.states).toHaveLength(1);

    for (let frame = 2; frame < 40; frame += 2) presence.flush(frame);

    // An idle board is silent. `Awareness` bumps its own clock every fifteen
    // seconds, so silence never reads as absence.
    expect(channel.states).toHaveLength(1);
  });

  it("takes a slower cadence when it is given one", () => {
    const { channel, presence } = setUp({ everyNthFrame: 6 });

    for (let frame = 0; frame < 12; frame += 1) {
      presence.pointerAt(frame * 10, 0, "select");
      presence.flush(frame);
    }

    expect(channel.states).toHaveLength(2);
  });
});

describe("what it says", () => {
  it("publishes only the fields section 9 allows", () => {
    const { channel, presence } = setUp();

    presence.flush(0);

    // Key-set equality, not a subset check. The point of this test is to fail
    // the day somebody adds a field by handing an object to a setter.
    expect(Object.keys(channel.last).sort()).toEqual([
      "cursor",
      "grab",
      "locks",
      "selection",
      "user",
      "wet",
    ]);
  });

  it("survives the round trip through JSON", () => {
    const { channel, camera, selection, presence } = setUp();
    camera.panByScreen(-40, 12);
    selection.add("item-1");
    presence.pointerAt(3.7, -9.2, "marker");
    presence.flush(0);

    // Awareness stringifies every state it sends, so anything that does not
    // survive this arrives as something else — or as `null`.
    expect(JSON.parse(JSON.stringify(channel.last))).toEqual(channel.last);
  });

  it("does not carry the camera at all (T-226)", () => {
    const { channel, camera, presence } = setUp();
    camera.resize(800, 600);
    camera.zoomTo(1.23456789, 400, 300);
    camera.panByScreen(-100.7, -50.3);

    presence.flush(0);

    // Not "is null" — the field is not on the object. A `cam: null` published
    // every other frame is the same claim in a quieter voice, and a receiver
    // written against it would still be reading a field nobody produces.
    expect(Object.keys(channel.last)).not.toContain("cam");
  });

  /**
   * The consequence of the field going, and the whole of what it bought. With
   * the camera on the wire, scrolling around a board somebody else was watching
   * published thirty messages a second to say nothing anyone could see.
   */
  it("says nothing when only the camera moves", () => {
    const { channel, camera, presence } = setUp();
    camera.resize(800, 600);
    presence.flush(0);
    const sent = channel.states.length;

    camera.panByScreen(-400, -220);
    camera.zoomTo(2, 400, 300);
    presence.flush(2);
    presence.flush(4);

    expect(channel.states.length).toBe(sent);
  });

  it("carries the selection by kind, as plain strings", () => {
    const { channel, selection, presence } = setUp();
    selection.replaceThread(["item-1"], ["string-9"], ["pin-3"]);

    presence.flush(0);

    expect(channel.last.selection).toEqual({
      items: ["item-1"],
      strings: ["string-9"],
      pins: ["pin-3"],
    });
    // A copy, not a live view. What was published is what was true when it was
    // published, whatever happens next.
    selection.clear();
    expect(channel.last.selection.items).toEqual(["item-1"]);
  });

  it("republishes when the selection changes and not when it does not", () => {
    const { channel, selection, presence } = setUp();
    presence.flush(0);
    presence.flush(2);
    expect(channel.states).toHaveLength(1);

    selection.add("item-1");
    presence.flush(4);
    expect(channel.states).toHaveLength(2);

    selection.add("item-1");
    presence.flush(6);
    expect(channel.states).toHaveLength(2);
  });
});

describe("the cursor", () => {
  it("is published in board coordinates, rounded", () => {
    const { channel, presence } = setUp();

    presence.pointerAt(1234.5678, -9.4, "select");
    presence.flush(0);

    expect(channel.last.cursor).toEqual({ x: 1235, y: -9, tool: "select" });
  });

  it("does not republish for movement below a board unit", () => {
    const { channel, presence } = setUp();
    presence.pointerAt(100.1, 100.1, "select");
    presence.flush(0);
    expect(channel.states).toHaveLength(1);

    presence.pointerAt(100.4, 99.8, "select");
    presence.flush(2);

    // A cursor is a few pixels across and an item is three hundred units wide.
    expect(channel.states).toHaveLength(1);
  });

  it("republishes when the tool changes under a stationary pointer", () => {
    const { channel, presence } = setUp();
    presence.pointerAt(10, 10, "select");
    presence.flush(0);

    presence.pointerAt(10, 10, "marker");
    presence.flush(2);

    expect(channel.states).toHaveLength(2);
    expect(channel.last.cursor?.tool).toBe("marker");
  });

  it("goes to null when the pointer leaves the board", () => {
    const { channel, presence } = setUp();
    presence.pointerAt(10, 10, "select");
    presence.flush(0);

    presence.pointerGone();
    presence.flush(2);

    expect(channel.states).toHaveLength(2);
    expect(channel.last.cursor).toBeNull();
  });

  it("ignores a coordinate that is not a number", () => {
    const { channel, presence } = setUp();
    presence.pointerAt(10, 10, "select");
    presence.flush(0);

    presence.pointerAt(Number.NaN, 5, "select");
    presence.pointerAt(5, Number.POSITIVE_INFINITY, "select");
    presence.flush(2);

    // `NaN` stringifies to `null` and would arrive as a cursor at the origin.
    expect(channel.states).toHaveLength(1);
    expect(channel.last.cursor).toEqual({ x: 10, y: 10, tool: "select" });
  });
});

describe("leaving", () => {
  it("clears the local state so peers drop the cursor", () => {
    const { channel, camera, presence } = setUp();
    presence.flush(0);

    presence.stop();

    expect(channel.states.at(-1)).toBeNull();

    // And says nothing more, however much happens afterwards.
    camera.panByScreen(100, 100);
    presence.flush(2);
    presence.flush(4);
    expect(channel.states).toHaveLength(2);
  });
});

describe("the grab", () => {
  it("carries a pose for every held item, absolute and rounded", () => {
    const { channel, poses, presence } = setUp();
    poses.put("a", 100.4, -20.7, 0.123456);
    poses.put("b", 500, 500, 0);

    presence.grabbing(["a", "b"]);
    presence.flush(0);

    const grab = channel.last.grab;
    expect(grab?.kind).toBe("items");
    expect(grab?.ids).toEqual(["a", "b"]);
    // Whole board units, and a ten-thousandth of a radian. A board unit is about
    // half a millimetre of the thing being dragged.
    expect(grab?.poses).toEqual([
      { x: 100, y: -21, rot: 0.1235 },
      { x: 500, y: 500, rot: 0 },
    ]);
    expect(grab?.phase).toBe("live");
  });

  it("is null when nothing is held", () => {
    const { channel, presence } = setUp();
    presence.flush(0);
    expect(channel.last.grab).toBeNull();
  });

  it("does not republish while a held item stays where it is", () => {
    const { channel, poses, presence } = setUp();
    poses.put("a", 100, 100);
    presence.grabbing(["a"]);
    presence.flush(0);
    expect(channel.states).toHaveLength(1);

    // A hand that is not quite still, on an item three hundred units across.
    poses.put("a", 100.3, 99.8);
    presence.grabbing(["a"]);
    presence.flush(2);

    expect(channel.states).toHaveLength(1);
  });

  it("republishes as soon as the item has moved a unit", () => {
    const { channel, poses, presence } = setUp();
    poses.put("a", 100, 100);
    presence.grabbing(["a"]);
    presence.flush(0);

    poses.put("a", 104, 100);
    presence.grabbing(["a"]);
    presence.flush(2);

    expect(channel.states).toHaveLength(2);
    expect(channel.last.grab?.poses[0]).toEqual({ x: 104, y: 100, rot: 0 });
  });

  it("counts up, so a receiver can drop a re-delivered state", () => {
    const { channel, poses, presence } = setUp();
    poses.put("a", 0, 0);
    presence.grabbing(["a"]);
    presence.flush(0);
    const first = channel.last.grab?.seq ?? -1;

    poses.put("a", 40, 0);
    presence.grabbing(["a"]);
    presence.flush(2);

    expect(channel.last.grab?.seq).toBe(first + 1);
  });

  it("stamps the sender's clock, which only intervals mean anything about", () => {
    let clock = 1000;
    const { channel, poses, presence } = setUp({ now: () => clock });
    poses.put("a", 0, 0);
    presence.grabbing(["a"]);
    presence.flush(0);
    expect(channel.last.grab?.t).toBe(1000);

    clock = 1033;
    poses.put("a", 40, 0);
    presence.grabbing(["a"]);
    presence.flush(2);
    expect(channel.last.grab?.t).toBe(1033);
  });

  it("sends a final on release even though nothing moved", () => {
    const { channel, poses, presence } = setUp();
    poses.put("a", 100, 100);
    presence.grabbing(["a"]);
    presence.flush(0);
    expect(channel.states).toHaveLength(1);

    presence.released();
    presence.flush(2);

    // The release is a state transition, not a movement, so it cannot be
    // discovered by comparing poses — and a receiver needs it to know when to
    // start waiting for the document (DATA-MODEL section 9.2).
    expect(channel.states).toHaveLength(2);
    expect(channel.last.grab?.phase).toBe("final");
    expect(channel.last.grab?.poses[0]).toEqual({ x: 100, y: 100, rot: 0 });
  });

  it("carries the released pose, not the one from the last publishing frame", () => {
    const { channel, poses, presence } = setUp();
    poses.put("a", 100, 100);
    presence.grabbing(["a"]);
    presence.flush(0);

    // Moved on an odd frame, which publishes nothing, and let go on the same one.
    poses.put("a", 260, 100);
    presence.released();
    presence.flush(2);

    expect(channel.last.grab?.poses[0]).toEqual({ x: 260, y: 100, rot: 0 });
  });

  it("clears the grab after the final, so nothing stale is left in awareness", () => {
    const { channel, poses, presence } = setUp();
    poses.put("a", 100, 100);
    presence.grabbing(["a"]);
    presence.flush(0);
    presence.released();
    presence.flush(2);

    presence.flush(4);

    // Awareness keeps the last state it was handed. A `final` left sitting there
    // is a pose the next peer to connect would arrive and hold.
    expect(channel.states).toHaveLength(3);
    expect(channel.last.grab).toBeNull();
  });

  it("releases an item that was deleted mid-gesture, with an empty id list", () => {
    const { channel, poses, presence } = setUp();
    poses.put("a", 100, 100);
    presence.grabbing(["a"]);
    presence.flush(0);

    poses.drop("a");
    presence.released();
    presence.flush(2);

    expect(channel.last.grab?.phase).toBe("final");
    expect(channel.last.grab?.ids).toEqual([]);
  });

  it("drops an id the scene does not know rather than publishing it at the origin", () => {
    const { channel, poses, presence } = setUp();
    poses.put("a", 100, 100);

    presence.grabbing(["a", "ghost"]);
    presence.flush(0);

    expect(channel.last.grab?.ids).toEqual(["a"]);
  });

  it("survives the round trip through JSON", () => {
    const { channel, poses, presence } = setUp();
    poses.put("a", 100, 100, 0.5);
    presence.grabbing(["a"]);
    presence.flush(0);

    expect(JSON.parse(JSON.stringify(channel.last))).toEqual(channel.last);
  });
});

/**
 * The advisory lock on a segment being split — DATA-MODEL section 5.4, T-130.
 *
 * > Take an advisory lock on the segment over awareness, purely as a UX hint —
 * > never as a correctness mechanism.
 *
 * Both halves are testable from here. The first is that it goes out at all and
 * goes away again; the second is that taking one is a *change*, because a
 * gesture that grabs a segment without moving the cursor a whole board unit
 * would otherwise say nothing until the hand did.
 */
describe("claiming a segment", () => {
  const SEG = { string: "s1", a: "p1", b: "p2" };

  it("says nothing about locks until something is claimed", () => {
    const { channel, presence } = setUp();
    presence.flush(0);
    expect(channel.last.locks).toEqual({ segments: [] });
  });

  it("publishes the segment, named by its two pins", () => {
    const { channel, presence } = setUp();
    presence.flush(0);
    presence.splitting(SEG);
    presence.flush(2);

    expect(channel.last.locks).toEqual({ segments: [{ string: "s1", a: "p1", b: "p2" }] });
  });

  /** A press that takes hold of a segment moves nothing and changes nothing
   *  else about this client. Without the claim in `changed` it would sit on the
   *  wire unsent until the hand happened to move a whole board unit. */
  it("is a change in its own right", () => {
    const { channel, presence } = setUp();
    presence.flush(0);
    const before = channel.states.length;

    presence.splitting(SEG);
    presence.flush(2);
    expect(channel.states.length).toBe(before + 1);
  });

  it("goes away when the gesture lets go", () => {
    const { channel, presence } = setUp();
    presence.flush(0);
    presence.splitting(SEG);
    presence.flush(2);
    presence.splitting(null);
    presence.flush(4);

    expect(channel.last.locks).toEqual({ segments: [] });
  });

  /** Holding a segment still is not news. The claim is republished only when it
   *  changes, like every other field here. */
  it("does not republish the same claim every frame", () => {
    const { channel, presence } = setUp();
    presence.splitting(SEG);
    presence.flush(0);
    const after = channel.states.length;

    for (let frame = 2; frame < 20; frame += 2) presence.flush(frame);
    expect(channel.states.length).toBe(after);
  });

  it("drops a claim with an empty id in it rather than publishing one", () => {
    const { channel, presence } = setUp();
    presence.flush(0);
    presence.splitting({ string: "s1", a: "", b: "p2" });
    presence.flush(2);

    expect(channel.last.locks).toEqual({ segments: [] });
  });

  it("survives the round trip through JSON", () => {
    const { channel, presence } = setUp();
    presence.splitting(SEG);
    presence.flush(0);

    expect(JSON.parse(JSON.stringify(channel.last))).toEqual(channel.last);
  });
});

/**
 * The window itself is `state/wetwire.test.ts`'s subject. What is here is the
 * part only `Presence` can be wrong about: when the samples are read, and when
 * the result is allowed to cost a message.
 */
describe("the stroke under the pen", () => {
  const RUN: WetStroke = {
    id: "run-1",
    tool: "marker",
    color: "#1f1b17",
    size: 6,
    opacity: 1,
    item: null,
    samples: [],
  };

  /** A run whose samples are the array handed in, exactly as `MarkerTool` hands
   *  its live one over rather than copying it. */
  function stroke(samples: { x: number; y: number; pressure: number }[]): WetStroke {
    return { ...RUN, samples };
  }

  it("says nothing about ink until somebody draws some", () => {
    const { channel, presence } = setUp();
    presence.flush(0);

    expect(channel.last.wet).toEqual([]);
  });

  it("publishes the run, named by the id it was born with", () => {
    const { channel, presence } = setUp();
    presence.flush(0);
    presence.drawing([
      stroke([
        { x: 0, y: 0, pressure: 0.5 },
        { x: 40, y: 0, pressure: 0.5 },
      ]),
    ]);
    presence.flush(2);

    expect(channel.last.wet).toHaveLength(1);
    // The name minted at pen-down (T-167) — what lets a receiver match the
    // document record that is about to arrive against the ghost it is drawing.
    expect(channel.last.wet[0]!.id).toBe("run-1");
    expect(channel.last.wet[0]!.base).toBe(0);
  });

  it("reads the samples on every frame, not only the ones that publish", () => {
    const { channel, presence } = setUp();
    const samples: { x: number; y: number; pressure: number }[] = [];
    presence.flush(0);

    // A hand moving through eight frames, four of which send nothing. The
    // decimation has to see all eight: sampling at the publish cadence would
    // make a remote preview coarser on a peer that had been told to publish
    // less often, which is a transport setting and no business of the ink's.
    for (let frame = 1; frame <= 8; frame += 1) {
      samples.push({ x: frame * 40, y: 0, pressure: 0.5 });
      presence.drawing([stroke(samples)]);
      presence.flush(frame);
    }

    expect(channel.last.wet[0]!.pts).toHaveLength(8 * 3);
  });

  it("decimates against the zoom the sender is drawing at", () => {
    const { channel, camera, presence } = setUp();
    camera.resize(800, 600);
    camera.zoomTo(4, 400, 300);
    const samples: { x: number; y: number; pressure: number }[] = [];
    for (let i = 0; i < 10; i += 1) samples.push({ x: i * 2, y: 0, pressure: 0.5 });

    presence.drawing([stroke(samples)]);
    presence.flush(0);

    // Six screen pixels is a unit and a half at 400%, so two-unit steps all
    // survive. At 100% the same hand would send four points for these ten —
    // which is the right answer *there*, and the wrong one here.
    expect(channel.last.wet[0]!.pts).toHaveLength(10 * 3);
  });

  it("is a change in its own right, which nothing else on presence would notice", () => {
    const { channel, presence } = setUp();
    const samples = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 40, y: 0, pressure: 0.5 },
    ];
    presence.drawing([stroke(samples)]);
    presence.flush(0);
    const after = channel.states.length;

    // The pen has pointer capture, so the cursor was published at this position
    // before the line reached it. Nothing but the ink itself has moved.
    samples.push({ x: 80, y: 0, pressure: 0.5 });
    presence.drawing([stroke(samples)]);
    presence.flush(2);

    expect(channel.states.length).toBe(after + 1);
  });

  it("goes quiet again when the hand stops without lifting", () => {
    const { channel, presence } = setUp();
    const samples = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 40, y: 0, pressure: 0.5 },
    ];
    presence.drawing([stroke(samples)]);
    presence.flush(0);
    const after = channel.states.length;

    // A pen resting on the tablet produces no pointer events, so the array
    // stops growing and there is nothing new to say about it.
    for (let frame = 2; frame < 20; frame += 2) {
      presence.drawing([stroke(samples)]);
      presence.flush(frame);
    }

    expect(channel.states.length).toBe(after);
  });

  it("clears the ink when the gesture ends, so nothing stale sits in awareness", () => {
    const { channel, presence } = setUp();
    presence.drawing([
      stroke([
        { x: 0, y: 0, pressure: 0.5 },
        { x: 40, y: 0, pressure: 0.5 },
      ]),
    ]);
    presence.flush(0);
    expect(channel.last.wet).toHaveLength(1);

    presence.drawing([]);
    presence.flush(2);
    // Awareness keeps whatever it was last told. A run left sitting here is a
    // trap for the next peer to connect: it would arrive and draw a ghost for a
    // stroke that landed in the document minutes ago.
    expect(channel.last.wet).toEqual([]);
  });

  it("survives the round trip through JSON", () => {
    const { channel, presence } = setUp();
    presence.drawing([
      stroke([
        { x: 3.7, y: -9.2, pressure: 0.37 },
        { x: 44.1, y: -9.2, pressure: 0.61 },
      ]),
    ]);
    presence.flush(0);

    expect(JSON.parse(JSON.stringify(channel.last))).toEqual(channel.last);
  });
});
