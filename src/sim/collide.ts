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
 * `ItemIndex` is the "found via the spatial index" half and `Draper` is the
 * push-out, which the solver calls into once per micro-step.
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
import { ROPE_SPACING } from "@/sim/tuning";
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

/**
 * How far outside a rope's own bounding box the broad phase looks.
 *
 * The box is where the rope was when it last stopped, and the solver is about
 * to move it — up to a whole fixed step's worth of gravity and of anchor
 * travel. One particle spacing of slop covers that with room to spare, and the
 * cost of being generous here is a candidate the exact test rejects.
 */
const QUERY_MARGIN = ROPE_SPACING;

/**
 * How many items one rope will collide against in a frame.
 *
 * Not a correctness bound, and it is never reached by anything a person makes:
 * a string long enough to cross two dozen photographs is a string across the
 * whole board. It is here because `prepare` runs per rope per frame and the
 * arrays it fills are the hot loop's — a pathological document that piles four
 * hundred items into one place must not turn one rope's step into a hundred
 * thousand tests. Past the cap the rope drapes over the first `MAX_CANDIDATES`
 * it was handed and passes through the rest, which is a wrong picture rather
 * than a stalled frame.
 */
const MAX_CANDIDATES = 24;

/**
 * The push-out, and the arrays it works from.
 *
 * One of these for the whole board, not one per rope: `sim/ropes.ts` steps a
 * rope to completion before it starts the next, so `prepare` overwrites the
 * candidate arrays each time and nothing is allocated per rope per frame.
 *
 * ## Why the item is a rectangle here and a box in the index
 *
 * The index answers in rotation-expanded boxes, which over-report a tilted
 * polaroid by several units at the corners. This is where that is paid back:
 * `prepare` reads the item's *actual* rotation and half-extents out of the
 * scene, and `resolve` works in the item's own frame, so a rope resting on a
 * tilted photograph rests on the tilted edge rather than on an invisible
 * upright box around it.
 */
export class Draper {
  readonly index = new ItemIndex();

  private readonly slots: number[] = [];

  /** Candidate silhouettes, unpacked into flat arrays because `resolve` walks
   *  them once per particle per micro-step and a field access per test is the
   *  difference between this fitting in the frame and not. */
  private cx = new Float64Array(MAX_CANDIDATES);
  private cy = new Float64Array(MAX_CANDIDATES);
  private cos = new Float64Array(MAX_CANDIDATES);
  private sin = new Float64Array(MAX_CANDIDATES);
  private hw = new Float64Array(MAX_CANDIDATES);
  private hh = new Float64Array(MAX_CANDIDATES);
  /** The same silhouettes as axis-aligned boxes — the cheap per-particle
   *  rejection, and on a long rope crossing one photograph it rejects almost
   *  every particle in four comparisons. */
  private minX = new Float64Array(MAX_CANDIDATES);
  private minY = new Float64Array(MAX_CANDIDATES);
  private maxX = new Float64Array(MAX_CANDIDATES);
  private maxY = new Float64Array(MAX_CANDIDATES);

  private n = 0;
  private readonly query: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  /** SIM phase (3), once per frame, before any rope steps. */
  update(scene: Scene, dirty: DirtySets): void {
    this.index.update(scene, dirty);
  }

  /**
   * Load the silhouettes one rope could be lying on, and say how many there
   * are — zero meaning the solver should not be handed this at all.
   *
   * `box` is where the rope is now; `QUERY_MARGIN` covers where it is about to
   * be. `skipA` and `skipB` are the slots of the items the segment's two end
   * pins are parented to, or −1 for a pin in the bare cork.
   *
   * ## Why a string never drapes over the item it is pinned to
   *
   * A parented pin's world position is derived from its item's pose, so the pin
   * is *inside* that item's silhouette — always, by construction. Pushing the
   * particles next to it out would kink the string hard around the photograph's
   * edge the instant it leaves its own pin, on very nearly every string on the
   * board, because pinning string to photographs is what the application is for.
   *
   * So the item a segment is tied to is not an obstacle to that segment. The
   * price is a long string that sags back across its own photograph and cuts
   * through it, which takes a deliberately slack run to arrange and is a great
   * deal less visible than a kink at every pin.
   */
  prepare(scene: Scene, box: Bounds, skipA: number, skipB: number): number {
    this.n = 0;
    this.slots.length = 0;

    this.query.minX = box.minX - QUERY_MARGIN;
    this.query.minY = box.minY - QUERY_MARGIN;
    this.query.maxX = box.maxX + QUERY_MARGIN;
    this.query.maxY = box.maxY + QUERY_MARGIN;
    this.index.query(scene, this.query, this.slots);

    for (let i = 0; i < this.slots.length && this.n < MAX_CANDIDATES; i++) {
      const slot = this.slots[i]!;
      if (slot === skipA || slot === skipB) continue;
      // An item spanning several cells comes back once per cell; the arrays are
      // short enough that a scan beats a per-query stamp array.
      let seen = false;
      for (let k = 0; k < this.n; k++) {
        if (this.slots[k] === slot) seen = true;
      }
      if (seen) continue;

      const angle = scene.rot[slot]! + scene.swing[slot]!;
      const n = this.n;
      this.cx[n] = scene.x[slot]! + scene.driftX[slot]!;
      this.cy[n] = scene.y[slot]! + scene.driftY[slot]!;
      this.cos[n] = Math.cos(angle);
      this.sin[n] = Math.sin(angle);
      this.hw[n] = scene.w[slot]! / 2;
      this.hh[n] = scene.h[slot]! / 2;
      const rx = (scene.w[slot]! * Math.abs(this.cos[n]!) + scene.h[slot]! * Math.abs(this.sin[n]!)) / 2;
      const ry = (scene.w[slot]! * Math.abs(this.sin[n]!) + scene.h[slot]! * Math.abs(this.cos[n]!)) / 2;
      this.minX[n] = this.cx[n]! - rx;
      this.minY[n] = this.cy[n]! - ry;
      this.maxX[n] = this.cx[n]! + rx;
      this.maxY[n] = this.cy[n]! + ry;
      // Overwritten in place so the dedupe scan above reads what was kept
      // rather than what the index happened to return.
      this.slots[n] = slot;
      this.n = n + 1;
    }
    return this.n;
  }

  /**
   * Move any particle that is inside a silhouette to the nearest point on its
   * edge — the fourth step of DESIGN section 5.2's solver, called once per
   * micro-step from `sim/verlet.ts`.
   *
   * ## Nearest edge, and why that gives the top one
   *
   * The exit is along whichever of the item's two axes the particle is least
   * deep into, which is the standard resolution for a rotated box and is the
   * only one that does not need a contact normal the simulation has no way to
   * know. It is not, on its own, "rests on the top edge" — a particle nearer
   * the bottom leaves through the bottom. Gravity is what makes the top edge
   * the answer: a rope arrives at a photograph from above, so its particles
   * enter through the top and are shallowest there, and every micro-step that
   * pushes one back up is a micro-step it does not sink. The rope settles along
   * the edge it landed on, which is the one a real string would drape over.
   *
   * ## Endpoints are not pushed
   *
   * They are pins, seated on their anchors every micro-step by the solver and
   * infinite-mass by construction. A correction applied to one is overwritten
   * before it is integrated once, so applying it is wasted work that would also
   * make a pin *look* like it had moved to anything reading the particle back.
   *
   * ## Why `prev` moves with `pos`
   *
   * A Verlet particle's velocity *is* `pos - prev`, so moving `pos` alone and
   * leaving `prev` where it was hands the particle the whole correction as
   * speed — it is fired away from the photograph it just touched, and a rope
   * resting on one buzzes instead of resting. Moving both by the same vector
   * carries the velocity through the contact unchanged: no bounce, no friction,
   * and the rope's own damping bleeds off the rest.
   */
  resolve(pos: Float64Array, prev: Float64Array, at: number, count: number): void {
    const last = at + (count - 1) * 2;
    for (let c = 0; c < this.n; c++) {
      const cx = this.cx[c]!;
      const cy = this.cy[c]!;
      const cos = this.cos[c]!;
      const sin = this.sin[c]!;
      const hw = this.hw[c]!;
      const hh = this.hh[c]!;
      const minX = this.minX[c]!;
      const minY = this.minY[c]!;
      const maxX = this.maxX[c]!;
      const maxY = this.maxY[c]!;

      for (let i = at + 2; i < last; i += 2) {
        const px = pos[i]!;
        const py = pos[i + 1]!;
        if (px < minX || px > maxX || py < minY || py > maxY) continue;

        const ox = px - cx;
        const oy = py - cy;
        const lx = ox * cos + oy * sin;
        const depthX = hw - Math.abs(lx);
        if (depthX <= 0) continue;
        const ly = oy * cos - ox * sin;
        const depthY = hh - Math.abs(ly);
        if (depthY <= 0) continue;

        let ex = lx;
        let ey = ly;
        if (depthX < depthY) ex = lx < 0 ? -hw : hw;
        else ey = ly < 0 ? -hh : hh;

        const dx = cx + ex * cos - ey * sin - px;
        const dy = cy + ex * sin + ey * cos - py;
        pos[i] = px + dx;
        pos[i + 1] = py + dy;
        prev[i] = prev[i]! + dx;
        prev[i + 1] = prev[i + 1]! + dy;
      }
    }
  }

  clear(): void {
    this.index.clear();
    this.n = 0;
    this.slots.length = 0;
  }
}
