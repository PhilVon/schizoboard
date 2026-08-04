/**
 * The sweep's policy, which is the whole of what this module adds — the
 * collecting itself is `assets.rs` and has its own tests over there.
 *
 * Two properties matter and they pull in opposite directions: it has to
 * actually collect (the defect was that nothing ever did), and it has to refuse
 * to collect in the one state where the keep set is a lie.
 */

import { describe, expect, it, vi } from "vitest";

import { sweepAssets } from "@/app/assetgc";
import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { createItems } from "@/crdt/ops";
import type { Platform } from "@/platform/types";

const PHOTO = "a".repeat(64);
const OTHER = "b".repeat(64);

function board(): BoardDoc {
  const doc = openBoardDoc();
  initialiseBoard(doc);
  return doc;
}

function withPhotos(...assetIds: string[]): BoardDoc {
  const doc = board();
  createItems(
    doc,
    assetIds.map((assetId) => ({ type: "polaroid" as const, x: 0, y: 0, w: 200, h: 240, assetId })),
  );
  return doc;
}

type Gc = Platform["assetGc"];

/** Only the one call this module makes. */
function store(gc: Gc = vi.fn<Gc>(async () => ({ freedBytes: 4096 }))) {
  return { native: { assetGc: gc } as unknown as Platform, gc: vi.mocked(gc) };
}

describe("sweeping the asset store", () => {
  it("collects everything the document does not refer to", async () => {
    const { native, gc } = store();

    const result = await sweepAssets(native, withPhotos(PHOTO, OTHER), { readOnly: false, packedCleanly: true });

    expect(gc).toHaveBeenCalledTimes(1);
    expect([...gc.mock.calls[0]![0]].sort()).toEqual([PHOTO, OTHER].sort());
    expect(result).toEqual({ freedBytes: 4096, kept: 2 });
  });

  /**
   * The board that has had every photograph taken off it is a real board, and
   * collecting all of them is the right answer. It is only wrong when the
   * emptiness is a *failure*, which is the next test.
   */
  it("collects everything when the board genuinely refers to nothing", async () => {
    const { native, gc } = store();

    const result = await sweepAssets(native, board(), { readOnly: false, packedCleanly: true });

    expect(gc).toHaveBeenCalledWith([]);
    expect(result).toEqual({ freedBytes: 4096, kept: 0 });
  });

  /**
   * The one that would hurt. A store that would not open leaves the board
   * empty, so every photograph on the disk reads as unreferenced and a sweep
   * would move the lot to the trash — reversible, and a hundred per cent wrong.
   * `crdt/persistence.ts` refuses to write a byte in this state; this refuses
   * to take one away.
   */
  it("does not collect at all when the document failed to load", async () => {
    const { native, gc } = store();

    expect(await sweepAssets(native, board(), { readOnly: true, packedCleanly: true })).toBeNull();
    expect(gc).not.toHaveBeenCalled();
  });

  /** Housekeeping nobody asked for does not become an error somebody has to see. */
  it("swallows a store that cannot be walked", async () => {
    const gc = vi.fn<Gc>(async () => {
      throw new Error("the asset directory is not there");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await sweepAssets(store(gc).native, withPhotos(PHOTO), { readOnly: false, packedCleanly: true })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * T-363, and the condition guards something this module cannot see.
   *
   * `assets/` is one store for the whole installation and `asset_gc` takes one
   * keep-set — the board this window is on. So a sweep does not merely collect
   * what this board has stopped referring to; it collects every photograph
   * belonging to every board this window is *not* on. That is survivable only
   * because each board's photographs are in its own pack and `take_up` puts
   * them back on the next open, which is what `packedCleanly` asserts.
   */
  describe("and the board's own file", () => {
    it("declines until this session has actually written the file", async () => {
      const { native, gc } = store();

      const result = await sweepAssets(native, withPhotos(PHOTO), {
        readOnly: false,
        packedCleanly: false,
      });

      expect(result).toBeNull();
      expect(gc).not.toHaveBeenCalled();
    });

    /**
     * AC-1014, stated as the thing that must not happen. A photograph that
     * arrived from a peer after the last flush is in the store and not in the
     * pack — so it is on this disk and nowhere else, and a sweep run against
     * some other board's keep-set would put the only copy in the trash.
     *
     * `missing` non-empty is exactly that state reported by the shell, and it
     * is what turns the flag off.
     */
    it("does not trash a photograph that arrived after the last flush", async () => {
      const { native, gc } = store();
      const board = withPhotos(PHOTO, OTHER);

      // The flush went out before OTHER arrived, so the file has one of the two
      // and the shell said so.
      const packed = { missing: [OTHER] };
      const result = await sweepAssets(native, board, {
        readOnly: false,
        packedCleanly: packed.missing.length === 0,
      });

      expect(result).toBeNull();
      expect(gc).not.toHaveBeenCalled();
    });

    it("collects once the file holds everything the board refers to", async () => {
      const { native, gc } = store();

      const result = await sweepAssets(native, withPhotos(PHOTO), {
        readOnly: false,
        packedCleanly: true,
      });

      expect(gc).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ freedBytes: 4096, kept: 1 });
    });

    /** Two conditions, and either one alone is enough to stand it down. */
    it("declines on a read-only board however cleanly it was packed", async () => {
      const { native, gc } = store();

      const result = await sweepAssets(native, withPhotos(PHOTO), {
        readOnly: true,
        packedCleanly: true,
      });

      expect(result).toBeNull();
      expect(gc).not.toHaveBeenCalled();
    });
  });
});
