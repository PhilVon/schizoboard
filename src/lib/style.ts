/**
 * What a sheet is *made of* — the per-item half of DATA-MODEL section 3's
 * `style` map.
 *
 * > | `style` | Y.Map | paperStock, tint, tapeStyle, fontFamily, fontSize,
 * > torn, agingEnabled. A Y.Map so two people adjusting different properties
 * > don't clobber each other. — DATA-MODEL section 3
 *
 * ## Every field is an override, and absent is the answer
 *
 * This board's whole look comes from `item.seed`: which paper a note is on,
 * how it is tinted, whether it is taped and at which corners, whether it was
 * torn off a pad. That is why every sheet is subtly different for nothing, and
 * why nobody has ever had to choose a paper stock to make a note.
 *
 * So a style property is never *the* source of an appearance — it is a
 * **veto over the seed's answer**, and the absence of one is not a default but
 * the ordinary case. Two comments in `render/items/` were already written for
 * exactly this reading, before there was anything to read:
 *
 * > leaves DATA-MODEL section 3's `style.torn` exactly the job it is described
 * > as having: overriding a default, rather than being the only source of one
 * > — `render/items/edge.ts`
 *
 * The practical consequence is that a fresh item writes **nothing** here. An
 * empty map is the correct and common state, `undefined` means "ask the seed",
 * and clearing a property is a delete rather than a write of some null-ish
 * value. Getting that backwards would mean every item on the board carrying a
 * frozen copy of what its seed happened to say on the day it was made — which
 * is the same appearance, permanently unable to change if the derivation ever
 * improves.
 *
 * ## Why here
 *
 * The same argument `material.ts` next door makes, and for the same three
 * readers. `lib/` is dependency-free and importable by anyone (there is a lint
 * rule, `LIB_IMPORTS_NOTHING`), and this vocabulary is needed in three places
 * that may not import each other: `crdt/` has to validate what arrives in a
 * document, `render/items/` has to prefer it over the seed, and `ui/` has to
 * draw a row of chips of it.
 *
 * Putting `PaperStock` in `render/items/paper.ts` — where it is today — and
 * importing it from `crdt/schema.ts` would be the document taking a dependency
 * on the renderer, which is the wrong way round even before ARCHITECTURE rule 2
 * is consulted: a board written by this build has to remain readable by a build
 * whose painter has been replaced.
 */

/**
 * The five papers of DESIGN 4.4.
 *
 * Re-exported by `render/items/paper.ts` rather than declared there, so the
 * table of colours and the document's vocabulary cannot drift apart.
 */
export const PAPER_STOCKS = ["white", "cream", "legal", "graph", "index"] as const;
export type PaperStock = (typeof PAPER_STOCKS)[number];

/**
 * The flat colour of each stock — warm, low-chroma, and none of them pure
 * white, because paper never is.
 *
 * Here rather than in `render/items/paper.ts` with the grain and the ruling for
 * one reason: `ui/` has to draw a swatch of each on a menu chip and may not
 * import the renderer. `paper.ts` reads these to build its own table, so a chip
 * and the sheet it stands for cannot come to disagree — which is what a second
 * copy of five hex values in a menu would eventually do.
 */
export const STOCK_BASE: Record<PaperStock, string> = {
  white: "#f7f4ed",
  cream: "#f2e9d6",
  legal: "#f6efb9",
  graph: "#f4f2e8",
  index: "#f8f5ef",
};

/** What each stock is called out loud — a chip has no text of its own. */
export const STOCK_NAMES: Record<PaperStock, string> = {
  white: "White",
  cream: "Cream",
  legal: "Legal pad",
  graph: "Graph paper",
  index: "Index card",
};

/**
 * The face an item's writing is set in.
 *
 * > A clean typeface is available per item for anyone pasting something they
 * > actually need to read. — DESIGN section 3.6
 *
 * Two words rather than a font name, and that is deliberate: a document that
 * names `"Patrick Hand"` is a document that renders differently on a machine
 * where the bundled woff2 has been swapped, and the *choice* being recorded
 * here is "in the board's hand" against "legible", not a family. Which files
 * those are is `render/items/`'s business.
 */
export const ITEM_FACES = ["hand", "clean"] as const;
export type ItemFace = (typeof ITEM_FACES)[number];

/**
 * Which corners carry tape, as a bitmask — top-left, top-right, bottom-right,
 * bottom-left, clockwise from the top left, which is the order
 * `render/items/tape.ts` and `curl.ts` already share.
 *
 * A mask rather than a count because the seed already produces asymmetric
 * pairs — one corner, or `TL|BR` across a diagonal — and a per-item override
 * that could only say "how many" would be unable to express what the seed
 * itself does.
 */
export const TAPE_NONE = 0;
export const TAPE_ALL = 0b1111;

/**
 * A per-item override of what the seed would otherwise decide.
 *
 * Every field optional, and every absent field meaning "the seed's answer" —
 * see the note at the top of this file, because it is the whole design.
 */
export interface ItemStyle {
  readonly paperStock?: PaperStock;
  /**
   * Hue rotation in degrees and lightness in percent, both signed offsets from
   * the stock's own base colour.
   *
   * The same two numbers `sheetTint` already draws from the seed, rather than a
   * colour: a sheet's tint is a *variation on its paper*, so an absolute colour
   * would let a graph-paper note be authored pink and stop reading as paper at
   * all. Bounds are the renderer's; nonsense is clamped rather than refused,
   * because a sheet nobody can read is still a sheet you must be able to select
   * and delete.
   */
  readonly tint?: { readonly hue: number; readonly light: number };
  /** Corners carrying tape. `TAPE_NONE` is a real choice — "take the tape off
   *  this one" — and is why this is not merely absent. */
  readonly tapeStyle?: number;
  /** Whether this sheet came off a pad. The *side* stays the stock's, because
   *  which edge a legal pad tears along is a fact about legal pads. */
  readonly torn?: boolean;
  readonly fontFamily?: ItemFace;
}

/** A style with nothing overridden — every item, until somebody chooses. */
export const NO_STYLE: ItemStyle = {};

export function isPaperStock(value: unknown): value is PaperStock {
  return typeof value === "string" && (PAPER_STOCKS as readonly string[]).includes(value);
}

export function isItemFace(value: unknown): value is ItemFace {
  return typeof value === "string" && (ITEM_FACES as readonly string[]).includes(value);
}

/** Whether anything is overridden at all. The renderer's cheap way to skip a
 *  whole branch, and the writer's way to know a delete emptied the map. */
export function isPlain(style: ItemStyle): boolean {
  return (
    style.paperStock === undefined &&
    style.tint === undefined &&
    style.tapeStyle === undefined &&
    style.torn === undefined &&
    style.fontFamily === undefined
  );
}
