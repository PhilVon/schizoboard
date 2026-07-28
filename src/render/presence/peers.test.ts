import { beforeEach, describe, expect, it } from "vitest";

import { Peers, readPeer, UNKNOWN_COLOR } from "@/render/presence/peers";

/** A well-formed awareness state, of the shape `state/presence.ts` publishes. */
function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { id: "7", name: "Blue peer", color: "#2c5aa8" },
    cam: { x: 0, y: 0, zoom: 1 },
    cursor: { x: 100, y: 50, tool: "select" },
    selection: { items: [], strings: [], pins: [] },
    grab: null,
    wet: [],
    ...over,
  };
}

let peers: Peers;

/** Run the spring for a second at 60 Hz — long past any settling time. */
function settle(): void {
  for (let i = 0; i < 60; i += 1) peers.step(16.7);
}

function only(): { name: string; color: string; cursor: { x: number; y: number } | null } {
  const all = [...peers.peers()];
  expect(all).toHaveLength(1);
  return all[0]!;
}

beforeEach(() => {
  peers = new Peers();
});

describe("readPeer", () => {
  it("needs a user with an id, and nothing else is compulsory", () => {
    expect(readPeer(null)).toBeNull();
    expect(readPeer("nonsense")).toBeNull();
    expect(readPeer({})).toBeNull();
    expect(readPeer({ user: {} })).toBeNull();
    expect(readPeer({ user: { id: "" } })).toBeNull();

    const bare = readPeer({ user: { id: "7" } });
    expect(bare).not.toBeNull();
    expect(bare!.cursor).toBeNull();
    expect(bare!.items).toEqual([]);
  });

  it("reads the fields it draws", () => {
    const peer = readPeer(
      state({ selection: { items: ["i1", "i2"], strings: ["s1"], pins: ["p1"] } }),
    )!;
    expect(peer.id).toBe("7");
    expect(peer.name).toBe("Blue peer");
    expect(peer.color).toBe("#2c5aa8");
    expect(peer.cursor).toEqual({ x: 100, y: 50 });
    expect(peer.items).toEqual(["i1", "i2"]);
    expect(peer.strings).toEqual(["s1"]);
    expect(peer.pins).toEqual(["p1"]);
  });

  /**
   * The sharp one. A colour off the wire is assigned to `ctx.fillStyle`, and a
   * string the canvas cannot parse is *ignored* rather than rejected — so an
   * unvalidated colour would paint one peer in the previous peer's identity.
   */
  it("only trusts a hex colour, and substitutes one otherwise", () => {
    for (const color of ["red", "", "#fff", "javascript:x", 7, null, "#2c5aa8; x"]) {
      expect(readPeer(state({ user: { id: "7", name: "n", color } }))!.color).toBe(UNKNOWN_COLOR);
    }
    expect(readPeer(state({ user: { id: "7", name: "n", color: "#A8322C" } }))!.color).toBe(
      "#A8322C",
    );
  });

  it("names a peer that did not say, and caps one that said too much", () => {
    expect(readPeer(state({ user: { id: "7" } }))!.name).toBe("peer");
    expect(readPeer(state({ user: { id: "7", name: "   " } }))!.name).toBe("peer");
    const long = readPeer(state({ user: { id: "7", name: "x".repeat(500) } }))!;
    expect(long.name).toHaveLength(24);
  });

  it("drops a cursor that is not two finite numbers", () => {
    expect(readPeer(state({ cursor: { x: Number.NaN, y: 0 } }))!.cursor).toBeNull();
    expect(readPeer(state({ cursor: { x: 1, y: Number.POSITIVE_INFINITY } }))!.cursor).toBeNull();
    expect(readPeer(state({ cursor: { x: "1", y: 2 } }))!.cursor).toBeNull();
    expect(readPeer(state({ cursor: null }))!.cursor).toBeNull();
  });

  /** Half a readable selection is still a selection of those things. */
  it("keeps the readable ids out of a malformed selection", () => {
    const peer = readPeer(state({ selection: { items: ["i1", 4, null, "", "i2"] } }))!;
    expect(peer.items).toEqual(["i1", "i2"]);
    expect(peer.strings).toEqual([]);
  });
});

describe("Peers", () => {
  it("drops this client's own state", () => {
    peers.ignore(9);
    peers.observe(9, state());
    expect(peers.size).toBe(0);
    peers.observe(1, state());
    expect(peers.size).toBe(1);
  });

  it("forgets a peer whose state stopped being readable", () => {
    peers.observe(1, state());
    peers.observe(1, { user: null });
    expect(peers.size).toBe(0);
  });

  /**
   * The overlay redraws on this number, so an idle board with an idle peer must
   * not tick — a full-viewport canvas is cleared and restroked every time it does.
   */
  it("bumps its version on a change and only on a change", () => {
    peers.observe(1, state());
    const joined = peers.version;
    expect(joined).toBeGreaterThan(0);

    peers.observe(1, state());
    settle();
    expect(peers.version).toBe(joined);

    peers.observe(1, state({ selection: { items: ["i1"] } }));
    expect(peers.version).toBe(joined + 1);

    peers.forget(1);
    expect(peers.version).toBe(joined + 2);
    peers.forget(1);
    expect(peers.version).toBe(joined + 2);
  });

  /**
   * A cursor that appears has no previous position to travel from. Sprung from
   * the default it would fly in across the board on the frame somebody joins.
   */
  it("snaps a cursor into place the first time it sees one", () => {
    peers.observe(1, state({ cursor: { x: 4000, y: -2000 } }));
    expect(only().cursor).toEqual({ x: 4000, y: -2000 });
  });

  it("springs towards a moved cursor rather than stepping to it", () => {
    peers.observe(1, state({ cursor: { x: 0, y: 0 } }));
    peers.observe(1, state({ cursor: { x: 600, y: 0 } }));

    // One frame is a fraction of the way there, not all of it and not none.
    peers.step(16.7);
    const first = only().cursor!.x;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(600);

    // And it keeps going in the same direction, which a step would not.
    peers.step(16.7);
    expect(only().cursor!.x).toBeGreaterThan(first);

    settle();
    expect(only().cursor).toEqual({ x: 600, y: 0 });
  });

  /** Asymptotic motion never *equals* anything, so it is snapped and stopped. */
  it("settles, and then costs nothing", () => {
    peers.observe(1, state({ cursor: { x: 0, y: 0 } }));
    peers.observe(1, state({ cursor: { x: 600, y: 0 } }));
    settle();
    const rested = peers.version;
    settle();
    expect(peers.version).toBe(rested);
  });

  /** A peer who stopped pointing at anything stops being drawn at once. */
  it("clears a cursor the moment the pointer leaves their board", () => {
    peers.observe(1, state({ cursor: { x: 100, y: 50 } }));
    const before = peers.version;
    peers.observe(1, state({ cursor: null }));
    expect(only().cursor).toBeNull();
    expect(peers.version).toBe(before + 1);

    // And it comes back snapped, not sprung from where it left.
    peers.observe(1, state({ cursor: { x: -900, y: 0 } }));
    expect(only().cursor).toEqual({ x: -900, y: 0 });
  });

  it("knows whether the chrome pass has anything to do", () => {
    expect(peers.chromed).toBe(false);
    peers.observe(1, state());
    expect(peers.chromed).toBe(false);
    peers.observe(1, state({ selection: { pins: ["p1"] } }));
    expect(peers.chromed).toBe(true);
    peers.forget(1);
    expect(peers.chromed).toBe(false);
  });

  it("does not move anything on a zero-length frame", () => {
    peers.observe(1, state({ cursor: { x: 0, y: 0 } }));
    peers.observe(1, state({ cursor: { x: 600, y: 0 } }));
    peers.step(0);
    expect(only().cursor).toEqual({ x: 0, y: 0 });
  });
});

/**
 * The claimed segments — DATA-MODEL section 5.4, arriving from another machine
 * and therefore validated down to three ids like everything else here.
 */
describe("a peer's claimed segments", () => {
  const SEG = { string: "s1", a: "p1", b: "p2" };

  it("is empty for a peer that claims nothing, and for one that never mentions it", () => {
    expect(readPeer(state())!.locks).toEqual([]);
    expect(readPeer(state({ locks: { segments: [] } }))!.locks).toEqual([]);
  });

  it("reads the segments a peer is holding", () => {
    expect(readPeer(state({ locks: { segments: [SEG] } }))!.locks).toEqual([SEG]);
  });

  it("drops a malformed entry and keeps the rest — a hint is not worth a peer over", () => {
    const read = readPeer(
      state({
        locks: {
          segments: [{ string: "s1", a: "p1" }, null, "nonsense", { string: "", a: "p1", b: "p2" }, SEG],
        },
      }),
    );
    expect(read!.locks).toEqual([SEG]);
  });

  it("ignores a locks field that is not the shape section 9 names", () => {
    expect(readPeer(state({ locks: "held" }))!.locks).toEqual([]);
    expect(readPeer(state({ locks: { segments: "s1" } }))!.locks).toEqual([]);
    expect(readPeer(state({ locks: null }))!.locks).toEqual([]);
  });

  /** The overlay redraws on this number, so taking or dropping a claim has to
   *  move it — and holding one still must not. */
  it("bumps the version when a claim is taken and again when it goes", () => {
    peers.observe(1, state({ locks: { segments: [] } }));
    const idle = peers.version;

    peers.observe(1, state({ locks: { segments: [SEG] } }));
    expect(peers.version).toBeGreaterThan(idle);
    const held = peers.version;

    peers.observe(1, state({ locks: { segments: [SEG] } }));
    expect(peers.version).toBe(held);

    peers.observe(1, state({ locks: { segments: [] } }));
    expect(peers.version).toBeGreaterThan(held);
  });
});

/**
 * A held segment is chrome, and it hangs off a rope that sags and settles — so
 * a board whose only peer activity is somebody holding a gap must still report
 * a canvas the overlay will restroke as the rope moves.
 */
describe("a claimed segment counts as chrome", () => {
  it("is chromed while a segment is held, and not once it is let go", () => {
    peers.observe(1, state());
    expect(peers.chromed).toBe(false);

    peers.observe(1, state({ locks: { segments: [{ string: "s1", a: "p1", b: "p2" }] } }));
    expect(peers.chromed).toBe(true);

    peers.observe(1, state({ locks: { segments: [] } }));
    expect(peers.chromed).toBe(false);
  });
});

/**
 * The wet-ink field, at the store's level. What the splice itself does is
 * `wetpeer.test.ts`'s subject; what is here is the part only `Peers` can get
 * wrong — whether the accumulator survives a message, and whether a stroke
 * moving is a reason to redraw.
 */
describe("a peer's wet ink", () => {
  function run(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "run-1",
      item: null,
      tool: "marker",
      color: "#1f1b17",
      size: 6,
      opacity: 1,
      base: 0,
      pts: [0, 0, 128, 80, 0, 128],
      ...over,
    };
  }

  it("says nothing is inked until somebody draws", () => {
    peers.observe(9, state());
    expect(peers.inked).toBe(false);
  });

  it("accumulates across messages rather than being replaced by each one", () => {
    peers.observe(9, state({ wet: [run()] }));
    // The second window overlaps the first by a point, which is what a sliding
    // window does — and the receiver has to end up with three points, not two
    // and not five.
    peers.observe(9, state({ wet: [run({ base: 1, pts: [80, 0, 128, 160, 0, 128] })] }));

    const [peer] = [...peers.peers()];
    const [stroke] = [...peer!.ink.drawable()];
    expect(stroke!.samples.map((sample) => sample.x)).toEqual([0, 10, 20]);
    expect(peers.inked).toBe(true);
  });

  it("bumps its version when the ink moved, and only then", () => {
    peers.observe(9, state({ wet: [run()] }));
    const after = peers.version;

    // The same window again. Awareness republishes on its own clock, and this
    // is what stops a peer holding a pen still restroking the viewport.
    peers.observe(9, state({ wet: [run()] }));
    expect(peers.version).toBe(after);

    peers.observe(9, state({ wet: [run({ pts: [0, 0, 128, 96, 0, 128] })] }));
    expect(peers.version).toBe(after + 1);
  });

  it("takes the ink with the peer when they leave", () => {
    peers.observe(9, state({ wet: [run()] }));
    expect(peers.inked).toBe(true);

    peers.forget(9);
    expect(peers.inked).toBe(false);
    expect([...peers.peers()]).toHaveLength(0);
  });

  it("takes it with them when their state stops being readable", () => {
    peers.observe(9, state({ wet: [run()] }));
    // No user, so there is nobody to attribute a mark to. `observe` forgets the
    // peer, and the accumulator is part of the peer.
    peers.observe(9, { cursor: { x: 1, y: 1 } });
    expect(peers.inked).toBe(false);
  });

  it("does not draw one peer's ink for another", () => {
    peers.observe(9, state({ wet: [run()] }));
    peers.observe(10, state({ user: { id: "8", name: "Green", color: "#4a8a4f" } }));

    const drawn = [...peers.peers()].map((peer) => [...peer.ink.drawable()].length);
    expect(drawn.sort()).toEqual([0, 1]);
  });

  it("bumps its version the frame a ghost is handed over, and only then", () => {
    peers.observe(9, state({ wet: [run()] }));
    const up = peers.version;

    // Every frame the record is not here yet. The handoff is asked once a frame
    // on a board where somebody is drawing, so a version bump per frame would
    // restroke a full-viewport canvas sixty times a second for nothing.
    peers.retire(16, () => false);
    peers.retire(16, () => false);
    expect(peers.version).toBe(up);

    peers.retire(16, (id) => id === "run-1");
    // Without this the mark stays on the canvas until something else happens to
    // move — the store owns the version, and nothing else knows a ghost went.
    expect(peers.version).toBe(up + 1);
    expect(peers.inked).toBe(false);
  });

  it("hands over every peer's ink, not just the first one holding some", () => {
    peers.observe(9, state({ wet: [run({ id: "mine" })] }));
    peers.observe(10, state({ user: { id: "8", name: "Green", color: "#4a8a4f" }, wet: [run({ id: "theirs" })] }));
    expect(peers.inked).toBe(true);

    // Both, in one pass. A walk that stopped at the first peer that changed
    // would leave the second person's mark up for as long as they stayed quiet.
    peers.retire(16, () => true);
    expect(peers.inked).toBe(false);
    expect([...peers.peers()].every((peer) => [...peer.ink.ids()].length === 0)).toBe(true);
  });
});
