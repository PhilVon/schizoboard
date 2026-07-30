/**
 * The board as one picture, composited from the five painters (T-206).
 *
 * The PDF route next door hands the live document to Chromium and gets vector
 * text back (D-36); this one draws. That difference is the whole reason both
 * exist — a PDF is the board as *text and lines*, an image is the board as
 * pixels, and neither is a worse version of the other.
 *
 * What is here is the composite and the ordering. What is *not* here is any
 * drawing: cork paints itself, the board ink paints itself, both rope layers
 * paint themselves, and since D-37 the item layer does too. This module knows
 * the order they go in and nothing about what any of them puts down.
 *
 * ## The order is the render stack, and it is not a preference
 *
 * `render/world.ts` stacks cork, board ink, ropes-under, items, ropes-over. An
 * export that reordered any of that would be a picture of a board nobody has:
 * a string that passes *behind* a photograph on screen and in front of it in
 * the file is the kind of wrongness nobody can prove without the two side by
 * side. So the order comes in as a list and the list is the same list.
 *
 * The overlay, the pins' chrome and the HUD are deliberately absent — an export
 * is the board, not the window on it, which is the same call T-208 makes for
 * the print.
 *
 * ## Nothing here is synchronous
 *
 * An item becomes pixels by being decoded as an image, and cork tiles have to
 * be loaded before they can be tiled. So the composite is a loop of `await`s
 * rather than a loop, and painters that have nothing to wait for simply return.
 */

import type { ImageFormat } from "@/platform/types";
import type { Bounds } from "@/state/scene";

import {
  exportView,
  type ExportLimits,
  type ExportPhase,
  type ExportView,
} from "@/app/export";
import { posed, type Stage } from "@/app/exportPdf";

/**
 * One layer of the board, as an export asks it to draw.
 *
 * A `name` on it because this is the interface a missing layer hides behind:
 * the composite cannot tell a painter that drew nothing from a painter that was
 * never in the list, and [`ImageOutcome.painted`] is what makes the difference
 * visible from outside.
 */
export interface BoardPainter {
  readonly name: string;
  /**
   * `unknown` rather than `void`, and deliberately loose: the layers report
   * different things — tiles drawn, whether anything was drawn at all, what the
   * items cost — and none of it is the composite's business. What matters is
   * that a painter can be handed over *as it is*. Narrowing this to `void` is
   * how an `await` gets dropped: the call site grows a `void` to make the types
   * line up, and a dropped await here is a layer landing after the one that
   * should be on top of it.
   */
  paint(ctx: CanvasRenderingContext2D, view: ExportView): unknown;
}

/** The board's surface, and somewhere to put the file. */
export interface ImageStage extends Stage {
  /**
   * A canvas of this size, cleared.
   *
   * Injected rather than created here so the ceiling has one owner: `exportView`
   * has already brought the scale down to something a canvas can hold (D-34's
   * measured 268 megapixels), and a caller that wants to render into something
   * else — an `OffscreenCanvas`, a test double — does not have to fight a
   * `document.createElement` buried in a composite.
   */
  canvas(width: number, height: number): HTMLCanvasElement;
  /** The painters, in render-stack order. */
  readonly painters: readonly BoardPainter[];
  /** The canvas as the bytes of a file, in the format the dialog settled on. */
  encode(canvas: HTMLCanvasElement, format: ImageFormat): Promise<Uint8Array>;
  /**
   * How big the encoded file actually turned out, by reading it back.
   *
   * Because an encoder is allowed to disagree with what it was handed and
   * Chromium's WebP one does: over 16383 pixels on a side it truncates rather
   * than refusing, and hands back a valid file with part of the board missing.
   * Nothing else in this pipeline can notice that — the canvas was right, the
   * blob is real, the file opens — so the only way to know is to look.
   */
  measure(bytes: Uint8Array, format: ImageFormat): Promise<{ width: number; height: number }>;
  /**
   * A monotonic clock, injected so the timings above are a fact a test can
   * assert rather than a number that changes every run.
   */
  now(): number;
}

/** Ask first, then draw — `exportPdf`'s argument for the pair, unchanged: a
 *  cancelled dialog must not have cost a re-pose of the board. */
export interface ImageWriter {
  /**
   * The format the user settled on, or `null` for a cancelled dialog.
   *
   * A format rather than a yes, because the dialog is where it is chosen: PNG
   * and WebP are two filters on one save dialog, not two rows on the board's
   * menu. Anything the shell does not recognise arrives as `png`, which is the
   * safe direction — it is lossless and it always encodes.
   */
  choose(title: string): Promise<ImageFormat | null>;
  write(bytes: Uint8Array): Promise<string>;
}

export type ImageOutcome =
  /** Nothing on the board, so nothing to take a picture of. */
  | { readonly done: "empty" }
  /** The dialog was closed. The board never moved. */
  | { readonly done: "cancelled" }
  | {
      readonly done: "saved";
      readonly path: string;
      readonly view: ExportView;
      /**
       * Which painters ran, in order, and what each cost.
       *
       * The names alone are the readout that says a layer made it into the file
       * — a missing one leaves no trace of itself, so the board simply has no
       * strings on it and looks like a board with no strings. The milliseconds
       * are here because an export of a large board is *slow*, in minutes
       * rather than seconds, and "which part" is otherwise unanswerable from
       * outside: every painter is somebody else's module and the whole thing is
       * one `await` from here.
       */
      readonly painted: readonly PainterCost[];
      /** Which format it came out as, since the dialog chose and not the caller. */
      readonly format: ImageFormat;
      /** What turning the canvas into a file cost, which on a board near the
       *  canvas ceiling is the largest number here by a distance. */
      readonly encodeMs: number;
      /** And what the file came to. */
      readonly bytes: number;
    };

/** One layer's share of an export. */
export interface PainterCost {
  readonly name: string;
  readonly ms: number;
}

/**
 * Export the board — or the selection, if there is one — as an image.
 *
 * `bounds` is `exportBounds(scene, selection)`, taken by the caller because the
 * scene and the selection are theirs; `null` means an empty board.
 */
export async function exportImage(
  stage: ImageStage,
  bounds: Bounds | null,
  title: string,
  writer: ImageWriter,
  limits: ExportLimits = {},
  report: (phase: ExportPhase) => void = () => {},
): Promise<ImageOutcome> {
  if (bounds === null) return { done: "empty" };

  // Before anything moves, and for the reason `exportPdf` sets out: a board
  // that rearranges itself while somebody is still typing a filename is the
  // window answering a question about a file by moving.
  const format = await writer.choose(title);
  if (format === null) return { done: "cancelled" };

  // The ceiling depends on what is being written, so the view cannot be
  // computed until the dialog has answered — which is the second reason the
  // pair is ordered this way, and it fell out of the first.
  const view = exportView(bounds, { ...ceilingFor(format), ...limits });
  const painted: PainterCost[] = [];
  let encodeMs = 0;

  const bytes = await posed(
    stage,
    view,
    async () => {
      const canvas = stage.canvas(view.width, view.height);
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("no 2d context for a board this size");
      report({ at: "drawing" });
      for (const painter of stage.painters) {
        const at = stage.now();
        await painter.paint(ctx, view);
        painted.push({ name: painter.name, ms: Math.round(stage.now() - at) });
      }

      report({ at: "encoding", format });
      const at = stage.now();
      const encoded = await stage.encode(canvas, format);
      encodeMs = Math.round(stage.now() - at);

      // The file is not handed over until it has been read back. An encoder
      // that quietly dropped part of the board would otherwise reach somebody's
      // disk looking exactly like a board that small.
      report({ at: "checking" });
      const actual = await stage.measure(encoded, format);
      if (actual.width !== canvas.width || actual.height !== canvas.height) {
        throw new Error(
          `the ${format} encoder returned ${actual.width}×${actual.height} for a ` +
            `${canvas.width}×${canvas.height} board — part of it would have been missing`,
        );
      }
      return encoded;
    },
    // Reported from inside `posed`, because the framing is the part where the
    // board visibly rearranges itself and is therefore the part most in need of
    // a word. It is also the first thing that happens after the dialog closes.
    () => report({ at: "framing" }),
  );

  report({ at: "writing" });
  const path = await writer.write(bytes);
  return { done: "saved", path, view, painted, format, encodeMs, bytes: bytes.length };
}

/**
 * The longest side a WebP may have — the format's own limit, and the one that
 * bites without saying anything.
 *
 * **Chromium does not refuse an over-wide canvas; it truncates it.** A
 * 19092 × 10412 board encoded to a perfectly valid 21 MB WebP that is
 * 16383 × 10412, with the right-hand seventh of the board simply not in it.
 * `toBlob` succeeded, the file opens, and nothing anywhere says a column of
 * photographs is missing. That is worse than the blank canvas D-34 warned about,
 * because a blank one is obvious.
 *
 * It is also why the pixel ceiling below cannot be trusted on its own: every
 * "this size encodes fine" measurement taken before this was found had been
 * silently truncated first, so the sizes that appeared to work were smaller
 * than the sizes that were asked for.
 */
export const MAX_WEBP_SIDE = 16_383;

/**
 * And how many pixels, once it is inside that.
 *
 * A second, separate limit, because 16383 × 16383 is 268 megapixels and
 * Chromium's WebP encoder gives up well below that — by returning `null`, which
 * at least fails loudly. Re-measured after the truncation was found, in terms
 * of what actually came out rather than what was asked for:
 *
 *     14000 × 8600  → 120 MP   15 MB   worked
 *     16383 × 10412 → 171 MP   21 MB   worked
 *     16383 × 11000 → 180 MP   23 MB   worked
 *     16383 × 12096 → 198 MP   null
 *
 * So 160 megapixels: comfortably inside the last known-good, and a bound on
 * something content-dependent rather than a documented constant, which is why
 * [`ImageStage.measure`] checks what came out instead of trusting this.
 */
export const MAX_WEBP_PIXELS = 160_000_000;

function ceilingFor(format: ImageFormat): ExportLimits {
  return format === "webp"
    ? { maxPixels: MAX_WEBP_PIXELS, maxSide: MAX_WEBP_SIDE }
    : {};
}
