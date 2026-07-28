/**
 * What goes on the wire about this client, and how often.
 *
 * Two questions, and the second one is AC-83: nothing durable ever goes on
 * awareness. That is a claim about the *shape* of what is published, so the
 * tests here read the payload rather than trusting the setters.
 */

import { describe, expect, it } from "vitest";

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

function setUp(options?: { everyNthFrame?: number }) {
  const channel = new Channel();
  const camera = new Camera();
  const selection = new Selection();
  const presence = new Presence(channel, camera, selection, PHIL, options);
  return { channel, camera, selection, presence };
}

describe("how often it speaks", () => {
  it("publishes on every other frame, not every frame", () => {
    const { channel, camera, presence } = setUp();

    for (let frame = 0; frame < 6; frame += 1) {
      camera.panByScreen(10, 0);
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
    const { channel, camera, presence } = setUp({ everyNthFrame: 6 });

    for (let frame = 0; frame < 12; frame += 1) {
      camera.panByScreen(10, 0);
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
    expect(Object.keys(channel.last).sort()).toEqual(["cam", "cursor", "selection", "user"]);
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

  it("carries the camera, rounded, so a seeding peer knows what to send next", () => {
    const { channel, camera, presence } = setUp();
    camera.resize(800, 600);
    camera.zoomTo(1.23456789, 400, 300);
    camera.panByScreen(-100.7, -50.3);

    presence.flush(0);

    const cam = channel.last.cam;
    // Three decimals on a multiplier, whole units on a position. The tail of
    // `-1234.5678901234` is bytes spent thirty times a second, on every peer,
    // to place a marker inside the width of its own outline.
    expect(cam?.zoom).toBe(1.235);
    expect(Number.isInteger(cam?.x)).toBe(true);
    expect(Number.isInteger(cam?.y)).toBe(true);
    expect(Math.abs((cam?.x ?? 0) - camera.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs((cam?.y ?? 0) - camera.y)).toBeLessThanOrEqual(0.5);
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
