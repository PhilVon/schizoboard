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

import { shortest } from "@/lib/angle";
import { CellGrid } from "@/lib/cellgrid";
import type { InkSample, InkSurface } from "@/lib/ink";
import { rotateIn, rotateOut, type Point } from "@/lib/rotate";

const INITIAL_CAPACITY = 256;

/** Reused by `layoutPins`; see the note there. */
const scratch: Point = { x: 0, y: 0 };

/** Reused by `layoutOver`, which runs over every item on every frame anything
 *  moved and must not mint a rectangle per item. */
const overRect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

/** The pin `layoutOver` is currently placing, in board coordinates. Held here
 *  rather than passed, for the reason `overRect` is. */
const overPoint: Point = { x: 0, y: 0 };

/** And the pivot the note being written on turns about — its own, because the
 *  flatten runs inside a call that has already lent `scratch` out. */
const flatPivot: Point = { x: 0, y: 0 };

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

/**
 * Where a pin should be parented and what its coordinates become there — the
 * two-field write of DESIGN section 2.2, as an answer rather than as a gesture.
 *
 * Restated in `crdt/ops/pins.ts` rather than shared, like the comparators are:
 * the scene imports nothing from `crdt/` and `crdt/` may not read the mirror, so
 * a type that crossed would be a dependency that crossed. Four fields, and
 * structural typing means the two are the same type to every caller.
 */
export interface PinHome {
  id: string;
  parent: string | null;
  lx: number;
  ly: number;
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

  /**
   * The lay-flat, for `setFlatten`: which slot is being written on (-1 for
   * none), how far it has gone, and the translation holding its pin still.
   *
   * The one piece of per-item scene state that is not an array, because it is
   * the one that is true of at most a single item — and the one that holds a
   * slot across frames, which is why `removeItem` has to clear it.
   */
  private flatSlot = -1;
  private flatT = 0;
  private flatDX = 0;
  private flatDY = 0;

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
   * Which pins each item is actually *pushed through* — the geometric answer,
   * and the one the physics asks (T-176).
   *
   * > pins currently only effect their parent, however a pin may end up over
   * > two items if a pin or an item with a pin was moved or an item rotated. my
   * > thinking is a pin should effect any item under it.
   *
   * `byParent` above cannot answer that, and the gap between the two is
   * visible on the board: an item with a pin plainly sitting on it lies flat,
   * because the pin names something else. Parent is the coordinate *frame* — it
   * says whose local space the pin's numbers are in and therefore what it
   * travels with — and DESIGN 2.2 is right that it must stay singular. What it
   * is not is the answer to "what does this pin hold", which is a question about
   * where the pin *is*.
   *
   * So the two indexes now say different things and both are needed. A pin
   * belongs to one frame and holds however many items it is stuck through.
   * `pinsParentedTo` is the first; `pinsOf`, `pinCount` and `solePin` are the
   * second, because every one of their callers is asking about physics.
   *
   * Rebuilt from scratch rather than maintained by `putPin`, because nothing
   * about a pin has to change for the answer to: an item dragged over a
   * stationary pin is now on it, and no pin was written to. Sets are cleared
   * and refilled rather than replaced, so a still board allocates nothing.
   *
   * *When* it is rebuilt is [`overStale`]'s, and it is not the LAYOUT phase —
   * that phase **invalidates** this and rebuilds nothing. The first reader
   * afterwards pays, which on a dirty frame is the DOM phase asking for the
   * paper curl. Anything reasoning about ordering should start there and not
   * here.
   */
  private readonly byOver = new Map<string, Set<string>>();

  /**
   * The topmost item each pin is pushed through — [`byOver`] read the other way
   * round, and reduced to one answer instead of a set.
   *
   * > my thinking is a pin should effect any item under it **and move with the
   * > top most item**.
   *
   * `byOver` answers the first clause. This answers the second, and the two are
   * different questions about the same query, which is why it is filled by the
   * same pass rather than derived from it afterwards: turning `byOver` inside
   * out costs a walk of every item's set, and picking a maximum out of that
   * costs a slot lookup per candidate. Both are already in hand while filing.
   *
   * Empty for a pin over nothing, which is the common case and means free in the
   * cork. Filled in [`fileOver`], consumed by [`rehomes`].
   */
  private readonly overTop = new Map<string, string>();

  /**
   * Items indexed by the box they cover, so [`layoutOver`] can ask what a pin
   * is inside without testing it against every item on the board.
   *
   * Slot-keyed, which is what `CellGrid` is built for, and the second thing on
   * this board to want one — `render/cull.ts` has the other. Not shared with it:
   * that grid is the culler's own and lives on the far side of the one-way data
   * flow, and this one has to be right in the LAYOUT phase, which is two phases
   * earlier.
   */
  private readonly overGrid = new CellGrid(512);

  /**
   * Whether [`byOver`] is behind the scene, so the next question rebuilds it.
   *
   * ## What the index is a function of, which is the whole of T-189
   *
   * **The stored pose. Never the drawn one** (Q-146). `x`, `y`, `rot` and the
   * pin's own `lx`/`ly` — not `renderX`/`renderY`/`renderRot`, and therefore not
   * `driftX`, `driftY`, `swing` or the flatten offsets. Only a real move changes
   * what holds what.
   *
   * Three reasons, and the first is the one that makes it a correctness rule
   * rather than a preference.
   *
   * **It closes a loop that `pinPivot` already refuses to close.** That method
   * reads the settled pose because "everything that asks this is computing
   * something the swing is then applied *to*", and a pivot read off the drawn
   * pose would be a function of the swing it is used to produce. Membership is
   * the same loop one level up: `pinCount` decides hanging-versus-rigid and
   * `solePin` decides the pivot, both in `sim/torsion.ts`, which then writes the
   * very drift the drawn pose is made of. Off the drawn pose a note could swing
   * itself over a second pin, become rigid, and stop swinging — the physics
   * driven by a visual offset that is never stored and that two peers
   * legitimately differ on.
   *
   * **It makes the answer the same in every phase.** `sim/torsion.ts` writes
   * `swing`/`driftX`/`driftY` straight into the typed arrays, `state/tools/
   * select.ts` writes `swing`, and `setFlatten` writes the flatten offsets —
   * none of them a setter, so none of them could raise this flag without being
   * told to. While the index read them, phase 3 built it from last frame's drift
   * and phase 5 rebuilt it from this frame's, and the board answered one
   * question two ways inside one frame. It cannot now: those fields are not in
   * the answer.
   *
   * **It keeps a `NaN` out of the one place it was worst.** `fileOver` explains
   * what a non-finite pose does to this index. The drawn pose is arithmetic done
   * every frame by the simulation; the stored one comes through `crdt/schema.ts`
   * and is finite or it is not there. The guard stays — a tool can still write a
   * bad pose — but the sim no longer has a route into it.
   *
   * ## When it is rebuilt
   *
   * On demand rather than in a phase, and that is not a micro-decision. The
   * obvious home is the LAYOUT phase, next to the pin world positions — but
   * `sim/torsion.ts` asks the physics question in phase *3*, and `sim/ropes.ts`
   * already carries a comment about that exact hazard. An index built one phase
   * after its readers is an index that is silently a frame stale for the thing
   * that cares most, and every test that puts a pin down would have to know to
   * run a phase before asking what it holds.
   *
   * So: anything that moves an item or a pin sets this, and the first question
   * afterwards pays for the rebuild. At most one rebuild per frame however many
   * callers ask, and a still board pays a boolean. A board that is only
   * *swinging* now pays a boolean too, which it did not before — see
   * `layoutPins`.
   */
  private overStale = true;

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
    return this.x[slot]! + this.driftX[slot]! + (slot === this.flatSlot ? this.flatDX : 0);
  }

  renderY(slot: number): number {
    return this.y[slot]! + this.driftY[slot]! + (slot === this.flatSlot ? this.flatDY : 0);
  }

  /**
   * The angle an item is drawn at: its authored rotation plus the swing, laid
   * flat if it is the one being written on.
   *
   * The companion to `renderX`/`renderY`, and it exists for the same reason —
   * this sum had been written out by hand in a dozen places, and T-107 was
   * what happens when one of them is missed. The selection chrome, the
   * marquee and the rotate pivot each re-derived the angle, one of them from
   * `rot` alone, and the geometry then disagreed with the paint: chrome drawn
   * off the paper, a marquee that missed an item it enclosed.
   *
   * So there is one reader, and the flatten bends it here rather than at
   * twelve call sites.
   */
  renderRot(slot: number): number {
    const angle = this.rot[slot]! + this.swing[slot]!;
    // Bit-identical to `settledRot` when nothing is being written on, which is
    // every frame on a board nobody is typing into.
    if (slot !== this.flatSlot) return angle;
    return shortest(angle) * (1 - this.flatT);
  }

  /**
   * The angle the item goes back to when the paper is put down — the drawn
   * angle with the flatten taken out of it.
   *
   * This is the one thing that must **not** see the flatten, and the reason is
   * that it is what gets written into the document. `drawnPose` flattens the
   * transients into stored fields so a pin change leaves paper exactly where
   * it looks (`state/tools/frame.ts`), and the swing is a real settling that
   * stays where it lands. The editor's lay-flat is the opposite: a lie told
   * for as long as someone is typing and taken back on blur. Bake it and a
   * note that happened to be pinned mid-sentence loses its tilt permanently.
   */
  settledRot(slot: number): number {
    return this.rot[slot]! + this.swing[slot]!;
  }

  /** The centre it goes back to, for the same reason. */
  settledX(slot: number): number {
    return this.x[slot]! + this.driftX[slot]!;
  }

  settledY(slot: number): number {
    return this.y[slot]! + this.driftY[slot]!;
  }

  /**
   * Lay an item flat to be written on, or let it back down.
   *
   * > **The note un-rotates to 0° while you edit** — animated over about
   * > 120 ms — and rotates back on blur. This is not a stylistic choice: caret
   * > placement, text selection and IME composition all misbehave inside a CSS
   * > rotated element, across every engine. — DESIGN section 3.6
   *
   * A scalar and a slot rather than a `Float32Array` per field like `swing`
   * and `lift`, because unlike those this is true of **at most one item at a
   * time** — there is one caret. Saying so in the shape of the state means
   * there is no second editor to leave behind, and costs one integer compare
   * in `renderX`, which pin layout calls for every pin on the board.
   *
   * `t` runs 0 (as it hangs) to 1 (square to the screen). Continuous rather
   * than a flag because the frame loop owns all motion (ARCHITECTURE section
   * 3) — there is no CSS transition available to soften it.
   *
   * The translation is the same "put the pivot back where it was" as the
   * swing's `drift`, and for the same reason: a pin is stuck in the cork and
   * does not move, so a note hanging on one turns about the pin rather than
   * about its own centre. Without it, entering an edit slides the pin out of
   * the paper and tugs every string through it.
   */
  setFlatten(itemId: string | null, t: number): boolean {
    const slot = itemId === null ? -1 : (this.slots.get(itemId) ?? -1);
    if (slot === -1 || t === 0) {
      if (this.flatSlot === -1) return false;
      this.flatSlot = -1;
      this.flatT = 0;
      this.flatDX = 0;
      this.flatDY = 0;
      return true;
    }

    // The translation depends on the *settled* angle, and a note being written
    // on may still be swinging into place under it. So this is recomputed on
    // every frame the paper is up, and the answer is compared rather than
    // assumed changed — a note nobody is typing into, hanging still, must not
    // dirty itself sixty times a second.
    let dx = 0;
    let dy = 0;
    // Two pins hold the paper rigid and none leaves it lying on the cork; in
    // neither case is there a point it obviously turns about, so it turns
    // about its centre and there is nothing to translate. The same rule the
    // rotation gesture uses, from the same place (T-105).
    const pin = this.solePin(itemId!);
    // `pinPivot`, not `pin.lx`/`pin.ly` — the pin holding this note need not be
    // one it parents (T-188), and un-rotating a note to write on it about a point
    // in the wrong frame takes the note off the screen instead of laying it flat.
    const at = pin === null ? null : this.pinPivot(pin.id, slot, flatPivot);
    if (at) {
      const settled = this.settledRot(slot);
      const drawn = shortest(settled) * (1 - t);
      const c0 = Math.cos(settled);
      const s0 = Math.sin(settled);
      const c1 = Math.cos(drawn);
      const s1 = Math.sin(drawn);
      dx = at.x * (c0 - c1) - at.y * (s0 - s1);
      dy = at.x * (s0 - s1) + at.y * (c0 - c1);
    }

    if (this.flatSlot === slot && this.flatT === t && this.flatDX === dx && this.flatDY === dy) {
      return false;
    }
    this.flatSlot = slot;
    this.flatT = t;
    this.flatDX = dx;
    this.flatDY = dy;
    return true;
  }

  /** How far the item in `slot` has been laid flat: 0 unless it is the one. */
  flattenOf(slot: number): number {
    return slot === this.flatSlot ? this.flatT : 0;
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
    // Geometry in, so what is over what may have changed.
    this.overStale = true;
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
    this.overStale = true;
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
    this.overStale = true;
    // Ink goes with the item, which is the opposite of what happens to its pins
    // — and the asymmetry is the document's, not a choice made here. A pin is
    // top-level and outlives its item (`Shift`+`Delete`); a stroke is nested
    // inside the item's map and cannot outlive it. Nothing has to remember the
    // strokes for undo either: an item that comes back brings its ink with it
    // through the observer, in the same entry.
    this.unfile(this.strokes.get(id));
    this.strokes.delete(id);
    // Dropped rather than cleared, unlike every other frame: `layoutOver`
    // rebuilds from `slots`, and an item that has left it would never be visited
    // again — so a set left behind would answer `pinCount` with the pins that
    // held this item at the moment it was deleted, for as long as the session
    // lasted. The grid entry can stay: a freed slot is guarded by its null id,
    // and re-indexed from scratch if the slot is reused.
    this.byOver.delete(id);
    this.slots.delete(id);
    this.ids[slot] = null;
    this.coldBySlot[slot] = null;
    this.swing[slot] = 0;
    this.driftX[slot] = 0;
    this.driftY[slot] = 0;
    this.lift[slot] = 0;
    // Slots are reused, and `flatSlot` is the one piece of scene state that
    // holds one across frames. Left behind, the next item into this slot would
    // be born laid flat by an editor that closed on a note a peer deleted.
    if (slot === this.flatSlot) this.setFlatten(null, 0);
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
    this.overStale = true;
    this.pins.set(pin.id, pin);
    if (pin.parent === null) return;
    let held = this.byParent.get(pin.parent);
    if (!held) this.byParent.set(pin.parent, (held = new Set()));
    held.add(pin.id);
  }

  removePin(id: string): boolean {
    const pin = this.pins.get(id);
    if (!pin) return false;
    this.overStale = true;
    this.pins.delete(id);
    this.overTop.delete(id);
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
    // And it does *not* invalidate the over-index, which it used to do here.
    //
    // That line was load-bearing by accident: the index read the drawn pose, no
    // writer of drift raised the flag, and this was the one thing that made the
    // simulation's own output show up in the answer at all — one phase late, and
    // only on frames something else had already dirtied. Now that the index is a
    // function of the stored pose (see `overStale`), this method writes nothing
    // the index reads: it refreshes `wx`/`wy`, and `layoutOver` computes pin
    // positions itself rather than reading those. Every real mutation already
    // raises the flag in its own setter.
    //
    // Worth stating because of what it buys. A hanging note is dirty on every
    // frame it swings, so this rebuilt the whole index — every item re-bucketed,
    // a point query per pin — once a frame for the entire settle, inside the
    // phase the loop designates write-only. A swing is now free.
  }

  /**
   * Rebuild [`byOver`]: which items each pin is currently pushed through.
   *
   * Every pin, every time, and *not* filtered by `changedItems` the way the
   * sweep above is. That filter is sound for world positions, because a pin only
   * moves when its own parent does — and it is exactly wrong here, because the
   * common case this whole task is about is a pin that did not move at all and
   * an item that was dragged over it. Filtering by what moved would answer for
   * the item and miss the pin.
   *
   * The cost is therefore one point query per pin per frame that anything moved,
   * against a grid that only re-buckets the items whose cells actually changed.
   * That is the same order as the sweep above and as the culler's own pass.
   */
  private layoutOver(): void {
    this.overStale = false;
    for (const [id, slot] of this.slots) {
      // Stored, not drawn — Q-146, and see [`overStale`] for the whole of why.
      const cos = Math.abs(Math.cos(this.rot[slot]!));
      const sin = Math.abs(Math.sin(this.rot[slot]!));
      const w = this.w[slot]!;
      const h = this.h[slot]!;
      // The upright box around the rotated one. Bigger than the item, which is
      // the safe direction: the grid only ever produces candidates, and the
      // exact test below rejects the corners it over-claims.
      const hw = (cos * w + sin * h) / 2;
      const hh = (sin * w + cos * h) / 2;
      const cx = this.x[slot]!;
      const cy = this.y[slot]!;
      overRect.minX = cx - hw;
      overRect.minY = cy - hh;
      overRect.maxX = cx + hw;
      overRect.maxY = cy + hh;
      this.overGrid.place(slot, overRect);
      // Cleared rather than deleted, so the Set survives to be refilled and a
      // board at rest allocates nothing at all.
      this.byOver.get(id)?.clear();
    }

    for (const pin of this.pins.values()) {
      // Dropped before filing rather than cleared in a sweep of its own: a pin
      // that has come off everything must not keep last frame's answer, and
      // this loop is the only place that knows it has.
      this.overTop.delete(pin.id);
      // Computed, not read off the pin: see [`pinWorld`]. And settled rather
      // than drawn, to match the boxes above.
      this.pinSettled(pin, overPoint);
      const cx = Math.floor(overPoint.x / this.overGrid.cell);
      const cy = Math.floor(overPoint.y / this.overGrid.cell);
      const bucket = this.overGrid.bucketAt(cx, cy);
      if (bucket) for (const slot of bucket) this.fileOver(pin, slot);
      // An item too big to bucket is a candidate for everything — see
      // `CellGrid.oversized`. Nothing this application makes is that size.
      for (const slot of this.overGrid.oversized) this.fileOver(pin, slot);
    }
  }

  /** File `pin`, whose world position is in `overPoint`, against the item in
   *  `slot` — if it really is inside it. */
  private fileOver(pin: PinNode, slot: number): void {
    const id = this.ids[slot];
    if (id === null || id === undefined) return;
    // Settled, like the box in `layoutOver` and the point in `overPoint`. All
    // three terms of this test come from the document's pose or from none.
    const angle = this.rot[slot]!;
    rotateIn(
      overPoint.x,
      overPoint.y,
      this.x[slot]!,
      this.y[slot]!,
      Math.cos(angle),
      Math.sin(angle),
      scratch,
    );
    /**
     * Stated as "is it inside" rather than as "is it outside", which is the
     * same test for every finite coordinate and not the same test at all for a
     * pin or an item whose pose has gone `NaN`.
     *
     * Every comparison against `NaN` is false, so the old `> w/2` rejection
     * *accepted* one — and this is the last line standing between that and the
     * whole board. An item with a non-finite pose gives `layoutOver` a `NaN`
     * bounding box; `CellGrid.place` computes a `NaN` cell count, cannot index
     * it, and puts the slot in `oversized`; and `oversized` is offered **every
     * pin on the board** on the reasoning that the exact test below will reject
     * what the grid over-claims. So one sick item silently became the thing
     * every pin was pushed through, which is `pinCount`, which is `solePin`,
     * which is how every hanging item on the board decides where it hangs.
     *
     * Written this way there is no separate `Number.isFinite` to remember: a
     * coordinate that is not a number is not inside anything.
     */
    const inside =
      Math.abs(scratch.x) <= this.w[slot]! / 2 && Math.abs(scratch.y) <= this.h[slot]! / 2;
    if (!inside) return;
    let over = this.byOver.get(id);
    if (!over) this.byOver.set(id, (over = new Set()));
    over.add(pin.id);
    const top = this.overTop.get(pin.id);
    if (top === undefined || this.outranks(slot, top)) this.overTop.set(pin.id, id);
  }

  /**
   * Does the item in `slot` paint over the item called `incumbent`?
   *
   * `crdt/zindex.ts`'s `compareOrder`, descending, and re-stated here for the
   * reason the file header gives and `compareStrokes` above gives again: the
   * scene imports nothing from `crdt/`. `render/items/dom.ts` holds the third
   * copy, and all three have to agree — a topmost that disagreed with the one
   * that draws would re-home a pin onto the item the user can see it is *not*
   * on top of.
   *
   * An incumbent that has left the board loses, so a stale answer is never
   * preferred to a live one.
   */
  private outranks(slot: number, incumbent: string): boolean {
    const challenger = this.coldBySlot[slot];
    if (!challenger) return false;
    const held = this.slots.get(incumbent);
    const holder = held === undefined ? null : this.coldBySlot[held];
    if (!holder) return true;
    if (challenger.z !== holder.z) return challenger.z > holder.z;
    if (challenger.createdBy !== holder.createdBy) return challenger.createdBy > holder.createdBy;
    return challenger.id > holder.id;
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
    this.pinWorld(pin, scratch);
    pin.wx = scratch.x;
    pin.wy = scratch.y;
  }

  /**
   * Where a pin is right now, into `out`, **without** writing it down.
   *
   * The read-only half of `layoutPin`, and the distinction is load-bearing for
   * one caller. `layoutPins(changedItems)` deliberately leaves the world
   * position of a pin whose item did not move untouched, so [`layoutOver`] —
   * which runs over every pin whether or not it moved — must not be the thing
   * that quietly refreshes them all. It also cannot simply *read* `wx`/`wy`,
   * because it can be asked before the LAYOUT phase has ever run and would then
   * be indexing every pin at the origin. So it computes, and does not store.
   */
  private pinWorld(pin: PinNode, out: Point): Point {
    // Rendered rotation about the rendered centre: a pin stays on the
    // photograph while the photograph swings — and, because `drift` is
    // defined as the translation that holds the pivot still, a *single*
    // pin's world position comes back unchanged by the swing entirely, which
    // is what makes it look pushed into the cork rather than sliding across
    // it.
    return this.pinAt(pin, out, true);
  }

  /**
   * Where a pin is once everything has stopped moving — the same point, read in
   * the pose the document holds rather than the one the frame draws.
   *
   * [`layoutOver`]'s half of the pair, and the two must not be mixed: an index
   * that put settled item boxes against drawn pin positions would be asking
   * whether a pin is inside a rectangle neither of them is in. Q-146 chose the
   * settled pose for the index, so *both* sides of the test are settled and the
   * question "which pins hold this item" has no term in it that a swing can
   * move.
   *
   * For the overwhelmingly common pin this is the identical point — a sole pin's
   * drawn position is its settled one, by drift's definition — so the split
   * costs nothing on a board of hanging notes. Where it bites is exactly where
   * it should: a pin parented to an item it is not over, riding that item's
   * swing, which used to be able to swing itself in and out of a *third* item's
   * physics.
   */
  private pinSettled(pin: PinNode, out: Point): Point {
    return this.pinAt(pin, out, false);
  }

  /** The shared body of the two above: `pin` in board coordinates, read through
   *  its parent's drawn pose or its stored one. */
  private pinAt(pin: PinNode, out: Point, drawn: boolean): Point {
    if (pin.parent === null) {
      out.x = pin.lx;
      out.y = pin.ly;
      return out;
    }
    const slot = this.slots.get(pin.parent);
    if (slot === undefined) {
      out.x = pin.lx;
      out.y = pin.ly;
      return out;
    }
    const angle = drawn ? this.renderRot(slot) : this.rot[slot]!;
    const cx = drawn ? this.renderX(slot) : this.x[slot]!;
    const cy = drawn ? this.renderY(slot) : this.y[slot]!;
    // Into the caller's object — this runs over every pin on the board on every
    // frame anything moved, so it must not mint one per pin.
    return rotateOut(pin.lx, pin.ly, cx, cy, Math.cos(angle), Math.sin(angle), out);
  }

  /**
   * How many pins hold this item — its physics, per DESIGN section 2.2.
   *
   * Geometric, not parental: every pin actually stuck through the paper counts,
   * whoever's frame its coordinates happen to be in. See [`byOver`], and note
   * that this and `pinsParentedTo` are now different questions with different
   * answers.
   */
  pinCount(itemId: string): number {
    if (this.overStale) this.layoutOver();
    return this.byOver.get(itemId)?.size ?? 0;
  }

  /**
   * Which pins hold this item. Empty for an unpinned one — never null, so a
   * caller can iterate without asking first.
   *
   * Live rather than a copy: the set is the index's own, and a rebuild clears
   * and refills it. Read it and let it go; do not keep it across a frame — and
   * not across a *rebuild* either, which is the tighter rule, because one can
   * happen at any read on a frame where anything moved (see [`overStale`]).
   */
  pinsOf(itemId: string): ReadonlySet<string> {
    if (this.overStale) this.layoutOver();
    return this.byOver.get(itemId) ?? EMPTY_IDS;
  }

  /**
   * Where a pin sits on an item, in the item's own settled frame, into `out`.
   *
   * The companion to [`pinsOf`] and [`solePin`], and it exists because those two
   * became *geometric* in T-176 while everything downstream of them went on
   * reading `pin.lx`/`pin.ly` as if the pin were parented to the item it holds.
   * That is only true when it is. For a free pin those are board coordinates and
   * for one parented elsewhere they are a third item's — so a note that had been
   * dragged over a pin was turning about a point thousands of units away and
   * being flung off the board by a few degrees of swing (T-188).
   *
   * **Settled, not drawn.** `rot[slot]` and `x`/`y`, never `renderRot` or
   * `renderX`/`renderY`. Everything that asks this is computing something the
   * swing is then applied *to* — the equilibrium angle, the drift that holds the
   * pivot still, which corners are held flat — so a pivot read off the drawn pose
   * would be a function of the swing it is used to produce. That is a loop, and
   * this is the line that is not allowed to close it.
   *
   * A pin this item parents short-circuits, and that is correctness rather than
   * speed: its world position is computed from the *drawn* pose of its parent, so
   * sending it out to the world and back through the settled frame would return
   * the swing rather than remove it.
   *
   * By slot, like `boundsAt`, because every caller already has one — it took a
   * `pinsOf` or a `solePin` to get here — and a lookup per pin per frame to turn
   * it back into an id would be paid on the DOM phase's walk of the viewport.
   */
  pinPivot(pinId: string, slot: number, out: Point): Point | null {
    const pin = this.pins.get(pinId);
    if (pin === undefined) return null;
    if (pin.parent !== null && pin.parent === this.ids[slot]) {
      out.x = pin.lx;
      out.y = pin.ly;
      return out;
    }
    this.pinWorld(pin, out);
    const angle = this.rot[slot]!;
    // Safe to read `out` back: `rotateIn` takes its inputs as scalars, so the
    // source and the destination being the same object costs nothing.
    return rotateIn(
      out.x,
      out.y,
      this.x[slot]!,
      this.y[slot]!,
      Math.cos(angle),
      Math.sin(angle),
      out,
    );
  }

  /**
   * Which pins store their coordinates in this item's frame — the *parent*
   * relationship, which is no longer the same set as the one above.
   *
   * One caller, and it is the one place where parentage is genuinely the
   * question being asked: `state/thread.ts` follows the connected component out
   * of a pin, into the item it is pushed into, and back out to that item's other
   * pins, and it enters through `pin.parent`. Physics wants `pinsOf`.
   */
  pinsParentedTo(itemId: string): ReadonlySet<string> {
    return this.byParent.get(itemId) ?? EMPTY_IDS;
  }

  /**
   * The topmost item this pin is pushed through, or null when it is over none —
   * which is to say, the item it ought to be parented to (D-31).
   */
  topOver(pinId: string): string | null {
    if (this.overStale) this.layoutOver();
    return this.overTop.get(pinId) ?? null;
  }

  /**
   * Every pin whose frame disagrees with the paper it is stuck through, and the
   * two-field write that would fix it. Empty on a board that is already right,
   * which is almost every frame.
   *
   * ## Why the drawn pose, when `pinPivot` two methods up insists on the settled one
   *
   * Because this is the one conversion where drawn and settled cannot disagree,
   * and using the drawn pose is what makes the re-home *invisible*: the world
   * position out of [`pinWorld`] and the frame it goes back into are then the
   * same two poses `pinWorld` will use to read it back, so the pin does not
   * move by a pixel on the frame its parent changes.
   *
   * That would normally bake this window's swing into the document, and swing is
   * local state that two peers legitimately differ on. It does not here, and the
   * reason is in what the new parent is. It is an item the pin is over, so the
   * pin is in its `pinsOf`, so it holds either exactly this pin or two or more.
   * Two or more is rigid and has no swing at all. Exactly one makes this the
   * sole pin, and `drift` is *defined* as the translation that holds the sole
   * pin still — so the frame turns about this very point, and a point's own
   * coordinates in a frame rotating about it do not change. Both cases give
   * every peer the same numbers.
   *
   * It is better than neutral, in fact. A pin parented to an item it is *not*
   * over currently rides that item's drawn pose, and that genuinely is
   * swing-dependent; re-homing it onto the paper it is actually in ends that.
   *
   * Into the caller's array, which it owns and this empties — the answer is
   * almost always nothing, and a fresh array per frame to say so is a fresh
   * array per frame.
   */
  rehomes(out: PinHome[]): PinHome[] {
    if (this.overStale) this.layoutOver();
    out.length = 0;
    for (const pin of this.pins.values()) {
      const top = this.overTop.get(pin.id) ?? null;
      if (top === pin.parent) continue;
      this.pinWorld(pin, scratch);
      if (top === null) {
        out.push({ id: pin.id, parent: null, lx: scratch.x, ly: scratch.y });
        continue;
      }
      const slot = this.slots.get(top);
      // Unreachable — `top` came out of a slot a moment ago — but the index is
      // rebuilt lazily and a caller between the two would rather have a short
      // answer than a wrong one.
      if (slot === undefined) continue;
      const angle = this.renderRot(slot);
      rotateIn(
        scratch.x,
        scratch.y,
        this.renderX(slot),
        this.renderY(slot),
        Math.cos(angle),
        Math.sin(angle),
        scratch,
      );
      out.push({ id: pin.id, parent: top, lx: scratch.x, ly: scratch.y });
    }
    return out;
  }

  /**
   * The one pin holding this item, or null if it is held by none or by
   * several. The physics question of DESIGN section 2.2, asked directly.
   *
   * Two things want it and want it for the same reason: an item on one pin
   * hangs from that pin, and turns about it — so both `sim/torsion.ts` and the
   * rotation gesture need to know which point that is. Which means this one had
   * to become geometric with the rest: an item hanging from a pin it does not
   * parent still turns about that pin, because that is where it is nailed.
   */
  solePin(itemId: string): PinNode | null {
    if (this.overStale) this.layoutOver();
    const held = this.byOver.get(itemId);
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
    const angle = this.renderRot(slot);
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    // Ink adds nothing here: it is clipped to the paper (T-136), so an item is
    // exactly as big as its paper and its shadow. That was not true between
    // T-133 and T-136, and this is the code that carried the difference.
    const hw = (this.w[slot]! * cos + this.h[slot]! * sin) / 2 + pad;
    const hh = (this.w[slot]! * sin + this.h[slot]! * cos) / 2 + pad;
    const cx = this.renderX(slot);
    const cy = this.renderY(slot);
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

    const angle = this.renderRot(slot);
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

    const dx = this.renderX(slot) - rcx;
    const dy = this.renderY(slot) - rcy;

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
    this.byOver.clear();
    this.overGrid.clear();
    this.overStale = true;
    this.byPin.clear();
    this.ids.fill(null);
    this.coldBySlot.fill(null);
    this.swing.fill(0);
    this.driftX.fill(0);
    this.driftY.fill(0);
    this.lift.fill(0);
    this.setFlatten(null, 0);
    this.freeSlots.length = 0;
    this.highWater = 0;
  }
}
