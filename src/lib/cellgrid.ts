/**
 * A uniform spatial grid over board space, addressed by slot.
 *
 * Two things on the board need to ask "what is near this rectangle?" and
 * neither may import the other: `render/cull.ts` asks it of the viewport to
 * decide what is worth having in the DOM, and `sim/collide.ts` asks it of a
 * rope's bounding box to decide what that rope might be lying on. The question
 * is the same question, the buckets are the same buckets, and the invalidation
 * discipline is the same discipline — so it lives here, in `lib/`, which is
 * dependency-free primitives importable by anyone.
 *
 * What is *not* here is anything about what an entry means. The grid stores
 * integers and rectangles: it has never heard of an item, a slot table, a
 * shadow pad or a hysteresis band, and both callers keep their own policy about
 * which rectangle to index and what to do with the answer. That is the line
 * that makes one structure serve two callers without becoming a third one's
 * problem — see the note on stale entries below, which is deliberately *not*
 * solved here.
 *
 * ## Invalidation is the caller's
 *
 * Entries are keyed by slot, and a slot outlives the thing that occupied it.
 * The grid therefore cannot tell a deleted entry from a live one, and does not
 * try: a slot's entries stay until something re-`place`s that slot, which
 * unindexes the previous occupant's cell range because `place` recorded it.
 * Callers filter dead slots on read. The cost is a few dead entries on a board
 * where things are deleted and never replaced, each one an array read and a
 * null check, and the alternative — a removal path that has to be called from
 * every deletion site — is the one that fails silently when somebody forgets.
 */

/** The rectangle shape this works in. Structurally `state/scene.ts`'s `Bounds`,
 *  restated because `lib/` may not import `state/`. */
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The cell range a query covers, filled into a caller-owned object so a
 *  per-frame query allocates nothing. */
export interface CellRange {
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
}

/**
 * Cell coordinates to one integer key.
 *
 * Wraps every 65536 cells — at the 512-unit cells both callers use, ±16.7
 * million board units, well past where `Float32Array` positions stop being
 * trustworthy at all (`state/scene.ts`) — and a wrap can only ever produce a
 * *false candidate*, which the caller's exact test then rejects. Never a
 * missing one. Cheap enough to matter: a small integer key keeps the bucket map
 * on V8's fast path, and a string key would not.
 */
function cellKey(cx: number, cy: number): number {
  return ((cx & 0xffff) << 16) | (cy & 0xffff);
}

export class CellGrid {
  private readonly buckets = new Map<number, number[]>();

  /** The cell range each indexed slot currently occupies. */
  private minCx = new Int32Array(0);
  private minCy = new Int32Array(0);
  private maxCx = new Int32Array(0);
  private maxCy = new Int32Array(0);
  /** 1 while a slot has entries in `buckets` describing the range above. */
  private indexed = new Uint8Array(0);

  /**
   * Slots whose rectangle spans more cells than `maxCellsPerEntry` and which
   * are therefore not indexed at all. Normally empty.
   *
   * Nothing on the board is this big, but nothing stops a corrupt or hostile
   * document naming an item a million units wide, and indexing that would
   * insert into millions of buckets inside one frame. Such a slot goes here
   * instead, and the caller decides what to do about it — a candidate for every
   * query, or a fallback to a linear scan. Bounded, correct, and the safe
   * direction to fail.
   */
  readonly oversized = new Set<number>();

  private capacity = 0;

  /**
   * @param cell Cell size in board units.
   * @param maxCellsPerEntry How many cells one entry may span before it is
   *   pushed onto `oversized` instead. The default is a 8192-unit square at a
   *   512-unit cell, twenty-five times the size of anything this application
   *   creates.
   */
  constructor(
    readonly cell: number,
    private readonly maxCellsPerEntry = 256,
  ) {}

  private ensure(slots: number): void {
    if (slots <= this.capacity) return;
    let next = Math.max(64, this.capacity);
    while (next < slots) next *= 2;
    const grow = (source: Int32Array): Int32Array => {
      const grown = new Int32Array(next);
      grown.set(source);
      return grown;
    };
    this.minCx = grow(this.minCx);
    this.minCy = grow(this.minCy);
    this.maxCx = grow(this.maxCx);
    this.maxCy = grow(this.maxCy);
    const indexed = new Uint8Array(next);
    indexed.set(this.indexed);
    this.indexed = indexed;
    this.capacity = next;
  }

  clear(): void {
    this.buckets.clear();
    this.indexed.fill(0);
    this.oversized.clear();
  }

  /** Index or re-index one slot from its board-space rectangle. */
  place(slot: number, rect: Rect): void {
    this.ensure(slot + 1);

    const cx0 = Math.floor(rect.minX / this.cell);
    const cy0 = Math.floor(rect.minY / this.cell);
    const cx1 = Math.floor(rect.maxX / this.cell);
    const cy1 = Math.floor(rect.maxY / this.cell);
    const cells = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);

    if (!Number.isFinite(cells) || cells > this.maxCellsPerEntry) {
      if (this.indexed[slot]) this.unindex(slot);
      this.oversized.add(slot);
      return;
    }
    this.oversized.delete(slot);

    // A drag moves an item a few units a frame, so most re-indexes land in the
    // same cells it was already in and there is nothing to do.
    if (
      this.indexed[slot] === 1 &&
      this.minCx[slot] === cx0 &&
      this.minCy[slot] === cy0 &&
      this.maxCx[slot] === cx1 &&
      this.maxCy[slot] === cy1
    ) {
      return;
    }

    if (this.indexed[slot]) this.unindex(slot);

    this.minCx[slot] = cx0;
    this.minCy[slot] = cy0;
    this.maxCx[slot] = cx1;
    this.maxCy[slot] = cy1;
    this.indexed[slot] = 1;

    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = cellKey(cx, cy);
        const bucket = this.buckets.get(key);
        if (bucket) bucket.push(slot);
        else this.buckets.set(key, [slot]);
      }
    }
  }

  /** Remove a slot's entries, using the range it was indexed at. */
  private unindex(slot: number): void {
    for (let cx = this.minCx[slot]!; cx <= this.maxCx[slot]!; cx++) {
      for (let cy = this.minCy[slot]!; cy <= this.maxCy[slot]!; cy++) {
        const key = cellKey(cx, cy);
        const bucket = this.buckets.get(key);
        if (!bucket) continue;
        const at = bucket.indexOf(slot);
        // Order in a bucket means nothing, so the last entry fills the hole.
        if (at >= 0) {
          bucket[at] = bucket[bucket.length - 1]!;
          bucket.pop();
        }
        if (bucket.length === 0) this.buckets.delete(key);
      }
    }
    this.indexed[slot] = 0;
  }

  /** How many cells a rectangle covers — how much the grid path would cost. */
  cellsIn(rect: Rect): number {
    const cells =
      (Math.floor(rect.maxX / this.cell) - Math.floor(rect.minX / this.cell) + 1) *
      (Math.floor(rect.maxY / this.cell) - Math.floor(rect.minY / this.cell) + 1);
    return Number.isFinite(cells) ? cells : Number.POSITIVE_INFINITY;
  }

  bucketAt(cx: number, cy: number): readonly number[] | undefined {
    return this.buckets.get(cellKey(cx, cy));
  }

  cellRange(rect: Rect, out: CellRange): CellRange {
    out.cx0 = Math.floor(rect.minX / this.cell);
    out.cy0 = Math.floor(rect.minY / this.cell);
    out.cx1 = Math.floor(rect.maxX / this.cell);
    out.cy1 = Math.floor(rect.maxY / this.cell);
    return out;
  }
}
