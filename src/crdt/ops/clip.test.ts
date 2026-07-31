/**
 * What survives a copy, and what a paste is allowed to invent.
 *
 * The three shortcuts on DESIGN section 3.9's *Editing* line all reduce to
 * `copySubgraph` and `pasteClip`, so this file is about the two of them and not
 * about keystrokes — `app/clipboard.test.ts` has those.
 *
 * Two properties are load-bearing and everything here is one of them wearing a
 * hat:
 *
 * 1. **A clip is closed under its own references.** Nothing in it points at the
 *    document it came from, so it survives that document being edited,
 *    collapsed or replaced, and it can be put down twice.
 * 2. **A paste is one transaction.** Six notes, their pins and the string
 *    between them are one thing the person did, so they are one undo entry and
 *    one update on the wire.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { copySubgraph, pasteClip, type BoardClip } from "@/crdt/ops/clip";
import { commitStroke } from "@/crdt/ops/ink";
import { createItems, deleteItems, setItemStyle, setItemText } from "@/crdt/ops/items";
import { createPin } from "@/crdt/ops/pins";
import { createString } from "@/crdt/ops/strings";
import { readAsset, readItem, readPin, readString, readStroke, type YMap } from "@/crdt/schema";
import { UndoHistory } from "@/crdt/undo";

let board: BoardDoc;

beforeEach(() => {
  board = openBoardDoc();
});

/** A note with the one pin `createItems` gives it. */
function note(x: number, y: number, rot = 0): { itemId: string; pinId: string } {
  const [made] = createItems(board, [{ type: "note", x, y, w: 200, h: 160, rot }]);
  return { itemId: made!.itemId, pinId: made!.pinId! };
}

function item(id: string) {
  return readItem(id, board.items.get(id)!)!;
}

function pin(id: string) {
  return readPin(id, board.pins.get(id)!)!;
}

/** Every string on the board, as its run of pin ids. */
function runs(on: BoardDoc = board): string[][] {
  return [...on.strings].map(([id, map]) => readString(id, map)!.nodes.map((n) => n.pin));
}

describe("what a copy takes", () => {
  it("reproduces the paper rather than making a new sheet", () => {
    const { itemId } = note(100, 50, 0.3);
    setItemText(board, itemId, "the sentence");
    setItemStyle(board, [itemId], { paperStock: "graph", torn: true });
    const original = item(itemId);

    const clip = copySubgraph(board, { items: [itemId], pins: [] })!;
    const pasted = pasteClip(board, clip, { x: 900, y: 900 });

    const copy = item(pasted.items[0]!);
    expect(copy.id).not.toBe(itemId);
    // The seed decides the stock's grain, the ragged edge and the scatter, so a
    // fresh one would be a different piece of paper wearing the same words.
    expect(copy.seed).toBe(original.seed);
    expect([copy.type, copy.w, copy.h, copy.rot]).toEqual(["note", 200, 160, 0.3]);
    expect(copy.style).toEqual({ paperStock: "graph", torn: true });
    expect(board.items.get(copy.id)!.get("text")!.toString()).toBe("the sentence");
    // And it lands where it was asked for, not where it came from.
    expect([copy.x, copy.y]).toEqual([900, 900]);
  });

  it("brings the item's own pins, re-parented to the copy", () => {
    const { itemId, pinId } = note(0, 0);
    const extra = createPin(board, { parent: itemId, lx: 60, ly: -20 });

    const clip = copySubgraph(board, { items: [itemId], pins: [] })!;
    const pasted = pasteClip(board, clip, { x: 500, y: 0 });

    const copied = pasted.items[0]!;
    const theirs = [...board.pins].map(([id]) => pin(id)).filter((p) => p.parent === copied);
    expect(theirs).toHaveLength(2);
    expect(theirs.map((p) => [p.lx, p.ly]).sort()).toEqual(
      [pin(pinId), pin(extra)].map((p) => [p.lx, p.ly]).sort(),
    );
    // Parented pins travel inside their paper, so they are not free pins.
    expect(pasted.freePins).toEqual([]);
  });

  it("carries the ink drawn on an item, in the order it was drawn", () => {
    const { itemId } = note(0, 0);
    for (const color of ["#111111", "#222222", "#333333"]) {
      commitStroke(board, {
        item: itemId,
        tool: "marker",
        color,
        size: 4,
        samples: [
          { x: 0, y: 0, pressure: 0.5 },
          { x: 20, y: 20, pressure: 0.5 },
        ],
      });
    }

    const clip = copySubgraph(board, { items: [itemId], pins: [] })!;
    const pasted = pasteClip(board, clip, { x: 800, y: 0 });

    const strokes = board.items.get(pasted.items[0]!)!.get("strokes") as YMap;
    const read = [...(strokes as unknown as Map<string, YMap>)]
      .map(([id, map]) => readStroke(id, map)!)
      .sort((a, b) => (a.z < b.z ? -1 : 1));
    expect(read.map((s) => s.color)).toEqual(["#111111", "#222222", "#333333"]);
    expect(read[0]!.pts.length).toBeGreaterThan(0);
  });

  it("keeps a photograph's hash and registers what it is on a board that has never seen it", () => {
    const [made] = createItems(board, [
      {
        type: "polaroid",
        x: 0,
        y: 0,
        w: 300,
        h: 300,
        assetId: "abc123",
        asset: { w: 900, h: 900, mime: "image/jpeg", size: 4096, origName: "kodak.jpg" },
      },
    ]);

    const clip = copySubgraph(board, { items: [made!.itemId], pins: [] })!;
    const elsewhere = openBoardDoc();
    const pasted = pasteClip(elsewhere, clip, { x: 0, y: 0 });

    expect(readItem(pasted.items[0]!, elsewhere.items.get(pasted.items[0]!)!)!.assetId).toBe(
      "abc123",
    );
    const asset = elsewhere.assets.get("abc123")!;
    expect([asset.get("mime"), asset.get("origName")]).toEqual(["image/jpeg", "kodak.jpg"]);
  });

  /**
   * T-261. A copied cassette is the same recording, and the board it lands on
   * may never hold a byte of it — so the duration has to be carried rather than
   * re-derived. Re-deriving means having the file, and the whole point of the
   * record is that it travels ahead of one.
   */
  it("carries what was measured of a cassette onto a board that has no bytes", () => {
    const [made] = createItems(board, [
      {
        type: "polaroid",
        x: 0,
        y: 0,
        w: 300,
        h: 300,
        assetId: "tape01",
        asset: { w: 0, h: 0, mime: "audio/mpeg", size: 4096, duration: 1606.139 },
      },
    ]);

    const clip = copySubgraph(board, { items: [made!.itemId], pins: [] })!;
    const elsewhere = openBoardDoc();
    pasteClip(elsewhere, clip, { x: 0, y: 0 });

    const asset = readAsset("tape01", elsewhere.assets.get("tape01")!)!;
    expect(asset.kind).toBe("audio");
    expect(asset.duration).toBeCloseTo(1606.139, 3);
  });
});

describe("the string web", () => {
  it("comes when every pin it runs through is coming too", () => {
    const a = note(0, 0);
    const b = note(400, 0);
    createString(board, { pins: [a.pinId, b.pinId] });

    const clip = copySubgraph(board, { items: [a.itemId, b.itemId], pins: [] })!;
    const pasted = pasteClip(board, clip, { x: 0, y: 600 });

    expect(pasted.strings).toHaveLength(1);
    const copiedPins = [...board.pins]
      .map(([id]) => id)
      .filter((id) => pasted.items.includes(pin(id).parent ?? ""));
    const run = readString(pasted.strings[0]!, board.strings.get(pasted.strings[0]!)!)!;
    // Pointing at the new pins, not at the ones it was copied from.
    expect(run.nodes.every((n) => copiedPins.includes(n.pin))).toBe(true);
    expect(runs()).toHaveLength(2);
  });

  it("is dropped when one end is staying behind", () => {
    const a = note(0, 0);
    const b = note(400, 0);
    createString(board, { pins: [a.pinId, b.pinId] });

    // Only one of the two notes. A copied node pointing at a pin that was never
    // copied is the dangling reference the janitor exists to collect.
    const clip = copySubgraph(board, { items: [a.itemId], pins: [] })!;
    expect(clip.strings).toEqual([]);
    const pasted = pasteClip(board, clip, { x: 0, y: 600 });
    expect(pasted.strings).toEqual([]);
    expect(runs()).toHaveLength(1);
  });

  it("keeps each segment's own slack", () => {
    const a = createPin(board, { parent: null, lx: 0, ly: 0 });
    const b = createPin(board, { parent: null, lx: 200, ly: 0 });
    const c = createPin(board, { parent: null, lx: 400, ly: 0 });
    createString(board, { pins: [a, b, c], slack: [0.4, 0.05, 0.2] });

    const clip = copySubgraph(board, { items: [], pins: [a, b, c] })!;
    const pasted = pasteClip(board, clip, { x: 0, y: 500 });

    const run = readString(pasted.strings[0]!, board.strings.get(pasted.strings[0]!)!)!;
    expect(run.nodes.map((n) => n.slackAfter)).toEqual([0.4, 0.05, 0.2]);
  });
});

describe("free pins", () => {
  it("land relative to the middle of what was copied", () => {
    const a = createPin(board, { parent: null, lx: -100, ly: 0 });
    const b = createPin(board, { parent: null, lx: 100, ly: 0 });

    const clip = copySubgraph(board, { items: [], pins: [a, b] })!;
    const pasted = pasteClip(board, clip, { x: 1000, y: 1000 });

    expect(pasted.freePins).toHaveLength(2);
    const landed = pasted.freePins.map((id) => [pin(id).lx, pin(id).ly]).sort((p, q) => p[0]! - q[0]!);
    expect(landed).toEqual([
      [900, 1000],
      [1100, 1000],
    ]);
  });

  it("drops a selected pin whose item is staying behind", () => {
    const { itemId, pinId } = note(0, 0);
    // A pin selected on its own, still pushed through paper nobody copied. Its
    // frame is not coming, and inventing a free pin at the world position would
    // change what the user copied into a different kind of object.
    const clip = copySubgraph(board, { items: [], pins: [pinId] });
    expect(clip).toBeNull();
    expect(item(itemId).id).toBe(itemId);
  });
});

describe("a clip is a snapshot", () => {
  it("survives the original being deleted", () => {
    const { itemId } = note(0, 0);
    setItemText(board, itemId, "evidence");
    const clip = copySubgraph(board, { items: [itemId], pins: [] })!;

    deleteItems(board, [itemId]);
    expect(board.items.size).toBe(0);

    const pasted = pasteClip(board, clip, { x: 0, y: 0 });
    expect(board.items.get(pasted.items[0]!)!.get("text")!.toString()).toBe("evidence");
  });

  it("can be put down twice, and the two do not share a byte", () => {
    const { itemId } = note(0, 0);
    commitStroke(board, {
      item: itemId,
      tool: "marker",
      color: "#111111",
      size: 4,
      samples: [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 20, y: 20, pressure: 0.5 },
      ],
    });
    const clip = copySubgraph(board, { items: [itemId], pins: [] })!;

    const first = pasteClip(board, clip, { x: 500, y: 0 });
    const second = pasteClip(board, clip, { x: 1000, y: 0 });
    expect(first.items[0]).not.toBe(second.items[0]);

    const bytes = (id: string): Uint8Array => {
      const strokes = board.items.get(id)!.get("strokes") as unknown as Map<string, YMap>;
      return readStroke(...([...strokes][0] as [string, YMap]))!.pts;
    };
    expect([...bytes(first.items[0]!)]).toEqual([...bytes(second.items[0]!)]);
    expect(bytes(first.items[0]!)).not.toBe(bytes(second.items[0]!));
  });

  it("does not move when the original does", () => {
    const { itemId } = note(0, 0);
    const clip = copySubgraph(board, { items: [itemId], pins: [] })!;
    setItemText(board, itemId, "changed after the copy");

    const pasted = pasteClip(board, clip, { x: 0, y: 400 });
    expect(board.items.get(pasted.items[0]!)!.get("text")!.toString()).toBe("");
  });
});

describe("a paste is one thing the person did", () => {
  it("is one update and one undo entry, however much is in it", () => {
    const a = note(0, 0);
    const b = note(400, 0);
    createString(board, { pins: [a.pinId, b.pinId] });
    const clip = copySubgraph(board, { items: [a.itemId, b.itemId], pins: [] })!;

    const history = new UndoHistory(board);
    let updates = 0;
    board.doc.on("update", () => updates++);

    const pasted = pasteClip(board, clip, { x: 0, y: 800 });
    expect(updates).toBe(1);
    expect(board.items.size).toBe(4);

    history.undo();
    expect(board.items.size).toBe(2);
    expect(runs()).toHaveLength(1);
    expect(pasted.items.every((id) => !board.items.has(id))).toBe(true);
  });

  it("stacks what it pastes above everything already on the board", () => {
    const under = note(0, 0);
    const clip = copySubgraph(board, { items: [under.itemId], pins: [] })!;
    const pasted = pasteClip(board, clip, { x: 10, y: 10 });
    expect(item(pasted.items[0]!).z > item(under.itemId).z).toBe(true);
  });
});

describe("invariant 1 — every number in the document is finite", () => {
  it("refuses an item the arithmetic cannot place, and everything hanging off it", () => {
    const a = note(0, 0);
    const b = note(400, 0);
    createString(board, { pins: [a.pinId, b.pinId] });
    const clip = copySubgraph(board, { items: [a.itemId, b.itemId], pins: [] })!;

    // A clip is plain data and can be handed to this op by anything; one
    // spoiled coordinate must cost its own item and the references into it, not
    // the paste.
    const spoiled: BoardClip = {
      ...clip,
      items: clip.items.map((clipped, index) =>
        index === 0 ? { ...clipped, dx: Number.NaN } : clipped,
      ),
    };
    const pasted = pasteClip(board, spoiled, { x: 0, y: 900 });

    expect(pasted.items).toHaveLength(1);
    expect(pasted.strings).toEqual([]);
    for (const [id, map] of board.items) {
      const fields = readItem(id, map)!;
      expect(Number.isFinite(fields.x) && Number.isFinite(fields.y)).toBe(true);
    }
    // And no pin was left pointing at the item that was refused.
    for (const [id] of board.pins) {
      const parent = pin(id).parent;
      expect(parent === null || board.items.has(parent)).toBe(true);
    }
  });
});
