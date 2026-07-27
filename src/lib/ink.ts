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
 * The coordinate space is the producer's: screen pixels for a stroke being drawn,
 * item-local units for one being re-rastered. The geometry is identical either
 * way; only the width has to be told which (`render/ink/geometry.ts`).
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
 * A stroke that is still being drawn — "wet ink", in DESIGN section 6.5's terms.
 *
 * Declared here for the same reason `InkSample` is: the tool holding the pointer
 * produces it and the overlay draws it, and the two may not import each other.
 * It is the ink counterpart of `render/overlay.ts`'s `PendingRun`, and it is
 * transient in the same way — nothing about it is in the document, nothing about
 * it survives the release, and a peer sees it only over awareness if at all.
 *
 * `samples` are in **board** space rather than screen, which is a deliberate
 * departure from the wet overlay being a screen-resolution surface. A stroke can
 * outlive a camera move: the wheel still zooms while a pointer is down, and
 * points stored in screen pixels would slide off the cork as it did. Board
 * coordinates converted at draw time is what every other canvas on this board
 * does (`render/ropes/paint.ts`) and it is right here for the same reason.
 */
export interface WetStroke {
  readonly tool: InkTool;
  readonly color: string;
  /** Board units — see [`DEFAULT_INK_SIZE`]. */
  readonly size: number;
  /** Board space, oldest first. */
  readonly samples: readonly InkSample[];
}
