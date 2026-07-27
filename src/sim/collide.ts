/**
 * Rope↔item draping — what a string is lying on, and where.
 *
 * > An `over` string cannot sag through an item. It rests on it.
 * >
 * > During constraint projection, for awake ropes only, particles are pushed
 * > out of the silhouettes of nearby items — found via the spatial index,
 * > restricted to items intersecting the rope's bounding box. A rope crossing a
 * > photograph therefore comes to rest along the photograph's top edge instead
 * > of cutting through it, exactly as real string does.
 * > — DESIGN section 5.6
 *
 * This file is the "found via the spatial index" half (T-64). The push-out
 * itself is T-65 and lands beside it.
 *
 * ## Why this index is not `render/cull.ts`'s
 *
 * They ask the same question of the same board and they index different
 * rectangles, which is the whole of the difference and it matters:
 *
 * - The culler indexes an item **plus its shadow**, because a shadow is drawn
 *   and a drawn thing must be mounted. A string does not rest on a shadow. Ten
 *   or so board units of pad would put every rope that passes near a photograph
 *   on top of it, hanging visibly clear of the paper.
 * - The culler pads *outward* for the hysteresis band, holds a mounted set, and
 *   answers one query per frame about the viewport. This answers one query per
 *   awake rope per frame about a box a fraction of the size.
 *
 * So the policy is separate and the buckets are shared: `lib/cellgrid.ts` holds
 * the grid, and `sim/` may not import `render/` anyway (ARCHITECTURE section 1).
 *
 * ## The silhouette is the paper, and only the paper
 *
 * `scene.boundsAt(slot, 0, …)` is exactly the right rectangle: rotation-
 * expanded, so a tilted polaroid is not under-reported; drift-corrected, so a
 * hanging item is indexed where it is drawn rather than where it is stored; and
 * with no pad at all, so the string comes to rest against the paper's own edge.
 *
 * Rotation-expanded means the indexed box is *bigger* than the silhouette for a
 * tilted item — the corners of the expanded box stick out past the paper by
 * several units. That is the correct direction to be wrong. This is a broad
 * phase: its job is to never miss a candidate, and the exact rotated-rectangle
 * test that decides whether a particle is actually on the paper is the push-
 * out's (T-65).
 */

import { CellGrid, type CellRange } from "@/lib/cellgrid";
import type { DirtySets } from "@/state/dirty";
import type { Bounds, Scene } from "@/state/scene";

/**
 * Grid cell size, board units — the same 512 the culler uses, for the same
 * reason: items are a few hundred units across, so a cell holds a couple of
 * them and an item rarely spans more than four.
 *
 * The query side wants the same number too. A rope's bounding box is its chord
 * plus its sag, which for the ordinary two-pin string across a board is a few
 * hundred units — the same order as a cell, so a query visits a handful of
 * buckets rather than one enormous one or a hundred small ones.
 */
const CELL = 512;

/**
 * Where every item's silhouette is, so an awake rope can ask what it might be
 * lying on without walking the board.
 *
 * Invalidated from the dirty sets exactly as the culler's grid is, and for the
 * same reason it is safe to: anything that moves an item marks it dirty,
 * because otherwise its transform would never be rewritten and it would
 * visibly stop moving. A deleted item's entries are left behind and filtered on
 * read — `lib/cellgrid.ts` explains why that is the honest way round.
 */
export class ItemIndex {
  private readonly grid = new CellGrid(CELL);
  private readonly box: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly cells: CellRange = { cx0: 0, cy0: 0, cx1: 0, cy1: 0 };

  /**
   * Whether the grid has ever been filled.
   *
   * The same guard the culler carries, against the same shape of bug: an index
   * that meets a scene already full of items with only a couple of them dirty
   * would hold two entries and quietly let every rope fall through everything
   * else. It presents as "draping works, but only sometimes".
   */
  private built = false;

  /**
   * Bring the index in line with the scene. Called once per frame from the SIM
   * phase, before any rope is stepped.
   *
   * A frame that moved nothing does nothing at all, which is what lets DESIGN
   * section 5.3's idle board stay idle: the ropes are asleep, so nothing
   * queries this, and the items are still, so nothing re-indexes it.
   */
  update(scene: Scene, dirty: DirtySets): void {
    if (dirty.all || !this.built) {
      this.rebuild(scene);
      return;
    }
    for (const id of dirty.items) {
      const slot = scene.slotOf(id);
      // No slot means the item was deleted this frame. Its entries stay until
      // something inherits the slot; see `lib/cellgrid.ts`.
      if (slot === undefined) continue;
      this.grid.place(slot, scene.boundsAt(slot, 0, this.box));
    }
  }

  private rebuild(scene: Scene): void {
    this.grid.clear();
    for (let slot = 0; slot < scene.slotLimit; slot++) {
      if (scene.idAt(slot) === null) continue;
      this.grid.place(slot, scene.boundsAt(slot, 0, this.box));
    }
    this.built = true;
  }

  /**
   * Every item slot whose silhouette could touch `rect`, appended to `into`.
   *
   * Slots rather than ids, because the caller is about to read the item's
   * geometry straight out of the scene's typed arrays and a Map lookup per
   * candidate per rope per frame is precisely what the index exists to avoid.
   *
   * "Could" is the contract, and it is deliberately loose. A candidate is an
   * item whose rotation-expanded box overlaps the query box; whether the paper
   * itself is really in the way is the caller's exact test. Over-reporting
   * costs a rejected candidate. Under-reporting is a rope falling through a
   * photograph, so the index never guesses in that direction: an item too big
   * to bucket is returned for every query rather than dropped.
   */
  query(scene: Scene, rect: Bounds, into: number[]): number[] {
    // Slots too big to bucket are candidates for everything. Prune the ones
    // that have since emptied first, so one corrupt item that was deleted does
    // not stay on every rope's candidate list for the life of the session.
    if (this.grid.oversized.size > 0) {
      for (const slot of this.grid.oversized) {
        if (scene.idAt(slot) === null) this.grid.oversized.delete(slot);
        else into.push(slot);
      }
    }

    const { cx0, cy0, cx1, cy1 } = this.grid.cellRange(rect, this.cells);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = this.grid.bucketAt(cx, cy);
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          const slot = bucket[i]!;
          // A deleted item's stale entry.
          if (scene.idAt(slot) === null) continue;
          const b = scene.boundsAt(slot, 0, this.box);
          if (b.minX > rect.maxX || b.maxX < rect.minX) continue;
          if (b.minY > rect.maxY || b.maxY < rect.minY) continue;
          // An item spanning four cells reaches here up to four times, and the
          // caller's push-out is idempotent — a particle already outside the
          // silhouette is not moved by being told so again. Deduping would cost
          // a per-query stamp array to save an arithmetic test.
          into.push(slot);
        }
      }
    }
    return into;
  }

  /** Everything goes. For teardown and for a document swapped out underneath
   *  the scene — none of this is derived from the new one. */
  clear(): void {
    this.grid.clear();
    this.built = false;
  }
}
