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
import { CONTACT_FRICTION, ROPE_SPACING } from "@/sim/tuning";
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
   * The stretches of board that items moved through this frame, as flat
   * quads — `minX, minY, maxX, maxY`, four numbers per rectangle.
   *
   * This is what wakes a rope that is resting on a photograph somebody has
   * picked up. It has to be the *swept* rectangle rather than either end of the
   * move: a rope resting on a photograph overlaps where the photograph was, and
   * a rope about to be landed on overlaps where it is going, and a drag fast
   * enough to clear its own width in a frame would otherwise wake neither.
   *
   * Emptied and refilled every `update`, and read in the same frame by
   * `sim/ropes.ts`. Flat numbers rather than objects because a multi-select drag
   * fills it once per item per frame.
   */
  readonly disturbed: number[] = [];

  /** The box each slot was last indexed at, four numbers per slot, and which
   *  slots have one. Half of the swept rectangle above. */
  private prevBox = new Float64Array(0);
  private hasPrev = new Uint8Array(0);
  /** The id each slot was indexed under, and the way back. A deleted item is
   *  gone from the scene by the time this hears about it, so its slot can only
   *  be found through a record this kept itself. */
  private indexedId: (string | null)[] = [];
  private readonly slotOfIndexed = new Map<string, number>();

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
    this.disturbed.length = 0;

    if (dirty.all || !this.built) {
      // A load, an undo, a document swap. Every rope is re-seeded at rest and
      // asleep on this frame anyway (`sim/ropes.ts`), so there is nothing to
      // wake and no swept rectangle worth reporting.
      this.rebuild(scene);
      return;
    }

    for (const id of dirty.items) {
      const slot = scene.slotOf(id);
      if (slot === undefined) {
        // Deleted this frame. Its bucket entries stay until something inherits
        // the slot (`lib/cellgrid.ts`), but where it *was* still has to wake
        // whatever was resting on it.
        const gone = this.slotOfIndexed.get(id);
        if (gone !== undefined) {
          if (this.indexedId[gone] === id) this.sweep(gone, null);
          this.slotOfIndexed.delete(id);
        }
        continue;
      }
      const box = scene.boundsAt(slot, 0, this.box);
      this.sweep(slot, box);
      this.grid.place(slot, box);
      this.remember(id, slot, box);
    }
  }

  /** Report where a slot has been and where it now is, as one rectangle. */
  private sweep(slot: number, box: Bounds | null): void {
    let minX = box === null ? Infinity : box.minX;
    let minY = box === null ? Infinity : box.minY;
    let maxX = box === null ? -Infinity : box.maxX;
    let maxY = box === null ? -Infinity : box.maxY;
    if (this.hasPrev[slot] === 1) {
      const at = slot * 4;
      if (this.prevBox[at]! < minX) minX = this.prevBox[at]!;
      if (this.prevBox[at + 1]! < minY) minY = this.prevBox[at + 1]!;
      if (this.prevBox[at + 2]! > maxX) maxX = this.prevBox[at + 2]!;
      if (this.prevBox[at + 3]! > maxY) maxY = this.prevBox[at + 3]!;
    }
    // An item that arrived this frame with nothing recorded and no box is
    // nothing at all — there is no such call, but a NaN quad here would wake
    // every rope on the board rather than none.
    if (minX > maxX) return;
    this.disturbed.push(minX, minY, maxX, maxY);
  }

  private remember(id: string, slot: number, box: Bounds): void {
    if (slot * 4 + 4 > this.prevBox.length) this.grow(slot + 1);
    const previous = this.indexedId[slot];
    // The slot changed hands. The old occupant is gone, and leaving it in the
    // map would mean a later item of the same id reading somebody else's box.
    if (previous !== null && previous !== undefined && previous !== id) {
      this.slotOfIndexed.delete(previous);
    }
    this.indexedId[slot] = id;
    this.slotOfIndexed.set(id, slot);
    const at = slot * 4;
    this.prevBox[at] = box.minX;
    this.prevBox[at + 1] = box.minY;
    this.prevBox[at + 2] = box.maxX;
    this.prevBox[at + 3] = box.maxY;
    this.hasPrev[slot] = 1;
  }

  private grow(slots: number): void {
    let next = Math.max(64, this.hasPrev.length);
    while (next < slots) next *= 2;
    const boxes = new Float64Array(next * 4);
    boxes.set(this.prevBox);
    this.prevBox = boxes;
    const has = new Uint8Array(next);
    has.set(this.hasPrev);
    this.hasPrev = has;
  }

  private rebuild(scene: Scene): void {
    this.grid.clear();
    this.hasPrev.fill(0);
    this.indexedId.length = 0;
    this.slotOfIndexed.clear();
    for (let slot = 0; slot < scene.slotLimit; slot++) {
      const id = scene.idAt(slot);
      if (id === null) continue;
      const box = scene.boundsAt(slot, 0, this.box);
      this.grid.place(slot, box);
      this.remember(id, slot, box);
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
    this.hasPrev.fill(0);
    this.indexedId.length = 0;
    this.slotOfIndexed.clear();
    this.disturbed.length = 0;
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
 * How far past a silhouette's edge a pin still counts as being inside it,
 * board units.
 *
 * A pin pushed through the very corner of a photograph sits about *on* the
 * edge, where the answer is decided by the last few hundredths of a unit and
 * differs frame to frame as the item drifts. Without the slack the item would
 * flip between obstacle and not, and the rope would be pushed off it and let
 * back on alternate frames. One board unit is far under anything visible.
 */
const EDGE_SLACK = 1;

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
   * be. `ax, ay` and `bx, by` are where the segment's two end pins are.
   *
   * ## Why an item holding one of this rope's ends is not an obstacle to it
   *
   * An endpoint is infinite mass: the solver seats it on its pin every
   * micro-step and never integrates it (`sim/verlet.ts`). So if that pin is
   * *inside* a silhouette, the endpoint cannot be pushed out of it — and
   * pushing its neighbours out anyway is a fight nobody wins. Sixteen times a
   * fixed step the particle next to the pin is shoved to the paper's edge, and
   * the link projection drags it straight back toward the pin in the middle.
   * The rope never falls under `ROPE_SLEEP_MOVE`, so it never sleeps, and it
   * settles into a shape that runs the long way round the outside of the paper
   * before jumping to a pin in the middle of it. Both were seen on a real
   * board.
   *
   * The condition is therefore geometric and not about parentage. Parentage was
   * the first version of this rule and it is only a proxy: a parented pin is
   * always inside its item, which is why the proxy worked for every string that
   * is pinned to a photograph — but a *free* pin that somebody later puts a
   * note on top of is inside an item it is not a child of, and that is the case
   * that thrashed.
   *
   * Such an item is dropped outright rather than kept and marked, so no later
   * pass has to remember the distinction. The price is a long string that sags
   * back across the same photograph its end is pinned to and cuts through it,
   * which takes a deliberately slack run to arrange and is a great deal less
   * visible than a kink at every pin.
   */
  prepare(scene: Scene, box: Bounds, ax: number, ay: number, bx: number, by: number): number {
    this.n = 0;
    this.slots.length = 0;

    this.query.minX = box.minX - QUERY_MARGIN;
    this.query.minY = box.minY - QUERY_MARGIN;
    this.query.maxX = box.maxX + QUERY_MARGIN;
    this.query.maxY = box.maxY + QUERY_MARGIN;
    this.index.query(scene, this.query, this.slots);

    for (let i = 0; i < this.slots.length && this.n < MAX_CANDIDATES; i++) {
      const slot = this.slots[i]!;
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
      // An item holding either end of this rope is not an obstacle to it.
      if (this.holds(n, ax, ay) || this.holds(n, bx, by)) continue;
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
   * ## Why `prev` moves with `pos`, and why that is not enough
   *
   * A Verlet particle's velocity *is* `pos - prev`, so moving `pos` alone and
   * leaving `prev` where it was hands the particle the whole correction as
   * speed — it is fired away from the photograph it just touched, and a rope
   * resting on one buzzes instead of resting. Moving both by the same vector
   * carries the velocity through the contact unchanged, which is the no-bounce
   * half of a contact model.
   *
   * The other half is friction, and leaving it out is what let ropes run
   * forever. Projection puts energy *in* every step — it moves `pos` and not
   * `prev`, so the correction becomes velocity on the next one — and a
   * frictionless contact takes none out, so a rope pressed against an edge by
   * its own tension churns there for good and never sleeps. Six of ten
   * geometries with an item between a string's two pins did exactly that. So
   * the contact also bleeds speed: see `CONTACT_FRICTION`, which is where the
   * measurement is.
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

      // Interior only — the endpoints are pins and are re-seated every
      // micro-step, so a correction applied to one is thrown away.
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
        // `prev + dx` carries the velocity through the contact, so the
        // correction is not also an impulse. The second term bleeds a slice of
        // that velocity off, so the contact is not frictionless either — and
        // since the correction shifts both by `dx`, what is left to bleed is
        // simply the speed the particle arrived with.
        prev[i] = prev[i]! + dx + (px - prev[i]!) * CONTACT_FRICTION;
        prev[i + 1] = prev[i + 1]! + dy + (py - prev[i + 1]!) * CONTACT_FRICTION;
      }
    }
  }

  /**
   * Is candidate `c` holding this point inside itself?
   *
   * Grown by `EDGE_SLACK`, so a pin sitting exactly on a photograph's edge —
   * which is where a pin pushed through a corner sits — gives the same answer
   * two frames running instead of flipping the item between obstacle and not.
   */
  private holds(c: number, x: number, y: number): boolean {
    const ox = x - this.cx[c]!;
    const oy = y - this.cy[c]!;
    const cos = this.cos[c]!;
    const sin = this.sin[c]!;
    return (
      Math.abs(ox * cos + oy * sin) <= this.hw[c]! + EDGE_SLACK &&
      Math.abs(oy * cos - ox * sin) <= this.hh[c]! + EDGE_SLACK
    );
  }

  /**
   * Is any of this rope *inside* something it should have been kept out of?
   *
   * Asked once per rope when a board loads, and nowhere else. `prepare` has to
   * have run first; the candidates it left are what this reads.
   *
   * Deliberately not "does this rope have a candidate". A rope near a
   * photograph it is not touching is exactly where it should be, and a board
   * where a string passes near something is every board — so waking on
   * proximity would settle the whole board on every open. This asks the
   * narrower question that only a rope in the wrong place answers yes to.
   *
   * The items a rope is *allowed* to be inside — the ones holding its own ends
   * — are not candidates at all by the time this runs, so they cannot make it
   * answer yes.
   */
  intrudes(pos: Float64Array, at: number, count: number): boolean {
    const last = at + (count - 1) * 2;
    for (let c = 0; c < this.n; c++) {
      const cx = this.cx[c]!;
      const cy = this.cy[c]!;
      const cos = this.cos[c]!;
      const sin = this.sin[c]!;
      const hw = this.hw[c]!;
      const hh = this.hh[c]!;

      for (let i = at + 2; i < last; i += 2) {
        const ox = pos[i]! - cx;
        const oy = pos[i + 1]! - cy;
        const lx = ox * cos + oy * sin;
        if (hw - Math.abs(lx) <= 0) continue;
        const ly = oy * cos - ox * sin;
        if (hh - Math.abs(ly) <= 0) continue;
        return true;
      }
    }
    return false;
  }

  clear(): void {
    this.index.clear();
    this.n = 0;
    this.slots.length = 0;
  }
}
