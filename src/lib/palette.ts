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

/**
 * What a board is made of, as a colour — T-408, Q-369.
 *
 * ## A ladder and not a picker, and the reason is the same as the strings'
 *
 * `STRING_THICKNESSES` above argues that thickness "is not a quantity anybody
 * wants to dial — it is a choice between a thread, a string, a cord and a
 * rope". A board's colour is the same shape of question. Nobody wants a hue
 * wheel over the thing every other object on the board is judged against; they
 * want the handful of surfaces that actually exist on real walls, and every one
 * of them has to look like something somebody would hang.
 *
 * A free picker would also break the one thing the cork has to keep doing,
 * which is to be the *ground*. DESIGN section 4.1 tunes every paper stock, every
 * ink and the shadow under every item against this beige; a board somebody had
 * turned pure cyan would not make the notes look wrong, it would make them look
 * broken, and there would be no way back from it that was not another guess.
 *
 * ## They are all still cork
 *
 * These are tints of the same granulated surface, not different materials —
 * `grainTile` multiplies its whole field by the base, so the flecks, the pale
 * dust and the pits all move together and the result still reads as compressed
 * bark. That is deliberate, and it is what keeps this task apart from T-409: a
 * pin goes into every one of these, so nothing here needs a second fastener
 * vocabulary. Coloured cork boards are a real thing on real walls; a whiteboard
 * you can push a pin into is not.
 *
 * ## Absent is `natural`
 *
 * `sourceAbout`'s convention, and `WRITTEN_TIMER_MODES`': the default is the
 * answer for nearly every board, so it is never written, and every other answer
 * — absent, an id a later build invented, a peer's nonsense — reads as the cork
 * this application ships. An unpainted board therefore puts nothing on the wire
 * and looks exactly as it did before this existed.
 */
export interface CorkColor {
  /** What is written in `meta.corkColor`. Never the label, which is prose and
   *  may be reworded; never the rgb, which may be re-tuned. */
  readonly id: string;
  /** What the menu says out loud. */
  readonly label: string;
  /** The base the grain, the flecks and the flat fill are all multiplied from. */
  readonly base: { readonly r: number; readonly g: number; readonly b: number };
}

export const CORK_COLORS: readonly CorkColor[] = [
  // The cork this application has always shipped, and the one `render/cork.ts`
  // was tuned against. First because it is the default.
  { id: "natural", label: "Cork", base: { r: 173, g: 130, b: 84 } },
  // Darker bark, the colour of a board that has been on a wall for thirty
  // years — the same object, further along the ageing this board already does.
  { id: "roasted", label: "Dark cork", base: { r: 122, g: 88, b: 56 } },
  // The three below are the pin boards that are not cork-coloured and are still
  // cork underneath: the felt-faced boards of a school corridor. Desaturated on
  // purpose — a saturated ground competes with the paper on it.
  { id: "slate", label: "Slate", base: { r: 116, g: 118, b: 118 } },
  { id: "moss", label: "Moss", base: { r: 104, g: 118, b: 92 } },
  { id: "oxblood", label: "Oxblood", base: { r: 134, g: 88, b: 82 } },
];

/** The cork an unpainted board is made of. */
export const DEFAULT_CORK = CORK_COLORS[0]!;

/**
 * The colour an id names, or the default — never null.
 *
 * Total on purpose, so no caller has to decide what an unrecognised id means.
 * There is one answer and it is the same one absence gives.
 */
export function corkColorOf(id: unknown): CorkColor {
  if (typeof id !== "string") return DEFAULT_CORK;
  return CORK_COLORS.find((c) => c.id === id) ?? DEFAULT_CORK;
}
