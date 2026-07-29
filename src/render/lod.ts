/**
 * Level of detail — how much of an item is worth drawing at this zoom.
 *
 * > Two LOD tiers, both about removing the things that cost most at small
 * > scales.
 * >
 * > **Below 35% zoom** — items become simplified cards: flat paper, baked
 * > shadow, and text swapped for a pre-rasterised snapshot. Live text layout is
 * > by far the largest cost when many items are visible. Ink renders at quarter
 * > resolution.
 * >
 * > **Below 15% zoom** — items are flat coloured rectangles, string draws as
 * > straight one-pixel chords with no sag, pins hide, board ink comes from tile
 * > thumbnails. — DESIGN section 6.6
 *
 * This file is the *decision* only: which tier the camera is in, and when that
 * changes. What each tier looks like belongs to the layer that draws it.
 *
 * ## Why LOD is not an optimisation either
 *
 * `render/cull.ts` says the same thing about itself and for the same reason,
 * and the two are halves of one measurement. D-15 flew the same camera three
 * times over 500 photographs:
 *
 *     stage                       unculled   culled
 *     pan at 100%                     27.7      7.1
 *     hold 5% (all 500 visible)      777.6    763.9
 *     zoom in to 35% (LOD edge)      763.8    562.5
 *
 * Culling makes every state where most of the board is off screen free, and
 * does nothing whatever for the two stages where it is not — because at 5% all
 * 500 items are genuinely visible and there is nothing to remove. Those are
 * *this* file's stages, and 763 ms is what a board costs today when somebody
 * zooms out to look at all of it.
 *
 * ## The tier is a function of zoom, not of `devicePixelRatio * zoom`
 *
 * Everything else in the renderer that reacts to the camera reacts to
 * `devicePixelRatio * zoom` — `World.onRasterize`, `ItemLayer.setRasterScale`,
 * the ink re-raster — because those choose a *bitmap resolution*, and a bitmap
 * is measured in device pixels.
 *
 * A tier is not that. The cost DESIGN names is live text layout, and layout
 * happens in CSS pixels: a note at 30% zoom lays out the same tens of thousands
 * of inline-block glyph boxes (`render/items/hand.ts`) on a 1x display as on a
 * 3x one. So the thing that decides whether the boxes are affordable is the
 * zoom, and `devicePixelRatio` is not part of it.
 *
 * The cost of reading it this way is legibility rather than speed: on a 2x
 * display, 35% zoom still puts a note's writing at 0.7 device scale, which is
 * more readable than the tier assumes. That is the right way round — a tier
 * boundary that moved with the display would mean two people at the same zoom
 * on the same board were looking at different boards.
 *
 * ## Hysteresis, for `render/cull.ts`'s reason
 *
 * A camera resting exactly on 35% must not rebuild every item on the board on
 * alternate gestures. So a tier is entered at its threshold and left ten
 * percent above it, and the band is wide enough to absorb any amount of wheel
 * chatter. Unlike culling's band this one costs nothing at rest: it changes
 * *when* the switch happens, never how much is drawn afterwards.
 *
 * ## Where it is evaluated
 *
 * At gesture end, with the re-raster (`render/world.ts`), because dropping to a
 * cheaper tier is a full repaint of every mounted item and that frame is
 * already a full repaint. It is deliberately **not** hung off `onRasterize`,
 * which fires only when the scale swings by more than 1.25x: 0.36 to 0.34
 * crosses the boundary and is a swing of 1.06, so a tier that listened there
 * would silently never switch at the one place it matters most.
 */

/**
 * How much of an item is drawn.
 *
 *   - `full` — everything. Paper grain, wear, tape, curl, per-glyph jitter.
 *   - `card` — a simplified card: flat paper, baked shadow, writing that is no
 *     longer one box per character.
 *   - `flat` — a coloured rectangle. No writing, no pins, no sag in a string.
 */
export type Tier = "full" | "card" | "flat";

/** DESIGN section 6.6 — "below 35% zoom", items become simplified cards. */
export const CARD_ZOOM = 0.35;

/** DESIGN section 6.6 — "below 15% zoom", items are flat rectangles. */
export const FLAT_ZOOM = 0.15;

/**
 * The far edge of the hysteresis band, as a fraction of the threshold.
 *
 * A tenth: at the card boundary that is 35% down and 38.5% back up, which is
 * three and a half percent of zoom — comfortably more than a wheel notch or a
 * trackpad tremor, and far less than a deliberate zoom.
 */
export const TIER_BAND = 0.1;

/**
 * Is the camera below this threshold, given whether it already was?
 *
 * The whole of the hysteresis: the way down is the threshold, the way back up
 * is the threshold plus the band.
 */
function below(zoom: number, threshold: number, wasBelow: boolean): boolean {
  return zoom < (wasBelow ? threshold * (1 + TIER_BAND) : threshold);
}

/**
 * The tier this zoom is in, given the tier it was in.
 *
 * Pure, and total for any finite zoom. A `NaN` zoom reads as `full`, because
 * every comparison against it is false — which is the safe way round: a camera
 * that has gone wrong draws the whole board rather than silently flattening it
 * (T-194, T-155).
 */
export function tierAt(zoom: number, previous: Tier): Tier {
  if (below(zoom, FLAT_ZOOM, previous === "flat")) return "flat";
  if (below(zoom, CARD_ZOOM, previous !== "full")) return "card";
  return "full";
}

/** Told when the camera settles into a different tier. Never called on a hold. */
export type TierListener = (tier: Tier) => void;

/**
 * The board's one answer to "what tier are we in".
 *
 * A holder rather than a free function because the hysteresis needs the last
 * answer, and because several layers need the same one: an item drawn as a
 * card while its string still sags is worse than either tier on its own.
 *
 * Starts at `full` and *not* at whatever the opening camera implies, so the
 * first `settle` after boot is a real transition and every layer is told once.
 * A board that opens zoomed out would otherwise have layers that were never
 * told anything sitting at their constructed default.
 */
export class Lod {
  private current: Tier = "full";
  private readonly listeners: TierListener[] = [];
  /** Whether anybody has been told anything yet. See the note above. */
  private announced = false;

  get tier(): Tier {
    return this.current;
  }

  /** Whether the writing, the grain and the wear are worth drawing. */
  get detailed(): boolean {
    return this.current === "full";
  }

  /**
   * The camera has settled here. Returns whether the tier changed, so the
   * caller can raise its full dirty pass only when there is something to see.
   */
  settle(zoom: number): boolean {
    const next = tierAt(zoom, this.current);
    if (next === this.current && this.announced) return false;
    this.current = next;
    this.announced = true;
    for (const fn of this.listeners) fn(next);
    return true;
  }

  /** Notified with the new tier whenever it changes. */
  on(fn: TierListener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}
