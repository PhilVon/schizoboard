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
