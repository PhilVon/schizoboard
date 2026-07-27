/**
 * Unit tests against a headless Y.Doc. No renderer, no DOM
 * (docs/ARCHITECTURE.md section 6).
 *
 * The interesting properties of an undo manager are all negative — what it
 * *doesn't* put on the stack, and what it *doesn't* split into two entries —
 * and every one of them fails silently. An unregistered origin doesn't throw,
 * it just quietly stops being undoable.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { createItems, createPin, deleteItems, setItemPoses } from "@/crdt/ops";
import { readItem } from "@/crdt/schema";
import { MAX_ENTRIES, UndoHistory, type ViewState } from "@/crdt/undo";
import type { SelectionSnapshot } from "@/state/selection";

function board(): BoardDoc {
  const b = openBoardDoc();
  initialiseBoard(b);
  return b;
}

function polaroid(b: BoardDoc, x = 0, y = 0): string {
  return createItems(b, [{ type: "polaroid", x, y, w: 300, h: 360 }])[0]!.itemId;
}

function poseOf(b: BoardDoc, id: string): { x: number; y: number } {
  const map = b.items.get(id);
  const item = map ? readItem(id, map) : null;
  if (!item) throw new Error(`no item ${id}`);
  return { x: item.x, y: item.y };
}

/** A two-node string between two pins, bypassing ops (T-41 owns those). */
function joinWithString(b: BoardDoc, pinA: string, pinB: string): string {
  const id = `s-${pinA}-${pinB}`;
  b.doc.transact(() => {
    const nodes = new Y.Array<Y.Map<unknown>>();
    for (const pin of [pinA, pinB]) {
      const node = new Y.Map<unknown>();
      node.set("nodeId", `n-${pin}`);
      node.set("pin", pin);
      node.set("slackAfter", 0.12);
      nodes.push([node]);
    }
    const s = new Y.Map<unknown>();
    s.set("nodes", nodes);
    b.strings.set(id, s);
  }, Origin.LOCAL_USER);
  return id;
}

/** Bump a tracked field under an arbitrary origin, without going near ops. */
function touch(b: BoardDoc, id: string, origin: unknown, y: number): void {
  b.doc.transact(() => b.items.get(id)?.set("y", y), origin);
}

describe("origin scoping", () => {
  it("tracks every origin a person's own edits carry", () => {
    for (const origin of [Origin.LOCAL_USER, Origin.DRAG_THROTTLE, Origin.INK_COMMIT]) {
      const b = board();
      const id = polaroid(b);
      const undo = new UndoHistory(b);
      touch(b, id, origin, 40);

      expect(undo.depth, `${origin} should be undoable`).toBe(1);
      undo.undo();
      expect(poseOf(b, id).y).toBe(0);
    }
  });

  it("ignores maintenance, so undo never reverts somebody's compaction", () => {
    for (const origin of [Origin.LOAD, Origin.MIGRATION, Origin.JANITOR, Origin.ASSET_GC]) {
      const b = board();
      const id = polaroid(b);
      const undo = new UndoHistory(b);
      touch(b, id, origin, 40);

      expect(undo.depth, `${origin} should be invisible to undo`).toBe(0);
      expect(undo.undo()).toBe(false);
      expect(poseOf(b, id).y).toBe(40);
    }
  });

  it("ignores a remote update — it is not local, by definition", () => {
    const mine = board();
    const id = polaroid(mine);

    const theirs = openBoardDoc();
    Y.applyUpdate(theirs.doc, Y.encodeStateAsUpdate(mine.doc));

    const undo = new UndoHistory(mine);
    theirs.doc.transact(() => theirs.items.get(id)?.set("y", 900), Origin.LOCAL_USER);
    Y.applyUpdate(mine.doc, Y.encodeStateAsUpdate(theirs.doc));

    expect(poseOf(mine, id).y).toBe(900);
    expect(undo.depth).toBe(0);
    expect(undo.undo()).toBe(false);
    expect(poseOf(mine, id).y).toBe(900);
  });

  it("does not enrol itself in the shared origin taxonomy", async () => {
    // Y.UndoManager mutates the `trackedOrigins` set it is handed. Handing it
    // the module constant would leave every manager ever built in there.
    const { TRACKED_ORIGINS } = await import("@/crdt/origins");
    const before = TRACKED_ORIGINS.size;
    new UndoHistory(board());
    new UndoHistory(board());
    expect(TRACKED_ORIGINS.size).toBe(before);
  });
});

describe("entries", () => {
  it("makes one entry of a drag — crash-safety writes merge into the release", () => {
    const b = board();
    const id = polaroid(b, 10, 10);
    const undo = new UndoHistory(b);

    // What `state/tools/select.ts` emits: a throttled live pose every 300 ms
    // under DRAG_THROTTLE, then the release under LOCAL_USER.
    for (const y of [40, 70, 100]) {
      setItemPoses(b, new Map([[id, { x: 10, y }]]), Origin.DRAG_THROTTLE);
    }
    setItemPoses(b, new Map([[id, { x: 10, y: 120 }]]), Origin.LOCAL_USER);

    expect(undo.depth).toBe(1);
    undo.undo();
    expect(poseOf(b, id)).toEqual({ x: 10, y: 10 });
  });

  it("splits at an explicit boundary", () => {
    const b = board();
    const id = polaroid(b, 0, 0);
    const undo = new UndoHistory(b);

    setItemPoses(b, new Map([[id, { x: 0, y: 50 }]]), Origin.LOCAL_USER);
    undo.boundary();
    setItemPoses(b, new Map([[id, { x: 0, y: 90 }]]), Origin.LOCAL_USER);

    expect(undo.depth).toBe(2);
    undo.undo();
    expect(poseOf(b, id).y).toBe(50);
    undo.undo();
    expect(poseOf(b, id).y).toBe(0);
  });

  it("redoes what it undid", () => {
    const b = board();
    const id = polaroid(b, 0, 0);
    const undo = new UndoHistory(b);

    setItemPoses(b, new Map([[id, { x: 0, y: 50 }]]), Origin.LOCAL_USER);
    undo.undo();
    expect(undo.canRedo).toBe(true);
    expect(undo.redo()).toBe(true);
    expect(poseOf(b, id).y).toBe(50);
  });

  it("caps the stack", () => {
    const b = board();
    const id = polaroid(b, 0, 0);
    const undo = new UndoHistory(b);

    for (let i = 1; i <= MAX_ENTRIES + 25; i++) {
      setItemPoses(b, new Map([[id, { x: 0, y: i }]]), Origin.LOCAL_USER);
      undo.boundary();
    }

    expect(undo.depth).toBe(MAX_ENTRIES);
    // The oldest entries are gone, so the pose can no longer walk all the way
    // home — which is what a bounded stack means.
    while (undo.undo());
    expect(poseOf(b, id).y).toBe(25);
  });
});

describe("cascades", () => {
  it("restores an item, its pins and its string in one step", () => {
    const b = board();
    const subject = polaroid(b, 0, 0);
    const other = polaroid(b, 500, 0);
    const pinA = createPin(b, { parent: subject, lx: 10, ly: 0 });
    const pinB = createPin(b, { parent: other, lx: -10, ly: 0 });
    const stringId = joinWithString(b, pinA, pinB);

    const undo = new UndoHistory(b);
    deleteItems(b, [subject]);

    // The whole cascade: the item, its pin, the string that dropped to one node.
    expect(b.items.has(subject)).toBe(false);
    expect(b.pins.has(pinA)).toBe(false);
    expect(b.strings.has(stringId)).toBe(false);
    expect(undo.depth).toBe(1);

    undo.undo();

    expect(b.items.has(subject)).toBe(true);
    expect(b.pins.has(pinA)).toBe(true);
    expect(b.strings.has(stringId)).toBe(true);
    expect(b.strings.get(stringId)?.get("nodes")).toBeInstanceOf(Y.Array);
    expect((b.strings.get(stringId)!.get("nodes") as Y.Array<unknown>).length).toBe(2);
  });

  it("un-creates a paste", () => {
    const b = board();
    const undo = new UndoHistory(b);
    const created = createItems(b, [
      { type: "note", x: 0, y: 0, w: 200, h: 200 },
      { type: "note", x: 40, y: 40, w: 200, h: 200 },
    ]);

    expect(undo.depth).toBe(1);
    undo.undo();
    for (const { itemId } of created) expect(b.items.has(itemId)).toBe(false);
  });
});

describe("camera and selection", () => {
  function sel(
    items: string[] = [],
    strings: string[] = [],
    pins: string[] = [],
  ): SelectionSnapshot {
    return { items, strings, pins };
  }

  function views(b: BoardDoc): {
    undo: UndoHistory;
    current: { value: ViewState };
    restored: ViewState[];
  } {
    const current = { value: { x: 0, y: 0, zoom: 1, selection: sel() } as ViewState };
    const restored: ViewState[] = [];
    const undo = new UndoHistory(b, {
      captureView: () => current.value,
      restoreView: (view) => restored.push(view),
    });
    return { undo, current, restored };
  }

  it("takes you back to where you were", () => {
    const b = board();
    const id = polaroid(b, 0, 0);
    const { undo, current, restored } = views(b);

    current.value = { x: 100, y: 200, zoom: 0.5, selection: sel([id]) };
    setItemPoses(b, new Map([[id, { x: 0, y: 50 }]]), Origin.LOCAL_USER);

    // Wander off before pressing Ctrl+Z.
    current.value = { x: -900, y: -900, zoom: 4, selection: sel() };
    undo.undo();

    expect(restored).toEqual([{ x: 100, y: 200, zoom: 0.5, selection: sel([id]) }]);
  });

  it("takes redo back to where undo was pressed", () => {
    const b = board();
    const id = polaroid(b, 0, 0);
    const { undo, current, restored } = views(b);

    current.value = { x: 1, y: 1, zoom: 1, selection: sel() };
    setItemPoses(b, new Map([[id, { x: 0, y: 50 }]]), Origin.LOCAL_USER);

    current.value = { x: 2, y: 2, zoom: 2, selection: sel() };
    undo.undo();
    current.value = { x: 3, y: 3, zoom: 3, selection: sel() };
    undo.redo();

    expect(restored.map((v) => v.x)).toEqual([1, 2]);
  });

  it("stashes the view the gesture started from, not where it ended", () => {
    const b = board();
    const id = polaroid(b, 0, 0);
    const { undo, current, restored } = views(b);

    current.value = { x: 10, y: 0, zoom: 1, selection: sel([id]) };
    setItemPoses(b, new Map([[id, { x: 0, y: 20 }]]), Origin.DRAG_THROTTLE);
    // The camera moves under a drag that reaches the edge of the viewport.
    current.value = { x: 999, y: 0, zoom: 1, selection: sel([id]) };
    setItemPoses(b, new Map([[id, { x: 0, y: 60 }]]), Origin.LOCAL_USER);

    undo.undo();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.x).toBe(10);
  });
});
