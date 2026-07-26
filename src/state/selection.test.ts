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
