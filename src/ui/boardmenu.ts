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

import { inkColors, INK_SIZES, type InkTool } from "@/lib/ink";
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
  edit?: (itemId: string) => void,
): MenuEntry[] {
  const live = targets.filter((id) => scene.slotOf(id) !== undefined);
  if (live.length === 0) return [];
  const rows: MenuEntry[] = [];

  /**
   * > Click into a note or a polaroid's caption area to edit.
   * > — DESIGN section 3.6
   *
   * Q-92 made that a double-click, which is the fastest way in and the least
   * discoverable — nothing on the board says the gesture exists. This row is
   * what says it, and it is the reason a menu row was worth adding for a verb
   * the pointer already has.
   *
   * `clicked` alone, like *Add pin* above and for the same reason: there is one
   * caret, and a menu opened over four selected notes cannot put it in all of
   * them. Absent when no editor is wired up, which is every headless caller.
   */
  if (edit) {
    const target = clicked;
    rows.push({ label: "Edit text", run: () => edit(target) });
  }

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
   * > Items have a position, a rotation, an intrinsic size, and a z-order.
   * > — DESIGN section 2.1
   *
   * Which was true of the document and of the renderer and of nothing a person
   * could reach: `z` was set once at creation and never again, so the only way
   * to get a photograph out from under another was to move one of them. These
   * are the way, and the menu is where the human asked for them.
   *
   * Both rows, always, in that order, and never one of them. A menu that hid
   * *Bring to front* on the item that happens to be topmost would be a menu that
   * changes shape as you use it, and the row is not a lie either way — the op
   * declines a write that would move nothing, so picking it on the front item
   * costs no key growth and no undo entry. The pair is also how the two rows
   * teach each other: *Send to back* is the answer to "I raised the wrong one",
   * and it is only obvious that it exists if it is sitting there.
   *
   * `live` and not `clicked`, unlike *Add pin* and *Edit text* above. Those two
   * are about a place and a caret, of which there is one; a restack is a verb
   * that a selection can perfectly well take together, and taking it together is
   * the only way to raise four photographs without scrambling them against each
   * other.
   */
  rows.push(
    {
      label: live.length > 1 ? `Bring ${live.length} to front` : "Bring to front",
      divided: rows.length > 0,
      run: () => write.bringToFront(live),
    },
    {
      label: live.length > 1 ? `Send ${live.length} to back` : "Send to back",
      run: () => write.sendToBack(live),
    },
  );

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

/**
 * What the board itself offers, which today is the one thing that is about the
 * board rather than about anything on it.
 *
 * ## Why a right-click on bare cork (Q-76)
 *
 * Because it was the only surface left, and it turned out to be the right one.
 * There is no settings panel; the two pieces of standing chrome — the hint line
 * and the dev HUD — are `pointer-events: none` on purpose, each having already
 * swallowed board presses once. A right-click on empty cork with nothing
 * selected opened nothing at all, which made it the one gesture on this board
 * that was reaching for something and finding nothing.
 *
 * It is also where it belongs. Every other menu here answers *about this thing
 * under the cursor*; on bare cork there is no thing, and the honest answer to
 * "what is here" is the board.
 *
 * ## The invite row and the string rows share this menu
 *
 * Because a right-click on cork a few pixels from a string is a right-click
 * that missed, and the string rows have always been kept for exactly that. The
 * invite goes *below* them behind a rule: a selection of four strings is a much
 * more likely thing to have meant, and burying the restyle pickers under a row
 * about networking would be answering the wrong question first.
 *
 * `link` is the invite as it stands, or null when there is nothing to give away
 * — a plain browser, or a board whose shell never started a relay. Null removes
 * the row rather than disabling it: a menu entry you cannot use is a question
 * ("why not?") that nothing on screen can answer.
 */
export function boardMenuRows(
  scene: Scene,
  write: BoardWriter,
  strings: readonly string[],
  invite: { link: string | null; copy(link: string): void },
): MenuEntry[] {
  const rows = stringMenuRows(scene, write, strings);
  if (invite.link === null) return rows;
  return [
    ...rows,
    {
      /**
       * Named for what it does rather than for what it is. *Invite someone* is
       * the friendlier label and it is a promise this row cannot keep — nothing
       * is sent, no one is notified, and the user is left holding a link and
       * wondering whether that was it. *Copy invite link* says exactly what will
       * be true a moment later, which is the only thing a confirmation can then
       * confirm.
       */
      label: "Copy invite link",
      divided: rows.length > 0,
      // The link is fixed when the menu opens, not when the row is picked,
      // because the rows are a snapshot and every other menu here works the same
      // way. There is one moment where that matters: an invite arriving while
      // this menu stands open moves the board to a different secret (T-165), and
      // this row would then copy the previous one. The answer is on that side —
      // a rewire closes the menu — rather than here, because a row that
      // re-resolved on activation would hand out a link to a board the user is
      // no longer looking at, which is the worse of the two.
      run: () => invite.copy(invite.link!),
    },
  ];
}

/**
 * The rows for a right-click made while a pen is the tool in hand.
 *
 * > Colours live in a small palette per tool — marker in black, red, blue,
 * > green; highlighter in yellow, pink, green, blue. Size is `[` and `]`.
 * > — DESIGN section 3.9
 *
 * DESIGN gives the palette and binds no key to it, so this is the way in, and it
 * is the fourth menu rather than a fourth thing a click can land on: with a pen
 * held, a right-click is not about the paper under the cursor. Nothing here
 * reads the scene or the click position at all — the marker is not editing an
 * object, it is being loaded.
 *
 * The size row is here as well as on `[` and `]` for the same reason the string
 * menu carries thickness: the keys are for somebody who already knows the
 * ladder, and the chips are how anybody finds out there is one. The chips are
 * drawn at the nib's *own* width (`weight`), so a size is picked by looking at
 * it rather than by reading a number in board units, which is a unit nobody
 * thinks in.
 *
 * A pen and not the document: nothing on this menu writes anything, which is why
 * it takes no `BoardWriter`. That is also why there is no undo entry for picking
 * a colour — changing pens is not an edit to the board.
 */
const PEN_LABEL: Readonly<Record<InkTool, string>> = {
  marker: "Marker",
  highlighter: "Highlighter",
  erase: "Eraser",
};

export function penMenuRows(pen: Pen): MenuEntry[] {
  const colors: MenuChoice[] = inkColors(pen.kind).map(({ label, hex }) => ({
    label,
    swatch: hex,
    current: pen.color === hex,
    run: () => pen.load({ color: hex }),
  }));

  const sizes: MenuChoice[] = INK_SIZES.map((size) => ({
    label: `${size}`,
    weight: size,
    current: pen.size === size,
    run: () => pen.load({ size }),
  }));

  // No colour row for the smudge, and not an empty one: a hole has no colour,
  // and `lib/ink.ts` answers its palette with nothing for exactly this reason.
  // A row with no swatches in it reads as a menu that failed to load.
  return [
    ...(colors.length === 0 ? [] : [{ label: PEN_LABEL[pen.kind], choices: colors }]),
    { label: "Size", choices: sizes },
  ];
}

/**
 * What `penMenuRows` needs of a pen, which is `state/tools/marker.ts`'s
 * `MarkerTool` and is written here as the four members it actually uses.
 *
 * The narrow shape rather than the class, for the same reason every other
 * function in this file takes ids: a menu row is a label and a closure, and
 * nothing about building one should need a tool that owns a pointer.
 */
export interface Pen {
  readonly kind: InkTool;
  readonly color: string;
  readonly size: number;
  load(pen: { color?: string; size?: number }): void;
}
