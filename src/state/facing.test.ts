/**
 * Which face a thing is showing, and what follows — T-330.
 *
 * The three functions here are what four layers ask instead of each writing out
 * "is this pin's page the page on show", and `dirtyFacing` is the one piece of
 * the feature that no layer's own tests can reach: it is what supplies the
 * document edit that a page turn is not.
 *
 * The middle state is the whole request. Hiding a tape on another page is the
 * cheap reading and it is wrong — the thread still has to get out of the folder
 * and across to the card, and what it does is go under the sheet you are
 * looking at.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { DirtySets } from "@/state/dirty";
import { dirtyFacing, tucked, tuckedGap } from "@/state/facing";
import { Scene, type PinNode } from "@/state/scene";

let scene: Scene;
let dirty: DirtySets;

function put(id: string, parent: string | null, page: number | null): PinNode {
  const pin: PinNode = {
    id,
    parent,
    lx: 0,
    ly: 0,
    kind: page === null ? "pushpin" : "tape",
    color: "#c8352f",
    page,
    wx: 0,
    wy: 0,
  };
  scene.putPin(pin);
  return pin;
}

beforeEach(() => {
  scene = new Scene();
  dirty = new DirtySets();
});

describe("whether a pin is on the face on show", () => {
  it("is on show when the item is open at its page", () => {
    expect(tucked(put("t", "folder", 4), () => 4)).toBe(false);
  });

  it("is put away when the reader has turned past it", () => {
    expect(tucked(put("t", "folder", 4), () => 12)).toBe(true);
  });

  /** Q-291's collapse: a shut folder shows no page, so no page it holds is the
   *  page on show, and "shut" needs no case of its own. */
  it("is put away when nothing is open, by the same sentence", () => {
    expect(tucked(put("t", "folder", 4), () => null)).toBe(true);
  });

  /** Every pin on every board that has never quoted a case file. */
  it("says nothing about a pin that is not on a page", () => {
    expect(tucked(put("p", "photo", null), () => 4)).toBe(false);
    expect(tucked(put("q", null, null), () => 4)).toBe(false);
  });

  /**
   * A page that reached a free pin anyway — the cork has no document, and a
   * resolver keyed on item ids has nothing to be asked about `null`.
   */
  it("says nothing about a page on a pin free in the cork", () => {
    expect(tucked(put("t", null, 4), () => 4)).toBe(false);
  });

  /** A shell with no reader in it: an export rig, a test, a read-only boot.
   *  Nothing is open there, so nothing it holds is on show. */
  it("treats no resolver at all as nothing being open", () => {
    expect(tucked(put("t", "folder", 4), null)).toBe(true);
  });
});

describe("whether a gap of a run goes behind the paper", () => {
  it("does when either end reaches a put-away tape", () => {
    put("t", "folder", 4);
    put("far", null, null);
    expect(tuckedGap(scene, () => null, "t", "far")).toBe(true);
    expect(tuckedGap(scene, () => null, "far", "t")).toBe(true);
  });

  it("does not when the tape is on the page on show", () => {
    put("t", "folder", 4);
    put("far", null, null);
    expect(tuckedGap(scene, () => 4, "t", "far")).toBe(false);
  });

  it("does not for a gap between two ordinary pins", () => {
    put("t", "folder", 4);
    put("a", null, null);
    put("b", null, null);
    expect(tuckedGap(scene, () => null, "a", "b")).toBe(false);
  });

  /** A pin a peer deleted between the frame starting and this being asked. */
  it("does not for an end that is not on the board", () => {
    put("t", "folder", 4);
    expect(tuckedGap(scene, () => null, "gone", "alsogone")).toBe(false);
  });
});

describe("the index that keeps all of it free", () => {
  it("is empty on a board with no tape stuck to a page", () => {
    put("a", "photo", null);
    put("b", null, null);
    expect(scene.pagedPins.size).toBe(0);
  });

  it("holds the tapes and lets them go again", () => {
    put("t", "folder", 4);
    expect([...scene.pagedPins]).toEqual(["t"]);
    // Re-read from the document with no page — a peer cleared it, or the pin
    // was re-homed into the cork.
    put("t", null, null);
    expect(scene.pagedPins.size).toBe(0);
  });

  it("drops a tape that is deleted", () => {
    put("t", "folder", 4);
    scene.removePin("t");
    expect(scene.pagedPins.size).toBe(0);
  });
});

describe("what a page turn has to mark dirty", () => {
  /** A folder with a tape on page four, a card, and the thread between them. */
  function threaded(): void {
    put("tape", "folder", 4);
    put("card", "card-item", null);
    scene.putString({
      id: "s",
      nodes: [
        { nodeId: "n0", pin: "tape", slackAfter: 0.2 },
        { nodeId: "n1", pin: "card", slackAfter: 0.2 },
      ],
      color: "#a8322c",
      thickness: 3,
      material: "string",
      layer: "over",
      closed: false,
    });
  }

  /**
   * The whole reason this function exists. Turning a page writes nothing to the
   * document, so without it the pin layer returns on `dirty.isClean` and the
   * rope painter returns on the frame before it looks at a string — and the
   * thread stays on whichever canvas it was on, for as long as the board is
   * still.
   */
  it("marks the tape and its thread when the reader turns", () => {
    threaded();
    dirtyFacing(scene, dirty, "folder", "folder");
    expect(dirty.pins.has("tape")).toBe(true);
    expect(dirty.strings.has("s")).toBe(true);
  });

  /**
   * Shutting is the transition that would go unnoticed if only the new face
   * were asked about: by then the item is no longer the one the resolver answers
   * for, so `now` is null and there is nothing on it to dirty.
   */
  it("marks the face being left, not only the one arrived at", () => {
    threaded();
    dirtyFacing(scene, dirty, "folder", null);
    expect(dirty.pins.has("tape")).toBe(true);
    expect(dirty.strings.has("s")).toBe(true);
  });

  it("marks the face arrived at, for a folder opened at a page it has tape on", () => {
    threaded();
    dirtyFacing(scene, dirty, null, "folder");
    expect(dirty.pins.has("tape")).toBe(true);
  });

  it("leaves an ordinary pin on the same folder alone", () => {
    threaded();
    put("pushpin", "folder", null);
    dirtyFacing(scene, dirty, "folder", null);
    expect(dirty.pins.has("pushpin")).toBe(false);
  });

  /** Every folder anybody opens without quoting from it lands here. */
  it("does nothing at all on a board with no tape stuck to a page", () => {
    put("pushpin", "folder", null);
    dirtyFacing(scene, dirty, "folder", null);
    expect(dirty.isClean).toBe(true);
  });
});
