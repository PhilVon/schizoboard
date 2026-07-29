/**
 * T-180. Writing on a note, against a headless `Y.Doc` — no renderer, no DOM
 * (docs/ARCHITECTURE.md section 6).
 *
 * The tests that matter here are the two-document ones. A note's text is a
 * `Y.Text` for exactly one reason — "two people can type in the same note"
 * (DESIGN section 9.3) — and an implementation that replaced the value instead
 * of splicing it passes every single-user test in this file and loses a peer's
 * sentence on the first merge.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { createItems, itemText, setItemText } from "@/crdt/ops";

function board(): BoardDoc {
  const b = openBoardDoc();
  initialiseBoard(b);
  return b;
}

function note(b: BoardDoc, text = ""): string {
  return createItems(b, [{ type: "note", x: 0, y: 0, w: 200, h: 120, text }])[0]!.itemId;
}

function textOf(b: BoardDoc, id: string): string {
  return itemText(b, id)?.toString() ?? "<none>";
}

/** Both ways, so neither document is the one that happens to win. */
function sync(a: BoardDoc, b: BoardDoc): void {
  const fromA = Y.encodeStateAsUpdate(a.doc);
  const fromB = Y.encodeStateAsUpdate(b.doc);
  Y.applyUpdate(a.doc, fromB);
  Y.applyUpdate(b.doc, fromA);
}

describe("setItemText", () => {
  it("writes what it is given", () => {
    const b = board();
    const id = note(b);
    setItemText(b, id, "hello");
    expect(textOf(b, id)).toBe("hello");
    setItemText(b, id, "hello there");
    expect(textOf(b, id)).toBe("hello there");
    setItemText(b, id, "");
    expect(textOf(b, id)).toBe("");
  });

  it("puts nothing on the wire when the text has not changed", () => {
    const b = board();
    const id = note(b, "unchanged");
    // Every `input` event re-sends the whole field, and most of them arrive
    // after a keystroke that changed nothing the document does not already
    // know — the echo of a peer's edit being the common one.
    let updates = 0;
    b.doc.on("update", () => updates++);
    setItemText(b, id, "unchanged");
    expect(updates).toBe(0);
  });

  it("ignores an item that is not there", () => {
    const b = board();
    expect(() => setItemText(b, "ghost", "hello")).not.toThrow();
  });

  it("goes in under LOCAL_USER, so the undo manager takes it", () => {
    const b = board();
    const id = note(b);
    const origins: unknown[] = [];
    b.doc.on("update", (_u, origin) => origins.push(origin));
    setItemText(b, id, "typed");
    expect(origins).toEqual([Origin.LOCAL_USER]);
  });

  /**
   * The whole reason this is a splice.
   *
   * Two people typing at opposite ends of the same note, neither having seen
   * the other. `text.delete(0, len)` then `text.insert(0, next)` gives the
   * identical string on each machine on its own, and loses one of them
   * entirely here — the peer's characters sit inside the range being deleted.
   */
  it("merges two people typing into the same note", () => {
    const alpha = board();
    const id = note(alpha, "the ");
    const beta = board();
    sync(alpha, beta);

    setItemText(alpha, id, "the red ");
    setItemText(beta, id, "the string");
    sync(alpha, beta);

    expect(textOf(alpha, id)).toBe(textOf(beta, id));
    const merged = textOf(alpha, id);
    // Both people's characters survived...
    expect(merged).toContain("red");
    expect(merged).toContain("string");
    // ...and the text they *shared* was not written twice. Checking only that
    // both words are present is not enough: a replace-the-whole-value
    // implementation leaves both inserts in and both copies of "the " with
    // them, which contains everything asked for and is not a merge.
    expect(merged.split("the ").length - 1).toBe(1);
    expect(merged).toHaveLength("the red string".length);
  });

  it("merges a deletion at one end with typing at the other", () => {
    const alpha = board();
    const id = note(alpha, "hello brave world");
    const beta = board();
    sync(alpha, beta);

    // One person cuts a word out of the middle...
    setItemText(alpha, id, "hello world");
    // ...while the other adds to the end, both from the same starting text.
    setItemText(beta, id, "hello brave world!");
    sync(alpha, beta);

    expect(textOf(alpha, id)).toBe(textOf(beta, id));
    expect(textOf(alpha, id)).toBe("hello world!");
  });

  /**
   * Character-level, not last-writer-wins on the field: typing a word into the
   * middle of a note must not touch the characters either side of it, or a
   * peer's concurrent edit to those would be clobbered by a write that had no
   * business naming them.
   */
  it("touches only the characters that changed", () => {
    const alpha = board();
    const id = note(alpha, "one two three");
    const beta = board();
    sync(alpha, beta);

    setItemText(alpha, id, "one TWO three");
    setItemText(beta, id, "one two THREE");
    sync(alpha, beta);

    expect(textOf(alpha, id)).toBe(textOf(beta, id));
    expect(textOf(alpha, id)).toBe("one TWO THREE");
  });
});
