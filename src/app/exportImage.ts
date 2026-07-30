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

import type { Bounds } from "@/state/scene";

import { exportView, type ExportLimits, type ExportView } from "@/app/export";
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
  paint(ctx: CanvasRenderingContext2D, view: ExportView): void | Promise<void>;
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
  /** The canvas as the bytes of a file. */
  encode(canvas: HTMLCanvasElement): Promise<Uint8Array>;
}

/** Ask first, then draw — `exportPdf`'s argument for the pair, unchanged: a
 *  cancelled dialog must not have cost a re-pose of the board. */
export interface ImageWriter {
  choose(title: string): Promise<boolean>;
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
      /** Which painters ran, in order — the one readout that says a layer made
       *  it into the file, since a missing one leaves no trace of itself. */
      readonly painted: readonly string[];
    };

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
): Promise<ImageOutcome> {
  if (bounds === null) return { done: "empty" };

  // Before anything moves, and for the reason `exportPdf` sets out: a board
  // that rearranges itself while somebody is still typing a filename is the
  // window answering a question about a file by moving.
  if (!(await writer.choose(title))) return { done: "cancelled" };

  const view = exportView(bounds, limits);
  const painted: string[] = [];

  const bytes = await posed(stage, view, async () => {
    const canvas = stage.canvas(view.width, view.height);
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("no 2d context for a board this size");
    for (const painter of stage.painters) {
      await painter.paint(ctx, view);
      painted.push(painter.name);
    }
    return stage.encode(canvas);
  });

  const path = await writer.write(bytes);
  return { done: "saved", path, view, painted };
}
