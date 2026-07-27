/**
 * Committing ink, against a headless Y.Doc. No renderer, no DOM.
 *
 * The properties worth pinning are the ones DATA-MODEL states as rules rather
 * than as behaviour: one stroke is one record and one undo entry, the record
 * holds input points and not an outline, its bbox contains those points, and
 * deleting the item takes the ink with it because the nesting is real rather
 * than because something remembered to cascade.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import {
  commitStroke,
  commitStrokes,
  createItems,
  deleteBoardStrokes,
  deleteItems,
  deleteStrokes,
} from "@/crdt/ops";
import { Origin } from "@/crdt/origins";
import { readStroke, type YMap } from "@/crdt/schema";
import { UndoHistory } from "@/crdt/undo";
import type { InkSample } from "@/lib/ink";
import { INK_EPSILON, unpackStroke } from "@/lib/strokepack";

function board(): BoardDoc {
  const b = openBoardDoc();
  initialiseBoard(b);
  return b;
}

function note(b: BoardDoc): string {
  return createItems(b, [{ type: "note", x: 0, y: 0, w: 380, h: 288 }])[0]!.itemId;
}

/** A wandering path, so the simplify keeps more than the two ends. */
function samples(count = 40): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: i * 5 - 100, y: Math.sin(i / 4) * 30, pressure: 0.3 + 0.5 * Math.abs(Math.sin(i / 7)) });
  }
  return out;
}

function strokeMap(b: BoardDoc, itemId: string): Y.Map<YMap> {
  return b.items.get(itemId)!.get("strokes") as Y.Map<YMap>;
}

function only(b: BoardDoc, itemId: string) {
  const map = strokeMap(b, itemId);
  const id = [...map.keys()][0]!;
  return readStroke(id, map.get(id)!)!;
}

describe("committing a stroke", () => {
  it("is one record with the fields the schema names", () => {
    const b = board();
    const id = note(b);
    const strokeId = commitStroke(b, {
      item: id,
      tool: "highlighter",
      color: "#c9a227",
      size: 20,
      opacity: 0.4,
      samples: samples(),
    });

    expect(strokeId).not.toBeNull();
    expect(strokeMap(b, id).size).toBe(1);
    const stroke = only(b, id);
    expect(stroke).toMatchObject({ tool: "highlighter", color: "#c9a227", size: 20, opacity: 0.4 });
    expect(stroke.pts).toBeInstanceOf(Uint8Array);
    expect(stroke.z.length).toBeGreaterThan(0);
    expect(stroke.seed).toBeGreaterThanOrEqual(0);
  });

  /**
   * AC-79, from the document's side. An outline would be roughly twice the
   * points and none of them on the path the hand took.
   */
  it("holds the input points, and they come back on the path", () => {
    const b = board();
    const id = note(b);
    const drawn = samples();
    commitStroke(b, { item: id, tool: "marker", color: "#1f1b17", size: 6, samples: drawn });

    const back = unpackStroke(only(b, id).pts);
    expect(back.length).toBeLessThanOrEqual(drawn.length);
    for (const p of back) {
      let best = Infinity;
      for (let i = 0; i + 1 < drawn.length; i++) {
        const a = drawn[i]!;
        const c = drawn[i + 1]!;
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        const l2 = dx * dx + dy * dy;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
        best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
      }
      expect(best).toBeLessThanOrEqual(INK_EPSILON + 0.1);
    }
  });

  /** Invariant 7, asserted rather than assumed — the packer measured the box
   *  round the points it produced, so this cannot drift. */
  it("stores a bbox that contains every point it stored", () => {
    const b = board();
    const id = note(b);
    commitStroke(b, { item: id, tool: "marker", color: "#1f1b17", size: 6, samples: samples() });

    const stroke = only(b, id);
    for (const p of unpackStroke(stroke.pts)) {
      expect(p.x).toBeGreaterThanOrEqual(stroke.bbox[0]);
      expect(p.y).toBeGreaterThanOrEqual(stroke.bbox[1]);
      expect(p.x).toBeLessThanOrEqual(stroke.bbox[2]);
      expect(p.y).toBeLessThanOrEqual(stroke.bbox[3]);
    }
  });

  it("stacks each new stroke above the last, within the item", () => {
    const b = board();
    const a = note(b);
    const c = note(b);
    commitStroke(b, { item: a, tool: "marker", color: "#000", size: 6, samples: samples() });
    commitStroke(b, { item: a, tool: "marker", color: "#000", size: 6, samples: samples() });
    commitStroke(b, { item: c, tool: "marker", color: "#000", size: 6, samples: samples() });

    const zs = [...strokeMap(b, a).values()].map((s) => s.get("z") as string).sort();
    expect(zs[0]! < zs[1]!).toBe(true);
    // The other item's ink stacks on its own, so two people annotating two
    // photographs have no ordering to argue about.
    expect(strokeMap(b, c).size).toBe(1);
  });

  it("writes under the ink origin, so undo can call it one entry", () => {
    const b = board();
    const id = note(b);
    const origins: unknown[] = [];
    b.doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
    commitStroke(b, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });
    expect(origins).toContain(Origin.INK_COMMIT);
  });
});

/**
 * Ink on the bare cork (T-61) — the same record in a different map.
 *
 * The properties here are the ones DATA-MODEL section 2 states as rules: the
 * tile key is the floor-divided *centre* of the stroke's own bounding box, the
 * bucket is created by the first stroke that needs it, and `z` orders within a
 * tile rather than across the board.
 */
describe("committing to bare cork", () => {
  /** A short path centred on `(cx, cy)`, so the tile it lands in is arithmetic
   *  rather than a guess. */
  function around(cx: number, cy: number): InkSample[] {
    return samples().map((s) => ({ x: s.x + cx, y: s.y + cy, pressure: s.pressure }));
  }

  function tile(b: BoardDoc, key: string): Y.Map<YMap> {
    return b.boardInk.get(key)!;
  }

  it("files a stroke under the tile its bbox centre falls in", () => {
    const b = board();
    // samples() spans x -100..95, so this one is centred near (3000, 3000):
    // floor(3000 / 2048) is 1 on both axes.
    const written = commitStroke(b, {
      item: null,
      tool: "marker",
      color: "#000",
      size: 6,
      samples: around(3000, 3000),
    })!;
    expect(written.tile).toBe("1,1");
    expect(tile(b, "1,1").size).toBe(1);
    expect(tile(b, "1,1").has(written.id)).toBe(true);
    // And it did not also land on any item.
    expect(b.items.size).toBe(0);
  });

  it("floors negative coordinates rather than truncating them", () => {
    const b = board();
    // -500 is inside the cell that runs from -2048 to 0, which is index -1.
    // `Math.trunc` would call it 0 and put the ink a whole tile away.
    const written = commitStroke(b, {
      item: null,
      tool: "marker",
      color: "#000",
      size: 6,
      samples: around(-500, -500),
    })!;
    expect(written.tile).toBe("-1,-1");
  });

  it("puts two strokes in the same cell in one bucket, and orders them there", () => {
    const b = board();
    const first = commitStroke(b, { item: null, tool: "marker", color: "#000", size: 6, samples: around(3000, 3000) })!;
    const second = commitStroke(b, { item: null, tool: "marker", color: "#000", size: 6, samples: around(3100, 3100) })!;
    expect(second.tile).toBe(first.tile);
    const map = tile(b, first.tile!);
    expect(map.size).toBe(2);
    expect(readStroke(second.id, map.get(second.id)!)!.z > readStroke(first.id, map.get(first.id)!)!.z).toBe(true);
  });

  /**
   * Two tiles are independent buckets, which is the point of tiling: two people
   * drawing in two corners of the board mint `z` keys that never have to be
   * compared, so there is nothing for them to contend over.
   */
  it("starts a fresh tile at the bottom of its own stack", () => {
    const b = board();
    let nearTile = "";
    let nearZ = "";
    for (let i = 0; i < 3; i++) {
      const w = commitStroke(b, { item: null, tool: "marker", color: "#000", size: 6, samples: around(3000, 3000) })!;
      nearTile = w.tile!;
      nearZ = readStroke(w.id, tile(b, w.tile!).get(w.id)!)!.z;
    }
    const far = commitStroke(b, { item: null, tool: "marker", color: "#000", size: 6, samples: around(9000, 9000) })!;
    expect(far.tile).not.toBe(nearTile);
    const farZ = readStroke(far.id, tile(b, far.tile!).get(far.id)!)!.z;
    // Below the third stroke in the other tile, not above it: the scan that
    // minted it never looked outside its own bucket.
    expect(farZ < nearZ).toBe(true);
  });

  it("stores the samples in board coordinates, unshifted by the tile", () => {
    const b = board();
    const written = commitStroke(b, {
      item: null,
      tool: "marker",
      color: "#000",
      size: 6,
      samples: around(3000, 3000),
    })!;
    const fields = readStroke(written.id, tile(b, "1,1").get(written.id)!)!;
    const points = unpackStroke(fields.pts);
    // A tile is a bucket, not a frame: nothing is relative to its corner. The
    // tolerance is the packer's quantisation and nothing else.
    expect(Math.abs(points[0]!.x - 2900)).toBeLessThanOrEqual(INK_EPSILON);
    // Which is the other half of it: the box is past the tile's own corner.
    expect(fields.bbox[0]).toBeGreaterThan(2048);
  });

  /** One insertion, one entry — the same claim the item path makes, and the
   *  reason `boardInk` is one of the undo manager's roots. */
  it("undoes as one entry, taking the tile with it", () => {
    const b = board();
    const undo = new UndoHistory(b);
    commitStroke(b, { item: null, tool: "marker", color: "#000", size: 6, samples: around(3000, 3000) });
    expect(b.boardInk.get("1,1")!.size).toBe(1);

    undo.undo();
    // The bucket goes too, because nothing else ever created it.
    expect(b.boardInk.has("1,1")).toBe(false);

    undo.redo();
    expect(b.boardInk.get("1,1")!.size).toBe(1);
  });
});

/**
 * One gesture, several records, one undo entry (T-137).
 *
 * A line drawn off the side of a photograph and onto the cork is two marks in the
 * document and one thing the hand did. The property that matters is the
 * transaction: `Y.UndoManager` groups by it, so a second `mutate` would be a
 * second Ctrl+Z — one that took back the half on the cork and left the half on
 * the paper.
 */
describe("committing a gesture that crossed a surface", () => {
  function around(cx: number, cy: number): InkSample[] {
    return samples().map((s) => ({ x: s.x + cx, y: s.y + cy, pressure: s.pressure }));
  }

  it("writes every run in one transaction", () => {
    const b = board();
    const id = note(b);
    let transactions = 0;
    b.doc.on("afterTransaction", () => transactions++);

    commitStrokes(b, [
      { item: id, tool: "marker", color: "#000", size: 6, samples: samples() },
      { item: null, tool: "marker", color: "#000", size: 6, samples: around(3000, 3000) },
      { item: id, tool: "marker", color: "#000", size: 6, samples: samples() },
    ]);

    expect(transactions).toBe(1);
    expect(strokeMap(b, id).size).toBe(2);
    expect(b.boardInk.get("1,1")!.size).toBe(1);
  });

  it("undoes the whole gesture in one step", () => {
    const b = board();
    const id = note(b);
    const undo = new UndoHistory(b);
    commitStrokes(b, [
      { item: id, tool: "marker", color: "#000", size: 6, samples: samples() },
      { item: null, tool: "marker", color: "#000", size: 6, samples: around(3000, 3000) },
    ]);
    undo.boundary();

    undo.undo();
    // Both halves, not one: a Ctrl+Z that left the cork's piece behind would be
    // undoing something nobody did.
    expect(strokeMap(b, id).size).toBe(0);
    expect(b.boardInk.has("1,1")).toBe(false);
  });

  it("says where each run landed, with the ones it refused simply absent", () => {
    const b = board();
    const id = note(b);
    const written = commitStrokes(b, [
      { item: "nobody", tool: "marker", color: "#000", size: 6, samples: samples() },
      { item: id, tool: "marker", color: "#000", size: 6, samples: samples() },
      { item: null, tool: "marker", color: "#000", size: 6, samples: around(3000, 3000) },
    ]);

    // Two of three, and each says which surface it is on — so a caller pairing
    // results with inputs by position would name the wrong one, and does not
    // have to.
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({ item: id, tile: null });
    expect(written[1]).toMatchObject({ item: null, tile: "1,1" });
  });

  it("stacks two runs of one gesture on the same surface in the order drawn", () => {
    const b = board();
    const id = note(b);
    const written = commitStrokes(b, [
      { item: id, tool: "marker", color: "#000", size: 6, samples: samples() },
      { item: null, tool: "marker", color: "#000", size: 6, samples: around(3000, 3000) },
      { item: id, tool: "marker", color: "#000", size: 6, samples: samples() },
    ]);

    const map = strokeMap(b, id);
    const first = readStroke(written[0]!.id, map.get(written[0]!.id)!)!;
    const third = readStroke(written[2]!.id, map.get(written[2]!.id)!)!;
    expect(third.z > first.z).toBe(true);
  });

  it("writes nothing at all for a gesture whose every run was empty", () => {
    const b = board();
    let transactions = 0;
    b.doc.on("afterTransaction", () => transactions++);
    expect(commitStrokes(b, [{ item: null, tool: "marker", color: "#000", size: 6, samples: [] }])).toEqual([]);
    expect(transactions).toBe(0);
    expect(b.boardInk.size).toBe(0);
  });
});

describe("taking cork ink away", () => {
  function around(cx: number, cy: number): InkSample[] {
    return samples().map((s) => ({ x: s.x + cx, y: s.y + cy, pressure: s.pressure }));
  }

  it("removes the record and leaves the rest of the bucket", () => {
    const b = board();
    const first = commitStroke(b, { item: null, tool: "marker", color: "#000", size: 6, samples: around(3000, 3000) })!;
    commitStroke(b, { item: null, tool: "marker", color: "#000", size: 6, samples: around(3100, 3100) });

    deleteBoardStrokes(b, first.tile!, [first.id]);
    expect(b.boardInk.get("1,1")!.size).toBe(1);
    expect(b.boardInk.get("1,1")!.has(first.id)).toBe(false);
  });

  /**
   * A bucket exists only because somebody drew in it, so the last stroke takes
   * it. An empty tile left in the document is a mount candidate with nothing in
   * it, on every peer that ever loads the board.
   */
  it("takes the tile with the last stroke in it", () => {
    const b = board();
    const only = commitStroke(b, { item: null, tool: "marker", color: "#000", size: 6, samples: around(3000, 3000) })!;
    deleteBoardStrokes(b, only.tile!, [only.id]);
    expect(b.boardInk.has("1,1")).toBe(false);
  });

  it("is one entry, so undo brings the bucket and its contents back together", () => {
    const b = board();
    const undo = new UndoHistory(b);
    const only = commitStroke(b, { item: null, tool: "marker", color: "#000", size: 6, samples: around(3000, 3000) })!;
    undo.boundary();
    deleteBoardStrokes(b, only.tile!, [only.id]);
    undo.boundary();
    expect(b.boardInk.has("1,1")).toBe(false);

    undo.undo();
    expect(b.boardInk.get("1,1")!.size).toBe(1);
  });

  it("does nothing for a tile that is not there", () => {
    const b = board();
    expect(() => deleteBoardStrokes(b, "9,9", ["nobody"])).not.toThrow();
    expect(b.boardInk.size).toBe(0);
  });
});

describe("what is not committed", () => {
  it("commits nothing for a gesture that produced no points", () => {
    const b = board();
    const id = note(b);
    expect(commitStroke(b, { item: id, tool: "marker", color: "#000", size: 6, samples: [] })).toBeNull();
    expect(strokeMap(b, id).size).toBe(0);
  });

  it("commits nothing to an item that has gone", () => {
    const b = board();
    expect(
      commitStroke(b, { item: "nobody", tool: "marker", color: "#000", size: 6, samples: samples() }),
    ).toBeNull();
  });
});

describe("taking ink away", () => {
  it("removes whole records rather than flattening anything", () => {
    const b = board();
    const id = note(b);
    const first = commitStroke(b, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() })!.id;
    commitStroke(b, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });

    deleteStrokes(b, id, [first]);
    expect(strokeMap(b, id).size).toBe(1);
    expect(strokeMap(b, id).has(first)).toBe(false);
  });

  /**
   * Invariant 8 — "cascades leave no orphaned strokes" — and the test is that
   * there is no cascade code to get wrong. The strokes map is *inside* the
   * item's map, so deleting the item takes it.
   */
  it("goes with the item, without a cascade", () => {
    const b = board();
    const id = note(b);
    commitStroke(b, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });

    deleteItems(b, [id]);
    expect(b.items.has(id)).toBe(false);
  });
});

describe("undo", () => {
  it("takes one stroke, and gives it back", () => {
    const b = board();
    const id = note(b);
    const history = new UndoHistory(b);
    commitStroke(b, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });
    history.boundary();

    history.undo();
    expect(strokeMap(b, id).size).toBe(0);
    history.redo();
    expect(strokeMap(b, id).size).toBe(1);
    history.destroy();
  });

  it("keeps two strokes separated by a boundary as two entries", () => {
    const b = board();
    const id = note(b);
    const history = new UndoHistory(b);
    commitStroke(b, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });
    history.boundary();
    commitStroke(b, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });
    history.boundary();

    // "One stroke, one entry" (crdt/origins.ts) is a claim about the boundary
    // as much as about the origin — the 400 ms capture timeout would otherwise
    // merge two fast strokes. This is the contract T-58 inherits.
    history.undo();
    expect(strokeMap(b, id).size).toBe(1);
    history.undo();
    expect(strokeMap(b, id).size).toBe(0);
    history.destroy();
  });

  /** An undone item brings its ink back with it, which is the whole reason
   *  DATA-MODEL nested the map instead of making strokes top-level. */
  it("brings an item's ink back when the item comes back", () => {
    const b = board();
    const id = note(b);
    const history = new UndoHistory(b);
    commitStroke(b, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });
    history.boundary();
    deleteItems(b, [id]);
    history.boundary();

    history.undo();
    expect(b.items.has(id)).toBe(true);
    expect(strokeMap(b, id).size).toBe(1);
    history.destroy();
  });
});

describe("reading a stroke back", () => {
  it("skips a record with no points and one with no ordering", () => {
    const map = new Y.Map<unknown>();
    map.set("z", "a0");
    expect(readStroke("x", map as YMap)).toBeNull();
    map.set("pts", new Uint8Array([1, 2, 3]));
    map.delete("z");
    expect(readStroke("x", map as YMap)).toBeNull();
  });

  it("clamps and falls back rather than rejecting, everywhere else", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("m") as YMap;
    map.set("pts", new Uint8Array([1, 2, 3]));
    map.set("z", "a0");
    map.set("tool", "crayon");
    map.set("size", -4);
    map.set("opacity", 9);
    map.set("bbox", "nonsense");

    const stroke = readStroke("x", map)!;
    expect(stroke.tool).toBe("marker");
    expect(stroke.size).toBeGreaterThan(0);
    expect(stroke.opacity).toBe(1);
    // A broken box is not trusted and not repaired in the document; the
    // renderer measures its own off the points.
    expect(stroke.bbox).toEqual([0, 0, 0, 0]);
  });
});
