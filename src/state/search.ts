/**
 * Which items say a thing, and which one of them you are looking at.
 *
 * > Search · `Ctrl+F` — flies the camera to a match. **Never filters or hides.**
 * > — DESIGN section 3.7
 *
 * The second half of that sentence is the whole design. A search on this board
 * may not narrow it: DESIGN 2.5 rules out filtering because a board that hides
 * the things you did not ask for stops being the thing you remember the shape
 * of. So this module answers *which* and *where*, the camera is taken there
 * (`state/flight.ts`), the match is lit for a moment, and every other item on
 * the board is exactly where it was and exactly as visible.
 *
 * ## There is one text field and it is already mirrored
 *
 * Every item type carries a single `text` — a note's body and a polaroid's
 * caption are the same field rendered into different elements (`crdt/schema.ts`)
 * — and `crdt/binding.ts` already flattens it onto `ItemCold.text`. So the walk
 * reads the scene and never touches Yjs, which matters because this runs on a
 * keystroke: reading a `Y.Text` per item per character typed would be the one
 * place in the application that pays CRDT costs for a read.
 *
 * Nothing else on the board holds prose. Strokes are packed points, pins and
 * strings carry colours and materials, and an asset's original filename is not
 * mirrored into the scene at all.
 *
 * ## It is a walk, and that is a decision rather than an oversight
 *
 * There is no text index and no text-changed signal — `state/dirty.ts` has
 * `dirty.item(id)` and nothing finer, so an index would have to be rebuilt from
 * a signal that does not exist, or rebuilt wholesale, which is the walk again
 * with a cache in front of it. At board scale — hundreds of items, not
 * hundreds of thousands — a substring test per item per keystroke is beneath
 * measurement, and the alternative is a second copy of the board's text that
 * can go stale.
 *
 * ## The order is reading order, and it does not depend on where you are
 *
 * Top to bottom, then left to right, over the rotation-expanded box. The
 * tempting alternative is nearest-the-camera-first, so the first flight is the
 * shortest — and it is wrong, because it makes `Enter` mean something different
 * depending on where you happened to be standing when you typed, and the
 * ordering is stale the moment the first flight lands. Reading order is the
 * same answer every time you search for the same thing, so stepping through
 * matches traces a predictable sweep across the board rather than a tour.
 *
 * There is no row structure on a corkboard, so two items at almost the same
 * height sort by a fraction of a unit. That is arbitrary but *stably* arbitrary,
 * which is the property that matters.
 */

import type { Bounds, Scene } from "@/state/scene";

/**
 * A board search, and a cursor into its answer.
 *
 * Holds ids rather than slots or indices: an item can be deleted by a
 * collaborator between one `Enter` and the next, and an id that has stopped
 * meaning anything is a miss to skip rather than a slot pointing at whatever
 * moved into it.
 */
export class Search {
  /** Matching ids in reading order. */
  private ids: string[] = [];
  /** Index into [`ids`], or -1 when there are none. */
  private at = -1;
  /** What [`ids`] is the answer to, so an unchanged query re-walks nothing. */
  private query = "";

  /** Reused by the sort; `boundsOf` writes into whatever it is handed. */
  private readonly box: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  get count(): number {
    return this.ids.length;
  }

  /** Which match is current, counting from 1 — 0 when there are none. */
  get ordinal(): number {
    return this.at < 0 ? 0 : this.at + 1;
  }

  get current(): string | null {
    return this.at < 0 ? null : (this.ids[this.at] ?? null);
  }

  /**
   * Walk the board for `query` and return the id to fly to, or null for none.
   *
   * **Null also means "you are already there".** Refining a query keeps the
   * match you are looking at as long as it still matches — type `sha`, land on
   * a note, type on to `shape` and the camera stays put rather than jumping to
   * whichever match now sorts first. Without that rule the view lurches with
   * every character and the thing you were reading slides away mid-word.
   *
   * `force` re-walks and re-answers even when nothing has changed, which is what
   * makes pressing `Ctrl+F` again on an open field a way to say "yes, that one"
   * — it flashes the current match rather than doing nothing.
   */
  run(scene: Scene, query: string, force = false): string | null {
    const needle = query.trim().toLowerCase();
    if (needle === this.query && !force) return null;
    this.query = needle;

    const was = this.current;
    this.ids = needle === "" ? [] : this.walk(scene, needle);
    if (this.ids.length === 0) {
      this.at = -1;
      return null;
    }

    // Still on screen and still a match: stay, and say nothing happened.
    if (was !== null) {
      const kept = this.ids.indexOf(was);
      if (kept >= 0) {
        this.at = kept;
        return force ? was : null;
      }
    }
    this.at = 0;
    return this.ids[0] ?? null;
  }

  /**
   * Move `delta` matches and return the id to fly to, or null when there are
   * none. Wraps in both directions.
   *
   * Wrapping rather than stopping at the ends: the count is on screen, so you
   * can see that you have come round, and a key that silently does nothing at
   * the last match is indistinguishable from a key that missed.
   *
   * A single match steps to itself and is returned rather than suppressed — the
   * flight will decline to move a camera already there, and the flash is the
   * answer to "is it still that one".
   */
  step(delta: number): string | null {
    if (this.ids.length === 0) return null;
    const n = this.ids.length;
    const from = this.at < 0 ? (delta >= 0 ? -1 : 0) : this.at;
    this.at = ((((from + delta) % n) + n) % n) | 0;
    return this.ids[this.at] ?? null;
  }

  /**
   * Drop the query and the cursor.
   *
   * Called when the field closes and when the document underneath is replaced —
   * a bundle import swaps every id on the board, and a held id would then name
   * whatever inherited it.
   */
  clear(): void {
    this.ids = [];
    this.at = -1;
    this.query = "";
  }

  private walk(scene: Scene, needle: string): string[] {
    const hits: string[] = [];
    for (const id of scene.itemIds()) {
      const text = scene.cold(id)?.text;
      // The `=== ""` half is an early out rather than a rule — a blank note
      // cannot contain a non-empty needle anyway. It is here because a board is
      // mostly photographs with no caption, and this runs per keystroke.
      if (text === undefined || text === "") continue;
      if (text.toLowerCase().includes(needle)) hits.push(id);
    }
    if (hits.length < 2) return hits;

    // Keyed once rather than measured inside the comparator: `boundsOf` is a
    // handful of trig per call and a sort asks for the same item's position
    // log(n) times.
    const key = new Map<string, number>();
    const keyX = new Map<string, number>();
    for (const id of hits) {
      const b = scene.boundsOf(id, 0, this.box);
      key.set(id, b === null ? Number.POSITIVE_INFINITY : b.minY);
      keyX.set(id, b === null ? Number.POSITIVE_INFINITY : b.minX);
    }
    hits.sort((a, b) => {
      const dy = key.get(a)! - key.get(b)!;
      if (dy !== 0) return dy;
      const dx = keyX.get(a)! - keyX.get(b)!;
      if (dx !== 0) return dx;
      // Two items at the same corner — a duplicated note, or a stack. The id is
      // the last resort and it is a total order, so the sort is deterministic
      // rather than dependent on the engine's stability.
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return hits;
  }
}
