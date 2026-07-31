/**
 * Unit tests for the board search — T-85, DESIGN section 3.7.
 *
 * Two properties carry the feature and neither is "it finds things".
 *
 * The first is that refining a query does **not** move you: type three more
 * characters at a match you are reading and the camera has to stay where it is.
 * That is what `run` returning null means, and it is the difference between a
 * search field you can think in and one that throws the board around under you.
 *
 * The second is that the order is a *fact about the board* rather than about the
 * camera, so the same search always steps through the same items in the same
 * sequence.
 */

import { describe, expect, it } from "vitest";

import { Scene, type ItemColdInput, type ItemPose } from "@/state/scene";
import { Search } from "@/state/search";

function add(scene: Scene, id: string, text: string, pose: Partial<ItemPose> = {}): void {
  const cold: ItemColdInput = {
    id,
    type: "note",
    z: "a0",
    seed: 1,
    assetId: null,
    createdBy: 1,
    createdAt: 0,
    text,
  };
  scene.putItem(cold, { x: 0, y: 0, rot: 0, w: 100, h: 100, ...pose });
}

describe("Search", () => {
  it("finds the items whose text contains the query, and no others", () => {
    const scene = new Scene();
    add(scene, "a", "buy milk", { x: 0, y: 0 });
    add(scene, "b", "MILKSHAKE", { x: 0, y: 200 });
    add(scene, "c", "call the plumber", { x: 0, y: 400 });

    const search = new Search();
    expect(search.run(scene, "milk")).toBe("a");
    expect(search.count).toBe(2);
  });

  it("is case-insensitive in both directions", () => {
    const scene = new Scene();
    add(scene, "a", "Deadline Friday");

    const search = new Search();
    expect(search.run(scene, "DEADLINE")).toBe("a");
    search.clear();
    expect(search.run(scene, "friday")).toBe("a");
  });

  it("matches a polaroid's caption the same as a note's body — it is one field", () => {
    const scene = new Scene();
    add(scene, "note", "the harbour at dawn", { y: 0 });
    const cold: ItemColdInput = {
      id: "photo",
      type: "polaroid",
      z: "a1",
      seed: 2,
      assetId: "sha",
      createdBy: 1,
      createdAt: 0,
      text: "harbour, 1998",
    };
    scene.putItem(cold, { x: 0, y: 300, rot: 0, w: 100, h: 100 });

    const search = new Search();
    search.run(scene, "harbour");
    expect(search.count).toBe(2);
  });

  it("finds nothing for an empty query, and nothing for one that is only spaces", () => {
    const scene = new Scene();
    add(scene, "a", "a note with spaces in it");

    const search = new Search();
    expect(search.run(scene, "")).toBe(null);
    expect(search.count).toBe(0);
    expect(search.run(scene, "   ")).toBe(null);
    expect(search.count).toBe(0);
  });

  it("finds nothing again when the field is cleared back to empty", () => {
    const scene = new Scene();
    add(scene, "a", "a note with spaces in it", { y: 0 });
    add(scene, "b", "another note", { y: 400 });

    // The assertion above never reaches the empty-query branch: a fresh Search
    // has no query, so an empty one is the query it already has and it returns
    // early. This is the path that gets there — the field being emptied — and
    // without it, "" matching every item on the board is uncovered. An empty
    // needle is a substring of every string, so the guard is the only thing
    // between clearing the field and every note on the board being a match.
    const search = new Search();
    expect(search.run(scene, "note")).toBe("a");
    expect(search.count).toBe(2);

    expect(search.run(scene, "")).toBe(null);
    expect(search.count).toBe(0);
    expect(search.current).toBe(null);
  });

  it("skips items with no text at all rather than treating them as matching", () => {
    const scene = new Scene();
    add(scene, "blank", "");
    add(scene, "written", "x");

    const search = new Search();
    search.run(scene, "x");
    expect(search.count).toBe(1);
    expect(search.current).toBe("written");
  });

  // --- the order -----------------------------------------------------------

  it("orders matches top to bottom, then left to right", () => {
    const scene = new Scene();
    // Deliberately inserted bottom-up, so insertion order cannot be what passes.
    add(scene, "low", "hit", { x: 0, y: 900 });
    add(scene, "high-right", "hit", { x: 500, y: 100 });
    add(scene, "high-left", "hit", { x: 0, y: 100 });

    const search = new Search();
    expect(search.run(scene, "hit")).toBe("high-left");
    expect(search.step(1)).toBe("high-right");
    expect(search.step(1)).toBe("low");
  });

  it("orders by the rotation-expanded box, so a tilted sheet sorts where it looks", () => {
    const scene = new Scene();
    // Same centre height, but one is turned 45 degrees, so its box reaches
    // higher up the board than the square one's does.
    add(scene, "flat", "hit", { x: 0, y: 500, w: 200, h: 40, rot: 0 });
    add(scene, "tilted", "hit", { x: 400, y: 500, w: 200, h: 40, rot: Math.PI / 4 });

    const search = new Search();
    expect(search.run(scene, "hit")).toBe("tilted");
  });

  it("gives the same order whatever the camera is looking at — the order is the board's", () => {
    const scene = new Scene();
    add(scene, "a", "hit", { x: 0, y: 0 });
    add(scene, "b", "hit", { x: 0, y: 500 });

    // Two searches, no camera involved at all: this is the assertion that the
    // ordering takes no view into account and so cannot depend on one.
    const first = new Search();
    first.run(scene, "hit");
    const second = new Search();
    second.run(scene, "hit");
    expect(first.current).toBe(second.current);
    expect(first.step(1)).toBe(second.step(1));
  });

  // --- refining --------------------------------------------------------------

  it("stays on the match you are reading while the query still matches it", () => {
    const scene = new Scene();
    add(scene, "first", "shard", { y: 0 });
    add(scene, "second", "shape of things", { y: 500 });

    const search = new Search();
    expect(search.run(scene, "sha")).toBe("first");
    search.step(1);
    expect(search.current).toBe("second");

    // Narrowing to something the *second* one still matches must not throw the
    // camera back to the first.
    expect(search.run(scene, "shap")).toBe(null);
    expect(search.current).toBe("second");
    expect(search.count).toBe(1);
  });

  it("moves when the match you were reading stops matching", () => {
    const scene = new Scene();
    add(scene, "first", "shard", { y: 0 });
    add(scene, "second", "shape", { y: 500 });

    const search = new Search();
    search.run(scene, "sha");
    search.step(1);
    expect(search.current).toBe("second");
    expect(search.run(scene, "shar")).toBe("first");
  });

  it("re-answers with the same match when forced, so Ctrl+F on an open field says 'that one'", () => {
    const scene = new Scene();
    add(scene, "a", "hit");

    const search = new Search();
    expect(search.run(scene, "hit")).toBe("a");
    expect(search.run(scene, "hit")).toBe(null);
    expect(search.run(scene, "hit", true)).toBe("a");
  });

  it("re-walks a board that changed under it when forced", () => {
    const scene = new Scene();
    add(scene, "a", "hit");

    const search = new Search();
    search.run(scene, "hit");
    expect(search.count).toBe(1);

    add(scene, "b", "hit", { y: 500 });
    // The query has not changed, so without the force this walks nothing.
    expect(search.run(scene, "hit")).toBe(null);
    expect(search.count).toBe(1);
    search.run(scene, "hit", true);
    expect(search.count).toBe(2);
  });

  // --- stepping ---------------------------------------------------------------

  it("wraps forward past the last match and backward past the first", () => {
    const scene = new Scene();
    add(scene, "a", "hit", { y: 0 });
    add(scene, "b", "hit", { y: 200 });
    add(scene, "c", "hit", { y: 400 });

    const search = new Search();
    search.run(scene, "hit");
    expect(search.ordinal).toBe(1);
    expect(search.step(1)).toBe("b");
    expect(search.step(1)).toBe("c");
    expect(search.step(1)).toBe("a");
    expect(search.ordinal).toBe(1);
    expect(search.step(-1)).toBe("c");
    expect(search.step(-1)).toBe("b");
  });

  it("steps a single match to itself rather than refusing, so the flash still says 'still this one'", () => {
    const scene = new Scene();
    add(scene, "a", "hit");

    const search = new Search();
    search.run(scene, "hit");
    expect(search.step(1)).toBe("a");
    expect(search.step(-1)).toBe("a");
  });

  it("steps nothing when nothing matched", () => {
    const scene = new Scene();
    add(scene, "a", "hit");

    const search = new Search();
    search.run(scene, "nothing here");
    expect(search.step(1)).toBe(null);
    expect(search.step(-1)).toBe(null);
    expect(search.ordinal).toBe(0);
    expect(search.current).toBe(null);
  });

  it("counts from one, for a readout that says '2 of 5'", () => {
    const scene = new Scene();
    add(scene, "a", "hit", { y: 0 });
    add(scene, "b", "hit", { y: 200 });

    const search = new Search();
    expect(search.ordinal).toBe(0);
    search.run(scene, "hit");
    expect(search.ordinal).toBe(1);
    search.step(1);
    expect(search.ordinal).toBe(2);
    expect(search.count).toBe(2);
  });

  it("forgets everything on clear, because the ids stop meaning anything", () => {
    const scene = new Scene();
    add(scene, "a", "hit");

    const search = new Search();
    search.run(scene, "hit");
    search.clear();
    expect(search.count).toBe(0);
    expect(search.current).toBe(null);
    expect(search.ordinal).toBe(0);
    // And the query is forgotten too, or re-typing the same thing would walk
    // nothing and answer null for a board it has never looked at.
    expect(search.run(scene, "hit")).toBe("a");
  });
});

/**
 * What the overlay draws its faint borders from — T-236, Q-176.
 *
 * The list has been here since T-85 (stepping through matches needs it); what
 * is new is that something outside now *reads* it every frame, so the answer's
 * identity has to be as cheap to ask about as its contents are to draw.
 */
describe("the matches, for the painter", () => {
  const board = (): Scene => {
    const scene = new Scene();
    add(scene, "a", "buy milk", { x: 0, y: 0 });
    add(scene, "b", "milkshake", { x: 0, y: 200 });
    add(scene, "c", "call the plumber", { x: 0, y: 400 });
    return scene;
  };

  it("hands over every match in reading order, current one included", () => {
    const scene = board();
    const search = new Search();
    search.run(scene, "milk");
    expect([...search.ids]).toEqual(["a", "b"]);
    // Not "the others": the flash lasts 800ms and the search does not, so the
    // item you are looking at must not be the only unmarked match on the board.
    expect(search.ids).toContain(search.current);
  });

  it("bumps its version when the answer changes and not when it does not", () => {
    const scene = board();
    const search = new Search();

    const fresh = search.version;
    search.run(scene, "milk");
    const two = search.version;
    expect(two).toBeGreaterThan(fresh);

    // Refining to a query with the same answer is the same picture. Borders
    // restroked on every keystroke of a word that narrows nothing is the cost
    // this version exists to avoid.
    search.run(scene, "mil");
    expect(search.version).toBe(two);

    search.run(scene, "milks");
    expect(search.version).toBeGreaterThan(two);
  });

  it("bumps it on the way down, so the borders come off", () => {
    const scene = board();
    const search = new Search();
    search.run(scene, "milk");
    const held = search.version;

    search.clear();
    expect([...search.ids]).toEqual([]);
    expect(search.version).toBeGreaterThan(held);

    // And not again on a second clear: an empty search that stays empty is the
    // same picture, and the overlay would restroke for it every frame.
    const empty = search.version;
    search.clear();
    expect(search.version).toBe(empty);
  });

  /**
   * The one case where membership is unchanged and the answer is not. Reading
   * order is a fact about where things are, so moving one match above another
   * reorders the list — and the `n of m` in the field is an index into it.
   */
  it("counts a reorder as a change", () => {
    const scene = board();
    const search = new Search();
    search.run(scene, "milk");
    const before = search.version;

    scene.setPose("b", { x: 0, y: -400, rot: 0, w: 100, h: 100 });
    search.run(scene, "milk", true);

    expect([...search.ids]).toEqual(["b", "a"]);
    expect(search.version).toBeGreaterThan(before);
  });
});
