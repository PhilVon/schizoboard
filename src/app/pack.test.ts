/**
 * Giving a board a file of its own, and the two properties that matter.
 *
 * It has to actually home a board that has no file — the migration is the one
 * thing in T-356 that must not go wrong. And every way of failing has to leave
 * the board exactly where it was, saying so, with a way to try again: a
 * migration that can fail and has no manual path leaves somebody stuck.
 */

import { describe, expect, it, vi } from "vitest";

import { HOME_DELAY_MS, homeBoard, packSpec } from "@/app/pack";
import { ASSET_SWEEP_DELAY_MS } from "@/app/assetgc";
import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { createItems } from "@/crdt/ops";
import { SCHEMA_VERSION } from "@/crdt/schema";
import type { BoardCard, BundleWritten, Platform } from "@/platform/types";

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
