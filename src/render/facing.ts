/**
 * Which face a thing is showing, and what follows for the things stuck to the
 * other one — T-278 and T-330.
 *
 * A case file is the only object on this board with two faces, so it is the
 * only one for which "where is this" needs a second answer. A mark got that
 * second answer first (`StrokeFields.page`); a tape has it now, because a
 * thread taped to page four of a filing is not on the folder, it is on the
 * page.
 *
 * The resolver and the predicate live together because they are one idea and
 * because there are four callers between them — the item layer, the overlay,
 * the pin layer and the rope painter — and a predicate written out four times
 * is four chances to disagree about what a shut folder shows.
 */

import type { PinNode, Scene } from "@/state/scene";

/**
 * Which page of an item's document is the face on show, or null for the object
 * itself — T-278.
 *
 * By item id rather than by asset hash, which is the opposite of
 * `PageResolver` and is not an inconsistency. That one asks *what is on this
 * page of this file*, which is a question about the file and would be answered
 * identically for two folders holding it. This one asks *which face is this
 * thing showing*, which is a question about the object: one folder is open and
 * the other is shut, and they are holding the same document.
 *
 * Only `app/main.ts` can build it — `opening` knows which item is turned up and
 * nothing about what is written on it, the reader knows which page is drawn and
 * deliberately nothing about items — so every layer that needs it is handed the
 * same one, and defaults to `() => null`, which is a board with nothing open.
 */
export type ShownPage = (itemId: string) => number | null;

/**
 * Is this pin stuck to a face that is not the one on show? — T-330.
 *
 * True for a tape on page four while you are reading page twelve, and for the
 * same tape while the folder is shut, and that is *one* answer rather than two
 * cases: a shut folder shows no page, so no page it holds is the page on show.
 * The middle state is the one that makes this physical instead of a visibility
 * toggle — the thread is still there, it has just gone under the sheet you are
 * looking at, which is what a thread taped to page four does when page twelve
 * is lying on top of it.
 *
 * False for every pin on every board that has never quoted a case file, on the
 * first comparison, which is why both callers ask this before they ask anything
 * that costs.
 *
 * The word is `Tuck behind`'s, from the string menu, on purpose: what a tucked
 * tape does to its thread is exactly what that row does, decided per frame by
 * what is open instead of once by somebody choosing.
 */
export function tucked(pin: PinNode, shown: ShownPage | null): boolean {
  // A page on a free pin has no meaning — the cork is not a document — and
  // `readPin` already refuses to mirror one. Tested here as well because this
  // is the only reader of the pair and a `null` parent would otherwise be asked
  // of a resolver keyed on item ids.
  if (pin.page === null || pin.parent === null) return false;
  // No resolver at all is a shell with no reader in it: an export rig, a test,
  // a board booted read-only. Nothing is open there, so nothing it holds is on
  // show — the same answer `() => null` gives, reached without calling it.
  return shown === null || shown(pin.parent) !== pin.page;
}

/**
 * Does this gap of a run go behind the paper? — T-330.
 *
 * **Either end, not the far one.** A thread can be taped to a page at each end —
 * two quotations off one filing, joined to each other — and a tape under the
 * sheet on show puts the gap that reaches it under the sheet too, whichever end
 * of that gap it is.
 *
 * The gap and not the string, because `layer` has always been a fact about a
 * whole string and this one is not. Pull a pin out of the middle of a quote
 * card's thread (T-46) and the half that never went near the folder must go on
 * drawing where it always did — tucking all of it would hide the thread behind
 * every note between the folder and the card.
 *
 * Free on a board with no tape stuck to a page, which is every board that has
 * never quoted a case file.
 */
export function tuckedGap(
  scene: Scene,
  shown: ShownPage | null,
  a: string,
  b: string,
): boolean {
  if (scene.pagedPins.size === 0) return false;
  const first = scene.pins.get(a);
  if (first !== undefined && tucked(first, shown)) return true;
  const second = scene.pins.get(b);
  return second !== undefined && tucked(second, shown);
}
