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

import { createQuoteCard, quoteCardText } from "@/crdt/ops/quote";
import type { BoardDoc } from "@/crdt/doc";
import type { AssetInput } from "@/crdt/ops/items";
import { noteSizeFor } from "@/app/ingest";
import { OPEN_PAGE_TURN, pageReference, timeReference } from "@/lib/objects";
import { polaroidFor } from "@/lib/polaroid";
import { rotateOut } from "@/lib/rotate";
import type { PageContent, PageCue } from "@/platform/types";
import type { RasterCamera, RasterReport } from "@/render/items/raster";
import type { Bounds, Camera, ScreenBox, Vec2 } from "@/state/camera";
import type { Scene } from "@/state/scene";

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
  /** When each line on this page was said, for a transcript — see `PageCue`. */
  readonly cues: readonly PageCue[];
  /**
   * The recording this page is a transcript *of*, or null for a case file —
   * T-287, Q-301.
   *
   * **A quote off a transcript is cited to the tape and never to the sidecar.**
   * The fields above describe the document being read, which for a recording is
   * a `.srt` nobody put on the wall and nobody thinks of as having pages: a card
   * reading `interview.srt p. 1` names the wrong file and gives a number that
   * cannot be followed back to a moment. What somebody wants to find again is
   * the recording, at the point the words were said.
   */
  readonly of: TranscriptOf | null;
}

/** The recording behind a transcript — what its citation names. */
export interface TranscriptOf {
  readonly sha256: string;
  readonly origName: string | null;
}

/** What the rectangle caught, and where on the page it started. */
export interface Passage {
  readonly text: string;
  /** Into the page's own text, in the units a `Range` counts in — see `PageCue`. */
  readonly at: number;
}

/**
 * What the card says it came from — `scan.pdf p. 4`, or `interview.mp3 12:04`.
 *
 * One function, called by both arms, for the reason `quoteCardText` is one
 * function: the three kinds reference themselves in three different units and
 * the card only ever says one of them out loud (`crdt/ops/quote.ts`). Two call
 * sites each choosing would be two ways for a clipping and a quotation off the
 * same page to disagree about where they came from.
 *
 * `at` is where the passage started, in the page's own text. It decides
 * *which* cue is cited and nothing else — a page reference has no use for it,
 * and a transcript with no cue before that point cites the recording and stops,
 * which is the same weaker-but-honest form `pageReference` takes for a document
 * with no pages of its own.
 */
export function citationFor(page: ShownPage, at: number): string {
  const source = page.of;
  if (source === null) return pageReference(page.origName, page.sha256, page.index);
  return timeReference(source.origName, source.sha256, spokenAt(page.cues, at));
}

/**
 * When the cue containing this offset was said, or null before the first one.
 *
 * The last cue at or before the offset — a quote is cited from where it
 * *starts*, the way a page reference is. The cues arrive in order, so this
 * walks rather than searching; a page holds a few dozen of them.
 */
export function spokenAt(cues: readonly PageCue[], at: number): number | null {
  let said: number | null = null;
  for (const cue of cues) {
    if (cue.offset > at) break;
    said = cue.at;
  }
  return said;
}

/**
 * What a rectangle found under it on a typed page — T-331, Q-290.
 *
 * `drawn` is a figure with pixels on the sheet, and is the only one there is
 * anything to cut out of. `unliftable` is the box `document.rs` reports for a
 * figure it could not lift, holding the place where one was.
 */
export type FigureUnder = "drawn" | "unliftable";

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
   * The words under the rectangle on a typed page — Q-284's other half.
   *
   * Injected because it is a DOM question and this module has no business
   * asking one: the page is a single text node and the only way to a character
   * from a point is the document's own caret hit test. What is decided *here*
   * rather than at the wiring is which two points to ask about, which is
   * {@link screenQuad} and {@link readingCorners} below.
   *
   * `""` when the rectangle caught nothing, which is a real answer: a rectangle
   * dragged over the blank half of a page has no passage in it.
   *
   * **`at` comes back with the words** — where the passage started, in the
   * page's own text — because a transcript is cited by *when* rather than by
   * page (T-287) and only the caret hit test knows where in the page somebody
   * began. Finding the words again in the page text afterwards was the
   * alternative and it is wrong on the ordinary case: a transcript repeats
   * itself, and `indexOf` on "I asked him twice" would cite the first time it
   * was said rather than the time that was quoted. Zero for a page whose
   * offsets mean nothing, which is every page that carries no cues.
   */
  passage(itemId: string, rect: Bounds): Passage;
  /**
   * Whether the rectangle crossed a picture that is actually drawn on the page
   * — T-331, Q-290.
   *
   * Injected for the reason {@link passage} is, and it is the same question
   * asked of the other half of the page: where the words are is a DOM fact and
   * so is where the figures are. What is decided here rather than at the wiring
   * is {@link screenQuad} and {@link crosses} — which four points the rectangle
   * is, and what "crossed" means.
   *
   * **Which** figure it crossed matters, so this is not a boolean. One this
   * build could not lift is a box holding its place and a sentence saying why —
   * there is nothing to photograph, and telling somebody "there is nothing
   * written there" over a box that is at that moment explaining itself is a
   * sentence that argues with the page it is about. `null` is a rectangle that
   * crossed no figure at all.
   */
  figureUnder(itemId: string, rect: Bounds): FigureUnder | null;
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

    // What comes out is what was actually there (Q-284). A scan has pixels and
    // no text to select; a typed page has words, and lifting pixels off one
    // would photograph our own hand rather than the document.
    // **Q-290: a rectangle that crossed a picture wanted the picture.** This
    // arm did not exist while a typed page could not carry one — Q-284's fork
    // is "pixels on a scan, and the text under the rectangle on a typed page",
    // and the reason it gives is entirely about the re-set *words*: a table on
    // a typed page is soup before the rectangle arrives, so lifting pixels off
    // one would photograph our own hand. None of that is true of a figure. A
    // figure is the original image laid on our paper, which is exactly the
    // standing Q-199 gives a scan and the reason a scan is cut as pixels.
    //
    // So it is a third arm rather than a different answer, and it goes *first*:
    // selecting a passage already has its own way in, and a rectangle dragged
    // across a chart as well as the sentence under it has caught the one thing
    // no other gesture reaches.
    if (page.content.kind === "text") {
      const crossed = this.options.figureUnder(itemId, rect);
      if (crossed === "drawn") {
        this.inFlight += 1;
        void this.lift(itemId, rect, page).finally(() => {
          this.inFlight -= 1;
        });
        return;
      }
      if (crossed === "unliftable") {
        // Still the words if it caught any — Q-290 gives the picture the
        // rectangle, and here there is no picture to give. What changes is only
        // what is said when it caught nothing either.
        this.words(itemId, rect, page, "That picture could not be lifted off the page.");
        return;
      }
    }
    if (page.content.kind === "text" || page.content.kind === "plain") {
      this.words(itemId, rect, page);
      return;
    }
    if (page.content.kind !== "image") {
      // Blank, or a page this build cannot read. The sheet already says so in
      // its own words; there is nothing to cut out of it.
      this.options.say?.("There is nothing on that page to cut out.");
      return;
    }

    this.inFlight += 1;
    void this.lift(itemId, rect, page).finally(() => {
      this.inFlight -= 1;
    });
  }

  /**
   * The written arm: the words under the rectangle, on an index card.
   *
   * Synchronous, and the asymmetry with {@link lift} is the whole difference
   * between the two. A picture has to be rasterised, encoded and written to
   * disk before there is a hash to put in the document; a passage is already in
   * the page somebody is reading. So this lands in the same frame as the
   * release, and the card is the one `createQuoteCard` has built since T-281 —
   * no asset, no polaroid, no bytes.
   */
  /**
   * Which page this item is showing and what is on it, or null — T-283.
   *
   * The same resolution {@link cut} forks on, offered to the frame *before* the
   * release so that the words being marked under the rectangle can be gated on
   * the arm the cut is going to take. Straight through to the injected answer:
   * what this adds is that there is one join and both halves of the gesture use
   * it, rather than the marking growing a second opinion about which page is
   * open.
   */
  pageOf(itemId: string): ShownPage | null {
    return this.options.shownPage(itemId);
  }

  private words(
    itemId: string,
    rect: Bounds,
    page: ShownPage,
    whenEmpty = "There is nothing written there.",
  ): void {
    const caught = this.options.passage(itemId, rect);
    const said = caught.text.trim();
    // A rectangle over the blank half of a page. Nothing is written, so there
    // is no card, no pin and no string — AC-855, and the same answer the
    // picture arm gives when nothing could be drawn.
    if (said === "") {
      this.options.say?.(whenEmpty);
      return;
    }
    const { scene, board } = this.options;
    // Where the passage *started* and not where the reader is: a transcript is
    // cited by the moment its words were said (T-287), and a page reference
    // ignores the offset entirely.
    const reference = citationFor(page, caught.at);
    // Sized the way a pasted note is sized, off its own words — and off *all*
    // of them. A quote card is a note on index stock and there is no second
    // rule for how big one is, but the words on it are not the quote: they are
    // `quoteCardText`'s composition of the quote, a blank line and the citation.
    //
    // Sizing off `said` alone was two rows short of the card it then made, and
    // `.paper-text` is `overflow: hidden` — so on any quote past about three
    // lines the page reference was not merely at the bottom, it was off the
    // paper and unreachable at every zoom. Which is the one thing the card
    // exists to carry. `NOTE_MIN_H` hid it on short quotes, which is why it
    // came out of a driven run on a four-line one rather than out of a test.
    //
    // Composed here through the same function the write uses rather than
    // approximated, so the two cannot describe different strings.
    const size = noteSizeFor(quoteCardText(said, reference));
    const where = landing(scene, itemId, rect, size.w);
    if (where === null) return;

    createQuoteCard(
      board,
      {
        quote: said,
        reference,
        x: where.x,
        y: where.y,
        w: size.w,
        h: size.h,
        // `page.index` and not the reader's position read a second time: the
        // tape is stuck to the page the rectangle was drawn on — T-330.
        source: {
          itemId,
          lx: (rect.minX + rect.maxX) / 2,
          ly: (rect.minY + rect.maxY) / 2,
          page: page.index,
        },
      },
    );
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
        // Through the same function the written arm uses. A clipping is only
        // ever cut off a scan or a typed page, so in practice this is always
        // the page reference — but a lifted rectangle and a quotation off one
        // document must not be able to name it differently, and the offset a
        // picture has no use for is the one this hands over as zero.
        reference: citationFor(page, 0),
        x: where.x,
        y: where.y,
        w: size.w,
        h: size.h,
        // The page the rectangle was drawn on, which by now may not be the page
        // the reader is on — the bytes went to disk and back while it was in
        // flight, and the arrow keys work throughout (T-330).
        source: {
          itemId,
          lx: (rect.minX + rect.maxX) / 2,
          ly: (rect.minY + rect.maxY) / 2,
          page: page.index,
        },
        clipping: { sha256, asset },
      },
      // **No settle, and that is a consequence of the tape** (Q-286).
      //
      // `settleOnPin` writes an item's drawn pose when a new pin is about to
      // stop it hanging — one pin to two is rigid, and baking the pose is what
      // stops the paper jumping on that frame. A tape changes nothing about
      // how the page hangs, so there is nothing to bake, and passing it anyway
      // is not merely redundant: it writes the *momentary swing* into the
      // stored rotation. Driven, before this line was removed, three clippings
      // off one folder walked its `settledRot` 0 → 0.028 → -0.022 → 0.008 — a
      // document write, on every peer, nudging the paper a degree or so each
      // time somebody quoted it.
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

/**
 * The rectangle's four corners in **screen** space, or null.
 *
 * The same conversion `SelectTool.quadFrom` makes for the outline, and here for
 * the same reason one level on: the rectangle is square in the item's frame and
 * the page it is over is not square to anything. A caret hit test takes client
 * coordinates, so the corners have to come back out through the pose the item
 * is *drawn* at — swing, drift, open turn and all — or the two points asked
 * about are two points on a page that is no longer there.
 *
 * Clockwise from the rectangle's own origin, like the tool's own quad.
 */
export function screenQuad(
  scene: Scene,
  camera: Camera,
  itemId: string,
  rect: Bounds,
): readonly Vec2[] | null {
  const slot = scene.slotOf(itemId);
  if (slot === undefined) return null;
  const angle = scene.renderRot(slot);
  const cx = scene.renderX(slot);
  const cy = scene.renderY(slot);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners: Vec2[] = [];
  for (const [lx, ly] of [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [rect.minX, rect.maxY],
  ] as const) {
    const board = rotateOut(lx, ly, cx, cy, cos, sin);
    const at = camera.boardToScreen(board.x, board.y);
    corners.push({ x: at.x, y: at.y });
  }
  return corners;
}

/**
 * Which two of the four corners a passage runs *between* — reading order, not
 * rectangle order.
 *
 * **The rectangle's own `minX`/`minY` corner is the wrong answer and it is
 * wrong by exactly a quarter turn.** The page lies at {@link OPEN_PAGE_TURN}
 * inside the folder, so the corner with the smallest local coordinates is not
 * the corner the text starts at — on an open folder it is the *bottom left* of
 * what somebody is looking at. Reading order is a fact about the screen, so it
 * is decided on the screen: the first corner is the highest one, and the last
 * is the lowest, with leftmost and rightmost breaking a tie.
 *
 * Doing it this way means nothing here knows about the folder's turn, the
 * item's scatter or the camera. A page at any angle reads from its own top
 * corner, which is what a person means by "from here to there".
 */
export function readingCorners(corners: readonly Vec2[]): readonly [Vec2, Vec2] | null {
  if (corners.length !== 4) return null;
  let first = corners[0]!;
  let last = corners[0]!;
  for (const at of corners) {
    if (at.y < first.y || (at.y === first.y && at.x < first.x)) first = at;
    if (at.y > last.y || (at.y === last.y && at.x > last.x)) last = at;
  }
  return [first, last];
}

/**
 * Widen `[start, end)` to whole words — the difference between a quotation and
 * a substring.
 *
 * A caret hit test lands between two characters, so a rectangle dragged over a
 * line of a filing came back as *"ed the vehicle parked outside the premises."*
 * — driven on the real app, and read off the card. That is not a passage from
 * the document; it is a fragment of one with the front bitten off, and it goes
 * on a wall as evidence.
 *
 * So the ends are pushed out rather than in: a rectangle that catches any part
 * of a word has caught the word. Pulling them *in* would be the other obvious
 * rule and it is worse in the one case that matters — a rectangle drawn tightly
 * around a single word would come back empty.
 *
 * Whitespace is the only boundary. Punctuation stays attached to the word it is
 * attached to, because a quotation that drops its own full stop reads as an
 * unfinished sentence, and the citation goes underneath rather than after it.
 */
export function toWordBounds(text: string, start: number, end: number): readonly [number, number] {
  const from = Math.max(0, Math.min(start, end, text.length));
  const to = Math.max(0, Math.max(start, end), 0);
  let a = Math.min(from, text.length);
  let b = Math.min(to, text.length);
  while (a > 0 && !isSpace(text[a - 1]!)) a -= 1;
  while (b < text.length && !isSpace(text[b]!)) b += 1;
  return [a, b];
}

/** A newline is a boundary as much as a space is: a quote that runs off the end
 *  of one line and onto the next has crossed a word gap, not a word. */
function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * What is written between two carets, as a quotation of the *document* — T-332.
 *
 * Here rather than in `app/main.ts` beside the hit test that produces the two
 * carets, on the standing rule this file's `toWordBounds` is already an example
 * of: the wiring module has no tests, so a decision left there is a decision
 * nothing checks. What stays up there is the one call that needs a document.
 *
 * ## Why this is not `span.toString()`
 *
 * It was, and it was right while a page was one text node. T-320 wrote the
 * whole page onto `.leaf-body` with `writeHand`, so a caret anywhere on it
 * landed in the same node and a range across it was a substring. T-329 ended
 * that: a page carrying a figure is built out of `.leaf-lines` blocks with the
 * figure between them, and a rectangle spanning one — which is the ordinary way
 * to take the paragraph above a chart and the caption below it — is a range
 * over three elements. Driven on the real page, `toString()` gave
 *
 *     "pha betaBOARD SAYSgamma de"
 *
 * and every part of that is a defect:
 *
 * - **The board's own sentence is inside the quotation.** A figure this build
 *   could not lift says so where the figure was, and that is the *board*
 *   speaking about the document. Carrying it onto a card as though the document
 *   said it is the worst of the three by a distance — it is a quotation of
 *   something nobody wrote, going on a wall as evidence.
 * - **Both ends are bitten off**, because the whole-word repair was guarded on
 *   both carets landing in one node and they no longer do. That is the exact
 *   fragment — *"ed the vehicle parked outside the premises"* — that the repair
 *   was added to stop.
 * - **The blocks run together with no gap**, where the one text node had the
 *   line break the document put there.
 *
 * So the ends are widened in whatever node each one landed in — the same rule
 * applied twice rather than a second rule — and the text is taken block by
 * block, with the board's voice dropped.
 */
export function passageBetween(from: Range, to: Range): string {
  const span = passageSpan(from, to);
  return span === null ? "" : quotationIn(span);
}

/**
 * The stretch of the page a quotation would be taken from, or null — the first
 * half of {@link passageBetween}, split out for T-283.
 *
 * Both halves have a caller now. The quotation reads the text out of this; the
 * words drawn under the rectangle while somebody is still dragging
 * ({@link passageBoxes}) measure the same stretch on the screen. They must
 * agree, because the whole point of marking the words is that the card holds
 * what was marked — and two functions that each decided for themselves where a
 * passage starts would disagree on exactly the case this widening exists for.
 * So there is one answer to "which stretch", computed once, and the two things
 * that want it ask this.
 */
export function passageSpan(from: Range, to: Range): Range | null {
  const doc = from.startContainer.ownerDocument;
  if (doc === null) return null;
  // Both ends inside the board's own sentence about a figure: nothing of the
  // document was under the rectangle at all. One end inside it is dropped by
  // the walk below, which is the same answer arrived at one step later.
  if (inBoardVoice(from.startContainer) && inBoardVoice(to.startContainer)) return null;

  const span = doc.createRange();
  try {
    if (
      from.startContainer === to.startContainer &&
      typeof from.startContainer.textContent === "string"
    ) {
      // One node, which is every page with no figure on it. Unchanged, and the
      // two offsets go in together so a rectangle dragged right to left still
      // widens outwards rather than collapsing.
      const [a, b] = toWordBounds(
        from.startContainer.textContent,
        from.startOffset,
        to.startOffset,
      );
      span.setStart(from.startContainer, a);
      span.setEnd(from.startContainer, b);
    } else {
      span.setStart(from.startContainer, wordEdge(from, "start"));
      span.setEnd(to.startContainer, wordEdge(to, "end"));
    }
  } catch {
    // The two carets landed in nodes with no common order — a rectangle that
    // started on the page and ended off it. Nothing was selected.
    return null;
  }
  return span;
}

/**
 * Where the words a quotation would take are **on the screen** — T-283, Q-294.
 *
 * > Select a passage — and an index card comes out carrying the quote and its
 * > page reference. — D-46 section 3
 *
 * The rectangle is the gesture and this is what makes it a *selection*: until
 * the card landed there was no sign of which words had been caught, so a
 * quotation was something you found out about afterwards. What is drawn from
 * these boxes is the answer to "what will be on the card", asked of the same
 * span the card is built from.
 *
 * **Text node by text node rather than `span.getClientRects()` outright**, and
 * that is the whole of the work here. A range's own rects cover everything
 * between its ends including the sentence the board writes where a figure it
 * could not lift was — which `quotationIn` then drops. Marking words that are
 * not going to be on the card would be a worse lie than marking nothing: it
 * would be the board offering to quote itself.
 *
 * `rectsOf` is injected because a rect is a *layout*, and layout is the one
 * thing a test cannot have — happy-dom answers zeroes for all of it. What is
 * decided here is which stretches of which nodes are measured, and that is
 * exactly what a test can hold.
 */
export function passageBoxes(
  span: Range,
  rectsOf: (part: Range) => Iterable<ScreenBox>,
): readonly ScreenBox[] {
  const doc = span.startContainer.ownerDocument;
  if (doc === null) return [];
  const boxes: ScreenBox[] = [];
  for (const part of passageParts(span, doc)) {
    for (const box of rectsOf(part)) {
      // A collapsed part measures as a zero-width caret line. It is not a word
      // and drawing it would put a stray tick at the end of every selection.
      if (box.right > box.left && box.bottom > box.top) boxes.push(box);
    }
  }
  return boxes;
}

/**
 * The pieces of `span` whose text a quotation actually takes: every text node
 * it touches, clipped to its ends, minus the board's own voice.
 *
 * Exported for its tests. A whole page with no figure on it is one text node
 * and comes back as one part, which is the common case and the one the
 * quotation has always been.
 */
export function passageParts(span: Range, doc: Document): readonly Range[] {
  const root = span.commonAncestorContainer;
  const parts: Range[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  // A text node *is* the root when the range sits inside one, and a walker
  // never visits its own root — so that case is answered directly.
  const nodes: Text[] = root.nodeType === 3 ? [root as Text] : [];
  for (let at = walker.nextNode(); at !== null; at = walker.nextNode()) nodes.push(at as Text);

  for (const node of nodes) {
    if (inBoardVoice(node)) continue;
    const length = node.data.length;
    if (length === 0) continue;
    try {
      // Wholly before the span, or wholly after it — the walker visits every
      // text node under the common ancestor, and on a page with a figure that
      // is more than the two the rectangle actually crossed.
      if (span.comparePoint(node, length) < 0) continue;
      if (span.comparePoint(node, 0) > 0) continue;
      const part = doc.createRange();
      part.selectNodeContents(node);
      // Clipped to the span's own ends, so the first line is marked from the
      // word the widening chose rather than from the edge of the node.
      if (span.comparePoint(node, 0) < 0) part.setStart(span.startContainer, span.startOffset);
      if (span.comparePoint(node, length) > 0) part.setEnd(span.endContainer, span.endOffset);
      if (!part.collapsed) parts.push(part);
    } catch {
      // A node with no common order with the span — nothing to measure.
      continue;
    }
  }
  return parts;
}

/** One caret widened to the edge of the word it is standing in. */
function wordEdge(caret: Range, which: "start" | "end"): number {
  const text = caret.startContainer.textContent;
  if (typeof text !== "string") return caret.startOffset;
  const bounds = toWordBounds(text, caret.startOffset, caret.startOffset);
  return which === "start" ? bounds[0] : bounds[1];
}

/** Whether a node is inside the sentence the board writes where a figure it
 *  could not lift was — see `render/items/dom.ts`'s `figureNodes`. */
function inBoardVoice(node: Node): boolean {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return el?.closest(".leaf-figure-note") != null;
}

/**
 * The range's text, block by block, with the board's voice left out.
 *
 * The clone is what makes this affordable: `cloneContents` hands back the
 * selection as a tree, so a note can be *removed* rather than recognised
 * character by character in a string that has already lost the structure.
 *
 * Blocks join with a newline because that is what the page had. On a page with
 * no figures the fragment is a single text node and this returns it unchanged,
 * which is what keeps every page in every filing exactly as T-320 left it.
 */
export function quotationIn(span: Range): string {
  const cut = span.cloneContents();
  for (const note of [...cut.querySelectorAll(".leaf-figure-note")]) note.remove();
  return [...cut.childNodes]
    .map((node) => node.textContent ?? "")
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * Whether a rectangle **crossed** a box on the screen — T-331, Q-290.
 *
 * Crossing and not containing, and not "mostly over" either: the answer to
 * Q-290 is the sentence "a rectangle that crossed a picture wanted the
 * picture", and intersection is what that sentence means. Anything stricter
 * would need a threshold nobody can see while they are dragging, and the board
 * would do different things for the same gesture depending on a ratio that is
 * not drawn anywhere.
 *
 * The rectangle arrives as four screen points because the page it was dragged
 * on is turned — a quarter turn inside the folder, plus the folder's own
 * scatter — so it is a quad rather than a box. Its bounding box is what is
 * tested against, which is generous by up to the item's angle and generous in
 * the right direction: a folder somebody is reading is turned upright, the
 * angle left over is a degree or two of scatter, and a near miss reading as a
 * hit is a better failure than a rectangle drawn over a chart coming back as
 * the caption underneath it.
 *
 * Strict inequalities, so a rectangle whose edge merely lands on a figure's has
 * not crossed it.
 */
export function crosses(quad: readonly Vec2[], box: ScreenBox): boolean {
  if (quad.length === 0) return false;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const at of quad) {
    left = Math.min(left, at.x);
    top = Math.min(top, at.y);
    right = Math.max(right, at.x);
    bottom = Math.max(bottom, at.y);
  }
  return left < box.right && right > box.left && top < box.bottom && bottom > box.top;
}

/**
 * Which figure a rectangle crossed, out of the ones on the page — T-331.
 *
 * The decision rather than the query: the caller hands over every figure with
 * its box and whether it has pixels, and this says what the rectangle found.
 * Split that way for the reason `toWordBounds` and `passageBetween` are here —
 * the wiring module has no tests, so a rule left in it is a rule nothing
 * checks, and "which of two figures wins" is a rule.
 *
 * **A drawn figure wins over an unliftable one wherever they both were.** They
 * are different sentences to whoever dragged the rectangle, and a drag across
 * both has caught a picture; making it depend on which came first down the page
 * would be a coin toss nobody can see.
 */
export function figureCrossed(
  quad: readonly Vec2[],
  figures: readonly { readonly drawn: boolean; readonly box: ScreenBox }[],
): FigureUnder | null {
  let found: FigureUnder | null = null;
  for (const figure of figures) {
    if (!crosses(quad, figure.box)) continue;
    if (figure.drawn) return "drawn";
    found = "unliftable";
  }
  return found;
}
