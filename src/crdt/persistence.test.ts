/**
 * What survives a reload, and what is never written.
 *
 * Against a headless Y.Doc and the browser mock's in-memory store, which
 * implements the three document commands honestly enough to run two sessions
 * through one "disk" (ARCHITECTURE section 6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { boardSeed, initialiseBoard, openBoardDoc, snapshot, type BoardDoc } from "@/crdt/doc";
import { createItems, setItemPoses } from "@/crdt/ops";
import { TRACKED_ORIGINS } from "@/crdt/origins";
import { Persistence } from "@/crdt/persistence";
import { readItem } from "@/crdt/schema";
import { MockPlatform } from "@/platform/mock";
import type { DocState } from "@/platform/types";

/** The mock's store, with a count of what crossed and a way to break it. */
class Store extends MockPlatform {
  appends = 0;
  compactions = 0;
  failing = false;

  override async docAppendUpdate(bytes: Uint8Array): Promise<void> {
    this.appends += 1;
    if (this.failing) throw new Error("the disk said no");
    return super.docAppendUpdate(bytes);
  }

  override async docCompact(bytes: Uint8Array): Promise<void> {
    this.compactions += 1;
    if (this.failing) throw new Error("the disk said no");
    return super.docCompact(bytes);
  }

  /** How many frames are sitting in the log. */
  async logLength(): Promise<number> {
    return (await this.docLoad()).updates.length;
  }
}

function polaroid(board: BoardDoc, x: number, y: number): string {
  return createItems(board, [{ type: "polaroid", x, y, w: 300, h: 360 }])[0]!.itemId;
}

/** A session: an empty document, opened against `store`. */
async function session(store: Store): Promise<{ board: BoardDoc; persistence: Persistence }> {
  const board = openBoardDoc();
  const persistence = new Persistence(board, store);
  await persistence.open();
  initialiseBoard(board);
  return { board, persistence };
}

describe("Persistence", () => {
  it("merges a burst of transactions into one frame (AC-45)", async () => {
    const store = new Store();
    const { board, persistence } = await session(store);

    const a = polaroid(board, 10, 20);
    polaroid(board, 30, 40);
    setItemPoses(board, new Map([[a, { x: 11, y: 21, rot: 0 }]]));

    // Four transactions so far, counting `initialiseBoard`, and nothing has
    // crossed: the batch is still open.
    expect(store.appends).toBe(0);

    await persistence.flush();
    expect(store.appends).toBe(1);
    expect(await store.logLength()).toBe(1);
  });

  it("does not write again when nothing changed", async () => {
    const store = new Store();
    const { board, persistence } = await session(store);
    polaroid(board, 0, 0);
    await persistence.flush();
    await persistence.flush();
    expect(store.appends).toBe(1);
  });

  it("a second session opens the board the first one left", async () => {
    const store = new Store();
    const first = await session(store);
    const id = polaroid(first.board, 120, -40);
    await first.persistence.close();

    const second = openBoardDoc();
    await new Persistence(second, store).open();

    expect(boardSeed(second)).toBe(boardSeed(first.board));
    expect(readItem(id, second.items.get(id)!)).toMatchObject({ x: 120, y: -40 });
  });

  it("never writes back the frames it just read", async () => {
    const store = new Store();
    const first = await session(store);
    polaroid(first.board, 1, 2);
    await first.persistence.close();
    const before = store.appends;

    const second = openBoardDoc();
    const persistence = new Persistence(second, store);
    await persistence.open();
    // The document is identical, so `initialiseBoard` is a no-op too.
    initialiseBoard(second);
    await persistence.flush();

    expect(store.appends).toBe(before);
  });

  it("loads under an origin undo does not track (AC-144)", async () => {
    const store = new Store();
    const first = await session(store);
    polaroid(first.board, 5, 5);
    await first.persistence.close();

    const second = openBoardDoc();
    // Built before the load, so it would capture it if the origin were tracked.
    const undo = new Y.UndoManager([second.items, second.pins], {
      trackedOrigins: new Set(TRACKED_ORIGINS),
    });
    await new Persistence(second, store).open();

    expect(undo.canUndo()).toBe(false);
  });

  it("compacts once the log has grown, and the board survives it", async () => {
    const store = new Store();
    const board = openBoardDoc();
    const persistence = new Persistence(board, store, { compactBytes: 1 });
    await persistence.open();
    initialiseBoard(board);

    const id = polaroid(board, 7, 8);
    await persistence.flush();

    expect(store.compactions).toBe(1);
    expect(await store.logLength()).toBe(0);

    const later = openBoardDoc();
    await new Persistence(later, store).open();
    expect(readItem(id, later.items.get(id)!)).toMatchObject({ x: 7, y: 8 });
  });

  describe("when the disk refuses", () => {
    it("keeps the batch and sends it with the next one", async () => {
      const store = new Store();
      const errors: unknown[] = [];
      const board = openBoardDoc();
      const persistence = new Persistence(board, store, { onError: (e) => errors.push(e) });
      await persistence.open();
      initialiseBoard(board);

      store.failing = true;
      const id = polaroid(board, 3, 4);
      await persistence.flush();
      expect(errors).toHaveLength(1);
      expect(await store.logLength()).toBe(0);

      store.failing = false;
      await persistence.flush();
      expect(await store.logLength()).toBe(1);

      const later = openBoardDoc();
      await new Persistence(later, store).open();
      expect(readItem(id, later.items.get(id)!)).toMatchObject({ x: 3, y: 4 });
    });

    it("reports once per run of failures rather than once per batch", async () => {
      const store = new Store();
      const errors: unknown[] = [];
      const board = openBoardDoc();
      const persistence = new Persistence(board, store, { onError: (e) => errors.push(e) });
      await persistence.open();
      store.failing = true;

      for (let i = 0; i < 5; i += 1) {
        polaroid(board, i, i);
        await persistence.flush();
      }

      expect(store.appends).toBe(5);
      expect(errors).toHaveLength(1);
    });
  });

  describe("when the document on disk cannot be read", () => {
    /** A store whose `doc_load` never answers. */
    class Unreadable extends Store {
      override docLoad(): Promise<DocState> {
        return Promise.reject(new Error("the log is not ours"));
      }
    }

    /** A store holding a snapshot that stops halfway through. */
    class Truncated extends Store {
      constructor(private readonly torn: Uint8Array) {
        super();
      }
      override async docLoad(): Promise<DocState> {
        return { snapshot: this.torn, updates: [] };
      }
    }

    it("goes read-only rather than overwriting it (AC-146)", async () => {
      const store = new Unreadable();
      const errors: unknown[] = [];
      const board = openBoardDoc();
      const persistence = new Persistence(board, store, { onError: (e) => errors.push(e) });
      await persistence.open();

      expect(persistence.readOnly).toBe(true);
      expect(errors).toHaveLength(1);

      initialiseBoard(board);
      polaroid(board, 0, 0);
      await persistence.flush();
      await persistence.compact();

      expect(store.appends).toBe(0);
      expect(store.compactions).toBe(0);
    });

    it("treats a snapshot that does not decode the same way", async () => {
      const source = openBoardDoc();
      initialiseBoard(source);
      polaroid(source, 1, 1);
      const whole = snapshot(source);

      const store = new Truncated(whole.subarray(0, whole.byteLength - 8));
      const board = openBoardDoc();
      const persistence = new Persistence(board, store, { onError: () => {} });
      await persistence.open();

      expect(persistence.readOnly).toBe(true);
      polaroid(board, 0, 0);
      await persistence.flush();
      expect(store.appends).toBe(0);
    });
  });

  describe("the batch window", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("closes on its own after the interval", async () => {
      const store = new Store();
      const { board } = await session(store);
      polaroid(board, 0, 0);

      await vi.advanceTimersByTimeAsync(199);
      expect(store.appends).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.appends).toBe(1);
    });

    it("closes early once the batch is big enough", async () => {
      const store = new Store();
      const board = openBoardDoc();
      const persistence = new Persistence(board, store, { batchBytes: 64 });
      await persistence.open();
      initialiseBoard(board);

      for (let i = 0; i < 8; i += 1) polaroid(board, i, i);

      // Not sent from inside the transaction — that runs in phase 9 of the
      // frame — but on the very next task rather than at the end of the window.
      await vi.advanceTimersByTimeAsync(0);
      expect(store.appends).toBe(1);
      await persistence.close();
    });
  });
});
