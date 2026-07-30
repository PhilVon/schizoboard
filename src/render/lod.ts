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
 * ## Where it is evaluated, and why the two directions differ
 *
 * A **fall** — losing detail — happens at gesture end, with the re-raster
 * (`render/world.ts`), because it is a full repaint of every mounted item and
 * that frame is already a full repaint. It is deliberately **not** hung off
 * `onRasterize`, which fires only when the scale swings by more than 1.25x: 0.36
 * to 0.34 crosses the boundary and is a swing of 1.06, so a tier that listened
 * there would silently never switch at the one place it matters most.
 *
 * A **rise** happens *during* the gesture, and [`Lod.rise`] is the argument. The
 * short of it: this file originally said a mid-gesture tier change would be paid
 * for and never seen, and the second half was backwards. Mid-gesture is precisely
 * when a change of detail is invisible, and doing it at rest put a board-wide pop
 * on the one frame nothing else was moving (T-203).
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

/**
 * The bottom tier's threshold — DESIGN section 6.6, and 20% rather than the 15%
 * the section first named (Q-120, T-204).
 *
 * It moved because `MIN_ZOOM` moved. The camera's floor was raised to 0.15 so the
 * board never mounts five hundred items at once, and 0.15 was also this number —
 * with an exclusive comparison, which meant the camera could reach the bottom
 * tier's threshold and never pass it. The tier was unreachable, and a section of
 * DESIGN that cannot be entered is worse than one that was never written.
 *
 * 20% gives it a real range of 15 to 20, which is not a leftover: it is precisely
 * the band where a board is at its heaviest, 370 mounted items on the bench board
 * against 142 at 35%. And it is where its three clauses become defensible —
 * a rope's sag really is sub-pixel there, and a pin really is four pixels across.
 *
 * The tier's fourth clause, "items are flat coloured rectangles", is not here and
 * was never built: it measured at zero against a flat card (D-33 section 5) and it
 * cost a visible pop, so DESIGN dropped it rather than this file implementing it.
 */
export const FLAT_ZOOM = 0.2;

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

/**
 * How much of an item each tier draws, most to least. Only the *order* is used —
 * see [`Lod.rise`], which is the one thing that needs to know that `full` is more
 * than `card`, and which would otherwise have to compare two strings and hope.
 *
 * Exported for `render/items/dom.ts`, which asks the same question of a tier it
 * is being handed: a rise owes every mounted item its detail, a fall owes
 * nothing.
 */
export const DETAIL: Record<Tier, number> = { full: 2, card: 1, flat: 0 };

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
   * The camera is *moving* and has reached this zoom — take any detail that has
   * become due, but do not give any up (T-203).
   *
   * ## Why detail rises during a gesture and only falls at rest
   *
   * The two directions are nothing alike, and treating them alike is what
   * produced the one thing left on this board that Phil could see. Going up, the
   * tier used to change on the frame the camera *stopped*, so a zoom in from 5%
   * held flat cards through the whole motion and then, on the first still frame,
   * about a hundred and forty sheets simultaneously grew a torn edge, a ruling, a
   * grain, tape and a per-letter lean. A board-wide pop, at the one moment nothing
   * else on screen was moving.
   *
   * T-197's note had it backwards. It said a mid-gesture tier change would be paid
   * for and never seen; the paying is true and the seeing is the wrong way round —
   * mid-gesture is exactly when a change of detail is invisible, because the whole
   * board is in motion. So detail arrives while it cannot be watched arriving.
   *
   * The other direction stays at the settle, and for a reason that is not
   * symmetry:
   *
   *   - **Rising is cheap.** It happens at a zoom where the camera is closing in
   *     and the culler has fewer items mounted, and — since the `flat` and `card`
   *     tiers became identical for items — the only rise that costs anything at
   *     all is `card` to `full`.
   *   - **Falling is expensive.** It happens at a zoom where five hundred items
   *     are mounted, and the settle frame is the one already repainting the whole
   *     world subtree for the demote. There is nothing to gain by moving it, and a
   *     board's detail *leaving* while you pull away from it is not a pop anybody
   *     minds.
   *
   * Returns whether anything changed, so the caller raises its dirty pass only
   * when there is something to see.
   */
  rise(zoom: number): boolean {
    const next = tierAt(zoom, this.current);
    if (DETAIL[next] <= DETAIL[this.current]) return false;
    return this.apply(next);
  }

  /**
   * The camera has settled here. Returns whether the tier changed, so the
   * caller can raise its full dirty pass only when there is something to see.
   */
  settle(zoom: number): boolean {
    return this.apply(tierAt(zoom, this.current));
  }

  private apply(next: Tier): boolean {
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
