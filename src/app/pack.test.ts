/**
 * The coarse tier of saving: giving a board a file of its own, and keeping that
 * file up to date afterwards.
 *
 * The properties that matter are the same on both halves and they pull in
 * opposite directions. It has to actually write — the migration is the one
 * thing in T-356 that must not go wrong, and a file silently a session behind
 * is the one somebody hands over. And every way of failing has to leave the
 * board exactly where it was, saying so, with a way through: the workshop is
 * the crash-safe copy, so this tier is allowed to skip a beat, but it is not
 * allowed to skip one quietly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOME_DELAY_MS, homeBoard, Pack, packSpec } from "@/app/pack";
import { ASSET_SWEEP_DELAY_MS } from "@/app/assetgc";
import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { createItems } from "@/crdt/ops";
import { SCHEMA_VERSION } from "@/crdt/schema";
import type { BoardCard, BundleSpec, BundleWritten, Platform } from "@/platform/types";

const PHOTO = "a".repeat(64);
const OTHER = "b".repeat(64);

function board(...assetIds: string[]): BoardDoc {
  const doc = openBoardDoc();
  initialiseBoard(doc);
  if (assetIds.length > 0) {
    createItems(
      doc,
      assetIds.map((assetId) => ({
        type: "polaroid" as const,
        x: 0,
        y: 0,
        w: 200,
        h: 240,
        assetId,
      })),
    );
  }
  return doc;
}

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    packId: "0".repeat(32),
    title: "Untitled board",
    folder: "",
    homed: false,
    current: true,
    ...over,
  };
}

const WROTE: BundleWritten = {
  packId: "0".repeat(32),
  embedded: 0,
  missing: [],
  bytes: 4096,
};

/**
 * The two calls this module makes, and nothing else — a shell that answered
 * more than it is asked would hide a call that should not be happening.
 *
 * `boardCurrent` takes a queue rather than one value because the register is
 * read twice, and the second read is *after* the home: the whole point of it is
 * that the answer has changed.
 */
function shell(cards: (BoardCard | null)[], home: Platform["boardHome"] = vi.fn(async () => WROTE)) {
  const queue = [...cards];
  const boardCurrent = vi.fn(async () => (queue.length > 1 ? queue.shift()! : (queue[0] ?? null)));
  return {
    native: { boardCurrent, boardHome: home } as unknown as Platform,
    boardCurrent,
    home: vi.mocked(home),
  };
}

describe("the spec every writer of a pack builds", () => {
  it("carries the schema, the title and every asset the board refers to", () => {
    const doc = board(PHOTO, OTHER);
    doc.meta.set("title", "Case one");

    const spec = packSpec(doc);

    expect(spec.schemaVersion).toBe(SCHEMA_VERSION);
    expect(spec.title).toBe("Case one");
    expect([...spec.assets].sort()).toEqual([PHOTO, OTHER].sort());
  });

  /**
   * The file has to be called *something*, and an untitled board is the
   * ordinary state of the one board this migration exists for.
   */
  it("names an untitled board rather than handing the shell an empty string", () => {
    expect(packSpec(board()).title).toBe("Untitled board");
  });
});

describe("giving a board a file of its own", () => {
  it("writes the board out and reports where the shell put it", async () => {
    const { native, home } = shell([card(), card({ homed: true, folder: "Schizoboard" })]);

    const homing = await homeBoard(native, board(PHOTO));

    expect(homing).toEqual({ kind: "homed", folder: "Schizoboard", bytes: 4096, missing: [] });
    expect(home).toHaveBeenCalledTimes(1);
    const [spec, snapshot] = home.mock.calls[0]!;
    expect(spec.assets).toEqual([PHOTO]);
    // A real document, not an empty one: the pack holds the board as it is now,
    // which is the whole reason this runs on this side of the boundary rather
    // than in Rust — the merge of snapshot and log frames is a Yjs operation.
    expect(snapshot.byteLength).toBeGreaterThan(0);
  });

  /**
   * Every launch after the first, and the reason the outcome is nullable rather
   * than a third case: nothing happening is not news.
   */
  it("does nothing at all to a board that already has one", async () => {
    const { native, home } = shell([card({ homed: true, folder: "Schizoboard" })]);

    expect(await homeBoard(native, board())).toBeNull();
    expect(home).not.toHaveBeenCalled();
  });

  /**
   * A plain browser. `boardCurrent` answers `null` there because a board is not
   * a file on that platform and never will be — which must not read as "a board
   * with no file", or every tab would try to write one.
   */
  it("does nothing on a platform where a board is not a file", async () => {
    const { native, home } = shell([null]);

    expect(await homeBoard(native, board())).toBeNull();
    expect(home).not.toHaveBeenCalled();
  });

  /**
   * AC-1005. No Documents folder, a full disk, a permission. `board_home`
   * writes the pack *before* it records the home, so the board is still running
   * out of its workshop and the only thing missing is the file.
   */
  it("reports a failure rather than throwing, so the board goes on running", async () => {
    const refused = new Error("this machine has no Documents folder");
    const { native } = shell(
      [card()],
      vi.fn(async () => {
        throw refused;
      }),
    );

    expect(await homeBoard(native, board())).toEqual({ kind: "failed", error: refused });
  });

  /** The same, one step earlier: a shell that will not say which board this is. */
  it("reports a failure when the register itself will not answer", async () => {
    const broken = new Error("the board register failed to open");
    const boardCurrent = vi.fn(async () => {
      throw broken;
    });
    const home = vi.fn(async () => WROTE);
    const native = { boardCurrent, boardHome: home } as unknown as Platform;

    expect(await homeBoard(native, board())).toEqual({ kind: "failed", error: broken });
    // And it did not go on to write a file for a board it could not name.
    expect(home).not.toHaveBeenCalled();
  });

  /**
   * The file is written and the home is recorded by the time the folder is
   * asked for. Losing the outcome over that last read would report a migration
   * that worked as one that did not — the worst of the three answers.
   */
  it("still reports a home when the register will not say where it went", async () => {
    const boardCurrent = vi
      .fn<Platform["boardCurrent"]>()
      .mockResolvedValueOnce(card())
      .mockRejectedValueOnce(new Error("gone"));
    const native = {
      boardCurrent,
      boardHome: vi.fn(async () => WROTE),
    } as unknown as Platform;

    expect(await homeBoard(native, board())).toEqual({
      kind: "homed",
      folder: "",
      bytes: 4096,
      missing: [],
    });
  });

  /**
   * DESIGN section 11.1's fourth risk, read at migration time. A board can
   * genuinely be missing a photograph — it arrived from a peer that has gone —
   * and the file is still worth having. It is the person whose board it is who
   * needs to know the file is not the whole of it.
   */
  it("carries out what the file turned out not to contain", async () => {
    const { native } = shell(
      [card(), card({ homed: true, folder: "Schizoboard" })],
      vi.fn(async () => ({ ...WROTE, embedded: 1, missing: [OTHER] })),
    );

    const homing = await homeBoard(native, board(PHOTO, OTHER));

    expect(homing).toMatchObject({ kind: "homed", missing: [OTHER] });
  });
});

describe("when it happens", () => {
  /**
   * The file has to exist before anything starts reclaiming bytes against the
   * board it holds. Asserted rather than left to two constants in two files
   * drifting past each other.
   */
  it("homes a board long before the asset sweep runs", () => {
    expect(HOME_DELAY_MS).toBeLessThan(ASSET_SWEEP_DELAY_MS);
  });
});

describe("when the board's own file is rewritten", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const IDLE = 5_000;

  /** A shell that records every flush and can be made to refuse. */
  function flushing(over: Partial<BundleWritten> | null = {}) {
    const flushes: { assets: string[]; bytes: number }[] = [];
    let refusing: Error | null = null;
    const answer: BundleWritten | null = over === null ? null : { ...WROTE, ...over };
    /** Runs while a flush is in flight — the gap a late edit lands in. */
    let during: (() => void) | null = null;
    const boardFlush = vi.fn(async (spec: BundleSpec, snap: Uint8Array) => {
      if (refusing) throw refusing;
      flushes.push({ assets: [...spec.assets], bytes: snap.byteLength });
      during?.();
      return answer;
    });
    return {
      native: { boardFlush } as unknown as Platform,
      flushes,
      calls: () => boardFlush.mock.calls.length,
      refuse: (error: Error | null) => {
        refusing = error;
      },
      whileWriting: (run: (() => void) | null) => {
        during = run;
      },
    };
  }

  it("writes nothing at all until the document has reached the disk", async () => {
    const shell = flushing();
    const pack = new Pack(board(PHOTO), shell.native);

    await vi.advanceTimersByTimeAsync(IDLE * 3);

    // No subscriber to the document, so a board nobody has written to disk is a
    // board whose file nobody rewrites.
    expect(shell.calls()).toBe(0);
    expect(pack.pending).toBe(false);
  });

  it("writes the file once the board has been quiet for the idle interval", async () => {
    const shell = flushing();
    const pack = new Pack(board(PHOTO), shell.native, { idleMs: IDLE });

    pack.wrote();
    expect(pack.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(shell.calls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(shell.flushes).toHaveLength(1);
    expect(shell.flushes[0]!.assets).toEqual([PHOTO]);
    expect(shell.flushes[0]!.bytes).toBeGreaterThan(0);
    expect(pack.pending).toBe(false);
  });

  /**
   * The rearm, and the property that makes an idle interval an idle interval
   * rather than a period: a board being worked on continuously is never
   * interrupted by a whole-file rewrite.
   */
  it("pushes the write out again on every write to the document", async () => {
    const shell = flushing();
    const pack = new Pack(board(), shell.native, { idleMs: IDLE });

    for (let i = 0; i < 5; i++) {
      pack.wrote();
      await vi.advanceTimersByTimeAsync(IDLE - 500);
    }
    expect(shell.calls()).toBe(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(shell.calls()).toBe(1);
  });

  it("settles when a caller needs the file written before a switch", async () => {
    const shell = flushing();
    const pack = new Pack(board(), shell.native, { idleMs: IDLE });
    pack.wrote();

    await pack.flushNow();

    // Written, and without waiting out the timer — which is the point: this is
    // what `switchToBoard` awaits before it closes the fine tier.
    expect(shell.calls()).toBe(1);
    expect(pack.pending).toBe(false);
    // And the timer it disarmed does not fire a second one behind it.
    await vi.advanceTimersByTimeAsync(IDLE * 2);
    expect(shell.calls()).toBe(1);
  });

  it("asks for nothing when there is nothing owed", async () => {
    const shell = flushing();
    const pack = new Pack(board(), shell.native);

    await pack.flushNow();

    expect(shell.calls()).toBe(0);
  });

  it("starts a write on the way out without waiting for one", async () => {
    const shell = flushing();
    const pack = new Pack(board(), shell.native, { idleMs: IDLE });
    pack.wrote();

    // A pagehide handler cannot await, so this returns immediately — but the
    // call has to be *issued* before the task that is unloading the page ends,
    // and one microtask turn is inside that task. No timer is advanced here on
    // purpose: a flush that needed the idle interval would be one a quit never
    // reaches.
    pack.flushBestEffort();
    await Promise.resolve();

    expect(shell.calls()).toBe(1);
  });

  /**
   * AC-1010. `packSpec` reads the document through `readItem`, so on a board
   * from a newer build a future item's photograph is in no asset list — a file
   * written here would be missing photographs plainly on the board, and it is
   * the file that gets handed to somebody.
   */
  it("stops for good on a board this build may only partly read", async () => {
    const shell = flushing();
    const pack = new Pack(board(), shell.native, { idleMs: IDLE });
    pack.wrote();

    pack.seal();

    await vi.advanceTimersByTimeAsync(IDLE * 3);
    pack.wrote();
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    await pack.flushNow();
    pack.flushBestEffort();
    expect(shell.calls()).toBe(0);
  });

  /**
   * AC-1011, and stage 2 deletes it. Stage 1's flush is `bundle::write`, a
   * whole-file copy: on a board of photographs that is gigabytes of disk every
   * time somebody pauses.
   */
  it("stands the idle write down once the file is too big to rewrite on a pause", async () => {
    const shell = flushing({ bytes: 300 * 1024 * 1024 });
    const pack = new Pack(board(), shell.native, {
      idleMs: IDLE,
      idleLimitBytes: 256 * 1024 * 1024,
    });

    // The first one has to happen, because the size is a fact about a file that
    // does not exist until it has been written once.
    pack.wrote();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(shell.calls()).toBe(1);

    pack.wrote();
    await vi.advanceTimersByTimeAsync(IDLE * 5);
    expect(shell.calls()).toBe(1);
    // Owed, and it says so — the two moments that cannot be skipped still take
    // it, which is the whole of what the gate costs.
    expect(pack.pending).toBe(true);
    await pack.flushNow();
    expect(shell.calls()).toBe(2);
  });

  it("goes on writing on idle while the file is small enough to", async () => {
    const shell = flushing({ bytes: 4096 });
    const pack = new Pack(board(), shell.native, {
      idleMs: IDLE,
      idleLimitBytes: 256 * 1024 * 1024,
    });

    for (let i = 0; i < 3; i++) {
      pack.wrote();
      await vi.advanceTimersByTimeAsync(IDLE);
    }
    expect(shell.calls()).toBe(3);
  });

  /** AC-1009, and it is `crdt/persistence.ts`'s pair kept rather than resembled. */
  it("says so once when the file will not write, and once when it writes again", async () => {
    const shell = flushing();
    const errors: unknown[] = [];
    let recovered = 0;
    const pack = new Pack(board(), shell.native, {
      idleMs: IDLE,
      onError: (error) => errors.push(error),
      onRecovered: () => {
        recovered += 1;
      },
    });

    shell.refuse(new Error("the disk said no"));
    for (let i = 0; i < 3; i++) {
      pack.wrote();
      await vi.advanceTimersByTimeAsync(IDLE);
    }
    // One report per run of failures. A disconnected disk is one piece of news.
    expect(errors).toHaveLength(1);
    expect(recovered).toBe(0);
    // And the write is still owed, so nothing has been quietly dropped.
    expect(pack.pending).toBe(true);

    shell.refuse(null);
    pack.wrote();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(recovered).toBe(1);
    expect(pack.pending).toBe(false);

    // Silent from here — a standing sentence taken down twice is a sentence
    // that was never standing.
    pack.wrote();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(recovered).toBe(1);
    expect(errors).toHaveLength(1);
  });

  /**
   * A board with no file of its own — the adopted pre-T-356 one, in the second
   * and a half before `homeBoard` runs. The shell answers `null` rather than
   * failing, and it must not read as "written".
   */
  it("stays owed when there is no file to write to yet", async () => {
    const shell = flushing(null);
    const errors: unknown[] = [];
    const pack = new Pack(board(), shell.native, {
      idleMs: IDLE,
      onError: (error) => errors.push(error),
    });

    pack.wrote();
    await vi.advanceTimersByTimeAsync(IDLE);

    expect(pack.pending).toBe(true);
    // Not a failure, so nothing is said about it.
    expect(errors).toHaveLength(0);
    // And it does not spin: only a write to the document arms the timer.
    await vi.advanceTimersByTimeAsync(IDLE * 5);
    expect(shell.calls()).toBe(1);
  });

  /**
   * AC-1013. The flag `app/assetgc.ts` stands its sweep down on, and the only
   * thing in the application that knows the answer — because only the thing
   * that wrote the file knows what went into it.
   */
  describe("and whether the file holds everything", () => {
    it("says no until a flush has actually happened", () => {
      const pack = new Pack(board(PHOTO), flushing().native, { idleMs: IDLE });

      // Not "probably yes because nothing has gone wrong". A board nobody has
      // written this session has a file that may hold anything at all.
      expect(pack.packedCleanly).toBe(false);
    });

    it("says yes once a flush has gone out with nothing missing", async () => {
      const shell = flushing({ missing: [] });
      const pack = new Pack(board(PHOTO), shell.native, { idleMs: IDLE });

      pack.wrote();
      await vi.advanceTimersByTimeAsync(IDLE);

      expect(pack.packedCleanly).toBe(true);
    });

    /**
     * The state the whole flag exists for: a photograph that arrived from a
     * peer after the last flush is on this disk and in no pack, so a sweep run
     * against another board's keep-set would put the only copy in the trash.
     */
    it("says no when the file went out without a photograph the board refers to", async () => {
      const shell = flushing({ missing: [OTHER] });
      const pack = new Pack(board(PHOTO, OTHER), shell.native, { idleMs: IDLE });

      pack.wrote();
      await vi.advanceTimersByTimeAsync(IDLE);

      expect(pack.packedCleanly).toBe(false);
    });

    it("goes back to no when a write fails after one that worked", async () => {
      const shell = flushing({ missing: [] });
      const pack = new Pack(board(PHOTO), shell.native, { idleMs: IDLE, onError: () => {} });

      pack.wrote();
      await vi.advanceTimersByTimeAsync(IDLE);
      expect(pack.packedCleanly).toBe(true);

      shell.refuse(new Error("the disk said no"));
      pack.wrote();
      await vi.advanceTimersByTimeAsync(IDLE);
      expect(pack.packedCleanly).toBe(false);
    });

    it("says no for a board with no file of its own to be packed into", async () => {
      const shell = flushing(null);
      const pack = new Pack(board(PHOTO), shell.native, { idleMs: IDLE });

      pack.wrote();
      await vi.advanceTimersByTimeAsync(IDLE);

      expect(pack.packedCleanly).toBe(false);
    });

    it("says no on a board this build may only partly read", async () => {
      const shell = flushing({ missing: [] });
      const pack = new Pack(board(PHOTO), shell.native, { idleMs: IDLE });
      pack.wrote();
      await vi.advanceTimersByTimeAsync(IDLE);
      expect(pack.packedCleanly).toBe(true);

      // `packSpec` cannot see a future build's items, so what it last reported
      // as complete was complete only as far as this build can read.
      pack.seal();

      expect(pack.packedCleanly).toBe(false);
    });
  });

  /**
   * The window between the document being read and the write returning is a
   * real one on a large board, and an edit that lands inside it is not in the
   * file that is being written. Clearing the flag *after* the write would
   * swallow exactly the edits made during the slowest writes, which are the
   * ones on the largest boards.
   */
  it("keeps an edit that landed while the file was being written", async () => {
    const shell = flushing();
    const pack = new Pack(board(), shell.native, { idleMs: IDLE });
    shell.whileWriting(() => pack.wrote());
    pack.wrote();

    await pack.flushNow();

    expect(pack.pending).toBe(true);
    // And that edit gets its own write on the next idle interval, rather than
    // waiting for whatever happens to be edited next.
    shell.whileWriting(null);
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(shell.calls()).toBe(2);
  });
});
