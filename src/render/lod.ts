/**
 * Level of detail — how much of an item is worth drawing at this zoom.
 *
 * > **Below 35% zoom** — items become simplified cards: flat paper, baked
 * > shadow, and writing laid down as a single text node rather than one
 * > transform box per character. Ink renders at quarter resolution.
 * >
 * > Detail varies with zoom; structure does not. What exists on the board, and
 * > where it is, is the same at every zoom. — DESIGN section 6.6
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
 *
 * ## There were two tiers here and now there is one
 *
 * DESIGN 6.6 had a second, at 15% and then briefly at 20%: "items are flat
 * coloured rectangles, string draws as straight one-pixel chords with no sag,
 * pins hide, board ink comes from tile thumbnails". Every clause of it is gone,
 * and by four different routes (Q-121):
 *
 *   - **flat rectangles** measured *identical* to a flat card, everywhere, once
 *     the glyph boxes were gone (D-33 section 5) — and the hiding of the writing
 *     that it amounted to in practice cost a visible pop as the text came back;
 *   - **straight chords** and **hidden pins** were refused on principle, and the
 *     principle is now in DESIGN 6.6: detail varies with zoom, structure does
 *     not. What exists on the board and where it is does not change because you
 *     moved the camera;
 *   - **board ink from tile thumbnails** was already true and never was work.
 *     `render/ink/board.ts` rasters every tile at `devicePixelRatio * zoom`, so
 *     at 15% a tile's canvas *is* a thumbnail by construction.
 *
 * So the type has two members rather than three, and that is the honest shape: a
 * third that behaved identically to `card` in every branch of this renderer was a
 * promise the code was not keeping.
 */
export type Tier = "full" | "card";

/** DESIGN section 6.6 — "below 35% zoom", items become simplified cards. */
export const CARD_ZOOM = 0.35;

/**
 * `items.css` `.paper-body` — the board's handwriting, in board units.
 *
 * Named here rather than inferred because the number below is derived from it,
 * and it has moved once already: 17 to 19 when the face became Patrick Hand,
 * whose x-height is smaller at the same nominal size. If it moves again, the
 * reading zoom moves with it and this is the line that says so.
 */
const BODY_UNITS = 19;

/**
 * How large the board's writing has to be drawn before it can be *read*, in
 * screen pixels — not merely be present, which is what [`CARD_ZOOM`] answers.
 *
 * Two different questions, and conflating them is the trap. `CARD_ZOOM` is
 * where per-glyph text stops being drawn at all, so below it there is nothing
 * to read by construction; at it, the writing is drawn and is 6.7 px tall,
 * which is a grey smudge in the shape of a paragraph.
 *
 * Measured rather than picked. The wordiest note on a real board, rendered at
 * 35 / 45 / 55 / 65 / 80 percent: 6.7 px is a smudge, 8.6 px resolves into word
 * shapes you can nearly guess at, and 10.5 px is where a rotated, handwritten,
 * hundred-and-fifty-character note simply reads. Above that it grows more
 * comfortable and buys nothing a search needs, at the cost of the surrounding
 * board — which is the thing DESIGN section 2.3 is about.
 */
const READABLE_PX = 10.5;

/**
 * The zoom a camera has to reach for the writing on a sheet to be legible —
 * Q-153, and the floor a search flight lands at (T-85).
 *
 * A quotient rather than a constant so there is one opinion about legibility
 * and it is held in the unit legibility is actually about. `0.55` written here
 * directly would be a number that silently stopped being true the next time the
 * body size moved.
 */
export const READING_ZOOM = READABLE_PX / BODY_UNITS;


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
export const DETAIL: Record<Tier, number> = { full: 1, card: 0 };

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
  /** Whether a caller has taken the tier away from the zoom — see [`hold`]. */
  private held = false;

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
   *     and the culler has fewer items mounted, and there is only one rise there
   *     is to make: `card` to `full`.
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
    if (this.held) return false;
    const next = tierAt(zoom, this.current);
    if (DETAIL[next] <= DETAIL[this.current]) return false;
    return this.apply(next);
  }

  /**
   * Take the tier away from the zoom until the returned function gives it back
   * (T-205).
   *
   * For an export, and it is not an optimisation to skip: an export frames the
   * whole board, which is a zoom of a few per cent, which is `card` — so the
   * first PDF this project produced came out as flat sheets with no ruling, no
   * ageing and no curl, and the dev HUD *inside the file* said `16% · card`
   * (D-36). The tier is a judgement about what is worth drawing in 16
   * milliseconds; a file has no frame budget and wants everything.
   *
   * A release rather than a second call, because the failure that matters is
   * forgetting to put it back — a board left holding `full` at 5% zoom is the
   * performance work of T-90 silently undone. The caller can put this in a
   * `finally` and cannot get it wrong.
   */
  hold(tier: Tier): () => void {
    const before = this.current;
    this.held = true;
    this.apply(tier);
    return () => {
      this.held = false;
      this.apply(before);
    };
  }

  /**
   * The camera has settled here. Returns whether the tier changed, so the
   * caller can raise its full dirty pass only when there is something to see.
   */
  settle(zoom: number): boolean {
    if (this.held) return false;
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
