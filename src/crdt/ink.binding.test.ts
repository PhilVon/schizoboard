/**
 * The whole chain, end to end: a stroke written to the document is ink in the
 * mirror.
 *
 *     crdt/ops/ink -> Y.Doc -> binding -> Scene.strokesOf -> dirty.ink
 *
 * Modelled on `crdt/strings.binding.test.ts` and for the same reason: the joins
 * are what this task is, and every other test drives one link.
 *
 * `frame()` clears the dirty sets exactly as `render/loop.ts` phase 9 does, so
 * anything that fails to survive being consumed once shows up as a test that
 * needs two frames.
 */

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { Binding } from "@/crdt/binding";
import { openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { commitStroke, deleteStrokes } from "@/crdt/ops/ink";
import { createItems, deleteItems, setItemPoses } from "@/crdt/ops/items";
import { UndoHistory } from "@/crdt/undo";
import type { InkSample } from "@/lib/ink";
import { INK_EPSILON } from "@/lib/strokepack";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";

let board: BoardDoc;
let scene: Scene;
let dirty: DirtySets;
let binding: Binding;

function frame(n = 1): void {
  for (let i = 0; i < n; i++) dirty.clear();
}

function note(): string {
  return createItems(board, [{ type: "note", x: 0, y: 0, w: 380, h: 288 }])[0]!.itemId;
}

function samples(count = 40, offset = 0): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: i * 5 - 100 + offset,
      y: Math.sin(i / 4) * 30,
      pressure: 0.3 + 0.5 * Math.abs(Math.sin(i / 7)),
    });
  }
  return out;
}

function ink(itemId: string) {
  return scene.strokesOf(itemId);
}

beforeEach(() => {
  board = openBoardDoc();
  scene = new Scene();
  dirty = new DirtySets();
  binding = new Binding(board, scene, dirty);
  binding.start();
});

describe("a stroke reaching the mirror", () => {
  it("is in the scene, unpacked, on the frame it was written", () => {
    const id = note();
    dirty.clear();
    const drawn = samples();
    commitStroke(board, { item: id, tool: "marker", color: "#1f1b17", size: 6, samples: drawn });

    const strokes = ink(id);
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toMatchObject({ tool: "marker", color: "#1f1b17", size: 6 });
    // Points, not bytes: the varint decode happens once here rather than on
    // every re-raster (`SceneStroke`).
    expect(strokes[0]!.samples.length).toBeGreaterThan(2);
    expect(strokes[0]!.samples[0]!.x).toBeCloseTo(drawn[0]!.x, 1);
  });

  it("raises the ink dirty set and not the item one", () => {
    const id = note();
    dirty.clear();
    commitStroke(board, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });

    // `render/cull.ts` is explicit that ink dirt cannot move an item, so raising
    // `items` here would re-cull and rewrite a transform for a mark.
    expect([...dirty.ink]).toEqual([id]);
    expect(dirty.items.size).toBe(0);
  });

  it("carries a bbox that contains every sample it carries", () => {
    const id = note();
    commitStroke(board, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });

    const stroke = ink(id)[0]!;
    for (const p of stroke.samples) {
      expect(p.x).toBeGreaterThanOrEqual(stroke.bbox[0]);
      expect(p.y).toBeGreaterThanOrEqual(stroke.bbox[1]);
      expect(p.x).toBeLessThanOrEqual(stroke.bbox[2]);
      expect(p.y).toBeLessThanOrEqual(stroke.bbox[3]);
    }
  });

  it("keeps an item's ink in paint order", () => {
    const id = note();
    commitStroke(board, { item: id, tool: "marker", color: "#111", size: 6, samples: samples() });
    commitStroke(board, { item: id, tool: "marker", color: "#222", size: 6, samples: samples() });
    commitStroke(board, { item: id, tool: "marker", color: "#333", size: 6, samples: samples() });

    const zs = ink(id).map((s) => s.z);
    expect([...zs].sort()).toEqual(zs);
    expect(ink(id).map((s) => s.color)).toEqual(["#111", "#222", "#333"]);
  });

  it("has no entry at all for an item nobody drew on", () => {
    const id = note();
    expect(ink(id)).toHaveLength(0);
    expect(scene.hasInk(id)).toBe(false);
  });
});

/**
 * The guard on the binding split. `syncItem` re-reads the whole entity, which is
 * right for an item's own fields; applied to ink it would unpack every stroke on
 * the item on every frame of a drag. If someone later collapses `syncStrokes`
 * back into `syncItem`, this is the test that says so — and the symptom in the
 * app would otherwise be "dragging an annotated photograph gets slower the more
 * you have drawn on it", found months later as vague sluggishness.
 */
describe("moving an item does not touch its ink", () => {
  it("leaves the very same stroke objects in place across a drag", () => {
    const id = note();
    commitStroke(board, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });
    const before = ink(id)[0]!;
    frame();

    for (let i = 1; i <= 10; i++) {
      setItemPoses(board, new Map([[id, { x: i * 12, y: i * 3 }]]));
      expect(dirty.ink.size).toBe(0);
      expect(ink(id)[0]).toBe(before);
      frame();
    }
  });
});

describe("ink going away", () => {
  it("drops a stroke that was erased", () => {
    const id = note();
    const first = commitStroke(board, {
      item: id,
      tool: "marker",
      color: "#000",
      size: 6,
      samples: samples(),
    })!.id;
    commitStroke(board, { item: id, tool: "marker", color: "#000", size: 6, samples: samples(40, 500) });
    frame();

    deleteStrokes(board, id, [first]);
    expect(ink(id)).toHaveLength(1);
    expect(dirty.ink.has(id)).toBe(true);
  });

  it("goes with the item, leaving no entry behind", () => {
    const id = note();
    commitStroke(board, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });
    frame();

    deleteItems(board, [id]);
    expect(scene.hasInk(id)).toBe(false);
    expect(ink(id)).toHaveLength(0);
  });
});

describe("undo", () => {
  it("takes a stroke out of the mirror and puts it back", () => {
    const id = note();
    const history = new UndoHistory(board);
    commitStroke(board, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });
    history.boundary();
    frame();

    history.undo();
    expect(ink(id)).toHaveLength(0);
    history.redo();
    expect(ink(id)).toHaveLength(1);
    history.destroy();
  });

  /**
   * The case the top-level create branch exists for: an item arriving already
   * has ink, and nothing nested fires for it because the whole item's map is one
   * insertion.
   */
  it("restores an item's ink along with the item", () => {
    const id = note();
    const history = new UndoHistory(board);
    commitStroke(board, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });
    history.boundary();
    deleteItems(board, [id]);
    history.boundary();
    frame();

    history.undo();
    expect(scene.has(id)).toBe(true);
    expect(ink(id)).toHaveLength(1);
    history.destroy();
  });
});

/**
 * The cork's half of the same chain (T-61):
 *
 *     crdt/ops/ink -> Y.Doc -> binding -> Scene.boardInkTile -> dirty.boardInk
 *
 * Its own describe rather than extra cases above, because the thing being
 * checked is that the two halves are genuinely separate all the way through —
 * different map, different scene bucket, different dirty set.
 */
describe("a stroke on bare cork reaching the mirror", () => {
  /** Centred on `(cx, cy)`, so the tile is arithmetic rather than a guess. */
  function cork(cx: number, cy: number): InkSample[] {
    return samples().map((s) => ({ x: s.x + cx, y: s.y + cy, pressure: s.pressure }));
  }

  it("is a tile in the scene, and raises boardInk rather than ink", () => {
    const written = commitStroke(board, {
      item: null,
      tool: "marker",
      color: "#1f1b17",
      size: 6,
      samples: cork(3000, 3000),
    })!;

    const tile = scene.boardInkTile("1,1")!;
    expect(tile.strokes).toHaveLength(1);
    expect(tile.strokes[0]).toMatchObject({ id: written.id, tool: "marker", color: "#1f1b17" });
    expect(dirty.boardInk.has("1,1")).toBe(true);
    // The item set is untouched: a tile key handed to the item layer would look
    // up an item that does not exist and silently draw nothing.
    expect(dirty.ink.size).toBe(0);
  });

  /**
   * The box is the tile's *ink*, not its cell. A stroke is filed by its centre,
   * so it hangs over the cell edge — and the renderer both culls and sizes its
   * canvas by this, so a box clamped to the lattice would clip the long strokes.
   */
  it("carries the box round its ink, which may reach outside the cell", () => {
    // Centred just inside the corner of cell (1,1), so the run reaches back into
    // cell (0,1).
    commitStroke(board, { item: null, tool: "marker", color: "#000", size: 6, samples: cork(2060, 3000) });
    const tile = scene.boardInkTile("1,1")!;
    expect(tile.bbox[0]).toBeLessThan(2048);
    expect(Math.abs(tile.bbox[0] - 1960)).toBeLessThanOrEqual(INK_EPSILON);
  });

  it("keeps two cells apart", () => {
    commitStroke(board, { item: null, tool: "marker", color: "#000", size: 6, samples: cork(3000, 3000) });
    commitStroke(board, { item: null, tool: "marker", color: "#000", size: 6, samples: cork(9000, 9000) });
    expect([...scene.boardInkTiles()]).toHaveLength(2);
    expect(scene.boardInkTile("1,1")!.strokes).toHaveLength(1);
    expect(scene.boardInkTile("4,4")!.strokes).toHaveLength(1);
  });

  /** An empty bucket must not survive, or the renderer keeps a mount candidate
   *  with a box of `Infinity` and nothing to draw. */
  it("takes the tile away when undo removes its last stroke", () => {
    const history = new UndoHistory(board);
    commitStroke(board, { item: null, tool: "marker", color: "#000", size: 6, samples: cork(3000, 3000) });
    history.boundary();
    frame();

    history.undo();
    expect(scene.boardInkTile("1,1")).toBeUndefined();
    expect([...scene.boardInkTiles()]).toHaveLength(0);
    expect(dirty.boardInk.has("1,1")).toBe(true);

    history.redo();
    expect(scene.boardInkTile("1,1")!.strokes).toHaveLength(1);
    history.destroy();
  });

  it("comes back on a whole-board resync", () => {
    commitStroke(board, { item: null, tool: "marker", color: "#000", size: 6, samples: cork(3000, 3000) });
    commitStroke(board, { item: null, tool: "marker", color: "#000", size: 6, samples: cork(3100, 3100) });
    frame();

    binding.resync();

    expect(scene.boardInkTile("1,1")!.strokes).toHaveLength(2);
  });

  /** Ink on the cork is not clipped to any paper, so it is the one kind of ink
   *  that can be the only content on a board. */
  it("counts as content, so a board of nothing but writing frames it", () => {
    expect(scene.contentBounds()).toBeNull();
    commitStroke(board, { item: null, tool: "marker", color: "#000", size: 6, samples: cork(3000, 3000) });
    const bounds = scene.contentBounds()!;
    expect(bounds).not.toBeNull();
    expect(bounds.minX).toBeGreaterThan(2800);
    expect(bounds.maxX).toBeLessThan(3200);
  });
});

describe("a whole-board resync", () => {
  it("brings every item's ink back", () => {
    const a = note();
    const b = note();
    commitStroke(board, { item: a, tool: "marker", color: "#000", size: 6, samples: samples() });
    commitStroke(board, { item: a, tool: "marker", color: "#000", size: 6, samples: samples(40, 300) });
    commitStroke(board, { item: b, tool: "highlighter", color: "#c9a227", size: 20, samples: samples() });
    frame();

    binding.resync();

    expect(ink(a)).toHaveLength(2);
    expect(ink(b)).toHaveLength(1);
    expect(ink(b)[0]!.tool).toBe("highlighter");
  });
});

describe("a stroke nobody can make sense of", () => {
  it("is skipped rather than repaired, and the rest of the item still draws", () => {
    const id = note();
    commitStroke(board, { item: id, tool: "marker", color: "#000", size: 6, samples: samples() });
    frame();

    // A peer on a version that writes something else, or a record whose points
    // did not survive. The reader returns null and the binding drops it;
    // repairing on read causes write storms in a shared session (DATA-MODEL
    // section 8.1), and this one would fire on every observer callback.
    board.doc.transact(() => {
      const strokes = board.items.get(id)!.get("strokes") as Y.Map<Y.Map<unknown>>;
      const broken = new Y.Map<unknown>();
      broken.set("tool", "marker");
      broken.set("z", "a5");
      strokes.set("broken", broken);
    });

    expect(dirty.ink.has(id)).toBe(true);
    expect(ink(id)).toHaveLength(1);
    expect(ink(id)[0]!.color).toBe("#000");
  });
});

describe("the samples that come back", () => {
  it("are within the simplify's tolerance of what went in", () => {
    const id = note();
    const drawn = samples(60);
    commitStroke(board, { item: id, tool: "marker", color: "#000", size: 6, samples: drawn });

    for (const p of ink(id)[0]!.samples) {
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
});
