/**
 * The eraser — `E`, and the only tool on this board that draws nothing.
 *
 * > | Eraser | `E` | Deletes whole strokes under the cursor | — DESIGN section 3.5
 *
 * > **Erasing deletes strokes.** The default eraser removes whole stroke
 * > records, which is tiny and merges cleanly. Rasterising and flattening ink
 * > would destroy both undo and merge, and is never done. — DESIGN section 7.3
 *
 * So this is a *find and delete* gesture wearing a pen's clothes. It holds the
 * pointer like the marker does, it walks the coalesced trail like the marker
 * does, and then instead of collecting samples it asks which records the rubber
 * touched and hands them to the writer.
 *
 * The smudge (`Shift+E`) is not here and is not this class. That one makes a
 * mark — a stroke with `tool: 'erase'` drawn `destination-out` — so it is
 * `state/tools/marker.ts` a third time rather than anything to do with this
 * file. The two share a letter and nothing else.
 *
 * ## The surface is fixed at the press
 *
 * Exactly the pens' rule (DESIGN section 2.4), and for a reason this tool makes
 * sharper rather than softer: erasing "whatever is nearest on any surface" would
 * let a mark on the cork be rubbed out *through* a photograph lying on top of
 * it, with nothing on screen to say it had happened. `Ctrl` at the press forces
 * the cork, which is how you reach ink a photograph is covering — the same
 * escape hatch, for the same case.
 *
 * ## It deletes as it sweeps
 *
 * Not on release. A rubber whose marks only vanish when you lift is a rubber you
 * cannot aim, and the whole feedback of the gesture is the ink disappearing
 * under your hand.
 *
 * The cost is undo granularity: `deleteStrokes` opens one transaction per batch,
 * so a sweep is several. `Y.UndoManager`'s 400 ms capture window merges them
 * while the hand keeps moving and splits them where it pauses — which is not the
 * "one gesture, one entry" that `crdt/ops/ink.ts` argues for, and is the price of
 * the feedback. Recorded here rather than quietly.
 */

import { DEFAULT_ERASER_SIZE, INK_SIZES, inkSizeIndex, type InkSurface } from "@/lib/ink";
import { strokeHit } from "@/lib/inkhit";
import type { Point } from "@/lib/rotate";
import type { SceneStroke } from "@/state/scene";
import { itemLocal } from "@/state/tools/frame";
import type { PointerSample, Tool, ToolContext, ToolInput } from "@/state/tools/tool";

/**
 * What a sweep is rubbing.
 *
 * Not `InkSurface`, deliberately: that names one *map* — one item or one tile —
 * and the cork is not one tile. A press on bare cork rubs the cork, and which
 * buckets that turns out to touch is a question asked per sample.
 */
type Target = { readonly kind: "item"; readonly id: string } | { readonly kind: "cork" };

const CORK: Target = Object.freeze({ kind: "cork" });

export interface EraserToolOptions {
  /** Board units. */
  readonly size?: number;
  /** `Escape`. The caller hands the board back — see `state/tools/marker.ts`. */
  onDone?: () => void;
}

export class EraserTool implements Tool {
  readonly id = "eraser";

  private readonly options: EraserToolOptions;
  /** The rubber's width, in board units. Per tool and not per gesture, like a
   *  pen's nib and for the same reason: `[` and `]` pick a rubber. */
  private nib: number;
  /**
   * What this sweep is rubbing, decided by the press.
   *
   * Null only between gestures: [`targetAt`] always answers with something, so
   * null here means "no pointer is down" and nothing else.
   */
  private target: Target | null = null;
  private erasing = false;
  /**
   * Ids already handed to the writer this gesture.
   *
   * A tool's writes are queued to phase 9 and the binding does not answer until
   * the frame after that, so a stroke stays in the scene mirror for a frame or
   * two after it has been condemned. Without this the same record would be
   * deleted again on every sample of the sweep still touching it — harmless in
   * the document, and a pile of no-op transactions the undo stack has to hold.
   */
  private readonly taken = new Set<string>();
  /** Reused: `itemLocal` allocates otherwise, and this runs once per sample. */
  private readonly local: Point = { x: 0, y: 0 };

  constructor(options: EraserToolOptions = {}) {
    this.options = options;
    this.nib = options.size ?? DEFAULT_ERASER_SIZE;
  }

  /** The rubber's width, for anything that wants to show it. */
  get size(): number {
    return this.nib;
  }

  /** `[` and `]` — one rung down or up the shared ladder, clamped at both ends
   *  exactly as a pen's is (`state/tools/marker.ts`). */
  step(by: number): void {
    const at = inkSizeIndex(this.nib);
    const next = Math.min(INK_SIZES.length - 1, Math.max(0, at + by));
    this.nib = INK_SIZES[next]!;
  }

  /** Is a sweep in progress? Read by `app/main.ts`, which suppresses the other
   *  tools' hover affordances while one is — the same as `MarkerTool.stroking`. */
  get sweeping(): boolean {
    return this.erasing;
  }

  handle(input: ToolInput, ctx: ToolContext): void {
    switch (input.kind) {
      case "down":
        this.taken.clear();
        this.erasing = true;
        this.target = this.targetAt(input.at, ctx);
        this.rub(input.at, ctx);
        return;
      case "move":
        if (!this.erasing) return;
        // The whole trail, not the position. A fast sweep is a dozen samples a
        // frame and reading only the last one leaves untouched gaps between them
        // — the same argument the marker makes about a curve, with a worse
        // failure: ink left standing in the middle of something you rubbed out.
        if (input.trail) for (const at of input.trail) this.rub(at, ctx);
        else this.rub(input.at, ctx);
        return;
      case "up":
        if (!this.erasing) return;
        this.rub(input.at, ctx);
        this.reset();
        return;
      case "cancel":
        this.cancel(ctx);
        return;
      case "key":
        if (input.code === "Escape") {
          this.reset();
          this.options.onDone?.();
        }
        return;
      default:
        return;
    }
  }

  /**
   * The surface a press at this point rubs — the item under it, or the cork.
   *
   * `ctrl` off the press's own sample rather than `ctx.held`, for the reason
   * `MarkerTool.spaceAt` gives: it is a property of the event, not a key that can
   * be let go of halfway through the sweep.
   */
  private targetAt(at: PointerSample, ctx: ToolContext): Target {
    if (at.ctrl) return CORK;
    const board = ctx.camera.screenToBoard(at.x, at.y);
    const item = ctx.hitTest(board.x, board.y);
    return item === null ? CORK : { kind: "item", id: item };
  }

  /** One sample of the sweep: whatever the rubber is touching, gone. */
  private rub(at: PointerSample, ctx: ToolContext): void {
    if (!this.erasing || this.target === null) return;
    const board = ctx.camera.screenToBoard(at.x, at.y);
    if (this.target.kind === "item") this.rubItem(this.target.id, board.x, board.y, ctx);
    else this.rubCork(board.x, board.y, ctx);
  }

  private rubItem(id: string, bx: number, by: number, ctx: ToolContext): void {
    // Through the item's *rendered* pose, which is `itemLocal`'s subject: a
    // photograph hanging on one pin is drawn at an angle that is in nobody's
    // document, and testing against the stored pose instead would put the rubber
    // as far from the mark as the swing has taken the paper.
    const local = itemLocal(ctx.scene, id, bx, by, this.local);
    // The paper went while the pointer was down. Its ink went with it, which is
    // what nesting buys (`crdt/ops/ink.ts`), so there is nothing left to erase.
    if (local === null) {
      this.reset();
      return;
    }
    this.take({ kind: "item", id }, ctx.scene.strokesOf(id), local.x, local.y, ctx);
  }

  /**
   * The cork, which unlike an item is not one surface but a lattice of buckets.
   *
   * Every tile is asked rather than only the one the cursor is standing in: a
   * stroke is filed by its bounding-box centre and can hang half its length into
   * a neighbouring cell, so the tile under the cursor is not necessarily the tile
   * the mark under the cursor belongs to. `strokeHit`'s own box test throws out
   * everything that is nowhere near, and there is one entry per cell somebody has
   * drawn in rather than one per cell.
   */
  private rubCork(bx: number, by: number, ctx: ToolContext): void {
    for (const tile of ctx.scene.boardInkTiles()) {
      const [x0, y0, x1, y1] = tile.bbox;
      const reach = this.nib;
      if (bx < x0 - reach || bx > x1 + reach || by < y0 - reach || by > y1 + reach) continue;
      this.take({ kind: "tile", key: tile.key }, tile.strokes, bx, by, ctx);
    }
  }

  /**
   * Hand over whatever the rubber touches on one surface.
   *
   * The rubber's *radius*, not its width: two discs overlapping is the hit, and
   * the stroke's own half-width is `lib/inkhit.ts`'s half of it.
   */
  private take(
    surface: InkSurface,
    strokes: readonly SceneStroke[],
    x: number,
    y: number,
    ctx: ToolContext,
  ): void {
    let hits: string[] | null = null;
    for (const stroke of strokes) {
      if (this.taken.has(stroke.id)) continue;
      if (!strokeHit(stroke.samples, stroke.bbox, stroke.size, x, y, this.nib / 2)) continue;
      this.taken.add(stroke.id);
      (hits ??= []).push(stroke.id);
    }
    // Allocated only when something was hit, which is most samples of most
    // sweeps: the rubber spends far more of its path over blank paper than over
    // ink, and this runs a dozen times a frame.
    if (hits !== null) ctx.write.eraseStrokes(surface, hits);
  }

  /** Nothing eases: a rubber that is not moving is not rubbing. */
  tick(): void {}

  /**
   * A lost pointer or a lost window.
   *
   * Nothing to revert. Unlike every other gesture on this board, this one has
   * already written what it did — the records are gone as they were swept — so a
   * cancel is only the tool forgetting that a pointer was down. Ctrl+Z is what
   * takes an interrupted sweep back, and it is the same Ctrl+Z that takes a
   * completed one back.
   */
  cancel(_ctx: ToolContext): void {
    this.reset();
  }

  private reset(): void {
    this.target = null;
    this.erasing = false;
    this.taken.clear();
  }
}
