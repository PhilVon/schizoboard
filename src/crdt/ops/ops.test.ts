/**
 * Unit tests against a headless Y.Doc. No renderer, no DOM
 * (docs/ARCHITECTURE.md section 6).
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { Origin, TRACKED_ORIGINS, isTracked } from "@/crdt/origins";
import {
  bringToFront,
  createItems,
  createPin,
  deleteItems,
  deletePins,
  pinWorldPosition,
  reparentPin,
  sendToBack,
  setItemPoses,
  resizeItems,
} from "@/crdt/ops";
import { readItem, readPin, SCHEMA_VERSION } from "@/crdt/schema";
import { compareOrder } from "@/crdt/zindex";
import { SCATTER_DEGREES } from "@/lib/seed";

function board(): BoardDoc {
  const b = openBoardDoc();
  initialiseBoard(b);
  return b;
}

function polaroid(b: BoardDoc, x = 0, y = 0) {
  return createItems(b, [{ type: "polaroid", x, y, w: 300, h: 360 }])[0]!;
}

/** Adds a two-node string between two pins, bypassing ops (T-41 owns those). */
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

describe("board document", () => {
  it("initialises meta once and does not overwrite it", () => {
    const b = board();
    const seed = b.meta.get("corkSeed");
    expect(b.meta.get("schemaVersion")).toBe(SCHEMA_VERSION);
    initialiseBoard(b, "different title");
    expect(b.meta.get("corkSeed")).toBe(seed);
    expect(b.meta.get("title")).toBe("Untitled board");
  });
});

describe("origins", () => {
  it("tracks user edits and never tracks maintenance", () => {
    expect(isTracked(Origin.LOCAL_USER)).toBe(true);
    expect(isTracked(Origin.DRAG_THROTTLE)).toBe(true);
    expect(isTracked(Origin.INK_COMMIT)).toBe(true);
    expect(isTracked(Origin.JANITOR)).toBe(false);
    expect(isTracked(Origin.MIGRATION)).toBe(false);
    expect(isTracked(Origin.ASSET_GC)).toBe(false);
    // Remote transactions carry an origin this client never set.
    expect(isTracked(null)).toBe(false);
    expect(isTracked({ some: "provider" })).toBe(false);
    expect(TRACKED_ORIGINS.size).toBe(3);
  });
});

describe("createItems", () => {
  it("gives every item one pin at top centre and a seeded scatter", () => {
    const b = board();
    const { itemId, pinId } = polaroid(b);
    const item = readItem(itemId, b.items.get(itemId)!)!;
    const pin = readPin(pinId!, b.pins.get(pinId!)!)!;

    expect(pin.parent).toBe(itemId);
    expect(pin.lx).toBe(0);
    expect(pin.ly).toBeLessThan(0); // above the centre
    expect(Math.abs(item.rot)).toBeLessThanOrEqual((SCATTER_DEGREES * Math.PI) / 180);
    expect(item.rot).not.toBe(0);
  });

  it("is reproducible from a seed", () => {
    const a = board();
    const c = board();
    const one = createItems(a, [{ type: "note", x: 5, y: 6, w: 200, h: 150, seed: 4242 }])[0]!;
    const two = createItems(c, [{ type: "note", x: 5, y: 6, w: 200, h: 150, seed: 4242 }])[0]!;
    expect(readItem(one.itemId, a.items.get(one.itemId)!)!.rot).toBe(
      readItem(two.itemId, c.items.get(two.itemId)!)!.rot,
    );
  });

  it("pastes twenty items as one undo entry", () => {
    const b = board();
    const undo = new Y.UndoManager([b.items, b.pins], {
      trackedOrigins: new Set(TRACKED_ORIGINS),
    });
    const inputs = Array.from({ length: 20 }, (_, i) => ({
      type: "polaroid" as const,
      x: i * 10,
      y: 0,
      w: 100,
      h: 100,
    }));
    createItems(b, inputs);
    expect(b.items.size).toBe(20);
    expect(b.pins.size).toBe(20);

    undo.undo();
    expect(b.items.size).toBe(0);
    expect(b.pins.size).toBe(0);
  });

  it("stacks new items above existing ones", () => {
    const b = board();
    const made = createItems(
      b,
      Array.from({ length: 5 }, (_, i) => ({
        type: "card" as const,
        x: i,
        y: 0,
        w: 100,
        h: 100,
      })),
    );
    const zs = made.map((m) => readItem(m.itemId, b.items.get(m.itemId)!)!.z);
    expect([...zs].sort()).toEqual(zs);
  });

  it("refuses a zero-size item", () => {
    const b = board();
    const { itemId } = createItems(b, [{ type: "note", x: 0, y: 0, w: 0, h: -5 }])[0]!;
    const item = readItem(itemId, b.items.get(itemId)!)!;
    expect(item.w).toBeGreaterThan(0);
    expect(item.h).toBeGreaterThan(0);
  });

  it("can create without a pin, so an item lies loose on the cork", () => {
    const b = board();
    const { pinId } = createItems(b, [
      { type: "scrap", x: 0, y: 0, w: 100, h: 100, withPin: false },
    ])[0]!;
    expect(pinId).toBeNull();
    expect(b.pins.size).toBe(0);
  });
});

describe("item pose", () => {
  it("ignores non-finite input rather than poisoning the document", () => {
    const b = board();
    const { itemId } = polaroid(b, 10, 20);
    setItemPoses(b, new Map([[itemId, { x: Number.NaN, y: 5 }]]));
    resizeItems(b, new Map([[itemId, { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 10 }]]));
    const item = readItem(itemId, b.items.get(itemId)!)!;
    expect(item.x).toBe(10);
    expect(item.w).toBe(300);
  });

  it("writes drag-throttle poses under their own origin", () => {
    const b = board();
    const { itemId } = polaroid(b);
    const origins: unknown[] = [];
    b.doc.on("afterTransaction", (t) => origins.push(t.origin));
    setItemPoses(b, new Map([[itemId, { x: 1, y: 2 }]]), Origin.DRAG_THROTTLE);
    expect(origins).toContain(Origin.DRAG_THROTTLE);
  });
});

describe("resizing an item", () => {
  /** A 200x100 note at the origin, with one pin 40 units left of its centre. */
  function note(b: BoardDoc, rot = 0): { itemId: string; pinId: string } {
    const { itemId } = createItems(b, [
      { type: "note", x: 0, y: 0, w: 200, h: 100, rot, withPin: false },
    ])[0]!;
    return { itemId, pinId: createPin(b, { parent: itemId, lx: -40, ly: 0 }) };
  }

  it("holds the pin still in the cork while the paper grows out from under it", () => {
    const b = board();
    const { itemId, pinId } = note(b);
    const before = pinWorldPosition(b, pinId)!;

    // The east edge, dragged 60 units out: the centre travels 30, the west edge
    // does not move, and neither does the pin — a pin is pushed through the
    // paper and into the board behind it, not attached to a proportion of it.
    resizeItems(b, new Map([[itemId, { x: 30, y: 0, w: 260, h: 100 }]]));

    const after = pinWorldPosition(b, pinId)!;
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    const item = readItem(itemId, b.items.get(itemId)!)!;
    expect(item.x - item.w / 2).toBeCloseTo(-100, 6);
  });

  it("does the same through the item's rotation", () => {
    const b = board();
    const { itemId, pinId } = note(b, Math.PI / 3);
    const before = pinWorldPosition(b, pinId)!;

    // The centre travels 30 units along the item's own east, whatever that is
    // on screen — the same displacement the tool computes.
    const cos = Math.cos(Math.PI / 3);
    const sin = Math.sin(Math.PI / 3);
    resizeItems(b, new Map([[itemId, { x: 30 * cos, y: 30 * sin, w: 260, h: 100 }]]));

    const after = pinWorldPosition(b, pinId)!;
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("composes across the throttled writes of one long drag", () => {
    const b = board();
    const { itemId, pinId } = note(b);
    const before = pinWorldPosition(b, pinId)!;

    // Three crash-safety writes on the way to the same place one release would
    // have written. Each is measured against the document, not against where
    // the gesture started, so they must not compound.
    resizeItems(b, new Map([[itemId, { x: 10, y: 0, w: 220, h: 100 }]]), Origin.DRAG_THROTTLE);
    resizeItems(b, new Map([[itemId, { x: 20, y: 0, w: 240, h: 100 }]]), Origin.DRAG_THROTTLE);
    resizeItems(b, new Map([[itemId, { x: 30, y: 0, w: 260, h: 100 }]]));

    const after = pinWorldPosition(b, pinId)!;
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("leaves pins alone when the centre did not move", () => {
    const b = board();
    const { itemId, pinId } = note(b);
    resizeItems(b, new Map([[itemId, { x: 0, y: 0, w: 400, h: 300 }]]));
    const pin = readPin(pinId, b.pins.get(pinId)!)!;
    expect(pin.lx).toBe(-40);
    expect(pin.ly).toBe(0);
  });

  it("does not touch a pin belonging to a different item", () => {
    const b = board();
    const { itemId } = note(b);
    const other = createItems(b, [
      { type: "note", x: 500, y: 0, w: 100, h: 100, withPin: false },
    ])[0]!;
    const strayId = createPin(b, { parent: other.itemId, lx: 7, ly: 9 });

    resizeItems(b, new Map([[itemId, { x: 30, y: 0, w: 260, h: 100 }]]));

    const stray = readPin(strayId, b.pins.get(strayId)!)!;
    expect(stray.lx).toBe(7);
    expect(stray.ly).toBe(9);
  });

  it("is one transaction, so undo takes the item and its pins back together", () => {
    const b = board();
    const { itemId } = note(b);
    let transactions = 0;
    b.doc.on("afterTransaction", () => transactions++);
    resizeItems(b, new Map([[itemId, { x: 30, y: 0, w: 260, h: 100 }]]));
    expect(transactions).toBe(1);
  });
});

describe("pins", () => {
  it("resolves a parented pin through its item's rotation", () => {
    const b = board();
    const { itemId } = createItems(b, [
      { type: "polaroid", x: 100, y: 100, w: 200, h: 200, rot: Math.PI / 2, withPin: false },
    ])[0]!;
    const pinId = createPin(b, { parent: itemId, lx: 10, ly: 0 });
    const world = pinWorldPosition(b, pinId)!;
    // A quarter turn takes local +x onto board +y.
    expect(world.x).toBeCloseTo(100, 9);
    expect(world.y).toBeCloseTo(110, 9);
  });

  it("re-parents as a two-field write that preserves the board position", () => {
    const b = board();
    const { itemId } = createItems(b, [
      { type: "note", x: 50, y: -30, w: 200, h: 200, rot: 0.7, withPin: false },
    ])[0]!;
    const pinId = createPin(b, { parent: null, lx: 80, ly: 10 });

    reparentPin(b, pinId, itemId, 80, 10);
    const pin = readPin(pinId, b.pins.get(pinId)!)!;
    expect(pin.parent).toBe(itemId);
    const world = pinWorldPosition(b, pinId)!;
    expect(world.x).toBeCloseTo(80, 9);
    expect(world.y).toBeCloseTo(10, 9);

    reparentPin(b, pinId, null, world.x, world.y);
    expect(readPin(pinId, b.pins.get(pinId)!)!.parent).toBeNull();
    expect(pinWorldPosition(b, pinId)!.x).toBeCloseTo(80, 9);
  });

  it("renders a pin whose parent vanished at its last known board position", () => {
    const b = board();
    const { itemId, pinId } = polaroid(b, 200, 300);
    const before = pinWorldPosition(b, pinId!)!;
    // Bypass the cascade to leave a genuinely dangling pin, which is what a
    // concurrent delete produces on the wire.
    b.doc.transact(() => b.items.delete(itemId), Origin.LOCAL_USER);
    const after = pinWorldPosition(b, pinId!)!;
    expect(after).not.toBeNull();
    expect(Number.isFinite(after.x)).toBe(true);
    expect(before).not.toEqual(after); // local coords, read as board coords
  });
});

describe("cascades", () => {
  it("takes an item's pins and heals the strings through them", () => {
    const b = board();
    const a = polaroid(b, 0, 0);
    const c = polaroid(b, 400, 0);
    const stringId = joinWithString(b, a.pinId!, c.pinId!);
    expect(b.strings.size).toBe(1);

    deleteItems(b, [a.itemId]);

    expect(b.items.has(a.itemId)).toBe(false);
    expect(b.pins.has(a.pinId!)).toBe(false);
    expect(b.pins.has(c.pinId!)).toBe(true);
    // One node left, so the string deleted itself — invariant 3.
    expect(b.strings.has(stringId)).toBe(false);
  });

  it("keeps a string that still has two valid nodes", () => {
    const b = board();
    const a = polaroid(b, 0, 0);
    const c = polaroid(b, 400, 0);
    const d = polaroid(b, 800, 0);
    const stringId = joinWithString(b, a.pinId!, c.pinId!);
    b.doc.transact(() => {
      const nodes = b.strings.get(stringId)!.get("nodes") as Y.Array<Y.Map<unknown>>;
      const node = new Y.Map<unknown>();
      node.set("nodeId", "extra");
      node.set("pin", d.pinId!);
      node.set("slackAfter", 0.1);
      nodes.push([node]);
    }, Origin.LOCAL_USER);

    deleteItems(b, [a.itemId]);
    expect(b.strings.has(stringId)).toBe(true);
    const nodes = b.strings.get(stringId)!.get("nodes") as Y.Array<Y.Map<unknown>>;
    expect(nodes.length).toBe(2);
  });

  it("Shift+Delete leaves the pins free-floating where they were", () => {
    const b = board();
    const a = createItems(b, [
      { type: "polaroid", x: 120, y: 240, w: 200, h: 200, rot: 0.4 },
    ])[0]!;
    const c = polaroid(b, 900, 0);
    const stringId = joinWithString(b, a.pinId!, c.pinId!);
    const where = pinWorldPosition(b, a.pinId!)!;

    deleteItems(b, [a.itemId], { keepPins: true });

    expect(b.items.has(a.itemId)).toBe(false);
    const pin = readPin(a.pinId!, b.pins.get(a.pinId!)!)!;
    expect(pin.parent).toBeNull();
    expect(pin.lx).toBeCloseTo(where.x, 9);
    expect(pin.ly).toBeCloseTo(where.y, 9);
    // Evidence removed, thread remains.
    expect(b.strings.has(stringId)).toBe(true);
  });

  it("runs the whole cascade as one undo entry", () => {
    const b = board();
    const a = polaroid(b, 0, 0);
    const c = polaroid(b, 400, 0);
    const stringId = joinWithString(b, a.pinId!, c.pinId!);
    const undo = new Y.UndoManager([b.items, b.pins, b.strings], {
      trackedOrigins: new Set(TRACKED_ORIGINS),
    });

    deleteItems(b, [a.itemId]);
    undo.undo();

    expect(b.items.has(a.itemId)).toBe(true);
    expect(b.pins.has(a.pinId!)).toBe(true);
    expect(b.strings.has(stringId)).toBe(true);
  });

  it("deleting a pin heals its strings", () => {
    const b = board();
    const a = polaroid(b, 0, 0);
    const c = polaroid(b, 400, 0);
    const stringId = joinWithString(b, a.pinId!, c.pinId!);
    deletePins(b, [a.pinId!]);
    expect(b.pins.has(a.pinId!)).toBe(false);
    expect(b.items.has(a.itemId)).toBe(true);
    expect(b.strings.has(stringId)).toBe(false);
  });
});

describe("z-order ops", () => {
  it("raises a selection without scrambling its internal order", () => {
    const b = board();
    const made = Array.from({ length: 4 }, (_, i) => polaroid(b, i * 10, 0));
    const raised = [made[0]!.itemId, made[2]!.itemId];
    bringToFront(b, raised);

    const ordered = [...b.items]
      .map(([id, map]) => readItem(id, map)!)
      .map((i) => ({ z: i.z, clientId: i.createdBy, id: i.id }))
      .sort(compareOrder)
      .map((i) => i.id);

    expect(ordered.slice(-2)).toEqual(raised);
  });

  it("sends to back below everything, keeping relative order", () => {
    const b = board();
    const made = Array.from({ length: 4 }, (_, i) => polaroid(b, i * 10, 0));
    const lowered = [made[3]!.itemId, made[1]!.itemId];
    sendToBack(b, lowered);

    const ordered = [...b.items]
      .map(([id, map]) => readItem(id, map)!)
      .map((i) => ({ z: i.z, clientId: i.createdBy, id: i.id }))
      .sort(compareOrder)
      .map((i) => i.id);

    expect(ordered.slice(0, 2)).toEqual(lowered);
  });
});

describe("concurrent editing", () => {
  it("resolves two concurrent drags to one position, never a midpoint", () => {
    const alpha = board();
    const { itemId } = polaroid(alpha, 0, 0);
    const beta = openBoardDoc();
    Y.applyUpdate(beta.doc, Y.encodeStateAsUpdate(alpha.doc));

    setItemPoses(alpha, new Map([[itemId, { x: 100, y: 0 }]]));
    setItemPoses(beta, new Map([[itemId, { x: -100, y: 0 }]]));

    const fromAlpha = Y.encodeStateAsUpdate(alpha.doc);
    const fromBeta = Y.encodeStateAsUpdate(beta.doc);
    Y.applyUpdate(alpha.doc, fromBeta);
    Y.applyUpdate(beta.doc, fromAlpha);

    const a = readItem(itemId, alpha.items.get(itemId)!)!;
    const c = readItem(itemId, beta.items.get(itemId)!)!;
    expect(a.x).toBe(c.x);
    expect([100, -100]).toContain(a.x);
  });

  it("merges concurrent typing into the same note", () => {
    const alpha = board();
    const { itemId } = createItems(alpha, [
      { type: "note", x: 0, y: 0, w: 200, h: 100, text: "abc" },
    ])[0]!;
    const beta = openBoardDoc();
    Y.applyUpdate(beta.doc, Y.encodeStateAsUpdate(alpha.doc));

    (alpha.items.get(itemId)!.get("text") as Y.Text).insert(0, "X");
    (beta.items.get(itemId)!.get("text") as Y.Text).insert(3, "Z");

    const fromAlpha = Y.encodeStateAsUpdate(alpha.doc);
    Y.applyUpdate(alpha.doc, Y.encodeStateAsUpdate(beta.doc));
    Y.applyUpdate(beta.doc, fromAlpha);

    const text = (alpha.items.get(itemId)!.get("text") as Y.Text).toString();
    expect(text).toBe((beta.items.get(itemId)!.get("text") as Y.Text).toString());
    // Both edits survived, which a plain string field could not have done.
    expect(text).toContain("X");
    expect(text).toContain("Z");
    expect(text.length).toBe(5);
  });

  it("converges on item creation from both peers", () => {
    const alpha = board();
    const beta = openBoardDoc();
    Y.applyUpdate(beta.doc, Y.encodeStateAsUpdate(alpha.doc));

    createItems(alpha, [{ type: "polaroid", x: 0, y: 0, w: 10, h: 10 }]);
    createItems(beta, [{ type: "note", x: 5, y: 5, w: 10, h: 10 }]);

    const fromAlpha = Y.encodeStateAsUpdate(alpha.doc);
    Y.applyUpdate(alpha.doc, Y.encodeStateAsUpdate(beta.doc));
    Y.applyUpdate(beta.doc, fromAlpha);

    expect(alpha.items.size).toBe(2);
    expect(beta.items.size).toBe(2);

    const order = (b: BoardDoc): string[] =>
      [...b.items]
        .map(([id, map]) => readItem(id, map)!)
        .map((i) => ({ z: i.z, clientId: i.createdBy, id: i.id }))
        .sort(compareOrder)
        .map((i) => i.id);

    // Invariant 9 — the total order is identical on both documents.
    expect(order(alpha)).toEqual(order(beta));
  });
});
