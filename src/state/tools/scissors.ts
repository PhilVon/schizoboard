/**
 * `Ctrl`+`Alt` on a string — the other gesture that belongs to no tool.
 *
 * > | Cut | `Ctrl`+`Alt`+click a string, **in any tool** — the scissors — or
 * > context menu → *Delete* | String removed; its pins stay where they are |
 * > — DESIGN section 3.4
 *
 * DESIGN named a "scissors modifier" for six phases without ever saying which
 * one, and that omission is the whole of why the row went unbuilt: every
 * ordinary modifier already means something within a few pixels of where a cut
 * would happen. `Alt` alone removes a pin and drags a new string out of one,
 * `Ctrl` keeps a pin put mid-drag and at pen-down forces ink onto the cork,
 * `Shift` extends a selection. Giving any of the three a fourth meaning over a
 * string is how a board starts cutting things people meant to drag; the unused
 * *pair* cannot be pressed by accident (Q-183).
 *
 * ## Why it is in every tool
 *
 * The same argument `state/tools/quickpull.ts` makes, and it sits beside it for
 * that reason: a person holding a marker who wants a string gone should not have
 * to put the pen down, find `V`, cut, and find `M` again. The quick pull spent
 * six phases living in the select tool, which meant it worked exactly where it
 * was least needed (T-229), and there was no reason to build its sibling into
 * the same corner (Q-186).
 *
 * ## It is one press, and it still holds the gesture
 *
 * There is no drag here — the write happens on the press and there is nothing to
 * decide at the release. It keeps the rest of the gesture anyway, because a tool
 * that was not offered the `down` and then *is* offered the moves would be a pen
 * drawing a stroke that starts nowhere.
 *
 * ## A miss is taken too
 *
 * Falling through would make a scissors press that landed a few pixels off the
 * curve start whatever the current tool does with a press — a marquee in select,
 * a mark in a pen — which is a worse answer to "I meant to cut that" than
 * nothing happening. `stringAt` is the same question the hover highlight asks,
 * so what is cut is exactly what was lit.
 */

import { isScissors, stringAt } from "@/state/tools/frame";
import type { ToolContext, ToolInput } from "@/state/tools/tool";

export class Scissors {
  /** True from the press that was taken until whatever ends it. */
  private cutting = false;

  /** Offer an input. **True means it was taken** and the tool must not look at it. */
  handle(input: ToolInput, ctx: ToolContext): boolean {
    switch (input.kind) {
      case "down": {
        if (!isScissors(input.at.ctrl, input.at.alt)) return false;
        this.cutting = true;
        const hit = stringAt(
          ctx.scene,
          ctx.camera,
          ctx.hitTest,
          ctx.hitPin,
          ctx.hitString,
          input.at.x,
          input.at.y,
          ctx.shownPage,
        );
        // No `keepPins` to pass: a string owns nothing but its nodes, so removing
        // it leaves every pin it hung from where it is (`crdt/ops/strings.ts`).
        if (hit !== null) ctx.write.deleteStrings([hit.string]);
        return true;
      }
      case "move":
        return this.cutting;
      case "up":
      case "cancel": {
        const was = this.cutting;
        this.cutting = false;
        return was;
      }
      default:
        return false;
    }
  }

  /** A tool switch or a lost pointer. Nothing to revert — the write happened on
   *  the press and was complete when it did. */
  cancel(): void {
    this.cutting = false;
  }
}
