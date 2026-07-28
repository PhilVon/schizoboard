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

import type { InkSample, InkSurface } from "@/lib/ink";
import { rotateOut, type Point } from "@/lib/rotate";

const INITIAL_CAPACITY = 256;

/** Reused by `layoutPins`; see the note there. */
const scratch: Point = { x: 0, y: 0 };

/** Handed back by `pinsOf` and `stringsThrough` when the index has no entry, so
 *  a caller never has to distinguish "none" from "not indexed". */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** The same, for `strokesOf` — and it is the common case, because most items
 *  have no ink at all (DESIGN section 6.5). */
const EMPTY_STROKES: readonly SceneStroke[] = Object.freeze([]);

/**
 * Paint order within one item's ink: `z`, then the id.
 *
 * The same tie-break `crdt/zindex.ts`'s `compareOrder` ends on, written out here
 * rather than imported for the reason the file header gives — the scene imports
 * nothing from `crdt/`, and `render/items/dom.ts` re-states the same comparator
 * for items for the same reason. Two peers can mint the same `z` for a stroke by
 * drawing on the same photograph at the same moment; the id then decides, and it
 * decides identically on both (invariant 9).
 *
 * There is no `createdBy` leg because a stroke does not carry one. The id is
 * already unique and already agreed, which is all the tie-break needs.
 */
function compareStrokes(a: SceneStroke, b: SceneStroke): number {
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

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

/**
 * A committed stroke, as everything downstream of the document sees it.
 *
 * `tool` is a plain `string` rather than the union in `crdt/schema.ts`, like
 * `PinNode.kind` and `StringNodes.material` and for the reason stated there: a
 * type imported across the one-way boundary is a dependency imported across it.
 *
 * ## The samples are already unpacked
 *
 * The document holds a packed `Uint8Array` (DATA-MODEL section 6.1) and this
 * holds the points. That is the one real decision in this type, and it is about
 * where the varint decode runs: the renderer re-rasters an item's ink on every
 * debounced zoom-end, so unpacking there would redo the decode for the whole
 * board's ink on each one. Unpacking in the binding runs it once per stroke per
 * edit, which is as few times as it can be run.
 *
 * ## And the box is measured, not copied
 *
 * `bbox` is measured off these samples rather than taken from the record. The
 * stored one exists so that a board-ink tile can cull without unpacking, and it
 * is a number a peer wrote; this side has already paid for the unpack and has no
 * reason to trust it. A box one unit too small is a stroke clipped at the edge
 * of its own canvas — the kind of wrong that nobody finds by looking, because
 * the stroke is still there and still nearly right.
 */
export interface SceneStroke {
  id: string;
  tool: string;
  color: string;
  /** Board units, which are item-local units too. */
  size: number;
  opacity: number;
  seed: number;
  z: string;
  /** `[x0, y0, x1, y1]`, round the points, in the item's local frame. */
  bbox: readonly [number, number, number, number];
  samples: readonly InkSample[];
}

/**
 * One 2048-unit bucket of ink on the bare cork, and the box round what is in it.
 *
 * The box is the tile's ink, **not** the tile's cell. A stroke is bucketed by
 * its bounding-box centre (DATA-MODEL section 2), so it may hang up to half its
 * own length outside the cell it is filed under, and a renderer that culled or
 * sized a canvas by the cell would clip exactly the long strokes that are most
 * visible. Most tiles hold far less than a cell's worth, which is the other half
 * of it: sizing to the ink is what keeps a 2048-unit tile from asking for a
 * 2048-pixel backing store to hold one word.
 *
 * Measured here so that culling costs one rectangle test per inked tile per
 * camera move rather than a walk of every stroke on the board.
 */
export interface BoardInkTile {
  readonly key: string;
  /** In `z` order — the paint order the renderer walks. */
  readonly strokes: readonly SceneStroke[];
  /** `[x0, y0, x1, y1]` in board units, round every stroke in the tile,
   *  unpadded by any nib. */
  readonly bbox: readonly [number, number, number, number];
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

/**
 * One node of a string's run: a reference to a pin, and the slack in the gap
 * that follows it.
 *
 * `slackAfter` is a **ratio** against the chord, never a length — and on the
 * terminal node of an open string it is unused and means nothing (DATA-MODEL
 * section 5.2). `sim/ropes.ts` reads it only from the node each segment starts
 * at, so on an open run the last value is never asked for.
 */
export interface StringNode {
  /**
   * The node's own identity, which is here for exactly one reason: it is how a
   * slack edit names the gap it means.
   *
   * `crdt/ops/strings.ts`'s `setNodeSlack` addresses a gap by the id of the node
   * it starts at rather than by index, because an index computed on one frame
   * and written on the next is an index a concurrent insert may have moved — and
   * the wheel over a segment (DESIGN section 3.4) is precisely a read on one
   * frame and a write on the next. Without this the tool would have nothing to
   * pass but the index it just measured.
   *
   * Nothing else reads it. The renderer draws pins in run order and the
   * simulation compares runs by their pin ids, both of which are questions about
   * the run rather than about a node.
   */
  nodeId: string;
  pin: string;
  slackAfter: number;
}

/**
 * A string, as everything downstream of the document sees it.
 *
 * Plain strings for `material` and `layer` rather than the union types in
 * `crdt/schema.ts`, for the same reason `PinNode.kind` is: the scene is the
 * wall between the document and everything else, and a type imported across it
 * is a dependency imported across it.
 */
export interface StringNodes {
  id: string;
  nodes: StringNode[];
  color: string;
  thickness: number;
  material: string;
  /** `'over'` draws above items and collides with them; `'under'` passes
   *  behind and does not — DESIGN section 6.2. */
  layer: string;
  closed: boolean;
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
   * Strings, mirrored from the document — topology and style only.
   *
   * No particle ever lands here. Where a string actually *is* belongs to
   * `sim/ropes.ts`, which is transient, local and rebuilt from scratch on
   * load; this map is the durable half, and the split is DESIGN section 5.1's
   * "physics never writes to the document" seen from the other side.
   *
   * Read it freely; write it only through `putString`/`removeString`, which
   * are what keep `byPin` honest — the same arrangement `pins` and `byParent`
   * have, and for the same reason.
   */
  readonly strings = new Map<string, StringNodes>();

  /**
   * An item's committed ink, kept in `z` order — the paint order the renderer
   * walks.
   *
   * Keyed by item id and not indexed in reverse, which is the one way this
   * differs from `pins` and `strings`: a stroke is already *inside* its item in
   * the document, so the owner is the key rather than a field to invert.
   *
   * An item with no ink has no entry at all rather than an empty array. Most
   * items have none (DESIGN section 6.5), and the renderer's cheapest question —
   * "is there anything to raster here?" — should be a map miss.
   */
  private readonly strokes = new Map<string, SceneStroke[]>();

  /**
   * Ink on the bare cork, bucketed the way the document buckets it — one entry
   * per 2048-unit tile that anybody has drawn in (DATA-MODEL section 2).
   *
   * A tile with no ink has no entry, exactly as an item with none does, and for
   * the same reason: the renderer's cheapest question is a map miss. It is also
   * what makes the entry count the mount candidate list — the board-ink layer
   * walks these rather than walking a lattice, because a lattice has a cell
   * everywhere and this has one only where somebody drew.
   */
  private readonly boardInk = new Map<string, BoardInkTile>();

  /**
   * Which surface each stroke is filed on — the reverse of the two maps above.
   *
   * Derived, never authoritative, and maintained by `putStrokes`,
   * `putBoardStrokes` and `removeItem` the way `byParent` is maintained by
   * `putPin`/`removePin`. Every one of those already walks the list it is
   * replacing, so the index costs a map write per stroke on an edit that was
   * already O(strokes) — and nothing per frame.
   *
   * It exists for one question, and the question cannot be answered any other
   * way: **"does this board hold the stroke a peer is drawing?"** — section
   * 9.2's handoff, asked of a run id that arrived over awareness. For a run
   * glued to an item the caller could walk `strokesOf` instead, but for one on
   * the bare cork it could not: a board stroke is filed by the bounding-box
   * centre of *all* its points (DATA-MODEL section 2), and a receiver holds a
   * possibly-shorter piece of the mark (`render/presence/wetpeer.ts`), so the
   * tile it would compute is not reliably the tile the sender filed it under.
   * The alternative is a walk of every stroke on the board, once a frame, per
   * ghost.
   *
   * One [`InkSurface`] object per surface per put, shared by all its strokes:
   * the answer is about the surface, not about the stroke, and a fresh object
   * each would allocate per stroke on every ink edit.
   */
  private readonly strokeAt = new Map<string, InkSurface>();

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

  /**
   * The reverse of a string's node list: which strings run through each pin.
   *
   * The other half of the same idea as `byParent`, and derived in the same
   * way — the nodes are the only truth, this is a cache of the answer to "what
   * hangs off this pin", maintained by `putString`/`removeString`.
   *
   * > A pin hosting six different strings works — with no special cases,
   * > because a string just holds pin ids and a pin doesn't know or care how
   * > many strings reference it. — DESIGN section 2.3
   *
   * That is exactly why the index is needed rather than a field on the pin: the
   * relationship is owned entirely by the string side, so asking a pin what it
   * hosts means walking every string on the board and every node in it. Two
   * gestures ask it — hover a pin and its threads light up (DESIGN section
   * 3.3), double-click one and the whole connected component selects — and the
   * first of those asks on every frame the cursor moves.
   *
   * A pin may appear twice in one run (a loop closed back through it), which
   * the `Set` absorbs: the entry is the string, not the visit.
   *
   * Unlike `byParent`, an entry here does *not* survive its pin. A string
   * naming a pin that no longer exists is a gap in the run rather than
   * something to remember — `render/ropes/paint.ts` draws it as one — and the
   * document deletes a run that falls below two valid nodes anyway.
   */
  private readonly byPin = new Map<string, Set<string>>();

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
    // Ink goes with the item, which is the opposite of what happens to its pins
    // — and the asymmetry is the document's, not a choice made here. A pin is
    // top-level and outlives its item (`Shift`+`Delete`); a stroke is nested
    // inside the item's map and cannot outlive it. Nothing has to remember the
    // strokes for undo either: an item that comes back brings its ink with it
    // through the observer, in the same entry.
    this.unfile(this.strokes.get(id));
    this.strokes.delete(id);
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

  // --- ink ------------------------------------------------------------------

  /**
   * Replace an item's ink wholesale.
   *
   * A whole list rather than one stroke at a time, because that is what the
   * binding has: any change inside an item's strokes map re-reads the map (the
   * "re-read the whole entity" rule `crdt/binding.ts` states), and a stroke is
   * immutable once written — there is no such thing as editing one, only adding
   * and removing (DATA-MODEL section 6.2, "erasing deletes stroke records").
   *
   * Sorted here rather than trusted, so the renderer can walk the array and be
   * painting in the document's own order.
   */
  putStrokes(itemId: string, strokes: readonly SceneStroke[]): void {
    // Before the replace, and of the *old* list: an erase is a shorter list
    // arriving, and the ids it dropped are only nameable from what is still
    // here. Filing the new one afterwards puts back every id that survived.
    this.unfile(this.strokes.get(itemId));
    if (strokes.length === 0) {
      this.strokes.delete(itemId);
      return;
    }
    const sorted = [...strokes].sort(compareStrokes);
    this.strokes.set(itemId, sorted);
    const surface: InkSurface = { kind: "item", id: itemId };
    for (const stroke of sorted) this.strokeAt.set(stroke.id, surface);
  }

  /**
   * An item's ink, in paint order. Empty — and always the *same* empty array —
   * for an item with none, so a caller iterates without asking first.
   *
   * Live, like `pinsOf`. Read it and let it go; do not keep it across a frame.
   */
  strokesOf(itemId: string): readonly SceneStroke[] {
    return this.strokes.get(itemId) ?? EMPTY_STROKES;
  }

  /** Is there anything to raster? The renderer's cheapest question, and for
   *  most items the answer is no. */
  hasInk(itemId: string): boolean {
    return this.strokes.has(itemId);
  }

  /**
   * Replace one board-ink tile wholesale — the cork's half of `putStrokes`, and
   * wholesale for the same reason: a stroke is immutable once written, so the
   * only question worth asking is which strokes the tile has now.
   *
   * An empty list removes the tile. That is the undo of the first stroke drawn
   * in a fresh cell, and it has to leave nothing behind: an entry with an empty
   * array would keep the tile in the mount candidate list forever, with a box of
   * `Infinity` and nothing to draw.
   */
  putBoardStrokes(key: string, strokes: readonly SceneStroke[]): void {
    this.unfile(this.boardInk.get(key)?.strokes);
    if (strokes.length === 0) {
      this.boardInk.delete(key);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of strokes) {
      const [x0, y0, x1, y1] = stroke.bbox;
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
    }
    const sorted = [...strokes].sort(compareStrokes);
    this.boardInk.set(key, { key, strokes: sorted, bbox: [minX, minY, maxX, maxY] });
    const surface: InkSurface = { kind: "tile", key };
    for (const stroke of sorted) this.strokeAt.set(stroke.id, surface);
  }

  /** Take a replaced list out of [`strokeAt`]. Undefined for a surface that had
   *  no ink, which is the common case on the first stroke drawn anywhere. */
  private unfile(strokes: readonly SceneStroke[] | undefined): void {
    if (strokes === undefined) return;
    for (const stroke of strokes) this.strokeAt.delete(stroke.id);
  }

  /**
   * The surface the document has this stroke on, or null if it has not got it.
   *
   * The document's half of DATA-MODEL section 9.2's handoff: a peer's wet run
   * carries the id the record will be filed under (minted at pen-down, T-167),
   * and this is how a client asks whether that record has arrived. The surface
   * rather than a bare yes/no, because the other half of the same handoff is
   * "and has that surface's canvas rastered it", which is a question for
   * whichever layer owns it.
   *
   * Null for a stroke on an item that has since been deleted — the ink went
   * with the item (see [`removeItem`]), which is the document's answer and not
   * an omission here.
   */
  strokeSurface(id: string): InkSurface | null {
    return this.strokeAt.get(id) ?? null;
  }

  /** One tile, or undefined for a cell nobody has drawn in — which is almost
   *  every cell on almost every board. */
  boardInkTile(key: string): BoardInkTile | undefined {
    return this.boardInk.get(key);
  }

  /**
   * Every tile that has ink in it, in no particular order.
   *
   * The board-ink layer's whole culling input. There is no spatial index here
   * and there should not be one: this is a handful of entries even on a board
   * somebody has been drawing on all afternoon, and `render/cull.ts`'s grid
   * exists because *items* are numerous and move, neither of which is true of a
   * bucket of dried ink.
   */
  boardInkTiles(): IterableIterator<BoardInkTile> {
    return this.boardInk.values();
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
      this.layoutPin(pin);
    }
  }

  /**
   * One pin's world position, from the item's pose as it stands right now.
   *
   * `layoutPins` is the LAYOUT phase's sweep over the board; this is the same
   * answer for a single pin, callable from anywhere. `sim/ropes.ts` needs it
   * because rope anchors are pins and the rope solver runs in phase 3 — a
   * frame *before* the sweep — so reading `wx`/`wy` there would anchor a
   * string to where its pin was last frame, and a photograph dragged at any
   * speed would tow its string along visibly detached from the pin.
   *
   * Cheap enough to be the answer to that: a rope asks for two, and only for
   * the handful of ropes actually awake. The sweep repeats the work a phase
   * later and neither minds, because it is a pure function of the pose.
   */
  layoutPin(pin: PinNode): void {
    if (pin.parent === null) {
      pin.wx = pin.lx;
      pin.wy = pin.ly;
      return;
    }
    const slot = this.slots.get(pin.parent);
    if (slot === undefined) {
      pin.wx = pin.lx;
      pin.wy = pin.ly;
      return;
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
    return this.byParent.get(itemId) ?? EMPTY_IDS;
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

  // --- strings --------------------------------------------------------------

  /**
   * Insert or replace a string.
   *
   * The only way a run's node list may change. The binding re-reads the whole
   * entity and calls this rather than reaching into `strings` and assigning,
   * because a node list edited in place would leave `byPin` describing a board
   * that no longer exists — and a stale reverse index is the kind of wrong that
   * shows up as a thread that selects one string too many, an afternoon later.
   */
  putString(run: StringNodes): void {
    const existing = this.strings.get(run.id);
    if (existing) this.unindexString(existing);
    this.strings.set(run.id, run);
    for (const node of run.nodes) {
      let through = this.byPin.get(node.pin);
      if (!through) this.byPin.set(node.pin, (through = new Set()));
      through.add(run.id);
    }
  }

  removeString(id: string): boolean {
    const run = this.strings.get(id);
    if (!run) return false;
    this.strings.delete(id);
    this.unindexString(run);
    return true;
  }

  private unindexString(run: StringNodes): void {
    for (const node of run.nodes) {
      const through = this.byPin.get(node.pin);
      if (!through) continue;
      through.delete(run.id);
      if (through.size === 0) this.byPin.delete(node.pin);
    }
  }

  /**
   * Which strings run through this pin. Empty for a pin nothing hangs off —
   * never null, so a caller can iterate without asking first.
   *
   * Live rather than a copy, like `pinsOf`: the set is the index's own. Read it
   * and let it go, and never hold it across a `putString`.
   */
  stringsThrough(pinId: string): ReadonlySet<string> {
    return this.byPin.get(pinId) ?? EMPTY_IDS;
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
    // Ink adds nothing here: it is clipped to the paper (T-136), so an item is
    // exactly as big as its paper and its shadow. That was not true between
    // T-133 and T-136, and this is the code that carried the difference.
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

  /**
   * Bounds of everything on the board, for Ctrl+0. Null on an empty board.
   *
   * Board ink counts, and unlike an item's ink it can be the *only* thing that
   * does: a mark on the cork is not clipped to any paper (T-136 clips only what
   * is drawn on an item), so a board somebody has written on and put nothing on
   * has content, and framing a default rectangle instead of the writing would
   * open it looking empty.
   */
  contentBounds(): Bounds | null {
    // Shares the item walk with `F`, so the two can never end up disagreeing
    // about how far an item extends.
    const out = this.boundsOfMany(this.slots.keys());
    if (!out) {
      // Pins are deliberately not enough on their own. A pin is 12 units across
      // and framing one would open the board at the zoom ceiling on a speck;
      // ink is as big as it was drawn.
      const inked = this.boardInkBounds();
      return inked;
    }
    for (const pin of this.pins.values()) {
      if (pin.wx < out.minX) out.minX = pin.wx;
      if (pin.wy < out.minY) out.minY = pin.wy;
      if (pin.wx > out.maxX) out.maxX = pin.wx;
      if (pin.wy > out.maxY) out.maxY = pin.wy;
    }
    const inked = this.boardInkBounds();
    if (inked) {
      if (inked.minX < out.minX) out.minX = inked.minX;
      if (inked.minY < out.minY) out.minY = inked.minY;
      if (inked.maxX > out.maxX) out.maxX = inked.maxX;
      if (inked.maxY > out.maxY) out.maxY = inked.maxY;
    }
    return out;
  }

  /** The box round every board-ink tile, or null when nobody has drawn on the
   *  cork. Each tile already carries the box round its own strokes. */
  private boardInkBounds(): Bounds | null {
    let found = false;
    const out: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const tile of this.boardInk.values()) {
      const [x0, y0, x1, y1] = tile.bbox;
      if (x0 < out.minX) out.minX = x0;
      if (y0 < out.minY) out.minY = y0;
      if (x1 > out.maxX) out.maxX = x1;
      if (y1 > out.maxY) out.maxY = y1;
      found = true;
    }
    return found ? out : null;
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
    this.strings.clear();
    this.strokes.clear();
    this.boardInk.clear();
    this.strokeAt.clear();
    this.byParent.clear();
    this.byPin.clear();
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
