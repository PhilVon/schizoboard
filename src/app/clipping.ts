/**
 * Cutting a clipping out of a page — T-282, D-46 section 3.
 *
 * > Select a passage — or drag a rectangle over it, which also works on a scan,
 * > a chart and a table — and an index card comes out carrying the quote and
 * > its page reference. — D-46 section 3
 *
 * `state/tools/select.ts` owns the rectangle; this owns everything the
 * rectangle turns into. The split is not arbitrary — a tool may not touch the
 * DOM, may not await, and writes only through `BoardWriter`, and cutting a
 * clipping does all three: it reads what kind of page is on show, it rasterises
 * a piece of the item's own presentation, and it crosses to Rust to store the
 * bytes before it can write anything at all.
 *
 * ## The fork, which is the whole design
 *
 * **Q-284 — answered: pixels on a scan, and the text under the rectangle on a
 * typed page.** What comes out is what was actually there.
 *
 * That answer settled a finding rather than a preference. D-46 argued the
 * rectangle is the primary gesture because it survives "a table that would come
 * out as soup" — which is true of a scan, where Q-199 lays the original image
 * on our paper and the rectangle cuts the real filing. It is *not* true of a
 * typed page: Q-198 chose re-typesetting over facsimile, and `linesOfRuns`
 * takes the boxes Rust measured, works out where the lines were and throws the
 * boxes away. A table on a typed page is soup before the rectangle arrives, and
 * lifting pixels off one would photograph our own hand rather than the
 * document.
 *
 * ## And the object that comes out
 *
 * **Q-283 — answered: a polaroid.** A clipping is a picture, so it arrives on
 * the thing this board already draws pictures on, with the citation in the
 * caption. The written arm keeps the index card `createQuoteCard` has built
 * since T-281. One gesture, two objects, and each matches its content — a
 * photograph of a scan and a card of a quotation are different things and
 * should not look alike.
 *
 * ## What is deliberately not here
 *
 * Anything about *where* the rectangle came from. It arrives item-local and
 * un-rotated, square with the page, because the gesture measured it that way —
 * see `SelectTool.applyClip`. Nothing below converts a screen coordinate.
 */

import { createQuoteCard } from "@/crdt/ops/quote";
import type { BoardDoc } from "@/crdt/doc";
import type { AssetInput } from "@/crdt/ops/items";
import { OPEN_PAGE_TURN, pageReference } from "@/lib/objects";
import { polaroidFor } from "@/lib/polaroid";
import { rotateOut } from "@/lib/rotate";
import type { PageContent } from "@/platform/types";
import type { RasterCamera, RasterReport } from "@/render/items/raster";
import type { Bounds } from "@/state/camera";
import type { Scene } from "@/state/scene";
import { settleOnPin } from "@/state/tools/frame";

/**
 * Device pixels per board unit in a lifted clipping.
 *
 * Not the zoom the page was read at, which is the tempting answer and the wrong
 * one: a clipping is a *thing on the board* from the moment it lands, and it
 * gets dragged, zoomed into and exported like anything else. Sizing its pixels
 * to how close somebody happened to be standing when they cut it would make the
 * same rectangle on the same page produce a different object every time.
 *
 * Three, because the page's own type is `PAGE_TEXT_SIZE` of the folder's
 * width — about eight board units for an em on a 480-unit folder — and three
 * pixels a unit puts that at roughly a 25 px em, which is comfortably legible
 * and is about what the reading zoom shows. Below two it is mush; above four it
 * is bytes nobody looks at.
 */
export const CLIP_SCALE = 3;

/**
 * The longest edge a clipping may have, in pixels.
 *
 * A whole page at {@link CLIP_SCALE} is well inside this — a 480-unit folder is
 * 1,440 px across — so the cap is not for the ordinary case. It is for the
 * rectangle somebody drags off the edge of the paper and across the cork: the
 * gesture does not clamp to the page, deliberately, because clamping is a thing
 * you notice fighting. So the size does not run away, and a cut that is mostly
 * board comes back small rather than as a canvas nothing can encode.
 */
export const CLIP_MAX_EDGE = 2048;

/** How far off the folder the card lands, as a fraction of the card's width. */
const LANDING_GAP = 0.35;

/** WebP, like the poster frame, and at a higher quality than one: a still of a
 *  film is a thumbnail, and this is somebody's evidence with type on it. */
export const CLIP_MIME = "image/webp";
export const CLIP_QUALITY = 0.92;

/** The page on show, and what is on it — the reader's answer, resolved by the
 *  application because neither the reader nor the scene holds both halves. */
export interface ShownPage {
  /** The document's hash, which is half of what D-60 calls a page reference. */
  readonly sha256: string;
  /** One-based, the number printed on the page. */
  readonly index: number;
  readonly content: PageContent;
  /** What the file was called, for the citation. Null for a file nobody named. */
  readonly origName: string | null;
}

export interface ClipperOptions {
  readonly board: BoardDoc;
  readonly scene: Scene;
  /** Null for an item that is not a case file with a page on show. */
  shownPage(itemId: string): ShownPage | null;
  /**
   * Draw the item square-on in its own frame — `ItemLayer.rasteriseInFrame`.
   *
   * Injected rather than reached for, so that what this module does with the
   * pixels is testable without a renderer, a webview or a decoder — none of
   * which happy-dom has.
   */
  rasterise(
    itemId: string,
    ctx: CanvasRenderingContext2D,
    camera: RasterCamera,
  ): Promise<RasterReport>;
  /** A canvas of this many device pixels. Injected for the same reason. */
  canvas(w: number, h: number): HTMLCanvasElement;
  /** The canvas's pixels as bytes, or null if the encoder refused. */
  encode(canvas: HTMLCanvasElement): Promise<{ bytes: Uint8Array; mime: string } | null>;
  /** Store the bytes and hand back what the record needs — `assetIngestBytes`. */
  ingest(bytes: Uint8Array, mime: string): Promise<{ sha256: string; w: number; h: number; size: number }>;
  /** These bytes went into this store a moment ago, so this machine holds them. */
  stored(sha256: string): void;
  /**
   * Say a sentence to whoever is at the board — `Flash.say`, the same channel
   * a refused paste uses (Q-235).
   *
   * Optional for `Paste`'s reason: a `Clipper` in a test has nobody to talk to,
   * and a cut that cannot be announced is still refused.
   */
  say?: (message: string) => void;
}

/**
 * One gesture's worth of cutting.
 *
 * ## Cuts overlap, and that was not the first answer
 *
 * This began with a queue of one — refuse a cut while another is in flight, on
 * `PosterGrabber`'s argument that two cards arriving out of order onto the same
 * spot is a mess nobody asked for. **Driving it proved that wrong, and the way
 * it proved it is the point.** A rasterise plus an encode plus a disk write is
 * around two hundred milliseconds, which is well inside the time it takes to
 * drag a second rectangle — so in a run that cut three bands off one page, the
 * second and third produced *nothing at all*, silently, and looked exactly like
 * a gesture the board had ignored.
 *
 * That is the failure DESIGN section 1.3 is about. A deliberate gesture that
 * lands nowhere and says nothing is indistinguishable from a broken board, and
 * `Paste.sayWhatWasRefused` already wrote that argument down for files.
 *
 * The refusal could have been made to say a sentence instead. It is not worth
 * one: "wait for the last clipping" is an implementation detail leaking into a
 * corkboard, and the mess it was protecting against is not a harm — each cut is
 * its own transaction, its own asset and its own card, and two rectangles cut a
 * moment apart land level with the two rectangles rather than on each other.
 *
 * A class rather than a function because the count in flight is worth having:
 * it is what a run reads to know whether the last gesture has landed yet.
 */
export class Clipper {
  private readonly options: ClipperOptions;
  private inFlight = 0;

  constructor(options: ClipperOptions) {
    this.options = options;
  }

  /**
   * True while any cut is still in flight — the dev handle's readout.
   *
   * The one piece of state a run cannot otherwise see: a cut is fire and forget
   * from a gesture that is already over, so "has it landed" has no other answer.
   */
  get cutting(): boolean {
    return this.inFlight > 0;
  }

  /** How many cuts are in flight. Zero almost always. */
  get inFlightCount(): number {
    return this.inFlight;
  }

  /**
   * Cut `rect` — item-local, un-rotated — out of the page `itemId` is showing.
   *
   * Fire and forget, because the gesture that started it is over: the pointer
   * went up before any of this began. Failures say a sentence rather than
   * throwing, because there is nobody left holding the mouse to catch one.
   */
  cut(itemId: string, rect: Bounds): void {
    const page = this.options.shownPage(itemId);
    // Not a case file, or shut between the release and here. Silent: this is
    // the gesture asking a question, not a person being refused.
    if (page === null) return;

    if (page.content.kind !== "image") {
      // The written arm — the text under the rectangle, as an index card.
      // Q-284's other half, and not yet built.
      this.options.say?.("A rectangle cuts a picture out of a scan. This page is typed.");
      return;
    }

    this.inFlight += 1;
    void this.lift(itemId, rect, page).finally(() => {
      this.inFlight -= 1;
    });
  }

  /**
   * The picture arm: rasterise the rectangle, store it, hang it on the board.
   *
   * The item's own presentation is what is photographed, rather than the
   * original scan re-cropped, and that is a choice worth defending. Re-cropping
   * the source image would mean re-deriving in TypeScript where the sheet sits
   * inside the folder and how `object-fit: contain` placed the scan on it —
   * geometry that lives in CSS and that `tests/folder-open-css.test.ts` exists
   * to stop being written down twice. Photographing the presentation is exact
   * by construction: what comes out is what was on the screen, which is also
   * the honest meaning of a clipping.
   *
   * It carries the ink with it, which is not a side effect but the point.
   * `inlineInk` puts the item's own canvas into the clone, and an open folder's
   * canvas holds the marks made on *this* page (T-278) — so a redaction bar is
   * in the clipping, which is what D-61 promises of every artefact that leaves
   * this board.
   */
  private async lift(itemId: string, rect: Bounds, page: ShownPage): Promise<void> {
    const width = rect.maxX - rect.minX;
    const height = rect.maxY - rect.minY;
    const scale = clipScale(width, height);
    const px = Math.max(1, Math.round(width * scale));
    const py = Math.max(1, Math.round(height * scale));

    const flat = this.options.canvas(px, py);
    const ctx = flat.getContext("2d");
    if (ctx === null) return;

    const report = await this.options.rasterise(itemId, ctx, {
      x: rect.minX,
      y: rect.minY,
      zoom: scale,
    });
    // Nothing was drawn: the item is not mounted, or its SVG would not parse —
    // the failure `rasteriseItems` counts rather than throws. Either way there
    // is no picture, and a card carrying a blank rectangle is worse than no
    // card at all (AC-855).
    if (report.drawn === 0) {
      this.options.say?.("Nothing could be lifted off that page.");
      return;
    }

    const upright = this.upright(flat, px, py);
    if (upright === null) return;

    const encoded = await this.options.encode(upright);
    if (encoded === null) {
      this.options.say?.("That clipping could not be saved.");
      return;
    }

    const meta = await this.options.ingest(encoded.bytes, encoded.mime);
    // The bytes went into this store a moment ago, so this machine is a holder.
    // Saying so now rather than waiting for the reconciler is what stops the
    // card drawing as undeveloped film until the next idle sweep.
    this.options.stored(meta.sha256);

    const asset: AssetInput = {
      w: meta.w,
      h: meta.h,
      mime: encoded.mime,
      size: meta.size,
      // The clipping's own name is the document it came out of. A hash would
      // be the alternative and it says nothing: `caseNumber` falls back to one
      // precisely when there is no better answer, and here there is.
      origName: page.origName ?? undefined,
    };

    this.write(itemId, rect, page, meta.sha256, asset, meta.w, meta.h);
  }

  /**
   * Turn the lifted canvas back the quarter the page is turned inside the
   * folder — the difference between what was cut and what was seen.
   *
   * **This is the one place the two frames are not the same, and it was found
   * by driving rather than by reading.** The rectangle is square in the item's
   * own frame and has to be lifted in that frame, because that is the only
   * frame it *is* a rectangle in. But the page does not lie square in the
   * folder: `items.css` turns `.folder-page` by {@link OPEN_PAGE_TURN} so it
   * lies the way paper actually lies in a folder, and `Scene.setOpen` turns the
   * whole item by the opposite quarter when it opens, which is what leaves the
   * page upright on screen. Lift in the item's frame and you get the right
   * pixels lying on their side — a landscape rectangle came back 289 by 578.
   *
   * So the clipping is turned by the page's own turn, undone. Not by the item's
   * rendered angle, which would be wrong in the other direction: a folder's
   * seeded scatter belongs to the folder, and a clipping is a new object that
   * gets a scatter of its own.
   */
  private upright(flat: HTMLCanvasElement, px: number, py: number): HTMLCanvasElement | null {
    // The turn swaps the axes, exactly as `openSheetOf` does.
    const turned = this.options.canvas(py, px);
    const ctx = turned.getContext("2d");
    if (ctx === null) return null;
    ctx.translate(py / 2, px / 2);
    ctx.rotate(-OPEN_PAGE_TURN);
    ctx.drawImage(flat, -px / 2, -py / 2);
    return turned;
  }

  /** The card, the two pins and the string — one transaction (AC-851). */
  private write(
    itemId: string,
    rect: Bounds,
    page: ShownPage,
    sha256: string,
    asset: AssetInput,
    pxW: number,
    pxH: number,
  ): void {
    const { board, scene } = this.options;
    const size = polaroidFor(pxW, pxH);
    const where = landing(scene, itemId, rect, size.w);
    // Nothing to hang it off: the folder went while the bytes were being
    // stored. The asset stays in the store and the sweep collects it, which is
    // the same fate as any other orphan and needs no special case here.
    if (where === null) return;

    createQuoteCard(
      board,
      {
        // The picture is the passage, so the caption is the citation alone.
        quote: "",
        reference: pageReference(page.origName, page.sha256, page.index),
        x: where.x,
        y: where.y,
        w: size.w,
        h: size.h,
        source: { itemId, lx: (rect.minX + rect.maxX) / 2, ly: (rect.minY + rect.maxY) / 2 },
        clipping: { sha256, asset },
      },
      // A folder hanging on one pin stops hanging the moment this gesture puts
      // a second one in it, and the pose it was drawn at belongs in the same
      // transaction or the paper jumps on the frame the card arrives. Computed
      // here, after every await, because the folder has been swinging
      // throughout.
      settleOnPin(scene, [itemId]),
    );
  }
}

/**
 * Device pixels per board unit for a rectangle this size — {@link CLIP_SCALE},
 * unless that would make an edge longer than {@link CLIP_MAX_EDGE}.
 *
 * Exported because it is the one number in this file that is arithmetic rather
 * than plumbing, and the cap is reachable by a gesture rather than only by a
 * mistake — a rectangle dragged off the page and across the cork.
 */
export function clipScale(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (!(longest > 0)) return CLIP_SCALE;
  return Math.min(CLIP_SCALE, CLIP_MAX_EDGE / longest);
}

/**
 * Where the card lands: beside the open folder, on the side the rectangle was
 * nearer, level with it.
 *
 * **Beside and not on top**, which is the only rule here that matters. The card
 * arrives on a string from a pin in the page, and a card that landed over the
 * page would cover the thing it was cut from and put its own string underneath
 * itself. Level with the rectangle keeps that string short and readable as what
 * it is — this passage, pulled out to here.
 *
 * The side is chosen from where the rectangle sits across the page rather than
 * always going right, so that cutting from the left column does not run a
 * string over the whole page to get out.
 *
 * Null when the item has left the board.
 */
export function landing(
  scene: Scene,
  itemId: string,
  rect: Bounds,
  cardW: number,
): { x: number; y: number } | null {
  const slot = scene.slotOf(itemId);
  const box = scene.openBoundsOf(itemId);
  if (slot === undefined || box === null) return null;

  const angle = scene.renderRot(slot);
  const at = rotateOut(
    (rect.minX + rect.maxX) / 2,
    (rect.minY + rect.maxY) / 2,
    scene.renderX(slot),
    scene.renderY(slot),
    Math.cos(angle),
    Math.sin(angle),
  );

  const gap = cardW * (0.5 + LANDING_GAP);
  const middle = (box.minX + box.maxX) / 2;
  const x = at.x >= middle ? box.maxX + gap : box.minX - gap;
  return { x, y: at.y };
}
