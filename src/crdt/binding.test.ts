import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { Binding } from "@/crdt/binding";
import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import {
  createItems,
  createPin,
  deleteItems,
  reparentPin,
  setItemPoses,
} from "@/crdt/ops";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";

let board: BoardDoc;
let scene: Scene;
let dirty: DirtySets;
let binding: Binding;

beforeEach(() => {
  board = openBoardDoc();
  initialiseBoard(board);
  scene = new Scene();
  dirty = new DirtySets();
  binding = new Binding(board, scene, dirty);
  binding.start();
  dirty.clear();
});

function polaroid(x = 0, y = 0) {
  return createItems(board, [{ type: "polaroid", x, y, w: 300, h: 360 }])[0]!;
}

describe("Binding", () => {
  it("mirrors a document that already has content", () => {
    const other = openBoardDoc();
    initialiseBoard(other);
    createItems(other, [{ type: "note", x: 7, y: 8, w: 100, h: 50 }]);

    const fresh = new Scene();
    const freshDirty = new DirtySets();
    const b = new Binding(other, fresh, freshDirty);
    b.start();

    expect(fresh.size).toBe(1);
    expect(fresh.pins.size).toBe(1);
    expect(freshDirty.all).toBe(true);
  });

  it("adds an item and marks it dirty", () => {
    const { itemId } = polaroid(100, 200);
    expect(scene.has(itemId)).toBe(true);
    expect(scene.poseOf(itemId)).toMatchObject({ x: 100, y: 200, w: 300, h: 360 });
    expect(dirty.items.has(itemId)).toBe(true);
  });

  it("follows a move", () => {
    const { itemId } = polaroid();
    dirty.clear();
    setItemPoses(board, new Map([[itemId, { x: 42, y: -17 }]]));
    expect(scene.poseOf(itemId)).toMatchObject({ x: 42, y: -17 });
    expect(dirty.items.has(itemId)).toBe(true);
  });

  it("follows text without a schema-specific handler", () => {
    const { itemId } = createItems(board, [
      { type: "note", x: 0, y: 0, w: 100, h: 100, text: "abc" },
    ])[0]!;
    expect(scene.cold(itemId)!.text).toBe("abc");

    (board.items.get(itemId)!.get("text") as Y.Text).insert(3, "def");
    expect(scene.cold(itemId)!.text).toBe("abcdef");
  });

  it("removes an item and its pins on a cascade", () => {
    const { itemId, pinId } = polaroid();
    dirty.clear();
    deleteItems(board, [itemId]);
    expect(scene.has(itemId)).toBe(false);
    expect(scene.pins.has(pinId!)).toBe(false);
    expect(dirty.items.has(itemId)).toBe(true);
  });

  it("marks the parent item dirty when one of its pins changes", () => {
    const { itemId } = polaroid();
    dirty.clear();
    createPin(board, { parent: itemId, lx: 10, ly: 10 });
    expect(dirty.items.has(itemId)).toBe(true);
  });

  it("marks both items dirty when a pin is re-parented", () => {
    const a = polaroid(0, 0);
    const b = polaroid(500, 0);
    dirty.clear();
    reparentPin(board, a.pinId!, b.itemId, 500, 0);
    expect(scene.pins.get(a.pinId!)!.parent).toBe(b.itemId);
    expect(dirty.items.has(b.itemId)).toBe(true);
    // The one it left, too: `a` has just gone from one pin to none, which is a
    // change to how it behaves (DESIGN section 2.2) even though it has not moved.
    expect(dirty.items.has(a.itemId)).toBe(true);
    expect(scene.pinCount(a.itemId)).toBe(0);
    expect(scene.pinCount(b.itemId)).toBe(2);
  });

  it("skips an item whose type nobody recognises rather than throwing", () => {
    board.doc.transact(() => {
      const broken = new Y.Map<unknown>();
      broken.set("type", "hologram");
      broken.set("z", "a0");
      board.items.set("weird", broken);
    });
    expect(scene.has("weird")).toBe(false);
    expect(scene.size).toBe(0);
  });

  it("keeps a pin's last known world position across an update", () => {
    const { itemId, pinId } = polaroid(0, 0);
    scene.layoutPins();
    const before = { ...scene.pins.get(pinId!)! };
    expect(before.wy).not.toBe(0);

    setItemPoses(board, new Map([[itemId, { x: 10, y: 0 }]]));
    // Not laid out yet — the pin must not have snapped to the origin.
    expect(scene.pins.get(pinId!)!.wy).toBe(before.wy);

    scene.layoutPins();
    // Relative, not absolute: the item arrived with a seeded scatter, so its
    // pin does not sit on the item's x axis and never did.
    expect(scene.pins.get(pinId!)!.wx - before.wx).toBeCloseTo(10, 4);
    expect(scene.pins.get(pinId!)!.wy).toBeCloseTo(before.wy, 4);
  });

  it("stops following once stopped", () => {
    const { itemId } = polaroid();
    binding.stop();
    setItemPoses(board, new Map([[itemId, { x: 999, y: 999 }]]));
    expect(scene.poseOf(itemId)!.x).not.toBe(999);
  });

  it("applies a remote update the same way as a local one", () => {
    const remote = openBoardDoc();
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(board.doc));
    createItems(remote, [{ type: "card", x: 300, y: 400, w: 200, h: 120 }]);

    Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(remote.doc));

    expect(scene.size).toBe(1);
    const id = [...scene.itemIds()][0]!;
    expect(scene.poseOf(id)).toMatchObject({ x: 300, y: 400 });
  });

  it("resyncs from scratch", () => {
    polaroid(1, 2);
    polaroid(3, 4);
    scene.removeItem([...scene.itemIds()][0]!);
    expect(scene.size).toBe(1);

    binding.resync();
    expect(scene.size).toBe(2);
    expect(dirty.all).toBe(true);
  });
});
