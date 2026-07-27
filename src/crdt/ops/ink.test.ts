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
import { commitStroke, createItems, deleteItems, deleteStrokes } from "@/crdt/ops";
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

describe("what is not committed", () => {
  it("refuses board space, because nothing renders it yet", () => {
    const b = board();
    // A write with no reader is the trap this file's header is about.
    expect(commitStroke(b, { item: null, tool: "marker", color: "#000", size: 6, samples: samples() })).toBeNull();
  });

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
    const first = commitStroke(b, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() })!;
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
