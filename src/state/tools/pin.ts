/**
 * The pin tool — `P`.
 *
 * > | Pin tool | `P` | Next click places a pin |
 * > | Place on an item | Click an item with the pin tool | Parented pin at the click point |
 * > | Place on cork | Click empty cork with the pin tool | Free-floating pin |
 * > — DESIGN section 3.3
 *
 * Those three rows are one rule: the click lands on whatever is under it, and
 * "whatever is under it" is either an item or the cork. There is no mode and no
 * choice to make — the two outcomes differ only in what `parent` gets set to.
 *
 * ## Only placement is in here
 *
 * The rest of section 3.3 — move, re-parent, un-parent, constrain, remove —
 * works in the **select** tool, not this one. The table says "Drag it" and
 * "`Alt`+click" with no tool named, while the three rows above name the tool
 * explicitly; and section 6.2 puts pins in their own layer labelled *hit
 * targets*, above items, because they are physically on top of them. So a pin
 * is grabbable wherever you are, the way a photograph is, and `P` is only
 * needed for the one thing that has nothing to grab yet.
 *
 * The cost of that reading is real and worth stating: the default pin sits at
 * the top centre of every item, so there is a small disc there where a press
 * takes the pin rather than the paper. That is also what happens on a real
 * board, and pillar one is "physical, not skeuomorphic".
 *
 * ## One placement, then back to select
 *
 * Same as the note tool, for the same reason — nothing on screen says which
 * tool is active, and a sticky tool with no indicator is a trap. See
 * `state/tools/note.ts`.
 */

import type { Vec2 } from "@/state/camera";
import { itemLocal } from "@/state/tools/frame";
import type { PointerSample, Tool, ToolContext, ToolInput } from "@/state/tools/tool";

export interface PinToolOptions {
  /** A pin was placed, or `Escape` abandoned it. The caller hands the board
   *  back to `select`; a tool has no idea what other tools exist. */
  onDone?: () => void;
}

export class PinTool implements Tool {
  readonly id = "pin";

  private readonly options: PinToolOptions;
  /** Where the press landed, board space, or null when nothing is pressed. */
  private downAt: Vec2 | null = null;

  constructor(options: PinToolOptions = {}) {
    this.options = options;
  }

  handle(input: ToolInput, ctx: ToolContext): void {
    switch (input.kind) {
      case "down":
        this.onDown(input.at, ctx);
        return;
      case "up":
        this.onUp(ctx);
        return;
      case "cancel":
        this.cancel(ctx);
        return;
      case "key":
        if (input.code === "Escape") {
          this.downAt = null;
          this.options.onDone?.();
        }
        return;
      default:
        return;
    }
  }

  private onDown(at: PointerSample, ctx: ToolContext): void {
    this.downAt = { ...ctx.camera.screenToBoard(at.x, at.y) };
  }

  /**
   * At the point the press went down, not where the release came up — the press
   * is the one that was aimed. Which item it lands on is asked here rather than
   * at pointer-down for the same reason: it is a question about the point being
   * committed to.
   */
  private onUp(ctx: ToolContext): void {
    const at = this.downAt;
    this.downAt = null;
    if (!at) return;
    const onto = ctx.hitTest(at.x, at.y);
    // Into the item's own frame here rather than in the op, because the item
    // may be hanging and the pose it is drawn at is not in the document —
    // `state/tools/frame.ts`.
    const local = onto === null ? null : itemLocal(ctx.scene, onto, at.x, at.y);
    if (onto !== null && !local) return;
    ctx.write.createPin(onto, local?.x ?? at.x, local?.y ?? at.y);
    this.options.onDone?.();
  }

  tick(): void {}

  /** Nothing has been written — the pin only exists at pointer-up — so
   *  abandoning is forgetting where the press was. `onDone` deliberately does
   *  not fire, as in the note tool: a window that lost focus mid-click has not
   *  finished with the tool. */
  cancel(_ctx: ToolContext): void {
    this.downAt = null;
  }
}
