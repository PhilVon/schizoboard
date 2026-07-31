/**
 * The per-item style map — writing it, reading it back, and the two properties
 * that make it a map rather than a record (T-225, DATA-MODEL section 3).
 *
 * Headless Y.Doc, no renderer, no DOM.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { createItems, setItemStyle } from "@/crdt/ops";
import { readItem } from "@/crdt/schema";

function board(): BoardDoc {
  const b = openBoardDoc();
  initialiseBoard(b);
  return b;
}

function note(b: BoardDoc): string {
  return createItems(b, [{ type: "note", x: 0, y: 0, w: 240, h: 200 }])[0]!.itemId;
}

function styleOf(b: BoardDoc, id: string) {
  return readItem(id, b.items.get(id)!)!.style;
}

/** The raw map, for the tests that are about the document rather than the read. */
function rawStyle(b: BoardDoc, id: string): Y.Map<unknown> {
  return b.items.get(id)!.get("style") as Y.Map<unknown>;
}

describe("an item nobody has restyled", () => {
  /** The state of nearly every item on the board, and it has to read as "ask
   *  the seed" rather than as anything chosen. */
  it("reads as an empty style", () => {
    const b = board();
    expect(styleOf(b, note(b))).toEqual({});
  });

  it("still has the map, so nothing has to create one to write into", () => {
    const b = board();
    expect(rawStyle(b, note(b))).toBeInstanceOf(Y.Map);
  });
});

describe("writing an override", () => {
  it("comes back on the read", () => {
    const b = board();
    const id = note(b);
    setItemStyle(b, [id], { paperStock: "graph", fontFamily: "clean", torn: true, tapeStyle: 0b1010 });
    expect(styleOf(b, id)).toEqual({
      paperStock: "graph",
      fontFamily: "clean",
      torn: true,
      tapeStyle: 0b1010,
    });
  });

  it("takes a tint as the two numbers rather than a colour", () => {
    const b = board();
    const id = note(b);
    setItemStyle(b, [id], { tint: { hue: -6, light: 2.5 } });
    expect(styleOf(b, id).tint).toEqual({ hue: -6, light: 2.5 });
  });

  it("restyles a whole selection in one transaction, so it is one undo entry", () => {
    const b = board();
    const ids = createItems(b, [
      { type: "note", x: 0, y: 0, w: 240, h: 200 },
      { type: "note", x: 300, y: 0, w: 240, h: 200 },
      { type: "note", x: 600, y: 0, w: 240, h: 200 },
    ]).map((made) => made.itemId);
    let transactions = 0;
    b.doc.on("afterTransaction", () => transactions++);
    setItemStyle(b, ids, { paperStock: "legal" });
    expect(transactions).toBe(1);
    for (const id of ids) expect(styleOf(b, id).paperStock).toBe("legal");
  });

  it("does nothing at all for an empty patch or an empty selection", () => {
    const b = board();
    const id = note(b);
    let transactions = 0;
    b.doc.on("afterTransaction", () => transactions++);
    setItemStyle(b, [id], {});
    setItemStyle(b, [], { paperStock: "graph" });
    expect(transactions).toBe(0);
  });

  it("skips an id that is not on the board rather than throwing", () => {
    const b = board();
    const id = note(b);
    setItemStyle(b, [id, "gone"], { paperStock: "cream" });
    expect(styleOf(b, id).paperStock).toBe("cream");
  });
});

describe("clearing an override", () => {
  /**
   * `undefined` in the patch means *clear*, not "write a default". The
   * difference is the whole design: an item that has been put back to its seed
   * must be indistinguishable from one that was never touched, so that if the
   * derivation ever improves it improves for that item too.
   */
  it("deletes the key rather than writing a null", () => {
    const b = board();
    const id = note(b);
    setItemStyle(b, [id], { paperStock: "graph" });
    setItemStyle(b, [id], { paperStock: undefined });

    expect(styleOf(b, id)).toEqual({});
    expect(rawStyle(b, id).has("paperStock")).toBe(false);
  });

  it("clears one property and leaves the others alone", () => {
    const b = board();
    const id = note(b);
    setItemStyle(b, [id], { paperStock: "graph", fontFamily: "clean" });
    setItemStyle(b, [id], { paperStock: undefined });
    expect(styleOf(b, id)).toEqual({ fontFamily: "clean" });
  });
});

describe("what makes it a map and not a record", () => {
  /**
   * DATA-MODEL section 3 says "a Y.Map so two people adjusting different
   * properties don't clobber each other", and until now nothing could write one
   * so the claim was untested by construction. This is the test.
   */
  it("lets two peers change different properties without either losing", () => {
    const a = board();
    const bee = openBoardDoc();
    const id = note(a);
    Y.applyUpdate(bee.doc, Y.encodeStateAsUpdate(a.doc));

    // Concurrently, and neither has seen the other.
    setItemStyle(a, [id], { paperStock: "graph" });
    setItemStyle(bee, [id], { tapeStyle: 0 });

    const fromA = Y.encodeStateAsUpdate(a.doc);
    const fromB = Y.encodeStateAsUpdate(bee.doc);
    Y.applyUpdate(a.doc, fromB);
    Y.applyUpdate(bee.doc, fromA);

    expect(styleOf(a, id)).toEqual({ paperStock: "graph", tapeStyle: 0 });
    expect(styleOf(bee, id)).toEqual(styleOf(a, id));
  });

  /**
   * The other half, and the reason the op patches key by key instead of
   * replacing the map: a build that has learned a sixth property writes it, and
   * an edit made on this build must not take it away. Simulated by writing a
   * key this build does not know.
   */
  it("leaves a property this build does not understand where it found it", () => {
    const b = board();
    const id = note(b);
    rawStyle(b, id).doc!.transact(() => rawStyle(b, id).set("marginColour", "#c00"));

    setItemStyle(b, [id], { paperStock: "index" });

    expect(rawStyle(b, id).get("marginColour")).toBe("#c00");
    // And this build simply does not see it, rather than choking on it.
    expect(styleOf(b, id)).toEqual({ paperStock: "index" });
  });
});

describe("what arrives from somewhere that is not this build", () => {
  const junk = (b: BoardDoc, id: string, key: string, value: unknown): void => {
    b.doc.transact(() => rawStyle(b, id).set(key, value));
  };

  it("drops a paper stock it does not recognise and keeps the rest", () => {
    const b = board();
    const id = note(b);
    setItemStyle(b, [id], { fontFamily: "clean" });
    junk(b, id, "paperStock", "vellum");
    expect(styleOf(b, id)).toEqual({ fontFamily: "clean" });
  });

  it("drops a font family that is a font name", () => {
    const b = board();
    const id = note(b);
    junk(b, id, "fontFamily", "Comic Sans MS");
    expect(styleOf(b, id).fontFamily).toBeUndefined();
  });

  /** A mask is four bits. Anything else is not a tape arrangement that can be
   *  drawn, and a fraction is not a mask at all. */
  it("drops a tape mask outside the four corners", () => {
    const b = board();
    const id = note(b);
    for (const bad of [-1, 16, 2.5, Number.NaN, "0b11"]) {
      junk(b, id, "tapeStyle", bad);
      expect(styleOf(b, id).tapeStyle).toBeUndefined();
    }
    junk(b, id, "tapeStyle", 0b1111);
    expect(styleOf(b, id).tapeStyle).toBe(0b1111);
  });

  /** Half a tint is not a tint. Defaulting the missing half to zero would
   *  render a different sheet from the one the writer meant. */
  it("drops a tint that is missing a half", () => {
    const b = board();
    const id = note(b);
    junk(b, id, "tint", { hue: 4 });
    expect(styleOf(b, id).tint).toBeUndefined();
    junk(b, id, "tint", { hue: 4, light: Number.POSITIVE_INFINITY });
    expect(styleOf(b, id).tint).toBeUndefined();
    junk(b, id, "tint", { hue: 4, light: -1 });
    expect(styleOf(b, id).tint).toEqual({ hue: 4, light: -1 });
  });

  it("survives a style key that is not a map at all", () => {
    const b = board();
    const id = note(b);
    b.doc.transact(() => b.items.get(id)!.set("style", "graph"));
    expect(styleOf(b, id)).toEqual({});
    // And restyling it puts a real map back rather than giving up.
    setItemStyle(b, [id], { paperStock: "cream" });
    expect(styleOf(b, id)).toEqual({ paperStock: "cream" });
  });
});
