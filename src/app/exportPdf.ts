/**
 * Putting the board where the page needs it, and putting it back.
 *
 * The PDF itself is Chromium's — `print_to_pdf` in `src-tauri/src/print.rs`
 * hands `ICoreWebView2_7::PrintToPdf` a page size and it renders the live
 * document into a file, handwriting and all, as embedded vector text (Q-128,
 * D-36). So nothing here draws anything. What is here is the *moment* that
 * print happens in, which turns out to be the whole difficulty.
 *
 * ## A print fires no resize
 *
 * Chromium lays a print out at the paper width — 1920 CSS pixels for a 20-inch
 * page — and tells the document nothing about it. No `resize` event, no change
 * to `innerWidth`. A board whose camera and screen-space canvases were sized
 * for a 1440-pixel window therefore prints as a board in the corner of a mostly
 * empty page with its ropes cut off at 1440, which is exactly what the first
 * PDF this project ever produced looked like (D-36).
 *
 * So the viewport is made the page by hand before the print and put back after:
 * the camera's own `width`/`height`, the two rope canvases, and the detail tier.
 * Three things, one of which is not obvious — see `Stage.hold`.
 *
 * ## Everything here is restored in a `finally`
 *
 * A `hold` never released is T-90's performance work silently undone; a camera
 * left at the export view is a board that has apparently teleported. Neither
 * failure looks like an export failing, which is what makes them expensive: the
 * board is simply wrong afterwards and nothing says why. So the restore is one
 * `finally` around everything after the first mutation, and it runs whether the
 * print worked, failed, or was cancelled at the dialog.
 *
 * ## Ask first, then pose
 *
 * The save dialog is `choose` and the print is `write`, two commands with the
 * chosen path held in the shell between them (`src-tauri/src/print.rs`), and
 * the reason for the pair is this ordering. A single command would have had to
 * open the dialog and print the instant it closed, which means the board is
 * already zoomed out to its own bounds while somebody is still typing a
 * filename — the window answering a question about a file by rearranging
 * itself. It also made the *common* case the expensive one: a cancelled dialog
 * had cost a full re-pose of the board and a re-pose back, for nothing.
 *
 * So nothing here touches the board until there is a file to write. Cancelling
 * is now free and invisible, which is what cancelling ought to be.
 */

import type { PdfPage } from "@/platform/types";
import type { Bounds } from "@/state/scene";

import { exportPage, type ExportLimits, type ExportView } from "@/app/export";

/**
 * The board, as an export needs to be able to move it.
 *
 * An interface rather than the objects themselves because this is the piece
 * worth testing without a browser — every field is something `app/main.ts`
 * already has, and the export is then the order they are called in.
 */
export interface Stage {
  /**
   * The camera, written field by field.
   *
   * Not `setView`, and this is the one place in the application that says so:
   * `setView` clamps to `MIN_ZOOM`, and that clamp exists for a frame budget
   * (T-204) an export does not have. Inheriting it would crop any board wider
   * than the zoom floor can frame — the failure a user could not see in the
   * file they were handed.
   */
  readonly camera: {
    x: number;
    y: number;
    zoom: number;
    width: number;
    height: number;
    version: number;
  };
  /** Size the screen-space canvases, and drop anything cached in their space. */
  resizeCanvases(width: number, height: number): void;
  /**
   * Take the detail tier away from the zoom until the returned function gives
   * it back.
   *
   * Not optional and not an optimisation to skip. An export frames the whole
   * board, a whole-board zoom is a few per cent, and a few per cent is the
   * `card` tier — so the first PDF came out as flat sheets with no ruling, no
   * ageing and no curl, and said `16% · card` in its own printed HUD (D-36).
   */
  hold(): () => void;
  /** The camera has stopped here — re-raster ink for this scale. */
  settle(zoom: number): void;
  /** Everything on screen is now wrong. */
  redraw(): void;
  /** Resolve after `count` frames have actually been drawn. */
  frames(count: number): Promise<void>;
}

/**
 * What came of an export. A failure throws; these are the three ways it can
 * succeed at doing nothing or something.
 */
export type PdfOutcome =
  /** Nothing on the board, so nothing to take a picture of. */
  | { readonly done: "empty" }
  /** The user closed the save dialog. An ordinary outcome, and the board never
   *  moved — nothing to say and nothing to put back. */
  | { readonly done: "cancelled" }
  | { readonly done: "saved"; readonly path: string; readonly view: ExportView };

/**
 * How many frames to let pass between posing the board and printing it.
 *
 * Three, because the pose takes three to finish: the culler mounts what the new
 * camera can see, the items it mounted are laid out and drawn on the next, and
 * the rope canvases are painted in the camera's new space on the one after. Two
 * was enough on a board of a dozen items and not on one of two hundred, which
 * is the sort of difference that shows up in somebody else's file rather than
 * in a test.
 */
const SETTLING_FRAMES = 3;

/**
 * The two halves of the shell's side, in the order they happen.
 *
 * `choose` resolves false for a cancelled dialog; `write` prints into whatever
 * `choose` settled on and resolves the path it went to.
 */
export interface PdfWriter {
  choose(title: string): Promise<boolean>;
  write(page: PdfPage): Promise<string>;
}

/**
 * Export the board — or the selection, if there is one — as a PDF.
 *
 * `bounds` is `exportBounds(scene, selection)`, taken by the caller because the
 * scene and the selection are theirs; `null` means an empty board.
 */
export async function exportPdf(
  stage: Stage,
  bounds: Bounds | null,
  title: string,
  writer: PdfWriter,
  limits: ExportLimits = {},
): Promise<PdfOutcome> {
  if (bounds === null) return { done: "empty" };

  // Before anything moves. Everything below this line has to be undone; nothing
  // above it does, which is what makes a cancelled export cost nothing.
  if (!(await writer.choose(title))) return { done: "cancelled" };

  const view = exportPage(bounds, limits);
  const path = await posed(stage, view, () =>
    writer.write({ width: view.inches.width, height: view.inches.height }),
  );
  return { done: "saved", path, view };
}

/**
 * Put the board where an export needs it, run `body`, and put it back whatever
 * happens.
 *
 * Shared by both export routes, and it is the piece of this file that had to
 * be: a `hold` never released is T-90's performance work silently undone and a
 * camera left at the export view is a board that has apparently teleported.
 * Neither failure looks like an export failing — the board is simply wrong
 * afterwards and nothing says why — so there is one `finally` and both routes
 * are inside it rather than each remembering.
 */
export async function posed<T>(
  stage: Stage,
  view: ExportView,
  body: () => Promise<T>,
): Promise<T> {
  const before = {
    x: stage.camera.x,
    y: stage.camera.y,
    zoom: stage.camera.zoom,
    width: stage.camera.width,
    height: stage.camera.height,
  };
  const release = stage.hold();

  try {
    stage.camera.x = view.x;
    stage.camera.y = view.y;
    stage.camera.zoom = view.zoom;
    stage.camera.width = view.width;
    stage.camera.height = view.height;
    // The camera's own `version` is what the render loop compares against to
    // decide a frame is worth drawing, and every field above was written past
    // the setter that would have bumped it. Missing this is a pose that never
    // reaches the screen and a print of the board exactly as it was.
    stage.camera.version += 1;
    stage.resizeCanvases(view.width, view.height);
    stage.settle(view.zoom);
    stage.redraw();
    await stage.frames(SETTLING_FRAMES);
    return await body();
  } finally {
    release();
    stage.camera.x = before.x;
    stage.camera.y = before.y;
    stage.camera.zoom = before.zoom;
    stage.camera.width = before.width;
    stage.camera.height = before.height;
    stage.camera.version += 1;
    stage.resizeCanvases(before.width, before.height);
    stage.settle(before.zoom);
    stage.redraw();
  }
}
