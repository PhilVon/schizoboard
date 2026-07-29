/**
 * The edge of a sheet of paper.
 *
 * > Edges are the tell. A machine-cut rectangle reads as a UI element; a torn or
 * > slightly irregular edge reads as paper. Notes get a subtly ragged edge by
 * > default, generated from the item seed, and a "torn" style with a proper rough
 * > tear on one side. — DESIGN section 4.4
 *
 * ## The treatment belongs to the stock
 *
 * The same section opens by saying each stock has "its own grain texture at low
 * opacity, **its own edge treatment**, and its own slight colour variation" — so
 * the tear is not a coin flip sprinkled over the board. It is where the sheet
 * came from. A legal pad is gummed at the head and every sheet leaves it torn
 * along the top; graph paper comes out of a book and tears down the left against
 * the wire; an index card is die-cut and has no business being ragged at all.
 *
 * That is worth more than a random minority of torn notes, because it means the
 * edge and the ruling agree about the same object. It also leaves DATA-MODEL
 * section 3's `style.torn` exactly the job it is described as having: overriding
 * a default, rather than being the only source of one — the same relationship
 * `defaultStock` already has with `style.paperStock`.
 *
 * ## Why a clip path and not a mask
 *
 * A mask is a per-item bitmap, and this board already refuses to pay per item
 * for anything it can share (`shadowSprite`, `paperGrainUrl`). But raggedness
 * cannot be shared — a board of fifty notes wearing one edge is a board of fifty
 * copies, which is the failure `sheetTint` exists to avoid. A `clip-path:
 * polygon()` is the one form of per-item silhouette that costs a string rather
 * than a bitmap, and it is written once per bind.
 *
 * The offsets are in `px` — board units in this file, like every other length in
 * `items.css` — and the positions along each edge are percentages. That mix is
 * the point: a note and a poster then have edges that wander by the same
 * *physical* amount rather than by the same fraction of themselves, which is
 * what stops a large sheet looking like a small sheet photographed closer.
 *
 * What does scale with the sheet is the *wavelength*, because the sample count
 * is fixed. That is the cheaper half of the tradeoff and it is also true of
 * paper: a torn A4 has coarser features than a torn Post-it. The alternative —
 * a sample every N board units — makes the path a function of `w` and `h`, which
 * are pose rather than cold, so it would have to be rewritten on every frame of
 * a resize instead of once when the document changes.
 *
 * Measured before it landed: 500 sheets panned across a fitted board, silhouette
 * on and off on the same nodes in the same session, came out median 24.0 / p99
 * 40.8 ms against 24.8 / 48.7 for plain rectangles, and 24.1 / 40.9 on the
 * repeat. The clip costs nothing measurable — it is a mask on a paint that was
 * already happening, not a filter.
 *
 * ## What it does not clip
 *
 * An item's ink canvas is a child of the item *root*, not of the surface, so the
 * polygon does not reach it — ink is clipped to the paper's **rectangle**
 * (T-136) and can therefore sit in the few board units the silhouette gave up.
 * Invisible at an ordinary edge, where the whole wander is under a nib's width,
 * and visible at a tear, which is T-186.
 */

import { edgeProfile, valueAt } from "@/lib/seed";
import type { PaperStock } from "@/render/items/paper";

/** Which side a sheet was pulled from its pad along. */
export type TornEdge = "top" | "right" | "bottom" | "left";

const EDGES: readonly TornEdge[] = ["top", "right", "bottom", "left"];

interface Treatment {
  /**
   * Half the peak-to-peak wander of an ordinary edge, in board units.
   *
   * Half, because the profile is symmetric about zero and the edge is inset by
   * this much before the profile is added — so the sheet gives up between zero
   * and twice this along each side, and never grows past its own box. Growing
   * would put paper outside the rectangle everything else agrees the item
   * occupies: the hit test, the culler's bounds, the selection chrome and the
   * ink clip are all that rectangle.
   */
  ragged: number;
  /** Where this stock leaves the pad, if it comes off one. */
  tear: TornEdge | null;
}

/**
 * Sample points along an ordinary edge.
 *
 * Nine gives four or five bumps a side, which is a hand-cut edge. Five reads as
 * a shape rather than as an edge — the eye names the individual dents — and past
 * about a dozen the wander is finer than the shadow under it and stops being
 * visible at all, at the same cost.
 */
const RAGGED_SAMPLES = 9;

/**
 * And along the torn one, which needs the finer structure.
 *
 * A tear is not a big wobble; it is a small wobble on a big one. Seventeen
 * against nine at the larger amplitude is what buys that, and it is only ever
 * one edge of the four.
 */
const TEAR_SAMPLES = 17;

/** Half the peak-to-peak of a tear, board units. */
const TEAR_AMPLITUDE = 4.5;

/**
 * Per stock, since DESIGN 4.4 says the edge treatment is the stock's.
 *
 * `white` and `cream` are loose sheets — guillotined once and handled since, so
 * they wander a little and tear nowhere. `index` is die-cut and very nearly
 * doesn't: not zero, because a *perfectly* straight edge beside four ragged ones
 * is the machine-cut rectangle the section warns about, and a card that has been
 * on a board reads as card stock rather than as a `<div>` with about a third of
 * a unit of life in its edge.
 */
const TREATMENTS: Record<PaperStock, Treatment> = {
  white: { ragged: 1.4, tear: null },
  cream: { ragged: 1.6, tear: null },
  legal: { ragged: 1.0, tear: "top" },
  graph: { ragged: 1.0, tear: "left" },
  index: { ragged: 0.35, tear: null },
};

function treatmentOf(stock: PaperStock): Treatment {
  return TREATMENTS[stock] ?? TREATMENTS.white;
}

/** The side this stock was torn along, or null if it was never on a pad. */
export function tearEdge(stock: PaperStock): TornEdge | null {
  return treatmentOf(stock).tear;
}

/**
 * The sheet's silhouette, as a `clip-path` value.
 *
 * Clockwise from the top-left corner. Each corner is emitted once and takes one
 * offset from each of the two edges that meet there, so a corner is displaced on
 * both axes — a corner that receded on one axis only is a bevel, and a bevel is
 * a thing a machine does.
 */
export function edgeClipPath(stock: PaperStock, seed: number): string {
  const treatment = treatmentOf(stock);
  const amplitude = (edge: TornEdge): number =>
    edge === treatment.tear ? TEAR_AMPLITUDE : treatment.ragged;
  const samples = (edge: TornEdge): number =>
    edge === treatment.tear ? TEAR_SAMPLES : RAGGED_SAMPLES;

  const profiles = {} as Record<TornEdge, Float32Array>;
  for (const edge of EDGES) profiles[edge] = edgeProfile(seed, edge, samples(edge));

  /** How far in from its side sample `i` of `edge` sits, board units. */
  const depth = (edge: TornEdge, i: number): number => {
    const half = amplitude(edge);
    return half + half * (profiles[edge][i] ?? 0);
  };
  /**
   * Where along its side sample `i` of `edge` sits.
   *
   * Not `i / (n - 1)`, which is where the first version of this put them, and
   * `items.css` had already written down why that is wrong for the torn
   * photograph: "the run must be irregular in *both* axes — vertices at uneven
   * intervals, each off the line by its own amount". Evenly spaced vertices at a
   * tear's amplitude are a sawtooth, and a sawtooth is a decoration.
   *
   * Under half a step, so the samples cannot cross or bunch into a spike, and
   * from a salt of its own so that where a vertex sits does not predict how deep
   * it goes. The two corners stay put: they belong to two edges at once.
   */
  const along = (edge: TornEdge, i: number): string => {
    const n = samples(edge);
    const slip = (valueAt(seed, `edge-along-${edge}`, i) * 2 - 1) * 0.38;
    return `${(((i + slip) / (n - 1)) * 100).toFixed(1)}%`;
  };

  const near = (edge: TornEdge, i: number): string => `${depth(edge, i).toFixed(2)}px`;
  const far = (edge: TornEdge, i: number): string =>
    `calc(100% - ${depth(edge, i).toFixed(2)}px)`;

  const top = samples("top");
  const right = samples("right");
  const bottom = samples("bottom");
  const left = samples("left");
  const points: string[] = [];

  // Top left, then east along the head. The left profile runs top to bottom and
  // the top profile runs left to right, so index 0 of each is this corner.
  points.push(`${near("left", 0)} ${near("top", 0)}`);
  for (let i = 1; i < top - 1; i++) points.push(`${along("top", i)} ${near("top", i)}`);

  // Top right, then south down the fore-edge.
  points.push(`${far("right", 0)} ${near("top", top - 1)}`);
  for (let i = 1; i < right - 1; i++) points.push(`${far("right", i)} ${along("right", i)}`);

  // Bottom right, then west along the tail — backwards through the bottom
  // profile, which is stored left to right like the top one.
  points.push(`${far("right", right - 1)} ${far("bottom", bottom - 1)}`);
  for (let i = bottom - 2; i > 0; i--) points.push(`${along("bottom", i)} ${far("bottom", i)}`);

  // Bottom left, then north up the spine.
  points.push(`${near("left", left - 1)} ${far("bottom", 0)}`);
  for (let i = left - 2; i > 0; i--) points.push(`${near("left", i)} ${along("left", i)}`);

  return `polygon(${points.join(", ")})`;
}
