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

    const result = await sweepAssets(native, withPhotos(PHOTO, OTHER), { readOnly: false });

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

    const result = await sweepAssets(native, board(), { readOnly: false });

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

    expect(await sweepAssets(native, board(), { readOnly: true })).toBeNull();
    expect(gc).not.toHaveBeenCalled();
  });

  /** Housekeeping nobody asked for does not become an error somebody has to see. */
  it("swallows a store that cannot be walked", async () => {
    const gc = vi.fn<Gc>(async () => {
      throw new Error("the asset directory is not there");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await sweepAssets(store(gc).native, withPhotos(PHOTO), { readOnly: false })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
