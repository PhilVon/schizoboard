import { describe, expect, it } from "vitest";

import { diffText, mapCaret, type TextEdit } from "@/lib/textdiff";

/** Apply an edit, so a test can check it says what it means. */
function apply(before: string, edit: TextEdit): string {
  return before.slice(0, edit.at) + edit.insert + before.slice(edit.at + edit.remove);
}

describe("the smallest splice between two strings", () => {
  it("is nothing at all when they are equal", () => {
    expect(diffText("", "")).toBeNull();
    expect(diffText("a note", "a note")).toBeNull();
  });

  it("finds a typed character, wherever it lands", () => {
    expect(diffText("ab", "axb")).toEqual({ at: 1, remove: 0, insert: "x" });
    expect(diffText("ab", "abx")).toEqual({ at: 2, remove: 0, insert: "x" });
    expect(diffText("ab", "xab")).toEqual({ at: 0, remove: 0, insert: "x" });
    expect(diffText("", "x")).toEqual({ at: 0, remove: 0, insert: "x" });
  });

  it("finds a deleted character, and an emptied field", () => {
    expect(diffText("axb", "ab")).toEqual({ at: 1, remove: 1, insert: "" });
    expect(diffText("ab", "")).toEqual({ at: 0, remove: 2, insert: "" });
  });

  it("finds a replaced selection and a pasted run as one splice", () => {
    expect(diffText("the red string", "the blue string")).toEqual({
      at: 4,
      remove: 3,
      insert: "blue",
    });
    expect(apply("the red string", diffText("the red string", "the blue string")!)).toBe(
      "the blue string",
    );
  });

  /**
   * The prefix must not eat into what the suffix has already claimed. Typing a
   * second `a` into `"a"` has a one-character prefix *and* a one-character
   * suffix available, and counting both would report removing -1 characters.
   */
  it("does not count the same character as both prefix and suffix", () => {
    expect(diffText("a", "aa")).toEqual({ at: 1, remove: 0, insert: "a" });
    expect(diffText("aa", "a")).toEqual({ at: 1, remove: 1, insert: "" });
    expect(diffText("aaa", "aa")).toEqual({ at: 2, remove: 1, insert: "" });
  });

  /**
   * One splice, even where a general diff would find two smaller ones.
   *
   * That is the point rather than a limitation. Between two `input` events a
   * person did one thing, so one splice is what actually happened — and a pair
   * of edits would have to be written into the `Y.Text` in an order, with the
   * second one's offsets measured against the first, for no gain.
   */
  it("is always one splice, never two", () => {
    const edit = diffText("axbxc", "abc")!;
    expect(edit).toEqual({ at: 1, remove: 3, insert: "b" });
    expect(apply("axbxc", edit)).toBe("abc");
  });

  /** Where several splices give the same string, the prefix wins the tie. */
  it("resolves an ambiguous edit prefix-first", () => {
    expect(diffText("aba", "aa")).toEqual({ at: 1, remove: 1, insert: "" });
  });
});

describe("carrying a caret over somebody else's edit", () => {
  const insert: TextEdit = { at: 5, remove: 0, insert: "xyz" };
  const remove: TextEdit = { at: 5, remove: 4, insert: "" };

  it("leaves a caret before the change where it is", () => {
    expect(mapCaret(0, insert)).toBe(0);
    expect(mapCaret(5, insert)).toBe(5);
    expect(mapCaret(5, remove)).toBe(5);
  });

  it("shifts a caret after the change by what the change was worth", () => {
    expect(mapCaret(6, insert)).toBe(9);
    expect(mapCaret(9, remove)).toBe(5);
    expect(mapCaret(12, remove)).toBe(8);
  });

  /** A caret inside a run somebody else deleted has nowhere of its own to go. */
  it("collapses a caret inside the removed run to the end of what replaced it", () => {
    const swap: TextEdit = { at: 5, remove: 4, insert: "ab" };
    expect(mapCaret(7, swap)).toBe(7);
    expect(mapCaret(8, swap)).toBe(7);
  });
});
