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

import { rotateOut, type Point } from "@/lib/rotate";

const INITIAL_CAPACITY = 256;

/** Reused by `layoutPins`; see the note there. */
const scratch: Point = { x: 0, y: 0 };

/** Handed back by `pinsOf` for an item nothing holds, so the caller never has
 *  to distinguish "no pins" from "no entry". */
const EMPTY_PINS: ReadonlySet<string> = new Set<string>();

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
   * Local, transient, never stored and never synced: the rotation an item has
   * on screen but not in the document. Rendered rotation is
   * `rot[slot] + swing[slot]`, and everything that reasons about where an item
   * actually is — `layoutPins`, `boundsOf`, `intersectsRect`, hit testing —
   * uses that sum rather than `rot` alone.
   *
   * Two things write it, and they hand over rather than compete: the
   * lag-and-catch-up of a carried item (DESIGN section 3.2) while a drag is in
   * progress, and the torsion swing of a single-pinned item (section 5.5) once
   * it is let go.
   */
  swing: Float32Array;

  /**
   * The other half of the swing: the translation that keeps a hanging item's
   * **pin** still while the item turns about it.
   *
   * A pin is stuck in the cork and does not move. An item hanging from one
   * rotates about the pin, not about its own centre — and since a parented
   * pin's world position is *derived* from the item's pose, turning the item
   * about its centre would drag the pin across the board with it. It is
   * immediately visible, and during a pin drag it is a feedback loop: move the
   * pin, the equilibrium changes, the item swings, the item carries the pin out
   * from under the cursor.
   *
   * So the swing is a rotation about the pin, decomposed into the rotation
   * about the centre that `rot + swing` already is, plus this. Transient and
   * local like the swing itself, for exactly the same reason — the item's
   * stored position never changes, so no peer has to agree about it.
   *
   * Everything that asks where an item *is on screen* adds this; everything
   * that authors a position — a drag, a resize — does not, because what those
   * write is the stored centre.
   */
  driftX: Float32Array;
  driftY: Float32Array;

  /**
   * Also transient: how far an item is off the cork, 0 at rest and 1 while it
   * is being carried. Drives the ~2% carry scale and the lifted shadow —
   * "the item is being *carried*, not teleported" (DESIGN section 3.2).
   *
   * Deliberately a continuous value rather than a flag, because the frame loop
   * owns all motion (ARCHITECTURE section 3) and a CSS transition is therefore
   * not available to soften the transition for us.
   */
  lift: Float32Array;

  private capacity = INITIAL_CAPACITY;
  private readonly slots = new Map<string, number>();
  private readonly ids: (string | null)[] = new Array<string | null>(INITIAL_CAPACITY).fill(null);
  private readonly coldBySlot: (ItemCold | null)[] = new Array<ItemCold | null>(
    INITIAL_CAPACITY,
  ).fill(null);
  private readonly freeSlots: number[] = [];
  private highWater = 0;

  readonly pins = new Map<string, PinNode>();

  /**
   * The reverse of `PinNode.parent`: which pins hold each item.
   *
   * Derived, never authoritative. `pin.parent` is the only source of truth
   * (AC-56); this is a cache of the answer to "how many pins hold this item",
   * maintained by `putPin`/`removePin` — which is to say, rebuilt from the
   * observer, since `crdt/binding.ts` is the only thing that calls them.
   *
   * It exists because pin count *is* an item's physics (DESIGN section 2.2),
   * so the torsion swing asks the question for every item in the viewport on
   * every frame. Answered by walking `pins` that is O(items x pins) per frame,
   * which on a board where both are in the hundreds is tens of thousands of
   * comparisons to discover that almost nothing changed.
   *
   * An entry survives its item. Pins outlive items (section 3.8 — `Shift`
   * +`Delete` "removes an item but leaves its pins free-floating"), and a pin
   * still naming a deleted parent is dangling rather than wrong: it renders
   * free-floating, and if undo brings the item back the index is already
   * right. What is dropped is an entry that has lost its last *pin*, so a
   * board that has had pins added and removed all afternoon does not
   * accumulate empty sets.
   */
  private readonly byParent = new Map<string, Set<string>>();

  constructor() {
    this.x = new Float32Array(INITIAL_CAPACITY);
    this.y = new Float32Array(INITIAL_CAPACITY);
    this.rot = new Float32Array(INITIAL_CAPACITY);
    this.w = new Float32Array(INITIAL_CAPACITY);
    this.h = new Float32Array(INITIAL_CAPACITY);
    this.swing = new Float32Array(INITIAL_CAPACITY);
    this.driftX = new Float32Array(INITIAL_CAPACITY);
    this.driftY = new Float32Array(INITIAL_CAPACITY);
    this.lift = new Float32Array(INITIAL_CAPACITY);
  }

  /**
   * Where an item is drawn: its stored centre plus the swing's translation.
   *
   * Every geometry question about the *screen* goes through these — bounds,
   * hit testing, pin layout, the selection chrome. A question about what to
   * write down does not.
   */
  renderX(slot: number): number {
    return this.x[slot]! + this.driftX[slot]!;
  }

  renderY(slot: number): number {
    return this.y[slot]! + this.driftY[slot]!;
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
    this.driftX = copy(this.driftX);
    this.driftY = copy(this.driftY);
    this.lift = copy(this.lift);
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
      this.driftX[slot] = 0;
      this.driftY[slot] = 0;
      this.lift[slot] = 0;
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
    this.driftX[slot] = 0;
    this.driftY[slot] = 0;
    this.lift[slot] = 0;
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

  /**
   * Insert or replace a pin.
   *
   * The only way a pin's `parent` may change. Assigning to `PinNode.parent` on
   * a node fished out of `pins` would leave the reverse index describing a
   * board that no longer exists — the binding re-reads the whole entity and
   * calls this, which is what keeps the two in step.
   */
  putPin(pin: PinNode): void {
    const existing = this.pins.get(pin.id);
    if (existing && existing.parent !== pin.parent) this.unindex(existing.parent, pin.id);
    this.pins.set(pin.id, pin);
    if (pin.parent === null) return;
    let held = this.byParent.get(pin.parent);
    if (!held) this.byParent.set(pin.parent, (held = new Set()));
    held.add(pin.id);
  }

  removePin(id: string): boolean {
    const pin = this.pins.get(id);
    if (!pin) return false;
    this.pins.delete(id);
    this.unindex(pin.parent, id);
    return true;
  }

  private unindex(parent: string | null, pinId: string): void {
    if (parent === null) return;
    const held = this.byParent.get(parent);
    if (!held) return;
    held.delete(pinId);
    if (held.size === 0) this.byParent.delete(parent);
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
      // Rendered rotation about the rendered centre: a pin stays on the
      // photograph while the photograph swings — and, because `drift` is
      // defined as the translation that holds the pivot still, a *single*
      // pin's world position comes back unchanged by the swing entirely, which
      // is what makes it look pushed into the cork rather than sliding across
      // it.
      const angle = this.rot[slot]! + this.swing[slot]!;
      // Into the shared scratch and straight back out again — this runs over
      // every pin on the board on every frame anything moved, so it must not
      // mint an object per pin.
      rotateOut(
        pin.lx,
        pin.ly,
        this.x[slot]! + this.driftX[slot]!,
        this.y[slot]! + this.driftY[slot]!,
        Math.cos(angle),
        Math.sin(angle),
        scratch,
      );
      pin.wx = scratch.x;
      pin.wy = scratch.y;
    }
  }

  /** How many pins hold this item — its physics, per DESIGN section 2.2. */
  pinCount(itemId: string): number {
    return this.byParent.get(itemId)?.size ?? 0;
  }

  /**
   * Which pins hold this item. Empty for an unpinned one — never null, so a
   * caller can iterate without asking first.
   *
   * Live rather than a copy: the set is the index's own, and `putPin` mutates
   * it. Read it and let it go; do not keep it across a frame.
   */
  pinsOf(itemId: string): ReadonlySet<string> {
    return this.byParent.get(itemId) ?? EMPTY_PINS;
  }

  /**
   * The one pin holding this item, or null if it is held by none or by
   * several. The physics question of DESIGN section 2.2, asked directly.
   *
   * Two things want it and want it for the same reason: an item on one pin
   * hangs from that pin, and turns about it — so both `sim/torsion.ts` and the
   * rotation gesture need to know which point that is.
   */
  solePin(itemId: string): PinNode | null {
    const held = this.byParent.get(itemId);
    if (!held || held.size !== 1) return null;
    for (const id of held) return this.pins.get(id) ?? null;
    return null;
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
    return this.boundsAt(slot, pad, out);
  }

  /**
   * The same thing, addressed by slot.
   *
   * The culler walks candidates as slots — that is what the grid stores — and
   * would otherwise pay a Map lookup per candidate per frame to turn each one
   * back into an id it is about to throw away. **The slot must be live**; there
   * is no lookup to fail on, so a stale one silently reads whatever is in the
   * arrays.
   */
  boundsAt(slot: number, pad: number, out: Bounds): Bounds {
    const angle = this.rot[slot]! + this.swing[slot]!;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const hw = (this.w[slot]! * cos + this.h[slot]! * sin) / 2 + pad;
    const hh = (this.w[slot]! * sin + this.h[slot]! * cos) / 2 + pad;
    const cx = this.x[slot]! + this.driftX[slot]!;
    const cy = this.y[slot]! + this.driftY[slot]!;
    out.minX = cx - hw;
    out.minY = cy - hh;
    out.maxX = cx + hw;
    out.maxY = cy + hh;
    return out;
  }

  /**
   * Does a rotated item overlap an axis-aligned board rectangle? The marquee
   * question (DESIGN section 3.8).
   *
   * Exact, via the separating-axis theorem, rather than the cheaper test
   * against `boundsOf`. The expanded box of a tilted polaroid sticks out past
   * its corners by several units, and a marquee that grabs a photograph it
   * visibly did not touch reads as the selection being sloppy — which on a
   * board whose whole premise is "mess is a feature" is the one place the
   * software cannot afford to look imprecise.
   *
   * Two boxes, so only four candidate axes: the rectangle's two, and the
   * item's own two.
   */
  intersectsRect(id: string, rect: Bounds): boolean {
    const slot = this.slots.get(id);
    if (slot === undefined) return false;

    const angle = this.rot[slot]! + this.swing[slot]!;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const hw = this.w[slot]! / 2;
    const hh = this.h[slot]! / 2;

    // Rectangle centre and half-extents, written so a rect dragged upwards or
    // leftwards — which is how half of all marquees are drawn — works without
    // the caller having to normalise it first.
    const rcx = (rect.minX + rect.maxX) / 2;
    const rcy = (rect.minY + rect.maxY) / 2;
    const rhw = Math.abs(rect.maxX - rect.minX) / 2;
    const rhh = Math.abs(rect.maxY - rect.minY) / 2;

    const dx = this.x[slot]! + this.driftX[slot]! - rcx;
    const dy = this.y[slot]! + this.driftY[slot]! - rcy;

    // Axes 1 and 2: the rectangle's. The item's radius along each is its
    // rotation-expanded half-extent, which is what boundsOf computes.
    if (Math.abs(dx) > rhw + hw * Math.abs(cos) + hh * Math.abs(sin)) return false;
    if (Math.abs(dy) > rhh + hw * Math.abs(sin) + hh * Math.abs(cos)) return false;

    // Axes 3 and 4: the item's own, along which it is exactly hw and hh wide.
    if (Math.abs(dx * cos + dy * sin) > hw + rhw * Math.abs(cos) + rhh * Math.abs(sin)) return false;
    if (Math.abs(-dx * sin + dy * cos) > hh + rhw * Math.abs(sin) + rhh * Math.abs(cos)) return false;

    return true;
  }

  /** Bounds of everything on the board, for Ctrl+0. Null on an empty board. */
  contentBounds(): Bounds | null {
    // Shares the item walk with `F`, so the two can never end up disagreeing
    // about how far an item extends.
    const out = this.boundsOfMany(this.slots.keys());
    if (!out) return null;
    for (const pin of this.pins.values()) {
      if (pin.wx < out.minX) out.minX = pin.wx;
      if (pin.wy < out.minY) out.minY = pin.wy;
      if (pin.wx > out.maxX) out.maxX = pin.wx;
      if (pin.wy > out.maxY) out.maxY = pin.wy;
    }
    return out;
  }

  /**
   * Combined bounds of some items — the selection, for `F`; every item, for
   * `contentBounds`. Null if none of them are on the board.
   */
  boundsOfMany(ids: Iterable<string>): Bounds | null {
    const out: Bounds = {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    };
    const scratch: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let found = false;
    for (const id of ids) {
      const b = this.boundsOf(id, 0, scratch);
      if (!b) continue;
      found = true;
      if (b.minX < out.minX) out.minX = b.minX;
      if (b.minY < out.minY) out.minY = b.minY;
      if (b.maxX > out.maxX) out.maxX = b.maxX;
      if (b.maxY > out.maxY) out.maxY = b.maxY;
    }
    return found ? out : null;
  }

  /** Every item id, in no particular order. Callers that need order sort by z. */
  itemIds(): IterableIterator<string> {
    return this.slots.keys();
  }

  clear(): void {
    this.slots.clear();
    this.pins.clear();
    this.byParent.clear();
    this.ids.fill(null);
    this.coldBySlot.fill(null);
    this.swing.fill(0);
    this.driftX.fill(0);
    this.driftY.fill(0);
    this.lift.fill(0);
    this.freeSlots.length = 0;
    this.highWater = 0;
  }
}
