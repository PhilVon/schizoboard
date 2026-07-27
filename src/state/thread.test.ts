/**
 * The connected-component walk, with no tool, no document and no renderer.
 *
 * Every test here is a shape of board and the question "what is one piece of
 * this investigation" — which is the only question the gesture asks, and the
 * one place it can be answered without a pointer.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { Scene, type ItemPose, type StringNodes } from "@/state/scene";
import { threadFrom } from "@/state/thread";

let scene: Scene;

function item(id: string, pose: Partial<ItemPose> = {}): void {
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
    { x: 0, y: 0, rot: 0, w: 100, h: 100, ...pose },
  );
}

function pin(id: string, parent: string | null = null): void {
  scene.putPin({ id, parent, lx: 0, ly: 0, kind: "pushpin", color: "#c8352f", wx: 0, wy: 0 });
}

function string(id: string, ...pins: string[]): void {
  const run: StringNodes = {
    id,
    nodes: pins.map((p, i) => ({ nodeId: `${id}-n${i}`, pin: p, slackAfter: 0.2 })),
    color: "#a8322c",
    thickness: 3,
    material: "string",
    layer: "over",
    closed: false,
  };
  scene.putString(run);
}

/** Sorted, because a breadth-first walk's order is an implementation detail and
 *  nothing downstream depends on it — the selection is a set. */
function thread(from: string): { items: string[]; strings: string[]; pins: string[] } {
  const t = threadFrom(scene, from);
  return {
    items: [...t.items].sort(),
    strings: [...t.strings].sort(),
    pins: [...t.pins].sort(),
  };
}

beforeEach(() => {
  scene = new Scene();
});

describe("threadFrom", () => {
  it("gives back a lone pin and nothing else", () => {
    pin("p");
    expect(thread("p")).toEqual({ items: [], strings: [], pins: ["p"] });
  });

  it("hands back nothing at all for a pin that is not there", () => {
    expect(thread("ghost")).toEqual({ items: [], strings: [], pins: [] });
  });

  it("walks a string to its far pin", () => {
    pin("a");
    pin("b");
    string("s", "a", "b");
    expect(thread("a")).toEqual({ items: [], strings: ["s"], pins: ["a", "b"] });
    // And the same answer from the other end, which is what "component" means.
    expect(thread("b")).toEqual({ items: [], strings: ["s"], pins: ["a", "b"] });
  });

  it("walks the whole of a multi-pin run from any node of it", () => {
    for (const id of ["a", "b", "c", "d"]) pin(id);
    string("s", "a", "b", "c", "d");
    expect(thread("c")).toEqual({
      items: [],
      strings: ["s"],
      pins: ["a", "b", "c", "d"],
    });
  });

  it("reaches the photograph a pin is pushed into", () => {
    item("photo");
    pin("p", "photo");
    expect(thread("p")).toEqual({ items: ["photo"], strings: [], pins: ["p"] });
  });

  /**
   * The rule that keeps a thread from falling apart when it is dragged: a
   * photograph is one piece of evidence, so reaching it reaches its other pins
   * and anything hanging off them. Stop at the item and the photograph comes
   * while the pin on its far side stays, taking its string with it.
   */
  it("goes on through an item to the other pins holding it, and their strings", () => {
    item("photo");
    pin("near", "photo");
    pin("far", "photo");
    pin("out");
    string("s", "far", "out");

    expect(thread("near")).toEqual({
      items: ["photo"],
      strings: ["s"],
      pins: ["far", "near", "out"],
    });
  });

  /** A hub pin: every string through it is in the same component, which is the
   *  case the whole gesture is for. */
  it("takes every string of a hub pin", () => {
    pin("hub");
    for (let i = 0; i < 4; i++) {
      pin(`end${i}`);
      string(`s${i}`, "hub", `end${i}`);
    }
    const t = thread("hub");
    expect(t.strings).toEqual(["s0", "s1", "s2", "s3"]);
    expect(t.pins).toEqual(["end0", "end1", "end2", "end3", "hub"]);
  });

  it("stops at the edge of the component", () => {
    pin("a");
    pin("b");
    string("s", "a", "b");
    // A second, unrelated thread on the same board.
    pin("x");
    pin("y");
    string("t", "x", "y");

    expect(thread("a")).toEqual({ items: [], strings: ["s"], pins: ["a", "b"] });
  });

  /** Two photographs joined by a string are one thread; that is the entire
   *  point of the board. */
  it("joins two photographs through the string between them", () => {
    item("one");
    item("two");
    pin("p", "one");
    pin("q", "two");
    string("s", "p", "q");

    expect(thread("p")).toEqual({
      items: ["one", "two"],
      strings: ["s"],
      pins: ["p", "q"],
    });
  });

  /** A loop closed back through where it started, and a run that visits a pin
   *  twice. Neither may spin. */
  it("terminates on a cycle", () => {
    pin("a");
    pin("b");
    pin("c");
    string("s", "a", "b", "c", "a");
    string("t", "c", "a");
    expect(thread("b")).toEqual({
      items: [],
      strings: ["s", "t"],
      pins: ["a", "b", "c"],
    });
  });

  /** Pins outlive items (DESIGN section 3.8), so a pin left naming a deleted
   *  photograph is free-floating rather than broken — and the walk must not put
   *  a deleted item into a selection that is about to be dragged. */
  it("does not follow a pin's parent to an item that has gone", () => {
    item("photo");
    pin("p", "photo");
    scene.removeItem("photo");
    expect(thread("p")).toEqual({ items: [], strings: [], pins: ["p"] });
  });

  /** A run naming a pin that has gone is drawn as a gap rather than as an
   *  error; the selection must not hold the ghost either. */
  it("does not collect a pin a run still names but the board has lost", () => {
    pin("a");
    pin("b");
    string("s", "a", "gone", "b");
    expect(thread("a")).toEqual({ items: [], strings: ["s"], pins: ["a", "b"] });
  });

  /**
   * The shape that decides whether this is a walk or an accident: a chain long
   * enough that a one-hop or two-hop implementation would look right on every
   * test above and be wrong here.
   */
  it("follows a chain of photographs the whole way along", () => {
    for (let i = 0; i < 6; i++) {
      item(`i${i}`);
      pin(`left${i}`, `i${i}`);
      pin(`right${i}`, `i${i}`);
    }
    for (let i = 0; i < 5; i++) string(`s${i}`, `right${i}`, `left${i + 1}`);

    const t = thread("left0");
    expect(t.items).toEqual(["i0", "i1", "i2", "i3", "i4", "i5"]);
    expect(t.strings).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    expect(t.pins.length).toBe(12);
  });
});
