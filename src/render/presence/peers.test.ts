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
