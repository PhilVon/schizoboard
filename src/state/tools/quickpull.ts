/**
 * `Alt` on a pin — the one gesture that belongs to no tool.
 *
 * > | Quick pull | `Alt`+drag from a pin, **in any tool** | Pulls a new string
 * > out without switching tools |
 * > | Remove | `Alt`+click, or context menu | Strings through it heal |
 * > — DESIGN sections 3.4 and 3.3
 *
 * One press, two endings, told apart by whether the pointer moved. That is why
 * neither can happen on the press itself: removing the pin on pointer-down, which
 * the select tool used to do, makes the drag unreachable — the pin is gone before
 * the pointer has had a chance to travel.
 *
 * ## Why it is not the select tool's any more
 *
 * "In any tool" is the whole point of the row. The gesture exists so that a
 * person holding a marker can run a string between two things without putting the
 * pen down, and it lived in `select.ts` for six phases, which meant it worked
 * exactly where it was least needed (T-229).
 *
 * Each tool holds one of these and offers it every input before looking at it
 * itself. Delegation rather than a rule the machine applies over the tools' heads:
 * a tool that wants to keep a press — none does today — can still see it, and the
 * machine stays what its own header says it is, which is the thing that turns
 * events into `ToolInput`s and nothing else.
 *
 * ## Nothing is written until the release
 *
 * Both endings are one write in one transaction, and there is no intermediate
 * state in the document at all — so `Esc`, a lost pointer or a tool switch revert
 * the whole thing by forgetting it.
 */

import { anchorAt, anchorParent, settleOnPin, settleOnUnpin } from "@/state/tools/frame";
import type { PointerSample, ToolContext, ToolInput } from "@/state/tools/tool";

/** The travel that tells a pull from a click, in screen pixels — the same
 *  threshold the select tool's own drags use. */
const DRAG_THRESHOLD_PX = 3;

export class QuickPull {
  /** The pin the press landed on, while it is still undecided whether this is a
   *  removal or a pull. */
  private from: string | null = null;
  private pulling = false;
  private downX = 0;
  private downY = 0;
  /** Where the pin is, in board space, so the pull can be drawn. */
  private pullX = 0;
  private pullY = 0;

  /** True while the gesture is this object's, so a tool can stand down without
   *  asking why. */
  get active(): boolean {
    return this.from !== null;
  }

  /**
   * Offer an input. **True means it was taken** and the tool must not look at it.
   *
   * A press is taken only when `Alt` is held and there is a pin under it; from
   * then until the release every input is this gesture's, because a pull that let
   * the tool see the moves would be drawing a marquee behind it.
   */
  handle(input: ToolInput, ctx: ToolContext): boolean {
    switch (input.kind) {
      case "down":
        if (!input.at.alt) return false;
        {
          const pin = ctx.hitPin(input.at.x, input.at.y);
          if (pin === null) return false;
          this.from = pin;
          this.pulling = false;
          this.downX = input.at.x;
          this.downY = input.at.y;
          return true;
        }
      case "move":
        if (this.from === null) return false;
        this.onMove(input.at, ctx);
        return true;
      case "up":
        if (this.from === null) return false;
        this.commit(input.at, ctx);
        return true;
      case "cancel":
        if (this.from === null) return false;
        this.cancel();
        return true;
      case "key":
        // > `Esc` mid-drag → the whole thing reverts — DESIGN section 3.4.
        //
        // Taken from the tool while this is in flight, because `Escape` in the
        // select tool clears the selection and in a pen it disarms the tool, and
        // both would be answering a keystroke the person meant for the string
        // hanging off their cursor.
        if (this.from === null || input.code !== "Escape") return false;
        this.cancel();
        return true;
      default:
        return false;
    }
  }

  /**
   * The string being pulled out, for `render/overlay.ts` — the pin it started on,
   * and the cursor.
   *
   * The same shape the string tool's `preview` returns, and drawn by the same
   * code, because they are the same thing arrived at two ways: a run that has not
   * been written down yet.
   */
  preview(cursor: { x: number; y: number } | null): readonly { x: number; y: number }[] | null {
    if (!this.pulling || !cursor) return null;
    return [{ x: this.pullX, y: this.pullY }, cursor];
  }

  /** Abandon it. Nothing was written and nothing was removed, which is the right
   *  revert for both halves of the gesture at once. */
  cancel(): void {
    this.from = null;
    this.pulling = false;
  }

  private onMove(at: PointerSample, ctx: ToolContext): void {
    if (this.pulling) return;
    const dx = at.x - this.downX;
    const dy = at.y - this.downY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    // The pointer has travelled, so this is a pull and not a removal.
    const pin = ctx.scene.pins.get(this.from!);
    if (!pin) {
      // A collaborator took the pin between the press and the move. There is
      // nothing to pull from and nothing to remove.
      this.cancel();
      return;
    }
    this.pullX = pin.wx;
    this.pullY = pin.wy;
    this.pulling = true;
  }

  /**
   * The two ends of the gesture. A pull that got as far as moving writes a string
   * from the pin it started on to whatever the release landed on — pin, item or
   * bare cork, by the same rule the string tool uses. One that never moved was a
   * click, and a click removes the pin.
   */
  private commit(at: PointerSample, ctx: ToolContext): void {
    const from = this.from!;
    const pulling = this.pulling;
    this.cancel();
    ctx.dirty.camera = true;

    if (!pulling) {
      // "Strings through it heal", which the op does in the same transaction.
      ctx.write.deletePins([from], settleOnUnpin(ctx.scene, [from]));
      return;
    }

    const to = anchorAt(ctx.scene, ctx.camera, ctx.hitTest, ctx.hitPin, at.x, at.y);
    // A pull that ended back on its own pin is a string of one node, which is not
    // a string. Nothing written, nothing removed — it was a drag, so it was not a
    // click either.
    if ("pin" in to.anchor && to.anchor.pin === from) return;
    // The far end may be an item that hangs, and this is the pin that stops it —
    // `settleOnPin`. The near end is a pin that already exists and changes
    // nobody's count.
    ctx.write.createString(
      [{ pin: from }, to.anchor],
      false,
      settleOnPin(ctx.scene, [anchorParent(to.anchor)]),
    );
  }
}
