/**
 * @vitest-environment happy-dom
 *
 * Ink on an open case file — T-278.
 *
 * The claim the task rests on is that redaction is nearly free: ink already
 * belongs to whatever it is over, in that thing's local space, so a black bar
 * over a name travels with the document. What is *not* free is that a folder is
 * the only thing on this board with two faces, and these are the four places
 * that fall out of it — which strokes are drawn, when the raster is rebuilt,
 * where the pen is allowed to write, and what a mark is clipped to.
 *
 * Its own file rather than more of `dom.test.ts` for `page.dom.test.ts`'s
 * reason: that one is already the largest test in this directory, and this is
 * about a document rather than about the item layer.
 *
 * happy-dom has no 2D context, so nothing here can assert a pixel. What it can
 * assert is the part that fails quietly — whether a canvas exists at all, and
 * the polygon three separate things read through one accessor.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { A4_UNITS, objectSizeFor, openSheetOf } from "@/lib/objects";
import { DomItemLayer, NO_FACTS, type AssetView } from "@/render/items/dom";
import { DirtySets } from "@/state/dirty";
import { Scene, type SceneStroke } from "@/state/scene";

const HASH = "3fa9c210".padEnd(64, "0");
const FOLDER = objectSizeFor("document")!;

let host: HTMLDivElement;
let scene: Scene;
let dirty: DirtySets;
/** The page the shell says is showing, which the harness moves the way a page
 *  turn does. Null is a folder that is shut, and every item that is not one. */
let showing: number | null;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  scene = new Scene();
  dirty = new DirtySets();
  showing = null;
});

const asset = (sha: string): AssetView => ({
  url: `asset://sha256/${sha}`,
  phase: "ready",
  fraction: 0,
});

function layer(): DomItemLayer {
  return new DomItemLayer(
    host,
    asset,
    () => ({ ...NO_FACTS, kind: "document", pages: 9, name: "R v Hartley.pdf" }),
    undefined,
    () => null,
    () => showing,
  );
}

function folder(id = "a"): void {
  scene.putItem(
    {
      id,
      type: "polaroid",
      z: "a0",
      seed: 1,
      assetId: HASH,
      createdBy: 1,
      createdAt: 0,
      text: "",
    },
    { x: 0, y: 0, rot: 0, w: FOLDER.w, h: FOLDER.h },
  );
  dirty.item(id);
}

/** A short horizontal mark at the item's centre, on `page`. */
function mark(id: string, page: number | null, at = 0): SceneStroke {
  return {
    id: `${id}-p${String(page)}`,
    tool: "marker",
    color: "#1f1b17",
    size: 6,
    opacity: 1,
    seed: 1,
    z: "a0",
    page,
    bbox: [-20, at, 20, at],
    samples: [
      { x: -20, y: at, pressure: 0.5 },
      { x: 20, y: at, pressure: 0.5 },
    ],
  };
}

function canvases(): HTMLCanvasElement[] {
  return [...host.querySelectorAll("canvas.item-ink")] as HTMLCanvasElement[];
}

/**
 * One frame: the DOM phase and the INK phase, and then the clear.
 *
 * **The clear is load-bearing and this helper exists for it.** `DirtySets` is
 * emptied at the end of every real frame, and a test that leaves it filling up
 * has an item permanently in `dirty.ink` — which repaints unconditionally and
 * would make everything below pass whatever the page rules did. Found by
 * sabotage: `stalePage` was disabled and the page-turn test still passed.
 */
function frame(l: DomItemLayer): void {
  l.sync(scene, dirty, null);
  l.paintInk(scene, dirty);
  dirty.clear();
}

/** Open the folder to `page` and draw a frame of it. */
function show(l: DomItemLayer, page: number | null): void {
  showing = page;
  scene.setOpen(page === null ? null : "a", page === null ? 0 : 1);
  dirty.item("a");
  frame(l);
}

describe("which marks an open case file shows", () => {
  it("shows the page you are on and none of the pages you are not", () => {
    const l = layer();
    folder();
    scene.putStrokes("a", [mark("a", 4)]);
    dirty.inkFor("a");

    // Open at page one, with the only mark on page four. Nothing to raster, so
    // there is no bitmap at all — not a blank one, which is the distinction
    // `InkCanvas` draws and the one a "did it draw" assertion would miss.
    show(l, 1);
    expect(canvases()).toHaveLength(0);

    // And page four, which is the whole feature in one line.
    show(l, 4);
    expect(canvases()).toHaveLength(1);
  });

  it("shows the cover when it is shut and hides what is on the pages", () => {
    const l = layer();
    folder();
    scene.putStrokes("a", [mark("a", 2)]);
    dirty.inkFor("a");

    // A redaction is on a page inside, and a shut folder is a piece of kraft.
    // The mark is still in the document — shutting a folder is not an erase —
    // and `strokesOf` still holds it; there is simply nowhere to draw it.
    show(l, null);
    expect(canvases()).toHaveLength(0);
    expect(scene.strokesOf("a")).toHaveLength(1);

    // Ink on the kraft itself is the opposite case and has to survive it.
    scene.putStrokes("a", [mark("a", null)]);
    dirty.inkFor("a");
    show(l, null);
    expect(canvases()).toHaveLength(1);
  });

  it("rebuilds the raster on a page turn, with nothing written to the document", () => {
    const l = layer();
    folder();
    scene.putStrokes("a", [mark("a", 3)]);
    dirty.inkFor("a");
    show(l, 3);
    expect(canvases()).toHaveLength(1);

    // The turn. No stroke is committed, no item is resized, and `dirty.ink` is
    // never raised — the only thing that changed is which page the shell says is
    // showing, which reaches the INK phase because the reader dirties the item.
    // Without `ItemInk.stalePage` this frame does nothing and page four keeps
    // page three's bar on it.
    showing = 4;
    dirty.item("a");
    frame(l);
    expect(canvases()).toHaveLength(0);
  });

  it("leaves an item with one face alone", () => {
    const l = layer();
    // A photograph is never open, so `shownPage` is null for it forever and its
    // ink is drawn through exactly the same rule rather than round it.
    scene.putItem(
      { id: "p", type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
      { x: 600, y: 0, rot: 0, w: 400, h: 400 },
    );
    scene.putStrokes("p", [mark("p", null)]);
    dirty.item("p");
    dirty.inkFor("p");
    frame(l);
    expect(canvases()).toHaveLength(1);
  });
});

describe("the paper an open case file offers the pen", () => {
  it("is the sheet standing in it, not the kraft round the sheet", () => {
    const l = layer();
    folder();
    frame(l);

    // Shut, a folder is its own rectangle and has no outline at all — the same
    // answer a photograph gives, and for the same reason: nothing with a file
    // behind it is cut to a ragged edge.
    expect(l.silhouetteOf(scene, "a")).toBeNull();

    scene.setOpen("a", 1);
    const sheet = l.silhouetteOf(scene, "a")!;
    expect(sheet).not.toBeNull();
    expect(sheet.n).toBe(4);

    const expected = openSheetOf(FOLDER.w, FOLDER.h);
    const xs = [0, 2, 4, 6].map((i) => sheet.points[i]!);
    const ys = [1, 3, 5, 7].map((i) => sheet.points[i]!);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(expected.w, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(expected.h, 6);
    // Centred on the item's own origin, which is what lets ink stored in the
    // item's frame land on the page without a second transform anywhere.
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0, 6);
    expect(Math.min(...ys) + Math.max(...ys)).toBeCloseTo(0, 6);
  });

  it("is A4 turned a quarter, which is why no geometry had to be re-cut", () => {
    // The sheet is A4 upright inside the folder and then rotated -90 degrees to
    // lie in it the way paper lies in a folder, so the box it occupies is A4's
    // height across and its width down. If these two ever swap, the page is
    // drawn portrait and the ink is clipped landscape.
    const sheet = openSheetOf(FOLDER.w, FOLDER.h);
    expect(sheet.w).toBeCloseTo(A4_UNITS.h, 6);
    expect(sheet.h).toBeCloseTo(A4_UNITS.w, 6);
    // Inside the folder in both axes, with a margin either way. A sheet wider
    // than its folder would put writable paper outside the item's own box.
    expect(sheet.w).toBeLessThan(FOLDER.w);
    expect(sheet.h).toBeLessThan(FOLDER.h);
  });

  it("scales with a folder that has been resized, because the stylesheet does", () => {
    // `items.css` places the sheet as two percentages of the item, so a folder
    // drawn at half size draws a half-size sheet. The pen has to agree with the
    // paper it can see or a mark lands on kraft.
    const half = openSheetOf(FOLDER.w / 2, FOLDER.h / 2);
    const full = openSheetOf(FOLDER.w, FOLDER.h);
    expect(half.w).toBeCloseTo(full.w / 2, 6);
    expect(half.h).toBeCloseTo(full.h / 2, 6);
  });

  it("refuses the pen the kraft margin while the folder is open", () => {
    const l = layer();
    folder();
    frame(l);

    // A point in the strip of board between the sheet's edge and the folder's,
    // which is about nine units and is what the reference photograph shows.
    const sheet = openSheetOf(FOLDER.w, FOLDER.h);
    const margin = (FOLDER.w - sheet.w) / 2;
    expect(margin).toBeGreaterThan(1);
    const x = sheet.w / 2 + margin / 2;

    // Shut, the whole kraft rectangle takes ink — you can write on a folder.
    expect(l.inkHitTest(scene, x, 0)).toBe("a");

    // Open, the folder has turned a quarter, so the same *item-local* point is
    // somewhere else on the board: `setOpen` rotates by +90 degrees about the
    // centre, which sends local (x, 0) to board (0, x). Asked through the turn
    // rather than around it, because the turn is exactly what makes this
    // interesting — the strip is in a different place and is still the strip.
    scene.setOpen("a", 1);
    expect(l.inkHitTest(scene, 0, x)).toBeNull();
    // That strip is no longer paper: the same divergence T-186 built for a torn
    // sheet, arriving at the one object whose writable surface changes shape
    // rather than being permanently smaller than its box.
    //
    // And what you can still pick up is unchanged — `hitTest` is what you grab
    // and `inkHitTest` is what you write on, which is Q-149's whole point.
    expect(l.hitTest(scene, 0, x)).toBe("a");
    // The sheet itself still takes ink, so this is a boundary moving rather than
    // an open folder refusing the pen outright.
    expect(l.inkHitTest(scene, 0, 0)).toBe("a");
  });
});
