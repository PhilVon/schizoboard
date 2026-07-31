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
import { PAPER_STOCKS, STOCK_BASE, STOCK_NAMES, type ItemStyle } from "@/lib/style";
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
       * > | Cut | `Ctrl`+`Alt`+click a string — the scissors — or context menu
       * > → *Delete* | String removed; its pins stay where they are
       * > — DESIGN section 3.4
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
/**
 * The two style overrides an item's menu offers - DATA-MODEL section 3's style
 * map, as the same restyle chrome a string already has.
 *
 * ## Two of the five, and the other three deliberately
 *
 * The map holds five properties and `render/items/style.ts` honours all five.
 * This offers **paper** and **the writing face**, because those are the two a
 * person has a reason to reach for: a note whose stock says what kind of note it
 * is, and DESIGN section 3.6's clean face for "something you actually need to
 * read". Tint, tape and the torn edge are the seed's job and it does them well -
 * the whole premise of seed-derived appearance is that nobody should have to
 * choose - and putting a control on each of them cost more menu than the choices
 * were worth. See the note above `itemMenuRows`.
 *
 * ## What the chips say, and what they deliberately do not
 *
 * Each strip marks what has been **chosen**, not what is being **shown**. That
 * is not a shortcut around `ui/` being unable to import the renderer; it is the
 * right question. The map holds overrides, "as it was" is the state of nearly
 * every item on the board, and a strip that lit the stock the *seed* happened to
 * draw would be telling you that you had picked cream when you had picked
 * nothing - and would leave no way to see, or to reach, the difference.
 *
 * So each strip leads with **as it was**, marked when nothing is overridden, and
 * picking it clears rather than writing a default (`crdt/ops/items.ts`). Without
 * that chip an item could be styled and never put back.
 *
 * ## The whole selection, like the restack rows
 *
 * A style is a verb a selection can take together - restyling four notes to the
 * same paper is the point of having selected four notes. Nothing here is about a
 * place or a caret, so nothing here uses `clicked` except to read what to mark.
 */
function appearanceRows(
  scene: Scene,
  write: BoardWriter,
  live: readonly string[],
  clicked: string,
): MenuEntry[] {
  // The clicked item's own overrides decide what is marked. A mixed selection
  // has no single answer and inventing one - "marked when they all agree" -
  // would make the strip go blank the moment two notes differed, which reads as
  // broken rather than as informative.
  const style: ItemStyle = scene.cold(clicked)?.style ?? {};
  const set = (patch: Partial<ItemStyle>) => () => write.setItemStyle(live, patch);

  /** The chip each strip leads with. A `transparent` swatch paints an empty
   *  box, which is what "nothing chosen" looks like. */
  const asItWas = (chosen: boolean, patch: Partial<ItemStyle>): MenuChoice => ({
    label: "As it was",
    swatch: "transparent",
    current: !chosen,
    run: set(patch),
  });

  return [
    {
      label: "Paper",
      divided: true,
      choices: [
        asItWas(style.paperStock !== undefined, { paperStock: undefined }),
        ...PAPER_STOCKS.map(
          (stock): MenuChoice => ({
            label: STOCK_NAMES[stock],
            swatch: STOCK_BASE[stock],
            current: style.paperStock === stock,
            run: set({ paperStock: stock }),
          }),
        ),
      ],
    },
    {
      label: "Writing",
      choices: [
        asItWas(style.fontFamily !== undefined, { fontFamily: undefined }),
        {
          label: "The board's hand",
          fibre: "hand",
          current: style.fontFamily === "hand",
          run: set({ fontFamily: "hand" }),
        },
        {
          label: "A clean face, for reading",
          fibre: "clean",
          current: style.fontFamily === "clean",
          run: set({ fontFamily: "clean" }),
        },
      ],
    },
  ];
}
export function itemMenuRows(
  scene: Scene,
  write: BoardWriter,
  clicked: string,
  targets: readonly string[],
  boardX: number,
  boardY: number,
  edit?: (itemId: string) => void,
  /**
   * The photograph itself, back out onto the disk — absent in a plain browser,
   * where `platform/mock.ts` has no dialog to open and `assetExport` rejects.
   *
   * Two members rather than one because the row has two ways not to belong, and
   * only one of them is a fact about the scene. Whether the item *wears* a
   * photograph is read here off `scene.cold`; whether this machine still expects
   * to have its bytes is `state/assets.ts`, which this file must not import — a
   * menu is a pure function of ids and a transfer is not.
   */
  photo?: {
    /** This machine has given up on the bytes — DESIGN 7.5's torn photograph. */
    gone(sha256: string): boolean;
    save(sha256: string): void;
  },
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
   * The restyle strips, here on the menu rather than behind a row that opens
   * them.
   *
   * This started as five strips, then as one *Appearance* row that opened all
   * five, and it is two strips because the problem was never where to put them:
   * it was how many there were. Five controls is more menu than a six-verb menu
   * can carry, and hiding five behind a row makes the menu shorter without
   * making the choice smaller — you still have to know the row is there and
   * still have to read five captions when you arrive. Cutting to the two a
   * person has a reason to reach for solves the size and the depth at once, and
   * leaves an item's menu speaking the same language a string's already does:
   * a caption and a strip of chips, sitting where you can see them.
   *
   * The other three properties are not lost — the map holds them, the renderer
   * honours them, and a peer or a later build can write them. They have no
   * control on this build because a control is a claim that the choice is worth
   * making, and for tint, tape and the torn edge the seed's answer is the one
   * anybody would have picked.
   */
  rows.push(...appearanceRows(scene, write, live, clicked));

  /**
   * The photograph back out, under the name it came in with (T-101).
   *
   * ## Why this file verb is on an item's menu when the others are not
   *
   * `boardMenuRows` below argues that every file verb belongs on the board menu,
   * and that argument holds for the three rows it was written about: a `.schizo`,
   * a PDF and an image are all *new files made out of the board*, and which part
   * of the board they cover is the selection, which the board menu can read
   * perfectly well without anything under the cursor.
   *
   * This is the other kind. It makes nothing: it hands back the bytes that came
   * in, byte for byte, at the size they were taken at rather than at whatever
   * scale an export came out — which is the only way to get a photograph off
   * this board and still have the photograph. And it is about *one* thing, of
   * which the board menu has none: a right-click on bare cork has no photograph
   * under it, and a row there would have to invent one out of the selection.
   *
   * So the dividing line is not board-verb against item-verb after all. It is
   * whether the file is a *picture of* the board or a thing already on it.
   *
   * ## `clicked` alone, and no count in the label
   *
   * Like *Edit text* and *Add pin* above, and here the reason is the dialog: one
   * save is one native dialog, and four selected photographs would be four of
   * them in a row, each waiting on the last. That is not a verb anybody meant to
   * pick — it is a modal queue — and *Save 4 photographs…* is the label that
   * would promise it.
   *
   * ## Absent, not disabled, in three cases
   *
   * No `photo` (a plain browser). A `clicked` wearing no photograph, which is
   * every note. And a photograph this machine has given up on, which is the one
   * that would otherwise open a save dialog, take a filename, and fail — the
   * exact shape the standing "null removes the row" rule exists to prevent. That
   * last absence is also the only one the board explains on its own: an item with
   * no bytes is drawn torn and the notice names who has them (DESIGN 7.5), so
   * there is no unanswerable *why not?* left behind.
   *
   * An asset still on its way is **not** one of the three. `unknown` is also what
   * a photograph that has been on this disk since boot reads as until something
   * asks for it, so hiding on anything short of a real giving-up would take the
   * row off perfectly good photographs at the least explicable moment.
   */
  if (photo !== undefined) {
    const asset = scene.cold(clicked)?.assetId ?? null;
    if (asset !== null && !photo.gone(asset)) {
      rows.push({
        // The ellipsis says a dialog is next and nothing has happened yet —
        // *Export board…* below carries one for the same reason, and *Copy
        // invite link*, which is finished the moment you let go, does not.
        //
        // "The photograph" rather than "image": DESIGN calls them photographs
        // throughout, and the word also separates this row from *Export the
        // board as an image…* on the other menu, which is the row it could most
        // easily be mistaken for and writes something else entirely.
        label: "Save the photograph…",
        divided: true,
        run: () => photo.save(asset),
      });
    }
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
 * ## The board rows and the string rows share this menu
 *
 * Because a right-click on cork a few pixels from a string is a right-click
 * that missed, and the string rows have always been kept for exactly that. The
 * board's own rows go *below* them behind a rule: a selection of four strings is
 * a much more likely thing to have meant, and burying the restyle pickers under
 * a row about networking would be answering the wrong question first.
 *
 * `link` is the invite as it stands, or null when there is nothing to give away
 * — a plain browser, or a board whose shell never started a relay. Null removes
 * the row rather than disabling it: a menu entry you cannot use is a question
 * ("why not?") that nothing on screen can answer.
 *
 * `ageing` is never absent, which is the difference between the two: every board
 * on every machine can be told to stop ageing, so this menu is now the one
 * gesture that always opens something. Before it, a right-click on the cork of a
 * board with no relay and no string selected still found nothing.
 *
 * `board` is null in a plain browser, where there is no shell to write a file
 * with — absent on the same terms as the invite, and for the same reason.
 *
 * ## Why every export is on this menu
 *
 * `selected` is the item selection, and it is here only to *word* the PDF row
 * (T-209) — the export itself reads the live selection when it runs.
 *
 * The obvious alternative was a row on the item menu, so that a right-click on
 * something selected offers to export it. It is the wrong shape twice over.
 * Every other row in `itemMenuRows` is a verb against the item — edit it, pin
 * it, raise it, delete it — and an export is a verb about a *file*; and the
 * board menu is already where the other two file rows live, so somebody looking
 * for "make me something to send" has one place to look rather than two.
 *
 * That first half read as "and no file verb is anywhere else" until T-101 put
 * one on the item menu, and the exception is worth stating because it sharpens
 * the rule rather than bending it. *Save the photograph…* does not make a file
 * out of the board; it hands back a file that is already on it. `itemMenuRows`
 * above carries the line that actually divides the two.
 *
 * What that costs is a trap this row has to word its way out of: a right-click
 * on bare cork does not clear the item selection, so with three notes held the
 * board menu is open *and* an export would cover those three (Q-127). A row
 * that said "the board" while writing a file of three notes would be lying, so
 * it says which it is. That is the whole of `selected`.
 */
export function boardMenuRows(
  scene: Scene,
  write: BoardWriter,
  strings: readonly string[],
  selected: readonly string[],
  invite: { link: string | null; copy(link: string): void },
  ageing: { on: boolean; set(on: boolean): void },
  /**
   * `null` in a plain browser, where none of these four can happen at all.
   *
   * `pdf` is separately nullable, and it is the only one that is: PDF export is
   * WebView2's `PrintToPdf`, so a macOS or Linux shell has all the others and
   * not that one (T-210, Q-139). Null removes the row on the same standing null
   * removes the whole group — a row that cannot work is a question nothing on
   * screen can answer, and this one would answer it by opening a save dialog
   * and then failing after the file had been named.
   */
  board: {
    export(): void;
    /**
     * Null on a board this build may not write to (T-224).
     *
     * The same standing `pdf` is on, and for a stronger reason: opening a
     * bundle *replaces* the board in this window — it writes the new snapshot
     * over this board's log — so on a read-only board it is the one row here
     * that would do the exact thing being refused. Absent rather than disabled,
     * like everything else on these menus.
     */
    open: (() => void) | null;
    pdf: (() => void) | null;
    image(): void;
  } | null,
): MenuEntry[] {
  const rows = stringMenuRows(scene, write, strings);
  const below: MenuEntry[] = [
    /**
     * DESIGN section 4.7's "ageing can be turned off entirely for anyone who
     * finds it precious", and a right-click on bare cork is the only gesture on
     * this board that is about the board rather than about a thing on it.
     *
     * A verb rather than a picker, and the label says what will happen rather
     * than what is currently true. Two chips reading *On* and *Off* would be the
     * other way to draw it and it is the worse one here: a picker's marked chip
     * is a report on state, and this is one switch with two positions and
     * nothing to compare them against.
     *
     * A preference and not an edit (`app/prefs.ts`), so it writes nothing to the
     * document and has no undo entry — the same standing `penMenuRows` has, and
     * for the same reason.
     */
    {
      label: ageing.on ? "Stop the board ageing" : "Let the board age",
      divided: rows.length > 0,
      run: () => ageing.set(!ageing.on),
    },
  ];
  if (invite.link !== null) {
    below.push({
      /**
       * Named for what it does rather than for what it is. *Invite someone* is
       * the friendlier label and it is a promise this row cannot keep — nothing
       * is sent, no one is notified, and the user is left holding a link and
       * wondering whether that was it. *Copy invite link* says exactly what will
       * be true a moment later, which is the only thing a confirmation can then
       * confirm.
       */
      label: "Copy invite link",
      // The link is fixed when the menu opens, not when the row is picked,
      // because the rows are a snapshot and every other menu here works the same
      // way. There is one moment where that matters: an invite arriving while
      // this menu stands open moves the board to a different secret (T-165), and
      // this row would then copy the previous one. The answer is on that side —
      // a rewire closes the menu — rather than here, because a row that
      // re-resolved on activation would hand out a link to a board the user is
      // no longer looking at, which is the worse of the two.
      run: () => invite.copy(invite.link!),
    });
  }
  if (board !== null) {
    below.push({
      /**
       * The ellipsis is doing real work: this row opens a save dialog and
       * nothing has happened yet when it is picked. *Copy invite link* above it
       * has no ellipsis for the same reason — that one is finished the moment
       * you let go.
       *
       * "Export" rather than "Save", because a board is already saved; it has
       * been saving itself since the first thing landed on it (DESIGN 7.8).
       * A *Save* row invites the reading that everything before it was
       * provisional, which is the one thing this application never asks anyone
       * to worry about.
       *
       * Null removes the row rather than disabling it, the way the invite above
       * does — a plain browser cannot write a bundle at all, and a menu entry
       * you cannot use is a question nothing on screen can answer.
       */
      label: "Export board…",
      // Under the invite: both hand the board to somebody, and this is the
      // heavier of the two.
      run: () => board.export(),
    });
    /**
     * The picture, where the row above it is the board itself (T-209).
     *
     * Under *Export board…* because a `.schizo` is the board — everything on
     * it, reopenable, and the thing to send somebody who is going to work on
     * it. A PDF is what it *looked* like: DESIGN section 1's "taking a picture
     * of your thinking", for somebody who is only going to read it. The order
     * is which of those two a person means more often when they are handing a
     * board over, and it is the first.
     *
     * **The label says what the file will cover.** Not decoration: a
     * right-click on bare cork leaves the item selection standing, so the
     * menu can perfectly well be open over a board with three notes held —
     * and the export would then be of those three and their neighbours
     * (Q-127), not of the wall. "The board" would be a lie in exactly the
     * case where nothing else on screen would correct it.
     *
     * *Selection* rather than a count, because a count would promise a cutout
     * of that many things and Q-127 chose the *region*: the file has whatever
     * else is inside those bounds, and "3 items" is the one wording that
     * makes the neighbours look like a bug.
     *
     * **And it is the one row here that a platform can take away** (T-210).
     * `PrintToPdf` is WebView2's, so this row exists on Windows and not on
     * macOS or Linux — where the row below it, which needs no shell but a
     * `write`, is the picture instead.
     */
    const pdf = board.pdf;
    if (pdf !== null) {
      below.push({
        label: selected.length > 0 ? "Export the selection as PDF…" : "Export the board as PDF…",
        run: pdf,
      });
    }
    below.push({
      /**
       * The other picture, and it goes below the PDF for one reason (T-206).
       *
       * Both rows are "a picture of your thinking"; they differ in what the
       * handwriting *is*. A PDF carries it as embedded, selectable,
       * infinitely-sharp text (D-36); an image carries it as pixels at whatever
       * size the file came out. So the PDF is the better answer to "send this to
       * somebody" and the image is the better answer to "put this in something
       * else" — and the first of those is what a person handing a board over
       * means more often, which is the same argument that put `.schizo` above
       * both.
       *
       * Worded off the same selection as the row above, and it has to be: the
       * two rows sit next to each other, and one saying *the board* while its
       * neighbour said *the selection* would read as a difference in what they
       * cover rather than in what they write.
       *
       * On a platform with no PDF row it has no neighbour and is simply the
       * picture (T-210) — which is why *this* row is the unconditional one.
       */
      label:
        selected.length > 0
          ? "Export the selection as an image…"
          : "Export the board as an image…",
      run: () => board.image(),
    });
    const openBoard = board.open;
    if (openBoard !== null) {
      below.push({
        /**
         * Last, and last on purpose. Q-111 made this the one row on the board
         * that destroys a board — it replaces the one in this window — so it
         * sits below *Export board…*, which is both the row somebody reading
         * down wants far more often and, if they take it first, the thing that
         * makes this one survivable.
         *
         * The confirmation is native and lives in `bundle_open`, because
         * nothing in `capabilities/` lets this side open a dialog at all.
         */
        label: "Open a board…",
        run: () => openBoard(),
      });
    }
  }
  return [...rows, ...below];
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
