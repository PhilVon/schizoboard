/**
 * Removing what is selected — the rule behind `Delete`, `Shift+Delete` and the
 * second half of `Ctrl+X`.
 *
 * It lived inside the select tool's key handler until cut needed it (T-227).
 * Cut is a copy and a delete, and a delete that agreed with `Delete` only most
 * of the time would be the worst kind of near-miss: the same keystroke-shaped
 * verb leaving a different board behind. So the rule is one function and the
 * two callers are two keystrokes.
 *
 * Deliberately **not** a `crdt/` op. Every write here goes through `BoardWriter`,
 * which queues to phase 9, and the settle it sends is measured off the scene
 * mirror — neither of which `crdt/` may touch.
 */

import type { BoardWriter } from "@/state/tools/tool";
import type { Scene } from "@/state/scene";
import type { Selection } from "@/state/selection";
import { settleOnUnpin } from "@/state/tools/frame";

/** What erasing needs — a structural subset of `ToolContext`, so a tool can
 *  pass its own context straight in. */
export interface EraseContext {
  readonly selection: Selection;
  readonly scene: Scene;
  readonly write: BoardWriter;
}

/**
 * Delete the selection, clearing it. `keepPins` is `Shift`, which "removes the
 * items but leaves their pins free-floating in the cork, so the string web keeps
 * its shape with a hole where the evidence was" (DESIGN section 3.8).
 *
 * Returns the items it asked to be deleted, which is what the caller needs to
 * forget anything it was animating — and false-y emptiness is also how it says
 * there was nothing to do.
 *
 * ## Three writes, because a selection holds three kinds of thing
 *
 * `Selection.toArray` is *items* — a selected string lives in its own set and
 * has never been in that list (`state/selection.ts` says so on `size`). So this
 * once read the item half of the selection, deleted it, and cleared the whole
 * thing; every string went on existing while the halo that said it was selected
 * disappeared, which reads as the string having come back rather than as a
 * delete that missed. Invisible until follow-the-thread (T-120) made a selection
 * of every kind at once ordinary, and then it was every double-click.
 *
 * Separate writes rather than one because they are different rules, and `Shift`
 * is the tell: it means "keep the pins", and that is an *item's* cascade
 * (DESIGN section 3.8). A string has no pins to keep — it references them, and
 * D-1 is why a reference never owned them — so deleting one is unconditional and
 * the modifier does not reach it.
 *
 * Three writes rather than two (Q-24): a selected *pin* goes too, and the
 * strings through it heal, which is `Alt`+click's cascade reached by the key
 * that deletes everything else. It waited for an answer because a double-click
 * on a hub pin selects a whole connected component, so one keystroke can take a
 * web apart — but a selection that quietly ignores one of the three kinds it
 * holds is the same bug T-121 fixed for strings, and it was the more surprising
 * of the two.
 *
 * `Shift` therefore means "keep the pins" for the *whole* selection and not only
 * for the item cascade. Otherwise it would be a lie exactly where it is most
 * needed: on a followed thread the selected pins **are** the items' pins, so
 * applying it to the cascade alone would delete every one of them anyway and the
 * modifier would do nothing visible. The cost is that `Shift`+`Delete` on a
 * selection of nothing but pins is a no-op — "delete these, but keep them" has
 * no other answer.
 */
export function eraseSelection(ctx: EraseContext, keepPins = false): string[] {
  const items = ctx.selection.toArray();
  const strings = [...ctx.selection.strings];
  /**
   * Not the pins an item is about to take with it: `deleteItems` cascades to
   * them (DESIGN section 3.8), so naming them here would be a second write
   * against something already gone — and the pose in `settleOnUnpin` would name
   * a deleted item, which in a CRDT is how you resurrect one.
   */
  const doomed = new Set(items);
  const pins = keepPins
    ? []
    : [...ctx.selection.pins].filter((id) => {
        const parent = ctx.scene.pins.get(id)?.parent ?? null;
        return parent === null || !doomed.has(parent);
      });
  if (items.length === 0 && strings.length === 0 && pins.length === 0) return [];

  ctx.selection.clear();
  if (items.length > 0) ctx.write.deleteItems(items, keepPins);
  if (strings.length > 0) ctx.write.deleteStrings(strings);
  // The settle is the same one `Alt`+click and the pin menu send, and for the
  // same reason: an item hanging by a pin about to go is drawn at an angle the
  // document has never held.
  if (pins.length > 0) ctx.write.deletePins(pins, settleOnUnpin(ctx.scene, pins));
  return items;
}
