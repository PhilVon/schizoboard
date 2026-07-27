/**
 * What a right-click on the board offers, as a pure function of ids.
 *
 * Ids in, rows out — no DOM, no camera, no hit testing. That split is the
 * point: `ui/menu.ts` is a box that shows labels, and this is the part with
 * opinions in it, which is the part worth testing. `boardmenu.test.ts` builds a
 * scene, asks for the rows, calls one, and asserts what was written, with no
 * browser anywhere in it.
 *
 * ## Three menus, one per kind of thing
 *
 * DESIGN names a context menu in three places, and a right-click resolves to
 * exactly one of them:
 *
 * > | Add without switching tools | Item context menu → *Add pin* | … (3.2)
 * > | Remove | `Alt`+click, or context menu | … (3.3)
 * > | Tuck behind · Restyle · Cut | Context menu | … (3.4)
 *
 * The string rows came first, because they were the ones with machinery behind
 * them and no other way to reach it. The other two are second routes to verbs
 * that already work — `P` places a pin, `Alt`+click takes one out — which is
 * why they waited, and is not a reason to leave a right-click on a photograph
 * answering with the *string* menu, which is what it did until now.
 *
 * Every one of these takes the ids it is to act on rather than working them out
 * — `app/main.ts` resolves the click, applies the selection rule and hands over
 * a list. So a menu is a pure function of ids in all three cases, and the
 * awkward half (what a right-click landed on) stays in one place.
 */

import { STRING_MATERIALS } from "@/lib/material";
import { STRING_COLORS, STRING_THICKNESSES } from "@/lib/palette";
import type { Scene } from "@/state/scene";
import { itemLocal, settleOnPin, settleOnUnpin } from "@/state/tools/frame";
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

  const materials: MenuChoice[] = STRING_MATERIALS.map(({ id, label }) => ({
    label,
    fibre: id,
    current: all((s) => scene.strings.get(s)?.material, id as string),
    run: () => write.setStringStyle(live, { material: id }),
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
     * > yellow, black, white), thickness, material (string / yarn / wire)
     * > — DESIGN section 3.4
     *
     * The colours are `lib/palette.ts`, and the swatches are the *actual* hexes
     * the painter will use rather than a set of approximations chosen to look
     * right in a menu. That is the entire argument for swatches over the six
     * words DESIGN writes them as: which red the red is, is a question only the
     * cork can answer, and the menu is the place to answer it.
     *
     * Material last of the three, because it is the only one that moves the
     * string: colour and weight redraw the same curve, and picking *Wire* has
     * the rope visibly haul itself in (`lib/material.ts`). A row that changes
     * the geometry sits below the two that do not, next to the rule and the two
     * verbs, rather than in the middle of the pickers that only ever restyle.
     */
    { label: "Colour", choices: colors },
    { label: "Weight", choices: weights },
    { label: "Material", choices: materials },
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

/**
 * The rows for a right-click that landed on an item.
 *
 * `clicked` is the item under the cursor and `boardX`/`boardY` the point on it,
 * because *Add pin* is about a place and not just a thing. `targets` is what
 * the verbs act on — the whole item selection when the clicked item was part of
 * it, and just that item when it was not, exactly as the string menu resolves.
 * Both are filtered against the scene: the menu is built from a snapshot taken
 * at the press, and a peer may have deleted any of it since.
 */
export function itemMenuRows(
  scene: Scene,
  write: BoardWriter,
  clicked: string,
  targets: readonly string[],
  boardX: number,
  boardY: number,
): MenuEntry[] {
  const live = targets.filter((id) => scene.slotOf(id) !== undefined);
  if (live.length === 0) return [];
  const rows: MenuEntry[] = [];

  /**
   * > | Add without switching tools | Item context menu → *Add pin* | Pin at
   * > the click point — DESIGN section 3.2
   *
   * At the click point, which is why this row is the one thing here that is
   * about `clicked` alone: a pin goes *somewhere*, and a menu opened over four
   * selected photographs still only has one cursor. `P` is the other route and
   * puts a pin under the cursor too; this is the same gesture without the mode.
   *
   * The local point comes through the item's **rendered** pose (`itemLocal`),
   * so a pin aimed at a photograph mid-swing lands where the paper looks rather
   * than where the document says it would be if it were not hanging. And
   * `settleOnPin` is the other half of that: an item on one pin gaining a
   * second stops swinging, so the pose it was drawn at is written in the same
   * transaction and nothing jumps.
   */
  const local = itemLocal(scene, clicked, boardX, boardY);
  if (local !== null) {
    rows.push({
      label: "Add pin",
      // The local point is fixed at the press because that is what was aimed
      // at, and it stays true however far the item swings while the menu is
      // open — it is a point on the paper. The settle is read at activation for
      // the mirror-image reason: it is the pose the paper is drawn at *now*.
      run: () => write.createPin(clicked, local.x, local.y, settleOnPin(scene, [clicked])),
    });
  }

  /**
   * > `Delete` | Removes the item **and its pins**; strings through those pins
   * > heal — DESIGN section 3.8
   *
   * The cascade is the op's, and `false` is the plain form of it. DESIGN's
   * other form — `Shift`+`Delete`, "the string web keeps its shape with a hole
   * where the evidence was" — stays on the keyboard rather than becoming a
   * second row here. A menu cannot express a modifier, so it would have to be
   * two rows named nearly the same thing, one of which the reader has to work
   * out they do not want; the keystroke that already means it says it better.
   */
  rows.push({
    label: live.length > 1 ? `Delete ${live.length} items` : "Delete",
    divided: rows.length > 0,
    danger: true,
    run: () => write.deleteItems(live, false),
  });

  return rows;
}

/**
 * The rows for a right-click that landed on a pin.
 *
 * > | Remove | `Alt`+click, or context menu | Strings through it heal
 * > — DESIGN section 3.3
 *
 * One row, because that is the row DESIGN names and a pin has nothing else to
 * offer: it has no styling to pick, no layer to flip, and moving it is a drag.
 * A menu with one verb on it is honest — the alternative was a right-click on a
 * pin opening the *string* menu for whatever happened to be selected elsewhere.
 *
 * The healing is `crdt/ops/pins.ts`' and not a flag from here. `settleOnUnpin`
 * is: an item hanging by the pin about to go is drawn at an angle no peer and
 * no reload can see, so the pose it was drawn at is written in the same
 * transaction — otherwise the paper snaps to its authored rotation the instant
 * the pin leaves. Same argument as `Alt`+click, which reaches the same helper.
 */
export function pinMenuRows(
  scene: Scene,
  write: BoardWriter,
  targets: readonly string[],
): MenuEntry[] {
  const live = targets.filter((id) => scene.pins.has(id));
  if (live.length === 0) return [];
  return [
    {
      label: live.length > 1 ? `Remove ${live.length} pins` : "Remove",
      danger: true,
      // Read at activation, not here: a hanging item goes on swinging while the
      // menu is open, and the pose worth writing is the one it is drawn at when
      // the pin actually leaves.
      run: () => write.deletePins(live, settleOnUnpin(scene, live)),
    },
  ];
}
