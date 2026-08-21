import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { Binding } from "@/crdt/binding";
import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import {
  createItems,
  createPin,
  deleteItems,
  deletePins,
  pauseTimer,
  reparentPin,
  resetTimer,
  setItemPoses,
  setTimerLength,
  setTimerLights,
  setTimerMode,
  startTimer,
  type TimerInput,
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

/**
 * What a resync has to put back to nothing — T-401.
 *
 * `Binding.resync` calls `scene.clear()` and then rebuilds from the document, so
 * anything `clear()` forgets is state from a board that no longer exists,
 * carried into one that does. Both of these were found by reading the method
 * beside a third line being added to it, and both are the same shape: a line
 * that went into a *setter* and not into that list.
 *
 * Driven through `resync` rather than by calling `clear()` directly, because the
 * resync is the real caller and it is what makes a slot get reused.
 */
describe("Binding — what a resync puts back", () => {
  it("leaves no slot marked open, so a folder's turn cannot land on a stranger", () => {
    const a = polaroid(0, 0).itemId;
    const b = polaroid(500, 0).itemId;
    // Turned up to be read, which is a purely local transient — nothing about it
    // is in the document, so a resync cannot restore it and must not leave it.
    scene.setOpen(b, 1);
    expect(scene.openOf(scene.slotOf(b)!)).toBe(1);

    binding.resync();

    // Every slot, and not merely `b`'s: the point is that slots are *reused*, so
    // the item that inherits the number is whichever one the rebuild hands it
    // to. Asserting on `b` alone would pass on a build where the numbering
    // happened to put `b` back where it was.
    for (let slot = 0; slot < scene.slotLimit; slot += 1) {
      expect(scene.openOf(slot)).toBe(0);
    }
    // And the translation that held the turn's pivot still, which is the other
    // half of it: a slot left open is also a slot offset by up to a hundred and
    // fifty units toward a pin that belonged to something else.
    for (const id of [a, b]) {
      const slot = scene.slotOf(id)!;
      expect(scene.renderX(slot)).toBe(scene.settledX(slot));
      expect(scene.renderRot(slot)).toBe(scene.settledRot(slot));
    }
  });

  it("empties the paged-pin index rather than carrying a dead board's tapes", () => {
    const { itemId } = polaroid();
    const pinId = createPin(board, { parent: itemId, lx: 10, ly: 10, kind: "tape", page: 4 });
    expect([...scene.pagedPins]).toEqual([pinId]);

    // Taken out of the document with nobody listening, which is what a document
    // being *replaced* looks like from the mirror's side — the observer never
    // sees the removal, so `removePin` (the only other thing that maintains this
    // index) never runs.
    binding.stop();
    deletePins(board, [pinId]);
    binding.resync();

    // One left, and it is the item's own — `createItems` gives every item a pin
    // and that one was never taped to a page. The tape is what has gone.
    expect(scene.pins.size).toBe(1);
    // A leak rather than a wrong picture — `render/ropes/paint.ts` tests each
    // pin before asking anything more expensive. But it is a leak that defeats
    // the fast path that file's `findTucked` is built on: "on every board it has
    // ever run the first line returns", which stops being true for the rest of
    // the session the moment one dead id is left here.
    expect(scene.pagedPins.size).toBe(0);
  });
});

/**
 * The clock, in the mirror — T-393.
 *
 * The mirror is where `state/` and `render/` meet a timer, because neither may
 * read a document (ARCHITECTURE section 2.1). So what is proved here is that all
 * five fields survive the crossing, that every one of the six writes arrives, and
 * that a photograph carries `null` rather than a clock face's worth of defaults.
 */
describe("Binding — timers", () => {
  /** A travel clock, at the size `lib/objects.ts` cuts one. */
  function timer(set: TimerInput = {}): string {
    return createItems(board, [{ type: "timer", x: 0, y: 0, w: 90, h: 70, timer: set }])[0]!.itemId;
  }

  it("carries all five fields across", () => {
    const lit = createItems(board, [{ type: "note", x: 500, y: 0, w: 100, h: 100 }])[0]!.itemId;
    const id = timer({ mode: "countdown", runsFor: 300_000, lights: lit });

    expect(scene.cold(id)!.timer).toEqual({
      mode: "countdown",
      runsFor: 300_000,
      // A new timer is put on the wall stopped, and `CreateItemInput.timer`
      // cannot say otherwise — so these two are the reset state and not an
      // omission from the test.
      runFrom: null,
      runBy: null,
      banked: 0,
      lights: lit,
    });
  });

  it("carries null for every item that is not one", () => {
    // All four, and not a representative one: `readItem` decides this off the
    // type, so a fifth branch appearing under any of them is the failure.
    for (const type of ["polaroid", "note", "scrap", "card"] as const) {
      const { itemId } = createItems(board, [{ type, x: 0, y: 0, w: 100, h: 100 }])[0]!;
      expect(scene.cold(itemId)!.timer).toBeNull();
    }
    expect(scene.timers.size).toBe(0);
  });

  it("follows every one of the six writes", () => {
    const other = timer();
    const id = timer();
    const at = 1_700_000_000_000;

    setTimerMode(board, [id], "countdown");
    expect(scene.cold(id)!.timer!.mode).toBe("countdown");

    setTimerLength(board, [id], 90_000);
    expect(scene.cold(id)!.timer!.runsFor).toBe(90_000);

    startTimer(board, [id], at);
    expect(scene.cold(id)!.timer!.runFrom).toBe(at);

    pauseTimer(board, [id], () => at + 4_000);
    // The two halves of the pause both arrive, and they arrive together: a
    // mirror that had seen only the cleared `runFrom` would read a timer that
    // had jumped back to nothing.
    expect(scene.cold(id)!.timer).toMatchObject({ runFrom: null, banked: 4_000 });

    resetTimer(board, [id]);
    expect(scene.cold(id)!.timer).toMatchObject({ runFrom: null, banked: 0, runsFor: 90_000 });

    setTimerLights(board, id, other);
    expect(scene.cold(id)!.timer!.lights).toBe(other);
  });

  it("mints a fresh cold record on a timer write, so the face rebinds", () => {
    const id = timer();
    const before = scene.cold(id)!;

    setTimerMode(board, [id], "stopwatch");

    // Identity, not equality. `render/items/dom.ts` re-binds on
    // `this.boundCold === cold` and nothing else, so a mirror that mutated the
    // record in place would change the mode and leave the face reading a clock.
    expect(scene.cold(id)).not.toBe(before);
    expect(dirty.items.has(id)).toBe(true);
  });

  it("indexes the timers, and lets one go when its item does", () => {
    createItems(board, [{ type: "note", x: 0, y: 0, w: 100, h: 100 }]);
    const id = timer();

    expect([...scene.timers]).toEqual([id]);

    // Through the document rather than through `scene.removeItem`, because the
    // observer is the only thing that empties the mirror in the running app.
    deleteItems(board, [id]);
    expect(scene.timers.size).toBe(0);
  });

  it("rebuilds the index on a resync", () => {
    const id = timer();
    scene.clear();
    expect(scene.timers.size).toBe(0);

    binding.resync();
    expect([...scene.timers]).toEqual([id]);
  });

  it("takes a peer's timer the same way", () => {
    const remote = openBoardDoc();
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(board.doc));
    const id = createItems(remote, [
      { type: "timer", x: 0, y: 0, w: 90, h: 70, timer: { mode: "stopwatch" } },
    ])[0]!.itemId;
    startTimer(remote, [id], 1_700_000_000_000);

    Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(remote.doc));

    expect(scene.cold(id)!.timer).toMatchObject({ mode: "stopwatch", runFrom: 1_700_000_000_000 });
    expect([...scene.timers]).toEqual([id]);
  });

  it("does not move while a timer runs", () => {
    const id = timer({ mode: "stopwatch" });
    startTimer(board, [id], 1_700_000_000_000);
    const running = scene.cold(id)!;
    dirty.clear();

    // Four seconds of a running stopwatch, as the document sees them: nothing.
    // This is D-73's load-bearing rule seen from the mirror — the record a face
    // was built from is still the record, so there is nothing here for a
    // per-frame reading to be derived *against*, and `state/timers.ts` (T-394)
    // must therefore get its `now` from the frame rather than from here.
    expect(scene.cold(id)).toBe(running);
    expect(dirty.items.size).toBe(0);
  });
});
