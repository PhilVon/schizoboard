/**
 * What a string is allowed to look like.
 *
 * > | Restyle | Context menu | Colour (red is default — also blue, green,
 * > yellow, black, white), thickness, material — DESIGN section 3.4
 *
 * ## Why these six hexes and not the six words
 *
 * > Default red is not a pure red — it's a slightly desaturated, slightly dark
 * > cotton red, because saturated red on brown cork vibrates unpleasantly.
 * > — DESIGN section 4.6
 *
 * That sentence is about red and it is a rule about all six. The board is a
 * brown surface under a warm light (section 4.1), and a fully saturated hue on
 * it does the same thing red does: it separates from the cork instead of lying
 * on it, and the eye reads a UI accent rather than a thread. So every one of
 * these is pulled toward the middle and slightly darkened, and the two
 * achromatic ones are not achromatic — black is a very dark warm grey, because
 * "shadow colour is never black" (section 4.1) and a string that *was* black
 * would read as a slot cut in the board; white is a warm off-white, because
 * cotton is not paper.
 *
 * ## Why here
 *
 * `lib/` is dependency-free and importable by anyone, which is the only place
 * `crdt/ops/` and `ui/` can both reach — the op needs the default to create a
 * string with, and the menu needs the whole list to draw swatches of. This is
 * the arrangement `lib/slack.ts` already argues for at length: `DEFAULT_SLACK`
 * lives there because it is *policy* about what an untouched string looks like,
 * while `MIN_SLACK` is duplicated into the schema because it is an invariant the
 * reader enforces on everything a peer sends. Colour is the first kind. The
 * schema's own fallback is the second, and `palette.test.ts` holds the two
 * together so they cannot drift in silence.
 */

/** One entry of the six. `label` is what the menu says out loud. */
export interface StringColor {
  readonly label: string;
  readonly hex: string;
}

/**
 * The palette, in DESIGN section 3.4's order — red first because red is the
 * default, and then the order the sentence lists them in.
 */
export const STRING_COLORS: readonly StringColor[] = [
  { label: "Red", hex: "#a8322c" },
  { label: "Blue", hex: "#2c5aa8" },
  { label: "Green", hex: "#4a7a4e" },
  { label: "Yellow", hex: "#c9a227" },
  { label: "Black", hex: "#26231f" },
  { label: "White", hex: "#e6ddcd" },
];

/** > red is default — DESIGN section 3.4. */
export const DEFAULT_STRING_COLOR = STRING_COLORS[0]!.hex;

/**
 * The thickness ladder, in screen pixels.
 *
 * Screen pixels and not board units, because that is what the renderer means by
 * thickness: `render/ropes/paint.ts` draws in screen space precisely so a line
 * width is absolute at every zoom. A "thick" string is thick when you lean in
 * and still thick from across the board.
 *
 * Four steps rather than a slider. Thickness is not a quantity anybody wants to
 * dial — it is a choice between a thread, a string, a cord and a rope — and a
 * ladder is also what keeps `paint.ts`'s batching worth anything, since it
 * batches by colour *and* width and a continuous control would give every
 * string on the board its own batch.
 *
 * The bottom of the ladder is 2 and not 1: `paint.ts`'s `HIGHLIGHT_MIN` exists
 * because a highlight thinner than about 1.25 px rasterises to a smear the eye
 * reads as nothing, and a 1 px *body* has the same problem with no floor to
 * save it.
 */
export const STRING_THICKNESSES: readonly number[] = [2, 3, 4.5, 6.5];

/** What a new string gets. The second rung, so "thinner" is available without
 *  having to have already thickened something. */
export const DEFAULT_STRING_THICKNESS = STRING_THICKNESSES[1]!;
