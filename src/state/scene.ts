/**
 * The scene mirror.
 *
 * > `state/scene.ts` is a plain mutable mirror of the document — no CRDT
 * > types, no observers, no framework reactivity. Hot fields (`x`, `y`, `rot`,
 * > `w`, `h`) live in `Float32Array`s indexed by a dense slot id; cold fields
 * > live in ordinary objects.
 * >
 * > This exists so that `sim/` and `render/` can run at 60 fps against tight
 * > typed-array loops without ever touching Yjs, and so that either can be
 * > tested with no document at all.
 * > — docs/ARCHITECTURE.md section 2.1
 *
 * That last clause is the acceptance criterion, and it is the reason this file
 * imports nothing from `crdt/`. `crdt/binding.ts` translates document events
 * into calls on this object, and it is the only thing that does.
 *
 * ## Slots
 *
 * Every item gets a dense integer slot. Slots are reused when items are
 * deleted, so **a slot is only meaningful while its item exists** — anything
 * that outlives a frame stores the id, not the slot.
 *
 * ## Precision
 *
 * `Float32Array` as specified. That is about seven significant digits, so at a
 * board coordinate of 100,000 units positions quantise to roughly a hundredth
 * of a unit — invisible at the 400% zoom ceiling. It would become visible past
 * about ten million units out, which is far beyond a board someone placed by
 * hand. If that ever stops being true the change is this file and nothing else.
 */

const INITIAL_CAPACITY = 256;

/** Cold fields — read when a view is built or rebuilt, not per frame. */
export interface ItemCold {
  id: string;
  type: string;
  z: string;
  seed: number;
  assetId: string | null;
  /** Yjs client id of the creator; the tie-break in the total order. */
  createdBy: number;
  createdAt: number;
  /** Plain text snapshot. The Y.Text stays behind the binding. */
  text: string;
}

export interface ItemPose {
  x: number;
  y: number;
  rot: number;
  w: number;
  h: number;
}

/** Pins are not hot enough to be worth a typed array; there are fewer of them
 *  and they move only when their item does. */
export interface PinNode {
  id: string;
  parent: string | null;
  lx: number;
  ly: number;
  kind: string;
  color: string;
  /** World position, recomputed in the LAYOUT phase. */
  wx: number;
  wy: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class Scene {
  /** Hot fields, indexed by slot. */
  x: Float32Array;
  y: Float32Array;
  rot: Float32Array;
  w: Float32Array;
  h: Float32Array;

  /**
   * Local, transient, never stored and never synced: the torsion swing of a
   * single-pinned item (DESIGN section 5.5). Rendered rotation is
   * `rot[slot] + swing[slot]`.
   */
  swing: Float32Array;

  private capacity = INITIAL_CAPACITY;
  private readonly slots = new Map<string, number>();
  private readonly ids: (string | null)[] = new Array<string | null>(INITIAL_CAPACITY).fill(null);
  private readonly coldBySlot: (ItemCold | null)[] = new Array<ItemCold | null>(
    INITIAL_CAPACITY,
  ).fill(null);
  private readonly freeSlots: number[] = [];
  private highWater = 0;

  readonly pins = new Map<string, PinNode>();

  constructor() {
    this.x = new Float32Array(INITIAL_CAPACITY);
    this.y = new Float32Array(INITIAL_CAPACITY);
    this.rot = new Float32Array(INITIAL_CAPACITY);
    this.w = new Float32Array(INITIAL_CAPACITY);
    this.h = new Float32Array(INITIAL_CAPACITY);
    this.swing = new Float32Array(INITIAL_CAPACITY);
  }

  get size(): number {
    return this.slots.size;
  }

  /** One past the highest slot ever handed out — the bound for a dense loop. */
  get slotLimit(): number {
    return this.highWater;
  }

  slotOf(id: string): number | undefined {
    return this.slots.get(id);
  }

  idAt(slot: number): string | null {
    return this.ids[slot] ?? null;
  }

  has(id: string): boolean {
    return this.slots.has(id);
  }

  coldAt(slot: number): ItemCold | null {
    return this.coldBySlot[slot] ?? null;
  }

  cold(id: string): ItemCold | null {
    const slot = this.slots.get(id);
    return slot === undefined ? null : (this.coldBySlot[slot] ?? null);
  }

  private grow(): void {
    const next = this.capacity * 2;
    const copy = (source: Float32Array): Float32Array => {
      const grown = new Float32Array(next);
      grown.set(source);
      return grown;
    };
    this.x = copy(this.x);
    this.y = copy(this.y);
    this.rot = copy(this.rot);
    this.w = copy(this.w);
    this.h = copy(this.h);
    this.swing = copy(this.swing);
    this.ids.length = next;
    this.coldBySlot.length = next;
    this.ids.fill(null, this.capacity);
    this.coldBySlot.fill(null, this.capacity);
    this.capacity = next;
  }

  /** Insert or replace. Returns the slot. */
  putItem(cold: ItemCold, pose: ItemPose): number {
    let slot = this.slots.get(cold.id);
    if (slot === undefined) {
      const reused = this.freeSlots.pop();
      if (reused !== undefined) {
        slot = reused;
      } else {
        if (this.highWater >= this.capacity) this.grow();
        slot = this.highWater++;
      }
      this.slots.set(cold.id, slot);
      this.ids[slot] = cold.id;
      this.swing[slot] = 0;
    }
    this.coldBySlot[slot] = cold;
    this.x[slot] = pose.x;
    this.y[slot] = pose.y;
    this.rot[slot] = pose.rot;
    this.w[slot] = pose.w;
    this.h[slot] = pose.h;
    return slot;
  }

  setPose(id: string, pose: Partial<ItemPose>): boolean {
    const slot = this.slots.get(id);
    if (slot === undefined) return false;
    if (pose.x !== undefined) this.x[slot] = pose.x;
    if (pose.y !== undefined) this.y[slot] = pose.y;
    if (pose.rot !== undefined) this.rot[slot] = pose.rot;
    if (pose.w !== undefined) this.w[slot] = pose.w;
    if (pose.h !== undefined) this.h[slot] = pose.h;
    return true;
  }

  removeItem(id: string): boolean {
    const slot = this.slots.get(id);
    if (slot === undefined) return false;
    this.slots.delete(id);
    this.ids[slot] = null;
    this.coldBySlot[slot] = null;
    this.swing[slot] = 0;
    this.freeSlots.push(slot);
    return true;
  }

  poseOf(id: string): ItemPose | null {
    const slot = this.slots.get(id);
    if (slot === undefined) return null;
    return {
      x: this.x[slot]!,
      y: this.y[slot]!,
      rot: this.rot[slot]!,
      w: this.w[slot]!,
      h: this.h[slot]!,
    };
  }

  // --- pins ---------------------------------------------------------------

  putPin(pin: PinNode): void {
    this.pins.set(pin.id, pin);
  }

  removePin(id: string): boolean {
    return this.pins.delete(id);
  }

  /**
   * LAYOUT phase (4). Recomputes world positions for pins whose item moved.
   *
   * A pin whose parent is missing keeps its stored coordinates, read as board
   * coordinates — DATA-MODEL section 8.1, "renders as free-floating at its
   * last known board position, computed locally with no write".
   */
  layoutPins(changedItems?: ReadonlySet<string>): void {
    for (const pin of this.pins.values()) {
      if (changedItems && pin.parent !== null && !changedItems.has(pin.parent)) continue;
      if (pin.parent === null) {
        pin.wx = pin.lx;
        pin.wy = pin.ly;
        continue;
      }
      const slot = this.slots.get(pin.parent);
      if (slot === undefined) {
        pin.wx = pin.lx;
        pin.wy = pin.ly;
        continue;
      }
      // Rendered rotation, not authored: a pin stays on the photograph while
      // the photograph swings.
      const angle = this.rot[slot]! + this.swing[slot]!;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      pin.wx = this.x[slot]! + pin.lx * cos - pin.ly * sin;
      pin.wy = this.y[slot]! + pin.lx * sin + pin.ly * cos;
    }
  }

  /** How many pins hold this item — its physics, per DESIGN section 2.2. */
  pinCount(itemId: string): number {
    let n = 0;
    for (const pin of this.pins.values()) if (pin.parent === itemId) n++;
    return n;
  }

  // --- geometry -----------------------------------------------------------

  /**
   * Axis-aligned bounds of a rotated item, expanded by `pad`.
   *
   * Rotation-expanded rather than the raw rectangle, because culling against
   * the unrotated box would pop the corners of a tilted polaroid in and out at
   * the viewport edge (DESIGN section 9.1).
   */
  boundsOf(id: string, pad = 0, out: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 }): Bounds | null {
    const slot = this.slots.get(id);
    if (slot === undefined) return null;
    const angle = this.rot[slot]! + this.swing[slot]!;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const hw = (this.w[slot]! * cos + this.h[slot]! * sin) / 2 + pad;
    const hh = (this.w[slot]! * sin + this.h[slot]! * cos) / 2 + pad;
    out.minX = this.x[slot]! - hw;
    out.minY = this.y[slot]! - hh;
    out.maxX = this.x[slot]! + hw;
    out.maxY = this.y[slot]! + hh;
    return out;
  }

  /** Bounds of everything on the board, for Ctrl+0. Null on an empty board. */
  contentBounds(): Bounds | null {
    if (this.slots.size === 0) return null;
    const out: Bounds = {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    };
    const scratch: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    for (const id of this.slots.keys()) {
      const b = this.boundsOf(id, 0, scratch);
      if (!b) continue;
      if (b.minX < out.minX) out.minX = b.minX;
      if (b.minY < out.minY) out.minY = b.minY;
      if (b.maxX > out.maxX) out.maxX = b.maxX;
      if (b.maxY > out.maxY) out.maxY = b.maxY;
    }
    for (const pin of this.pins.values()) {
      if (pin.wx < out.minX) out.minX = pin.wx;
      if (pin.wy < out.minY) out.minY = pin.wy;
      if (pin.wx > out.maxX) out.maxX = pin.wx;
      if (pin.wy > out.maxY) out.maxY = pin.wy;
    }
    return out;
  }

  /** Every item id, in no particular order. Callers that need order sort by z. */
  itemIds(): IterableIterator<string> {
    return this.slots.keys();
  }

  clear(): void {
    this.slots.clear();
    this.pins.clear();
    this.ids.fill(null);
    this.coldBySlot.fill(null);
    this.freeSlots.length = 0;
    this.highWater = 0;
  }
}
