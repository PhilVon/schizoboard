/**
 * What a right-click on the board offers, as a pure function of ids.
 *
 * Ids in, rows out — no DOM, no camera, no hit testing. That split is the
 * point: `ui/menu.ts` is a box that shows labels, and this is the part with
 * opinions in it, which is the part worth testing. `boardmenu.test.ts` builds a
 * scene, asks for the rows, calls one, and asserts what was written, with no
 * browser anywhere in it.
 *
 * ## Only strings, for now
 *
 * DESIGN wants three menus and this builds one:
 *
 * > | Add without switching tools | Item context menu → *Add pin* | … (3.2)
 * > | Remove | `Alt`+click, or context menu | … (3.3)
 * > | Tuck behind · Restyle · Cut | Context menu | … (3.4)
 *
 * The string rows are the ones with machinery already behind them and no other
 * way to reach it. An item's *Add pin* is `P` and a pin's *Remove* is
 * `Alt`+click, and both of those work today; adding a second route to each is
 * worth doing and is not worth blocking the first menu on.
 */

import { STRING_COLORS, STRING_THICKNESSES } from "@/lib/palette";
import type { Scene } from "@/state/scene";
import type { BoardWriter } from "@/state/tools/tool";
import type { MenuChoice, MenuEntry } from "@/ui/menu";

/**
 * The rows for a right-click that landed on string.
 *
 * `targets` is what the click resolved to — the whole selection when the string
 * under the cursor was part of it, and just that string when it was not. Ids
 * that are no longer in the scene are dropped, because the menu is built from a
 * snapshot taken at the press and a peer may have deleted one of them in the
 * meantime; an empty result is a menu that does not open.
 */
export function stringMenuRows(
  scene: Scene,
  write: BoardWriter,
  targets: readonly string[],
): MenuEntry[] {
  const live = targets.filter((id) => scene.strings.has(id));
  if (live.length === 0) return [];

  /**
   * Whether every target already has this value, which is what marks a chip.
   *
   * *Every*, not the first one: a selection of four strings in three colours
   * has no current colour, and marking the first one's would say the other
   * three were already that and quietly invite the user not to bother.
   */
  const all = <T,>(read: (id: string) => T | undefined, value: T): boolean =>
    live.every((id) => read(id) === value);

  const colors: MenuChoice[] = STRING_COLORS.map(({ label, hex }) => ({
    label,
    swatch: hex,
    current: all((id) => scene.strings.get(id)?.color, hex),
    run: () => write.setStringStyle(live, { color: hex }),
  }));

  const weights: MenuChoice[] = STRING_THICKNESSES.map((thickness) => ({
    label: `${thickness} px`,
    weight: thickness,
    current: all((id) => scene.strings.get(id)?.thickness, thickness),
    run: () => write.setStringStyle(live, { thickness }),
  }));

  /**
   * > | Tuck behind | Context menu → *Tuck behind* | Flips `layer`; the string
   * > now runs behind items instead of over them — DESIGN section 3.4
   *
   * One target layer for the whole set rather than each string flipping its
   * own, which is the rule `SelectTool`'s retired `B` established and the same
   * one the `1`-`9` presets follow: a mixed selection has no state to invert,
   * and a verb that turned one mixed selection into a different mixed selection
   * is not a thing anyone picks off a menu. Only a set that is *already*
   * entirely behind comes back out, and the label says which it is about to do.
   */
  const allUnder = live.every((id) => scene.strings.get(id)?.layer === "under");
  const layer = allUnder ? "over" : "under";

  return [
    /**
     * > | Restyle | Context menu | Colour (red is default - also blue, green,
     * > yellow, black, white), thickness — DESIGN section 3.4
     *
     * The colours are `lib/palette.ts`, and the swatches are the *actual* hexes
     * the painter will use rather than a set of approximations chosen to look
     * right in a menu. That is the entire argument for swatches over the six
     * words DESIGN writes them as: which red the red is, is a question only the
     * cork can answer, and the menu is the place to answer it.
     */
    { label: "Colour", choices: colors },
    { label: "Weight", choices: weights },
    {
      divided: true,
      label: allUnder ? "Bring in front" : "Tuck behind",
      run: () => write.setStringLayer(live, layer),
    },
    {
      /**
       * > | Cut | Scissors modifier, or context menu → *Delete* | String
       * > removed; its pins stay where they are — DESIGN section 3.4
       *
       * The pins staying is `crdt/ops/strings.ts`'s doing and not a flag passed
       * from here: deleting a string deletes the string, and a pin has never
       * belonged to one — D-1, "pins are the primitive". Which is exactly why
       * the row is not called *Cut*: nothing is on a clipboard afterwards.
       */
      label: live.length > 1 ? `Delete ${live.length} strings` : "Delete",
      divided: true,
      danger: true,
      run: () => write.deleteStrings(live),
    },
  ];
}
