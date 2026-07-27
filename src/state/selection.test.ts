import { beforeEach, describe, expect, it } from "vitest";

import { Selection } from "@/state/selection";

let selection: Selection;

beforeEach(() => {
  selection = new Selection();
});

describe("Selection", () => {
  it("adds, removes and toggles", () => {
    selection.add("a");
    selection.add("b");
    expect(selection.toArray().sort()).toEqual(["a", "b"]);

    selection.toggle("a");
    expect(selection.has("a")).toBe(false);
    selection.toggle("a");
    expect(selection.has("a")).toBe(true);

    selection.clear();
    expect(selection.isEmpty).toBe(true);
  });

  it("bumps the version only when the membership actually changes", () => {
    const start = selection.version;
    selection.add("a");
    expect(selection.version).toBe(start + 1);

    // The renderer walks every mounted node on a version change, so a repeated
    // click on the same item must not be a change.
    selection.add("a");
    selection.replace(["a"]);
    selection.remove("b");
    expect(selection.version).toBe(start + 1);

    selection.replace(["a", "b"]);
    expect(selection.version).toBe(start + 2);
  });

  it("sees a same-size set with different members as a change", () => {
    selection.replace(["a", "b"]);
    const version = selection.version;
    selection.replace(["a", "c"]);
    expect(selection.version).toBe(version + 1);
    expect(selection.toArray().sort()).toEqual(["a", "c"]);
  });

  it("survives being replaced with its own live member set", () => {
    selection.replace(["a", "b"]);
    selection.replace(selection.members);
    expect(selection.toArray().sort()).toEqual(["a", "b"]);
  });

  it("prunes ids that are no longer on the board", () => {
    selection.replace(["a", "b", "c"]);
    const version = selection.version;
    selection.prune((id) => id !== "b");
    expect(selection.toArray().sort()).toEqual(["a", "c"]);
    expect(selection.version).toBe(version + 1);
  });
});

/**
 * Strings are selectable too (DESIGN section 3.4), and they are kept in their
 * own set — the item questions must never answer about one, or `Delete` hands a
 * string id to the item delete and the overlay looks up a slot that is not
 * there.
 */
describe("Selection, strings", () => {
  it("holds a string without it becoming an item", () => {
    selection.replaceStrings(["s"]);
    expect([...selection.strings]).toEqual(["s"]);
    expect(selection.hasString("s")).toBe(true);

    expect(selection.has("s")).toBe(false);
    expect(selection.isEmpty).toBe(true);
    expect(selection.size).toBe(0);
    expect(selection.toArray()).toEqual([]);
  });

  it("is one selection, not two: each kind replaces the other", () => {
    selection.replace(["a"]);
    selection.replaceStrings(["s"]);
    expect(selection.toArray()).toEqual([]);
    expect([...selection.strings]).toEqual(["s"]);

    selection.replace(["a"]);
    expect(selection.strings.size).toBe(0);
    expect(selection.toArray()).toEqual(["a"]);
  });

  it("bumps the version when a string arrives, goes, or is displaced", () => {
    const start = selection.version;
    selection.replaceStrings(["s"]);
    expect(selection.version).toBe(start + 1);

    // Re-clicking the same string is not a change.
    selection.replaceStrings(["s"]);
    expect(selection.version).toBe(start + 1);

    // ...but clearing the items out from under it is, even though the strings
    // are the same, or the halo outlives the outline it replaced.
    selection.replace([]);
    expect(selection.version).toBe(start + 2);
    expect(selection.strings.size).toBe(0);
  });

  it("clears both kinds", () => {
    selection.replaceStrings(["s"]);
    selection.clear();
    expect(selection.strings.size).toBe(0);
    expect(selection.isEmpty).toBe(true);
  });

  it("prunes a string by its own predicate, never by the item one", () => {
    selection.replaceStrings(["s", "t"]);
    const version = selection.version;

    // The item predicate says no to both, and must not touch either.
    selection.prune(() => false);
    expect([...selection.strings].sort()).toEqual(["s", "t"]);
    expect(selection.version).toBe(version);

    selection.prune(
      () => false,
      (id) => id !== "t",
    );
    expect([...selection.strings]).toEqual(["s"]);
    expect(selection.version).toBe(version + 1);
  });
});

/**
 * Pins, which arrive only as part of a thread.
 *
 * > Double-click | Selects the entire connected component of pins, strings and
 * > items — DESIGN section 3.3
 *
 * So the interesting behaviour is not any single-kind method; it is that a
 * selection can be all three kinds at once, that one gesture producing it is
 * one version bump, and that every other gesture still wipes it whole.
 */
describe("Selection, pins and threads", () => {
  let selection: Selection;

  beforeEach(() => {
    selection = new Selection();
  });

  it("holds a pin without it becoming an item or a string", () => {
    selection.replaceThread([], [], ["p"]);
    expect([...selection.pins]).toEqual(["p"]);
    expect(selection.hasPin("p")).toBe(true);
    expect(selection.has("p")).toBe(false);
    expect(selection.hasString("p")).toBe(false);
    // Items only, which is what every item verb asks and must keep asking.
    expect(selection.isEmpty).toBe(true);
    expect(selection.isBare).toBe(false);
  });

  it("takes all three kinds in one gesture and one version bump", () => {
    const start = selection.version;
    selection.replaceThread(["a", "b"], ["s"], ["p", "q"]);
    expect(selection.version).toBe(start + 1);
    expect([...selection.members].sort()).toEqual(["a", "b"]);
    expect([...selection.strings]).toEqual(["s"]);
    expect([...selection.pins].sort()).toEqual(["p", "q"]);
  });

  /** Double-clicking the same pin twice is the same statement twice, and the
   *  overlay must not restroke for it. */
  it("is silent when the thread is the one already held", () => {
    selection.replaceThread(["a"], ["s"], ["p"]);
    const version = selection.version;
    selection.replaceThread(["a"], ["s"], ["p"]);
    expect(selection.version).toBe(version);
  });

  it("notices a thread that differs only in its pins", () => {
    selection.replaceThread(["a"], ["s"], ["p"]);
    const version = selection.version;
    selection.replaceThread(["a"], ["s"], ["q"]);
    expect(selection.version).toBe(version + 1);
    expect([...selection.pins]).toEqual(["q"]);
  });

  /**
   * The rule the three sets exist to keep: one selection, not three. Clicking a
   * photograph after following a thread means the photograph, not the
   * photograph *and* the thread you were looking at a moment ago.
   */
  it("is displaced whole by a plain click or a string click", () => {
    selection.replaceThread(["a"], ["s"], ["p"]);
    selection.replace(["b"]);
    expect(selection.pins.size).toBe(0);
    expect(selection.strings.size).toBe(0);

    selection.replaceThread(["a"], ["s"], ["p"]);
    selection.replaceStrings(["t"]);
    expect(selection.pins.size).toBe(0);
    expect(selection.members.size).toBe(0);
  });

  /**
   * The early-out has to notice the other two sets, or a click on the one
   * photograph a thread happened to contain would leave that thread's pins and
   * strings selected and silently claim nothing changed.
   */
  it("does not mistake a matching item set for an unchanged selection", () => {
    // No strings, deliberately: with one selected the old guard fell through
    // to the slow path anyway and the pin clause was never reached. This is the
    // shape that catches it — the items agree, and only the pins differ.
    selection.replaceThread(["a"], [], ["p"]);
    const version = selection.version;
    selection.replace(["a"]);
    expect(selection.version).toBe(version + 1);
    expect(selection.pins.size).toBe(0);
  });

  /** The same hole on the other method. */
  it("does not mistake a matching string set for an unchanged selection", () => {
    selection.replaceThread([], ["s"], ["p"]);
    const version = selection.version;
    selection.replaceStrings(["s"]);
    expect(selection.version).toBe(version + 1);
    expect(selection.pins.size).toBe(0);
  });

  it("clears all three kinds", () => {
    selection.replaceThread(["a"], ["s"], ["p"]);
    selection.clear();
    expect(selection.isBare).toBe(true);
    expect(selection.pins.size).toBe(0);
  });

  it("prunes a pin by its own predicate, never by the other two", () => {
    selection.replaceThread([], [], ["p", "q"]);
    const version = selection.version;

    selection.prune(
      () => false,
      () => false,
    );
    expect([...selection.pins].sort()).toEqual(["p", "q"]);
    expect(selection.version).toBe(version);

    selection.prune(
      () => false,
      () => false,
      (id) => id !== "q",
    );
    expect([...selection.pins]).toEqual(["p"]);
    expect(selection.version).toBe(version + 1);
  });
});
