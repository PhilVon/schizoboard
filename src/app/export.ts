/**
 * What an export contains, and how big it comes out.
 *
 * > Export exists for taking a picture of your thinking — DESIGN section 1
 *
 * Two questions, and neither of them is about drawing. **What** is in the file
 * (Q-127: the selection when there is one, the whole board when there is not),
 * and **how big** the page is. Both answers are the same shape for the image
 * route and the PDF route, which is why they live here rather than inside either
 * of them.
 *
 * ## Why this does not use `camera.fit`
 *
 * Because `fit` is for looking at a board and this is for leaving one. `fit`
 * clamps to `MIN_ZOOM`, which exists because the culler mounts hundreds of items
 * at low zoom and a frame has 16 milliseconds (T-204) — a constraint an export
 * does not have and must not inherit, since a board wider than the floor can
 * frame would come out cropped. So the view here is *derived from the page*
 * instead: the page is shaped like the board, and the camera that fills it is
 * arithmetic rather than a fit.
 *
 * That inversion is the point. The first PDF this project ever produced had the
 * board in one corner of a mostly empty page, because Chromium lays a print out
 * at the paper width — 1920 CSS pixels for a 20-inch page — and the camera had
 * been fitted for a 1440-pixel window and never heard about it (D-36). Page and
 * camera coming out of one calculation is what makes that impossible rather than
 * unlikely.
 *
 * ## Two ceilings, and they are not the same ceiling
 *
 * - **Raster.** This webview gives a canvas 65,535 in one dimension but only
 *   2^28 = 268 megapixels of area, measured (D-34). Over it, a canvas does not
 *   throw — it comes back blank, which is the worst way to fail.
 * - **PDF.** The format's own limit is 200 inches a side (14,400 points), which
 *   at 96 CSS pixels to the inch is 19,200 pixels. A 20,000-unit board crosses
 *   it at 1:1.
 *
 * Neither is a reason to refuse an export, so both are expressed as a *scale
 * that fits* rather than as an error. [`ExportView.scale`] says what was
 * actually possible and `ExportView.reduced` says whether that is less than was
 * asked for, so a caller can say so out loud instead of quietly handing over a
 * smaller board.
 */

import type { ImageFormat } from "@/platform/types";
import type { Bounds } from "@/state/scene";

/** CSS pixels to the inch. Chromium's print pipeline uses this and so must we,
 *  because the paper size is what decides the layout width. */
const CSS_PX_PER_INCH = 96;

/** The area a canvas may cover in this webview, measured rather than assumed. */
export const MAX_CANVAS_PIXELS = 268_435_456;

/** The longest single canvas dimension, likewise. */
export const MAX_CANVAS_SIDE = 65_535;

/** A PDF page may be 200 inches a side — 14,400 points, the format's own limit. */
export const MAX_PDF_INCHES = 200;

/**
 * Room round the edge, in board units rather than screen pixels.
 *
 * Board units because an export has no screen: a margin in pixels would be a
 * different amount of cork depending on the scale, and the whole point is that
 * the file looks the same whatever size it comes out at. Small, because this is
 * a picture of a wall and not a mounted print — a wide mat would read as a
 * frame somebody chose.
 */
export const EXPORT_MARGIN = 48;

export interface ExportView {
  /** Board rectangle the file covers, margin included. */
  readonly bounds: Bounds;
  /** Board coordinate at the file's top-left corner. */
  readonly x: number;
  readonly y: number;
  /** Board units to output pixels — the camera zoom an export draws at. */
  readonly zoom: number;
  /** Output size in pixels, which for the print route is also the layout size. */
  readonly width: number;
  readonly height: number;
  /** The page, for a route that thinks in paper. */
  readonly inches: { readonly width: number; readonly height: number };
  /** What was asked for, so a caller can tell whether it got it. */
  readonly asked: number;
  /** Whether a ceiling brought the scale down. */
  readonly reduced: boolean;
}

/**
 * Where an export has got to.
 *
 * Here rather than in either route because both of them take minutes and both
 * of them do it while the board has zoomed itself out to its own bounds and
 * stopped answering — which is indistinguishable from having hung. The two
 * pipelines share the framing and nothing else: an image is drawn and encoded
 * in the renderer, a PDF is rendered by Chromium on the far side of a command,
 * so the phases in between are genuinely different work and are named for what
 * each is actually doing.
 *
 * Coarse on purpose. Per-painter milliseconds go to the console because they
 * are a developer's question; a person waiting wants to know it is still going
 * and roughly what it is doing.
 */
export type ExportPhase =
  /** Moving the camera to the whole board and letting it settle. Both routes. */
  | { readonly at: "framing" }
  /** The six painters, start to finish. Image only. */
  | { readonly at: "drawing" }
  /** Turning the canvas into a file. The long one, image only. */
  | { readonly at: "encoding"; readonly format: ImageFormat }
  /** Reading the file back to check the encoder did not crop it. Image only. */
  | { readonly at: "checking" }
  /** Handing finished bytes to the shell. Image only, and quick. */
  | { readonly at: "writing" }
  /** Chromium laying the document out and writing the file. The long one, PDF
   *  only — and unlike the image route it happens on the far side of a command,
   *  so this side knows only that it has started. */
  | { readonly at: "printing" };

/**
 * What to put on screen for each phase.
 *
 * Here rather than in `app/main.ts` on the standing argument: the wiring module
 * has no tests, so wording left there is wording nothing checks — and these are
 * the only sentences in the application somebody reads while *waiting*, which
 * is when a vague one is most expensive.
 *
 * No ellipsis on the two slow ones: they carry a running count of seconds
 * instead, and a number that is going up says "still working" in a way three
 * dots do not.
 */
export function phraseFor(phase: ExportPhase): string {
  switch (phase.at) {
    case "framing":
      return "Framing the board…";
    case "drawing":
      return "Drawing the board…";
    case "encoding":
      return `Encoding as ${phase.format === "webp" ? "WebP" : "PNG"}`;
    case "checking":
      return "Checking the file…";
    case "writing":
      return "Saving…";
    case "printing":
      return "Printing the board";
  }
}

/**
 * Whether this phase is long enough to need a clock under it.
 *
 * The two that are: encoding a canvas and printing a document. Neither offers
 * any progress of its own — `toBlob` has no callback and the print is a single
 * command on the far side of the boundary — so without a number going up they
 * are a sentence that has not changed in a minute, which reads exactly like a
 * window that has stopped.
 *
 * A predicate rather than a flag on each variant, because it is a fact about
 * how long the work takes rather than about what the work is, and the answer
 * has already changed once: `printing` was added after the counter existed.
 */
export function phaseTicks(phase: ExportPhase): boolean {
  return phase.at === "encoding" || phase.at === "printing";
}

export interface ExportLimits {
  /** Output pixels per board unit. 2 is the useful default: a note's writing is
   *  19 units tall, and at 1:1 it is 19 pixels in the file. */
  scale?: number;
  maxPixels?: number;
  maxSide?: number;
  margin?: number;
}

/**
 * The rectangle an export covers: the selection when there is one, and the whole
 * board when there is not (Q-127).
 *
 * Selection *bounds*, not the selected items alone — the region, with whatever
 * else is in it. Hiding the neighbours would leave holes where a string passes
 * behind a note and where a shadow falls across one, and the honest description
 * of the gesture is "a picture of that part of the wall" rather than "a cutout
 * of these three things".
 *
 * `boundsOfMany` and `contentBounds` are the same two calls `F` and `Ctrl+0`
 * already frame with, so an export cannot disagree with what those show.
 */
export function exportBounds(
  scene: {
    boundsOfMany(ids: Iterable<string>): Bounds | null;
    contentBounds(): Bounds | null;
  },
  selection: Iterable<string>,
): Bounds | null {
  const held = [...selection];
  if (held.length > 0) {
    const picked = scene.boundsOfMany(held);
    if (picked !== null) return picked;
  }
  return scene.contentBounds();
}

/**
 * The page and the camera that fills it, from one calculation.
 *
 * The scale comes down — never the framing — when a ceiling is in the way, so
 * every export contains the whole of what was asked for and only its resolution
 * is negotiable. Cropping to fit would be the one failure a user could not see
 * in the file they were handed.
 */
export function exportView(bounds: Bounds, limits: ExportLimits = {}): ExportView {
  const asked = limits.scale ?? 2;
  const margin = limits.margin ?? EXPORT_MARGIN;
  const maxPixels = limits.maxPixels ?? MAX_CANVAS_PIXELS;
  const maxSide = limits.maxSide ?? MAX_CANVAS_SIDE;

  const framed: Bounds = {
    minX: bounds.minX - margin,
    minY: bounds.minY - margin,
    maxX: bounds.maxX + margin,
    maxY: bounds.maxY + margin,
  };
  // A board with one item on it is a rectangle of zero area in one axis if that
  // item has no size, and a zero divides into every scale below.
  const bw = Math.max(1, framed.maxX - framed.minX);
  const bh = Math.max(1, framed.maxY - framed.minY);

  let scale = asked;
  // Area first, then each side: a long thin board can be inside the area
  // ceiling and still over the dimension one.
  scale = Math.min(scale, Math.sqrt(maxPixels / (bw * bh)));
  scale = Math.min(scale, maxSide / bw, maxSide / bh);
  // Floored to a hundredth rather than rounded, so a scale that only just fits
  // cannot round back up over the ceiling it was computed from.
  scale = Math.max(0.01, Math.floor(scale * 100) / 100);

  // The page is whole pixels — it has to be, a canvas and a paper size both are
  // — and the camera is then *derived from the page* rather than computed beside
  // it. Both from one scale was the arrangement that let them disagree: at
  // 40,000 units the product landed a hair under a whole pixel, the page floored
  // down and the zoom did not, and the board over-filled its own file by a pixel.
  // Deriving means the x axis is exact by construction and y is inside one pixel,
  // which is as close as one zoom can hold two axes of integers.
  const width = Math.max(1, Math.floor(bw * scale));
  const zoom = width / bw;
  // Floored, not rounded: rounding up could put the last row of pixels over the
  // ceiling this scale was computed to stay inside.
  const height = Math.max(1, Math.floor(bh * zoom));

  return {
    bounds: framed,
    x: framed.minX,
    y: framed.minY,
    zoom,
    width,
    height,
    inches: { width: width / CSS_PX_PER_INCH, height: height / CSS_PX_PER_INCH },
    asked,
    reduced: scale < asked,
  };
}

/**
 * The same thing for the print route, whose ceiling is paper rather than pixels.
 *
 * A separate entry point rather than an argument, because the two routes fail at
 * different sizes for unrelated reasons and a single default would be wrong for
 * one of them. The scale defaults to 1 here: the handwriting is vector in a PDF
 * (D-36), so nothing is gained by asking Chromium to lay the board out twice as
 * large — it would only make the photographs and the ink canvases resample
 * further from their stored size.
 */
export function exportPage(bounds: Bounds, limits: ExportLimits = {}): ExportView {
  return exportView(bounds, {
    scale: limits.scale ?? 1,
    margin: limits.margin,
    maxPixels: limits.maxPixels ?? Number.POSITIVE_INFINITY,
    maxSide: limits.maxSide ?? MAX_PDF_INCHES * CSS_PX_PER_INCH,
  });
}
