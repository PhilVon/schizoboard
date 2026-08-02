import { beforeEach, describe, expect, it } from "vitest";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { checkInvariants } from "@/crdt/invariants";
import { createItems, itemText, registerAsset } from "@/crdt/ops/items";
import { readItem } from "@/crdt/schema";
import {
  CLIP_MAX_EDGE,
  CLIP_SCALE,
  Clipper,
  clipScale,
  landing,
  type ShownPage,
} from "@/app/clipping";
import type { PageContent } from "@/platform/types";
import type { RasterCamera, RasterReport } from "@/render/items/raster";
import type { Bounds } from "@/state/camera";
import { Scene } from "@/state/scene";

const SHA = "d0c5".padEnd(64, "0");
const CLIP_SHA = "c11b".padEnd(64, "0");

const SCAN: PageContent = {
  kind: "image",
  image: { mime: "image/jpeg", width: 1700, height: 2200, bytes: 402_118 },
};
const TYPED: PageContent = { kind: "text", runs: [], figures: [] };

let board: BoardDoc;
let scene: Scene;
let said: string[];
let ingested: Array<{ bytes: Uint8Array; mime: string }>;
let held: string[];
let rasterCalls: Array<{ itemId: string; camera: RasterCamera }>;
let canvases: Array<{ w: number; h: number }>;

/** What the reader would answer for the page on show. */
let page: ShownPage | null;
/** What the raster painter reports. Zero drawn is a real answer, not an error. */
let drawn: number;
/** What the encoder answers. Null is an encoder that refused. */
let encoded: { bytes: Uint8Array; mime: string } | null;

/**
 * A case file lying open, in the scene *and* in the document.
 *
 * Both, because the two halves are read by different people: `landing` asks the
 * scene where the paper is, and `createQuoteCard` reads the source out of the
 * document inside its own transaction and refuses one that is not there.
 */
function folder(x = 0, y = 0, rot = 0, w = 480, h = 344): string {
  // No pin of its own: a folder lying on the board is the ordinary case, and
  // it keeps the pin assertions below about the pin this gesture made.
  const [made] = createItems(board, [
    { type: "polaroid", x, y, w, h, assetId: SHA, withPin: false },
  ]);
  const id = made!.itemId;
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 3, assetId: SHA, createdBy: 1, createdAt: 0, text: "" },
    { x, y, rot, w, h },
  );
  return id;
}

function clipper(): Clipper {
  return new Clipper({
    board,
    scene,
    shownPage: () => page,
    rasterise: (itemId, _ctx, camera) => {
      rasterCalls.push({ itemId, camera: { ...camera } });
      return Promise.resolve({
        items: 1,
        drawn,
        inlined: 0,
        unreadable: 0,
        bytes: 0,
        inked: 0,
      } satisfies RasterReport);
    },
    canvas: (w, h) => {
      canvases.push({ w, h });
      // happy-dom has no 2D context, and what is worth checking here is the
      // arithmetic either side of the drawing rather than the drawing.
      return { width: w, height: h, getContext: () => ({}) } as unknown as HTMLCanvasElement;
    },
    encode: () => Promise.resolve(encoded),
    ingest: (bytes, mime) => {
      ingested.push({ bytes, mime });
      return Promise.resolve({ sha256: CLIP_SHA, w: 480, h: 300, size: bytes.length });
    },
    stored: (sha256) => held.push(sha256),
    say: (message) => said.push(message),
  });
}

function rect(minX: number, minY: number, maxX: number, maxY: number): Bounds {
  return { minX, minY, maxX, maxY };
}

/** The card a cut made, or null — anything in the document that is not the
 *  folder the cut came out of. */
function card(source: string): string | null {
  for (const id of board.items.keys()) if (id !== source) return id;
  return null;
}

/** Let the cut's promise chain drain. It is fire-and-forget by design: the
 *  pointer went up before any of it started. */
async function settled(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  board = openBoardDoc();
  initialiseBoard(board);
  scene = new Scene();
  said = [];
  ingested = [];
  held = [];
  rasterCalls = [];
  canvases = [];
  drawn = 1;
  encoded = { bytes: new Uint8Array([1, 2, 3, 4]), mime: "image/webp" };
  page = { sha256: SHA, index: 4, content: SCAN, origName: "scan.pdf" };
  registerAsset(
    board,
    SHA,
    { w: 0, h: 0, mime: "application/pdf", size: 9, origName: "scan.pdf" },
    0,
  );
});

describe("what a rectangle yields, by what is on the page", () => {
  it("lifts the pixels off a scanned page", async () => {
    // Q-284's first half, and D-46's "a scanned page is only quotable by
    // rectangle" — a scan has no text to select.
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.mime).toBe("image/webp");
    const made = card(id)!;
    expect(readItem(made, board.items.get(made)!)!.type).toBe("polaroid");
    expect(readItem(made, board.items.get(made)!)!.assetId).toBe(CLIP_SHA);
  });

  it("cuts nothing off a typed page, and says why", async () => {
    // Q-284's other half is the text under the rectangle, which is not built
    // yet. What must never happen meanwhile is a picture of our own hand being
    // stored as though it were the document.
    const id = folder();
    page = { sha256: SHA, index: 4, content: TYPED, origName: "scan.pdf" };
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    expect(card(id)).toBeNull();
    expect(said).toHaveLength(1);
  });

  it("does nothing at all on something that is not an open case file", async () => {
    // Silent, deliberately: this is the gesture asking a question rather than
    // a person being refused.
    const id = folder();
    page = null;
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    expect(said).toEqual([]);
  });

  it("writes the citation under the picture", async () => {
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();
    expect(itemText(board, card(id)!)?.toString()).toBe("scan.pdf p. 4");
  });

  it("comes out threaded, and leaves the document sound", async () => {
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(board.strings.size).toBe(1);
    // Two: one in the page where the rectangle was, one in the card.
    expect(board.pins.size).toBe(2);
    expect(checkInvariants(board)).toEqual([]);
  });

  it("puts the pin at the middle of the rectangle, in the page's own frame", async () => {
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    const parented = [...board.pins.values()]
      .map((map) => ({ parent: map.get("parent"), lx: map.get("lx"), ly: map.get("ly") }))
      .find((pin) => pin.parent === id)!;
    expect(parented.lx).toBeCloseTo(-20, 6);
    expect(parented.ly).toBeCloseTo(-5, 6);
  });

  it("holds the bytes it just wrote, rather than waiting to be told", async () => {
    // Without this the card draws as undeveloped film until the next idle
    // reconcile — what `PosterGrabber` says, for its reason.
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();
    expect(held).toEqual([CLIP_SHA]);
  });

  it("stores nothing when nothing could be drawn", async () => {
    // The item is not mounted, or its SVG would not parse — the failure
    // `rasteriseItems` counts rather than throws. A card carrying a blank
    // rectangle is worse than no card at all (AC-855).
    const id = folder();
    drawn = 0;
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    expect(card(id)).toBeNull();
    expect(said).toHaveLength(1);
  });

  it("stores nothing when the encoder refuses", async () => {
    const id = folder();
    encoded = null;
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    expect(card(id)).toBeNull();
    expect(said).toHaveLength(1);
  });

  it("refuses a second cut while the first is still in flight", async () => {
    // Not a correctness problem — each cut is its own transaction and its own
    // asset — but a rasterise plus an encode plus a disk write is long enough
    // for somebody to drag a second rectangle, and two cards arriving out of
    // order onto the same spot is a mess nobody asked for.
    const id = folder();
    const cut = clipper();
    cut.cut(id, rect(-100, -80, 60, 70));
    expect(cut.cutting).toBe(true);
    cut.cut(id, rect(0, 0, 40, 40));
    await settled();

    expect(ingested).toHaveLength(1);
    expect(cut.cutting).toBe(false);
  });

  it("sizes the canvas to the rectangle and aims the camera at its corner", async () => {
    // What makes the rectangle fill the canvas exactly: the item is drawn
    // square-on at the origin, so a local point lands at (local - camera) *
    // zoom.
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    // 160 by 150 board units, at three device pixels to the unit.
    expect(canvases[0]).toEqual({ w: 480, h: 450 });
    expect(rasterCalls[0]!.camera).toEqual({ x: -100, y: -80, zoom: CLIP_SCALE });
  });

  it("names the clipping after the document it came out of", async () => {
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();
    const made = card(id)!;
    const asset = board.assets.get(readItem(made, board.items.get(made)!)!.assetId!)!;
    expect(asset.get("origName")).toBe("scan.pdf");
  });
});

describe("how big a lifted clipping is", () => {
  it("is three device pixels to the board unit", () => {
    expect(clipScale(160, 150)).toBe(CLIP_SCALE);
  });

  it("comes down rather than running away on a rectangle dragged off the page", () => {
    // The gesture does not clamp to the paper, deliberately — clamping is a
    // thing you notice fighting. So the cap is reachable by a gesture rather
    // than only by a mistake.
    expect(clipScale(CLIP_MAX_EDGE, 10)).toBeCloseTo(1, 6);
    expect(clipScale(CLIP_MAX_EDGE * 3, 10) * CLIP_MAX_EDGE * 3).toBeCloseTo(CLIP_MAX_EDGE, 6);
  });

  it("caps on the longer edge, whichever one that is", () => {
    expect(clipScale(10, CLIP_MAX_EDGE)).toBeCloseTo(1, 6);
  });

  it("never returns a scale of zero for a rectangle with no size", () => {
    expect(clipScale(0, 0)).toBe(CLIP_SCALE);
  });
});

describe("where the card lands", () => {
  it("lands clear of the folder rather than over the page it came from", () => {
    // A card on top of the page would cover the thing it was cut from and put
    // its own string underneath itself.
    const id = folder();
    const box = scene.openBoundsOf(id)!;
    const at = landing(scene, id, rect(40, -20, 120, 40), 200)!;
    expect(at.x).toBeGreaterThan(box.maxX);
  });

  it("goes out the side the rectangle was nearer", () => {
    // So that cutting from the left column does not run a string across the
    // whole page to get out.
    const id = folder();
    const box = scene.openBoundsOf(id)!;
    const at = landing(scene, id, rect(-200, -20, -120, 40), 200)!;
    expect(at.x).toBeLessThan(box.minX);
  });

  it("sits level with the rectangle, so the string is short", () => {
    const id = folder();
    const at = landing(scene, id, rect(40, 60, 120, 100), 200)!;
    expect(at.y).toBeCloseTo(80, 6);
  });

  it("follows the page round when the folder is turned", () => {
    // The rectangle is the same rectangle in the page's frame either way, so a
    // turned folder has to put the card somewhere else on the board.
    const turned = folder(0, 0, 0.5);
    const flat = landing(scene, turned, rect(40, 60, 120, 100), 200)!;
    const square = folder(0, 0, 0);
    const level = landing(scene, square, rect(40, 60, 120, 100), 200)!;
    expect(flat.y).not.toBeCloseTo(level.y, 1);
  });

  it("has nowhere to put a card for an item that has gone", () => {
    expect(landing(scene, "nobody", rect(0, 0, 10, 10), 200)).toBeNull();
  });
});
