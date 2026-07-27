/**
 * What ink is, before anything draws any.
 *
 * `lib/` is dependency-free and importable by anyone, which is the only place
 * `state/tools/` and `render/ink/` can both reach — and both need these. The tool
 * produces samples and the renderer consumes them, and neither may import the
 * other: a tool never touches the DOM (`state/tools/tool.ts`) and the renderer
 * answers from the scene, never from a gesture. So the shape they agree on lives
 * here, for the same reason `lib/slack.ts` holds `DEFAULT_SLACK` and
 * `lib/palette.ts` holds the six string colours.
 */

/**
 * One input sample: where the pointer was, and how hard.
 *
 * Pressure is a plain number rather than optional, unlike on
 * `state/tools/tool.ts`'s `PointerSample`, and the difference between the two is
 * the whole reason both exist. That one is what the *event* said, where a missing
 * reading and a meaningless one have to stay distinguishable; this one is what
 * the *stroke* is made of, by which point somebody has had to decide. The
 * deciding is `lib/pressure.ts`: a pen's own reading, and for every other device
 * one derived from how fast the hand was moving.
 *
 * The coordinate space is the stroke's, and [`WetStroke.item`] is what names it:
 * item-local for a stroke glued to a photograph, board for one on bare cork. The
 * two are the same scale — an item's local frame is a rotation and a translation
 * with no zoom in it — so a width in board units means the same thing in either,
 * and the geometry is identical either way.
 */
export interface InkSample {
  readonly x: number;
  readonly y: number;
  /** 0 to 1. */
  readonly pressure: number;
}

/**
 * > | Marker | `M` | Opaque, width varies with pressure (pen) or velocity
 * > (mouse) |
 * > | Highlighter | `H` | Translucent multiply, flat cap, near-constant width |
 * > — DESIGN section 3.9
 *
 * The eraser is not here. It is a tool you hold but not a *kind of mark* — the
 * default one deletes stroke records and leaves nothing behind, and the `Shift+E`
 * smudge is stored as a stroke with `tool: 'erase'` drawn `destination-out`
 * (DATA-MODEL section 6.2). It joins this union when that lands (T-62), because
 * only then does it have geometry of its own.
 */
export type InkTool = "marker" | "highlighter";

/**
 * The nib width, in **board units** — 1 unit is 1 px at 100% zoom.
 *
 * Board rather than screen because ink is a mark *on* the paper: zoom in and it
 * gets thicker along with the photograph it is drawn on, which is the opposite of
 * a string (`render/ropes/paint.ts` keeps those a fixed number of screen pixels,
 * because a string is an object in front of the board rather than a mark on it).
 *
 * Six is a fine-tip marker on a board where a polaroid is a few hundred units
 * across — thick enough to read as ink rather than as a pen line, thin enough to
 * circle a face without covering it. `[` and `]` move it (DESIGN section 3.9);
 * the ladder they walk arrives with them.
 */
export const DEFAULT_INK_SIZE = 6;

/**
 * > marker in black — DESIGN section 3.9
 *
 * A warm near-black, not `#000`. The board is a brown surface under a warm light
 * and "shadow colour is never black" (DESIGN section 4.1); a pure black mark on a
 * warm off-white polaroid reads as printed rather than drawn on. Slightly darker
 * and less warm than `lib/palette.ts`'s string black, because that one is dyed
 * cotton lit from the front and this one is a pigment soaked into paper.
 */
export const DEFAULT_MARKER_COLOR = "#1f1b17";

/**
 * > highlighter in yellow, pink, green, blue — DESIGN section 3.9
 *
 * The yellow, and it is a saturated one because it is about to be laid down at
 * [`DEFAULT_HIGHLIGHTER_OPACITY`] and multiplied: a pale yellow chosen by eye at
 * full strength disappears entirely once it is a translucent film over paper.
 * Pick the pigment, not the result.
 */
export const DEFAULT_HIGHLIGHTER_COLOR = "#f2d024";

/**
 * The chisel tip, in board units — wide enough to cover a line of a note's text,
 * which is 17 units tall.
 *
 * Nearly four times the marker's, and that ratio is the tools' whole visual
 * difference at a glance: one is for writing on things and the other is for
 * covering things that are already written.
 */
export const DEFAULT_HIGHLIGHTER_SIZE = 22;

/**
 * How much of the paper a highlighter pass leaves showing.
 *
 * Two passes over the same words should read as deliberate emphasis and a third
 * should saturate — which puts a single pass somewhere around 0.4, since
 * `multiply` compounds what is already there rather than replacing it. Lower and
 * one pass is invisible on a photograph; higher and one pass is already opaque,
 * at which point it is a marker in the wrong colour.
 */
export const DEFAULT_HIGHLIGHTER_OPACITY = 0.4;

/**
 * > Colours live in a small palette per tool — marker in black, red, blue,
 * > green; highlighter in yellow, pink, green, blue. — DESIGN section 3.9
 *
 * Two palettes rather than one shared list, because the same word means a
 * different pigment in each: a marker's green is a dark ink read at full
 * strength, and a highlighter's is a fluorescent one about to be laid down at
 * [`DEFAULT_HIGHLIGHTER_OPACITY`] and multiplied. Sharing the hexes would make
 * one of the two wrong, and it would be the highlighter — a dark green film over
 * a photograph is a stain rather than a highlight.
 *
 * Labels as well as hexes, because the menu shows swatches and a swatch has no
 * name to read out. Same arrangement as `lib/palette.ts`'s string colours, and
 * for the reason `ui/boardmenu.ts` gives: which red the red is, is a question
 * only the cork can answer.
 */
export interface InkColor {
  readonly label: string;
  readonly hex: string;
}

/** Black first — it is [`DEFAULT_MARKER_COLOR`], and the default is where a
 *  palette starts. */
export const MARKER_COLORS: readonly InkColor[] = [
  { label: "Black", hex: DEFAULT_MARKER_COLOR },
  // Warm rather than pure, all three, for the reason the black is: this is
  // pigment soaked into paper under a warm light, not a screen colour.
  { label: "Red", hex: "#b8342a" },
  { label: "Blue", hex: "#2a4d8f" },
  { label: "Green", hex: "#2f6b3c" },
];

/** Saturated, all four, because every one of them is about to be drawn at 0.4
 *  and multiplied — see [`DEFAULT_HIGHLIGHTER_COLOR`]. */
export const HIGHLIGHTER_COLORS: readonly InkColor[] = [
  { label: "Yellow", hex: DEFAULT_HIGHLIGHTER_COLOR },
  { label: "Pink", hex: "#f0509b" },
  { label: "Green", hex: "#5fd23c" },
  { label: "Blue", hex: "#3fc4f0" },
];

/** The palette a tool draws from. */
export function inkColors(tool: InkTool): readonly InkColor[] {
  return tool === "highlighter" ? HIGHLIGHTER_COLORS : MARKER_COLORS;
}

/**
 * The nib widths `[` and `]` walk, in board units.
 *
 * A ladder rather than a multiplier on a free number, so that the sizes are the
 * same set every time and the two defaults are *on* it — a `]` that moved 6 to
 * 7.5 would leave the marker somewhere no menu can show as current, and the
 * ladder would be different on every board depending on how it was walked.
 *
 * Ratios of roughly 1.5, which is about the smallest step that reads as a
 * different pen rather than as the same one drawn twice. It spans both tools:
 * there is one ladder, and the marker merely starts near the bottom of it and
 * the highlighter near the top.
 */
export const INK_SIZES: readonly number[] = [2, 4, 6, 10, 15, 22, 32, 48];

/**
 * The nearest rung to a size, which is what a pen constructed with an arbitrary
 * one steps from.
 *
 * Nearest rather than "the one below", so a pen handed a size between two rungs
 * does not shrink the first time it is asked to grow.
 */
export function inkSizeIndex(size: number): number {
  let best = 0;
  for (let i = 1; i < INK_SIZES.length; i++) {
    if (Math.abs(INK_SIZES[i]! - size) < Math.abs(INK_SIZES[best]! - size)) best = i;
  }
  return best;
}

/**
 * A stroke that is still being drawn — "wet ink", in DESIGN section 6.5's terms.
 *
 * Declared here for the same reason `InkSample` is: the tool holding the pointer
 * produces it and the overlay draws it, and the two may not import each other.
 * It is the ink counterpart of `render/overlay.ts`'s `PendingRun`, and it is
 * transient in the same way — nothing about it is in the document, nothing about
 * it survives the release, and a peer sees it only over awareness if at all.
 *
 * `samples` are never screen pixels, which is a deliberate departure from the wet
 * overlay being a screen-resolution surface. A stroke can outlive a camera move:
 * the wheel still zooms while a pointer is down, and points stored in screen
 * pixels would slide off the cork as it did. World coordinates converted at draw
 * time is what every other canvas on this board does (`render/ropes/paint.ts`)
 * and it is right here for the same reason.
 *
 * Which world, though, is [`item`] — and that is fixed at pen-down and never
 * revisited:
 *
 * > The stroke's coordinate space is fixed at pen-down: item-local if the press
 * > landed on a photograph, board if it landed on cork. — DESIGN section 3.9
 */
export interface WetStroke {
  readonly tool: InkTool;
  readonly color: string;
  /** Board units — see [`DEFAULT_INK_SIZE`]. Also item-local units, because the
   *  two are the same scale. */
  readonly size: number;
  /**
   * 0 to 1 — the highlighter's translucency, and 1 for the marker.
   *
   * Carried on the wet stroke rather than being the renderer's business, so that
   * the mark under the pointer is the mark that lands: the committed record has
   * an `opacity` field (DATA-MODEL section 6.1) and the wet path and the dry path
   * have to read the same number, or a highlighter changes shade at pen-up.
   */
  readonly opacity: number;
  /**
   * The item the samples are local to, or null for board space.
   *
   * Decided at pen-down and then held, which is the whole of the rule. Held
   * because the alternative — asking on each sample what is under the cursor —
   * would change space in the middle of a line the moment it crossed an edge,
   * and a stroke drawn off the side of a polaroid would break in half and glue
   * its two halves to different things.
   *
   * Naming the item rather than carrying its transform, because the transform is
   * a function of where the item is *this frame*: it can be moved, and swing on
   * its pin, while the pointer is still down. Resolving the id at draw time is
   * what makes the ink stay on the paper through all of that (AC-22), and
   * baking the pose in at pen-down is exactly the bug that would look like ink
   * sliding off a photograph as it swings.
   */
  readonly item: string | null;
  /** The space [`item`] names, oldest first. */
  readonly samples: readonly InkSample[];
}
