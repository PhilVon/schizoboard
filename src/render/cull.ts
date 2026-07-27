/**
 * Viewport culling — which items are worth having in the DOM at all.
 *
 * > A uniform spatial grid over board space. Item bounds are rotation-expanded
 * > and shadow-padded, tested against the viewport expanded by 20%.
 * >
 * > Off-screen items **return their DOM node to a pool and are removed** — at
 * > high counts, removal genuinely beats hiding — with a hysteresis band so
 * > items hovering at the edge don't thrash. — DESIGN section 9.1
 *
 * ## Why this is not an optimisation
 *
 * The phase-0 spike (D-12) measured the frame in which `will-change` comes off
 * at gesture end, with 500 live item nodes: **777 ms**. Three quarters of a
 * second, every time somebody finishes a zoom. With two nodes live the worst
 * frame in the same run was 13.9 ms. The cost tracks the number of live item
 * nodes and essentially nothing else, so the only lever is to have fewer of
 * them. This file is that lever. LOD (T-90) is the other half, for the case
 * where the items genuinely are all on screen and there is nothing to cull.
 *
 * ## Culling changes what is mounted, never what exists
 *
 * The scene mirror is the whole board at all times, so everything that reasons
 * about the board rather than about pixels is untouched: the marquee walks
 * `scene.itemIds()`, `F` and `Ctrl+0` walk it too, deletion is an op on ids, and
 * pin layout is scene arithmetic. The one thing that *is* scoped to what is
 * mounted is `hitTest`, and that is correct rather than a compromise — the
 * pointer only ever lands inside the viewport, and everything inside the
 * viewport is mounted with a 20% margin to spare.
 *
 * ## Two ways to answer the same question
 *
 * The grid is a win when the board is large and the viewport is small — the
 * ordinary state of working on something. Zoomed out to see everything it is
 * pure overhead: the query rect covers every cell, and walking thousands of
 * mostly-empty buckets costs more than the dense slot scan it replaces. So the
 * query counts the cells it is about to visit first and takes the scan when
 * there are more cells than items. One structure, two access paths, and the
 * cheaper one is chosen per frame rather than argued about here.
 *
 * ## The buckets themselves are `lib/cellgrid.ts`
 *
 * The grid moved to `lib/` when the draping pass wanted the same buckets, and
 * has stayed there since that pass was scrapped (D-22). What is here is all the
 * policy: which rectangle an item is indexed at (rotation-expanded and
 * shadow-padded), when to re-index it (the dirty sets), and the hysteresis
 * band — none of which the grid has ever heard of.
 */

import { CellGrid, type CellRange } from "@/lib/cellgrid";
import { SHADOW_PAD } from "@/render/items/shadow";
import type { Camera } from "@/state/camera";
import type { DirtySets } from "@/state/dirty";
import type { Bounds, Scene } from "@/state/scene";

/**
 * Grid cell size, board units.
 *
 * Items are a few hundred units across (a pasted photograph is ~320), so a cell
 * holds a couple of them and an item rarely spans more than four cells. Smaller
 * cells mean more buckets to visit per query; larger ones mean more items to
 * reject per bucket, and the cost of a rejection is the cheaper of the two.
 */
const CELL = 512;

/** DESIGN section 9.1 — tested against "the viewport expanded by 20%". */
export const ENTER_MARGIN = 0.2;

/**
 * The far edge of the hysteresis band: an item stays mounted until it leaves
 * *this* rectangle, having mounted when it entered the 20% one.
 *
 * The band has to be wider than the camera can jitter back and forth, or an item
 * sitting exactly on the boundary mounts and unmounts on alternate frames — and
 * a mount is a DOM insertion plus a rebind, which is precisely the cost culling
 * exists to avoid paying. A tenth of the viewport absorbs any amount of wheel
 * chatter or hand tremor. It is not free: during a sustained pan the mounted set
 * is the *leave* rectangle's population, about 30% more nodes than the enter
 * rectangle's. That is the price of not thrashing, and it is worth it.
 */
export const LEAVE_MARGIN = 0.3;

/** Which access path the last query took — the grid, or the dense slot scan. */
export type CullPath = "grid" | "scan" | "none";

export class Culler {
  /**
   * The mounted set, live. The renderer is handed this object rather than a
   * copy, and it is also the culler's own record of what was visible last
   * frame — which is what the hysteresis band is measured against.
   */
  readonly visible = new Set<string>();

  /** Diagnostic: how the last query was answered. Read by tests and the HUD. */
  path: CullPath = "none";

  /**
   * Buckets of **slots**, not ids: the whole point of the walk is to reach the
   * typed arrays without a Map lookup per item.
   *
   * ## Invalidation
   *
   * Maintained from `dirty.items` rather than by hooking scene mutations, which
   * works because of an invariant the DOM layer already depends on: *anything
   * that changes where an item is on the board marks it dirty*. It has to —
   * otherwise the item's transform would never be rewritten either, and it
   * would visibly stop moving. So one source of truth serves both.
   *
   * Deletion is the one thing a dirty *id* cannot express, because the slot is
   * already gone by the time we look. Those entries are left in place and
   * filtered on read (`scene.idAt(slot)` is null), and cleaned out for real by
   * whichever item inherits the slot — see `lib/cellgrid.ts`.
   */
  private readonly grid = new CellGrid(CELL);
  private readonly enter: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly leave: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly item: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly cells: CellRange = { cx0: 0, cy0: 0, cx1: 0, cy1: 0 };

  /** Whether the grid has ever been filled. See `update`. */
  private built = false;

  /**
   * LAYOUT phase (4). Bring `visible` in line with the camera and the scene.
   *
   * Deliberately in a read phase and not in the DOM phase that consumes it:
   * this is arithmetic over the scene mirror, and phase 5 is for writing
   * (ARCHITECTURE section 3).
   *
   * One path, whatever changed. It would be cheaper to re-test only the dirty
   * items when the camera held still, instead of re-querying the whole viewport
   * — but "cheaper" here is a hundred-odd floating-point comparisons against
   * one, on a frame that is about to write DOM. Two paths that must agree, with
   * only a fuzz test standing between them and a silently missing item, is a bad
   * trade for noise.
   */
  update(scene: Scene, dirty: DirtySets, camera: Camera): void {
    // Ink and rope dirt cannot move an item, so they cannot change the answer.
    // Ink briefly could, between T-133 and T-136 — a stroke ran off the paper
    // and the item was drawn bigger than it was. It is clipped to the paper now.
    if (!dirty.all && !dirty.camera && !dirty.culling && dirty.items.size === 0) return;

    // `!built` covers a culler that meets a scene already full of items with
    // nothing but the camera dirty — which is not how `main.ts` wires it, but is
    // exactly the shape of bug that presents as "half the board is missing, but
    // only sometimes".
    if (dirty.all || !this.built) this.reindexAll(scene);
    else this.reindexDirty(scene, dirty);

    camera.visibleBounds(ENTER_MARGIN, this.enter);
    camera.visibleBounds(LEAVE_MARGIN, this.leave);

    // Out first, on the wider rectangle. Deleting from a Set while iterating it
    // is defined behaviour: an entry removed before it is reached is skipped.
    for (const id of this.visible) {
      const slot = scene.slotOf(id);
      if (slot === undefined || !this.overlaps(scene, slot, this.leave)) this.visible.delete(id);
    }

    // Then in, on the narrower one. The gap between the two is the band.
    this.gather(scene, this.enter);
  }

  /** Rebuild from nothing — document load, undo, anything with `dirty.all`. */
  private reindexAll(scene: Scene): void {
    this.grid.clear();
    for (let slot = 0; slot < scene.slotLimit; slot++) {
      if (scene.idAt(slot) === null) continue;
      this.grid.place(slot, scene.boundsAt(slot, SHADOW_PAD, this.item));
    }
    this.built = true;
  }

  private reindexDirty(scene: Scene, dirty: DirtySets): void {
    for (const id of dirty.items) {
      const slot = scene.slotOf(id);
      // No slot means the item was deleted this frame. Its entries stay until
      // something inherits the slot; see CellGrid's note on invalidation.
      if (slot === undefined) continue;
      this.grid.place(slot, scene.boundsAt(slot, SHADOW_PAD, this.item));
    }
  }

  private overlaps(scene: Scene, slot: number, rect: Bounds): boolean {
    const b = scene.boundsAt(slot, SHADOW_PAD, this.item);
    return b.minX <= rect.maxX && b.maxX >= rect.minX && b.minY <= rect.maxY && b.maxY >= rect.minY;
  }

  /** Add every item overlapping `rect`, by whichever path is cheaper. */
  private gather(scene: Scene, rect: Bounds): void {
    // An unindexable item forces the scan, because the grid does not know where
    // it is. Prune the ones whose slots have since emptied first, so a single
    // corrupt item that was deleted does not leave the culler scanning for good.
    if (this.grid.oversized.size > 0) {
      for (const slot of this.grid.oversized) {
        if (scene.idAt(slot) === null) this.grid.oversized.delete(slot);
      }
    }

    if (this.grid.oversized.size > 0 || this.grid.cellsIn(rect) >= scene.slotLimit) {
      this.path = "scan";
      for (let slot = 0; slot < scene.slotLimit; slot++) {
        const id = scene.idAt(slot);
        if (id === null) continue;
        if (this.overlaps(scene, slot, rect)) this.visible.add(id);
      }
      return;
    }

    this.path = "grid";
    const { cx0, cy0, cx1, cy1 } = this.grid.cellRange(rect, this.cells);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = this.grid.bucketAt(cx, cy);
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          const slot = bucket[i]!;
          // A deleted item's stale entry. Cheaper to skip here than to hunt the
          // slot down at deletion time, when it no longer exists.
          const id = scene.idAt(slot);
          if (id === null) continue;
          // An item spanning four cells is tested up to four times. `Set.add`
          // is idempotent and the test is a dozen floating-point comparisons,
          // so a per-query stamp array to dedupe would cost more than it saves.
          if (this.overlaps(scene, slot, rect)) this.visible.add(id);
        }
      }
    }
  }

  clear(): void {
    this.visible.clear();
    this.grid.clear();
    this.built = false;
    this.path = "none";
  }
}
