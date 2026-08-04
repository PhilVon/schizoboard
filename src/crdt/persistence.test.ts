/**
 * What survives a reload, and what is never written.
 *
 * Against a headless Y.Doc and the browser mock's in-memory store, which
 * implements the three document commands honestly enough to run two sessions
 * through one "disk" (ARCHITECTURE section 6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  boardSeed,
  initialiseBoard,
  openBoardDoc,
  snapshot,
  type BoardDoc,
} from "@/crdt/doc";
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
  return createItems(board, [{ type: "polaroid", x, y, w: 300, h: 360 }])[0]!
    .itemId;
}

/** A session: an empty document, opened against `store`. */
async function session(
  store: Store,
): Promise<{ board: BoardDoc; persistence: Persistence }> {
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
    expect(readItem(id, second.items.get(id)!)).toMatchObject({
      x: 120,
      y: -40,
    });
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
      const persistence = new Persistence(board, store, {
        onError: (e) => errors.push(e),
      });
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
      const persistence = new Persistence(board, store, {
        onError: (e) => errors.push(e),
      });
      await persistence.open();
      store.failing = true;

      for (let i = 0; i < 5; i += 1) {
        polaroid(board, i, i);
        await persistence.flush();
      }

      expect(store.appends).toBe(5);
      expect(errors).toHaveLength(1);
    });

    /**
     * The other end of that (T-220). The failure is shown as a *standing*
     * sentence — the board is not being saved, and it will still not be being
     * saved in a minute — so something has to take it down again, and the only
     * thing that knows the run of failures has ended is this class.
     */
    it("says so when a write works again", async () => {
      const store = new Store();
      const errors: unknown[] = [];
      let recoveries = 0;
      const board = openBoardDoc();
      const persistence = new Persistence(board, store, {
        onError: (e) => errors.push(e),
        onRecovered: () => (recoveries += 1),
      });
      await persistence.open();

      store.failing = true;
      polaroid(board, 1, 1);
      await persistence.flush();
      expect(errors).toHaveLength(1);
      expect(recoveries).toBe(0);

      store.failing = false;
      await persistence.flush();
      expect(recoveries).toBe(1);
    });

    /** One each way per run, so the two pair up and a caller needs no flag. */
    it("pairs a recovery with each run of failures and no more", async () => {
      const store = new Store();
      const errors: unknown[] = [];
      let recoveries = 0;
      const board = openBoardDoc();
      const persistence = new Persistence(board, store, {
        onError: (e) => errors.push(e),
        onRecovered: () => (recoveries += 1),
      });
      await persistence.open();

      for (let run = 0; run < 2; run += 1) {
        store.failing = true;
        polaroid(board, run, run);
        await persistence.flush();
        await persistence.flush();
        store.failing = false;
        await persistence.flush();
      }

      expect(errors).toHaveLength(2);
      expect(recoveries).toBe(2);
    });

    /** A board whose disk has never misbehaved is never told anything. */
    it("says nothing at all when every write works", async () => {
      const store = new Store();
      let spoken = 0;
      const board = openBoardDoc();
      const persistence = new Persistence(board, store, {
        onError: () => (spoken += 1),
        onRecovered: () => (spoken += 1),
      });
      await persistence.open();

      polaroid(board, 2, 2);
      await persistence.flush();
      await persistence.compact();

      expect(store.appends).toBeGreaterThan(0);
      expect(spoken).toBe(0);
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
      const persistence = new Persistence(board, store, {
        onError: (e) => errors.push(e),
      });
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

    /**
     * And never recovers, because nothing writes after `giveUp` and there is no
     * success to recover with. The distinction matters to whoever is holding
     * the sentence up: this one is permanent for the session, and taking it
     * down would be a lie (T-220).
     */
    it("never announces a recovery, because there is nothing to recover", async () => {
      const store = new Unreadable();
      let recoveries = 0;
      const persistence = new Persistence(openBoardDoc(), store, {
        onError: () => {},
        onRecovered: () => (recoveries += 1),
      });
      await persistence.open();
      await persistence.flush();
      await persistence.compact();

      expect(persistence.readOnly).toBe(true);
      expect(recoveries).toBe(0);
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

  /**
   * The property a board switch is built on (T-358).
   *
   * `src-tauri/src/workshop.rs` swaps the store behind `doc_append_update` while
   * the shell is running, so an append that arrives *after* the swap and belongs
   * to the board *before* it would be written into the wrong board's log — a
   * failure nothing would notice until the next launch, on a board that was
   * never told.
   *
   * Nothing in Rust closes that, and nothing in Rust should: a lock there would
   * serialise the append against the switch and then let the append win. It is
   * closed here, by `close()` unsubscribing *before* it awaits `flush()`, and
   * `flush()` returning the serialisation chain — so once it resolves there is
   * nothing queued and nothing that can queue. `replaceWith` has leant on this
   * since T-84; the switch is the second caller, and this is the test that says
   * so out loud rather than leaving it as a property of the reading.
   */
  describe("closing", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("cannot be made to append after close resolves (T-358)", async () => {
      const store = new Store();
      const { board, persistence } = await session(store);
      polaroid(board, 0, 0);
      await persistence.close();

      const afterClose = store.appends;
      const inTheLog = await store.logLength();

      // Everything a board still on screen can do between the switch and the
      // reload: edits, and the timers that would have carried an earlier one.
      polaroid(board, 100, 100);
      setItemPoses(
        board,
        new Map([[polaroid(board, 5, 5), { x: 6, y: 6, rot: 0 }]]),
      );
      await persistence.flush();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(store.appends).toBe(afterClose);
      expect(await store.logLength()).toBe(inTheLog);
    });
  });

  /**
   * T-84's replace (Q-111): somebody else's document goes on the disk, and the
   * board still on screen must not get a word in edgeways on the way out.
   */
  describe("replacing the board with a bundle's document", () => {
    /** A document that is plainly not this session's. */
    async function elsewhere(): Promise<Uint8Array> {
      const other = openBoardDoc();
      initialiseBoard(other, "Somebody else's board");
      createItems(other, [{ type: "note", x: 900, y: 900, w: 100, h: 100 }]);
      return snapshot(other);
    }

    it("puts the bundle's document on the disk in place of this one", async () => {
      const store = new Store();
      const { board, persistence } = await session(store);
      polaroid(board, 10, 20);
      await persistence.flush();

      await persistence.replaceWith(await elsewhere());

      // What the next boot would load.
      const state: DocState = await store.docLoad();
      expect(state.updates).toEqual([]);
      const next = openBoardDoc();
      Y.applyUpdate(next.doc, state.snapshot!);
      expect(next.meta.get("title")).toBe("Somebody else's board");
      expect(next.items.size).toBe(1);
      expect(
        readItem([...next.items.keys()][0]!, [...next.items.values()][0]!)
          ?.type,
      ).toBe("note");
    });

    /**
     * The failure this exists to make impossible, and it is a silent one.
     *
     * Persistence batches ~200 ms of updates. A replace that compacted while
     * still following the live document would truncate the log to the new
     * snapshot and then append a frame of the *old* board on top of it — a file
     * that is two boards at once, with nothing anywhere reporting a problem.
     */
    it("stops following the old board before it writes, not after", async () => {
      const store = new Store();
      const { board, persistence } = await session(store);
      polaroid(board, 10, 20);

      await persistence.replaceWith(await elsewhere());

      // The board is still on screen and still being edited — a stray pointer,
      // a peer's update arriving, an animation settling.
      polaroid(board, 999, 999);
      polaroid(board, 998, 998);
      await persistence.flush();

      const state: DocState = await store.docLoad();
      expect(state.updates).toEqual([]);
      const next = openBoardDoc();
      Y.applyUpdate(next.doc, state.snapshot!);
      expect(next.items.size).toBe(1);
      expect(next.meta.get("title")).toBe("Somebody else's board");
    });

    it("sends what was pending rather than dropping it on the floor", async () => {
      const store = new Store();
      const { board, persistence } = await session(store);
      polaroid(board, 10, 20);
      // Un-flushed: the batch is still open when the replace arrives.
      expect(store.appends).toBe(0);

      await persistence.replaceWith(await elsewhere());
      expect(store.appends).toBe(1);
    });

    /**
     * Loud, because there is a window about to be reloaded. A replace that
     * quietly failed would come back as the board the user was just told had
     * gone.
     */
    it("refuses rather than reporting when the store is read-only", async () => {
      const store = new Store();
      const board = openBoardDoc();
      const persistence = new Persistence(board, store, { onError: () => {} });
      store.failing = true;
      vi.spyOn(store, "docLoad").mockRejectedValueOnce(
        new Error("the disk said no"),
      );
      await persistence.open();
      expect(persistence.readOnly).toBe(true);

      await expect(persistence.replaceWith(await elsewhere())).rejects.toThrow(
        /read-only/,
      );
      expect(store.compactions).toBe(0);
    });
  });
});
