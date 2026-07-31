/**
 * Committing ink, and taking it away again.
 *
 * > Everything up to pen-up is local and ephemeral. The commit is a single
 * > `Y.Map` insertion — which makes a stroke atomic for undo, deletion and
 * > hit-testing. — DATA-MODEL section 6.2
 *
 * One stroke, one insertion, one transaction, one undo entry. That is the whole
 * design and every property this file has follows from it.
 *
 * ## Nested under the item, which is not a detail
 *
 * > Ink dies with the item it was drawn on, and undoing a delete must restore
 * > the ink atomically. Nesting gives both for free: deleting the item's map
 * > deletes the strokes with it, and one undo entry restores everything. Pins
 * > can't work this way (they're referenced by strings and can outlive the
 * > item), which is why they're top-level and need explicit cascade code.
 * > — DATA-MODEL section 3
 *
 * So there is no cascade in this file, and there is not supposed to be. The
 * strokes map is inside `board.items`, which is already a root of the undo
 * manager, so a stroke is undoable and a deleted item takes its ink with it
 * without a line of code here — see `crdt/ops/items.ts`'s `deleteItems`, which
 * has a comment saying exactly this and nothing to do about it.
 *
 * ## Ink on bare cork goes somewhere else, and that is the only fork here
 *
 * > **`boardInk` is tiled** into 2048-unit cells, keyed by the floor-divided
 * > coordinates of each stroke's bounding-box centre. — DATA-MODEL section 2
 *
 * So a stroke with no item lands in `board.boardInk` under a tile key instead of
 * in `item.strokes`, and nothing else about it differs: same fields, same
 * packing, same one insertion in one transaction. The tile is a bucket, not a
 * frame — the samples are already in board coordinates and are stored unchanged,
 * so a stroke that runs off the side of its tile is stored whole and drawn whole.
 * The renderer culls by the stroke's own bounds anyway (the same section).
 *
 * `z` is scanned within the tile for the same reason it is scanned within an
 * item: two people drawing in two different corners of the board have no
 * ordering to argue about. Across a tile boundary there is no order at all,
 * which is what a bucket means — and two strokes far enough apart to be in
 * different tiles cannot overlap unless one of them is 2048 units long.
 */

import * as Y from "yjs";

import type { BoardDoc } from "@/crdt/doc";
import { freshId, inkTileKey, mutate } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import type { YMap } from "@/crdt/schema";
import { keyAbove } from "@/crdt/zindex";
import type { InkSample, InkTool } from "@/lib/ink";
import { newSeed } from "@/lib/seed";
import { packStroke } from "@/lib/strokepack";

export interface CommitStrokeInput {
  /**
   * The id to file this run under, when the caller has already decided one.
   *
   * The pen does (`state/tools/marker.ts`), and for a reason that has nothing to
   * do with the document: a peer watching the stroke being drawn needs a name to
   * match the arriving record against, and an id minted here does not exist
   * while the ink is still wet (DATA-MODEL section 9.2). Everything else that
   * writes a stroke leaves this out and gets a fresh one.
   *
   * Taken as given, not checked for collision. It is twelve base-62 characters
   * from `crypto.getRandomValues`, and a caller that hands over one it made up
   * has bigger problems than this map key.
   */
  id?: string;
  /** The item the samples are local to, or null for a stroke on bare cork —
   *  which goes into a `boardInk` tile instead. See the note at the top. */
  item: string | null;
  tool: InkTool;
  color: string;
  /** Board units, which are the item's local units too — the same scale. */
  size: number;
  /** 0 to 1; the highlighter's translucency. Defaults to opaque. */
  opacity?: number;
  seed?: number;
  /** In the space `item` names. One run of one gesture: the marker breaks a
   *  stroke at every edge it crosses (T-137) and each piece arrives here in the
   *  frame of the surface it ended up on. */
  samples: readonly InkSample[];
}

/**
 * Where a committed stroke landed — exactly one of `item` and `tile` is set.
 *
 * Both are returned rather than recomputed by the caller. The tile because the
 * packer is what measured the box the key comes from, and packing a second time
 * to ask where something already is would be the largest allocation in the
 * gesture; the item because a batch drops the runs it could not write, so the
 * results do not line up with the inputs by position and a caller matching them
 * up by index would name the wrong surface the moment one was refused.
 *
 * The caller that wants both is the wet/dry handoff, which has to know which
 * canvases to wait for — see `app/main.ts`.
 */
export interface CommittedStroke {
  readonly id: string;
  readonly item: string | null;
  readonly tile: string | null;
}

/**
 * Write one stroke — [`commitStrokes`] for the gesture that produced several.
 * Returns where it landed, or null when there was nothing worth keeping.
 *
 * Null covers two cases: an item that has gone, and a gesture whose samples
 * packed to no bytes. The last is a click rather than a stroke, and
 * `lib/strokepack.ts` deliberately does not throw on it — deciding a click is
 * not worth committing belongs here, to the caller that knows a pointer was
 * involved.
 *
 * `bbox` is the packer's rather than measured here, which is what makes
 * invariant 7 — "a stroke's `bbox` always contains its unpacked points" — true
 * by construction: the same function that decided where the points ended up
 * measured the box round them. The tile key is taken from that same box, so a
 * stroke is bucketed by exactly the extent it is stored with.
 */
export function commitStroke(
  board: BoardDoc,
  input: CommitStrokeInput,
): CommittedStroke | null {
  return commitStrokes(board, [input])[0] ?? null;
}

/**
 * Several runs of one gesture, in one transaction.
 *
 * > one gesture, several stroke records in one undo entry — Q-37
 *
 * A stroke that crosses off the paper it started on is broken at the edge and the
 * pieces are glued to what they are actually over (T-137). That is several
 * records, and it must be **one** undo entry: the hand made one movement, and a
 * Ctrl+Z that took back the half on the cork and left the half on the photograph
 * would be undoing something nobody did.
 *
 * One `mutate` rather than one per run is the whole of how that is achieved —
 * `Y.UndoManager` groups by transaction, so the entry is a property of this call
 * and not of a timeout.
 *
 * Returns one entry per run that was actually written, in order. A run that
 * packed to no bytes or whose item has gone is skipped rather than returned as a
 * hole, so the list is shorter than the input exactly when something was
 * dropped — and the caller (the wet/dry handoff) wants the ones that landed.
 */
export function commitStrokes(
  board: BoardDoc,
  inputs: readonly CommitStrokeInput[],
): CommittedStroke[] {
  // Packed outside the transaction. It is the expensive part — simplify,
  // quantise, delta-encode — and it neither reads nor writes the document, so
  // holding a transaction open across it would widen the one window in this
  // application where a peer's update has to wait.
  //
  // Filtered *before* the pack rather than after, which is not tidiness: an
  // infinite sample does not survive `packStroke` to be inspected. See
  // [`writable`].
  const packed = inputs
    .filter(writable)
    .map((input) => ({ input, packed: packStroke(input.samples) }));
  if (packed.every(({ packed: p }) => p.pts.length === 0)) return [];

  return mutate(board, Origin.INK_COMMIT, () => {
    const out: CommittedStroke[] = [];
    for (const { input, packed: p } of packed) {
      if (p.pts.length === 0) continue;
      const [x0, y0, x1, y1] = p.bbox;
      const tile = input.item === null ? inkTileKey((x0 + x1) / 2, (y0 + y1) / 2) : null;
      const map = input.item === null ? tileMap(board, tile!) : strokesOfItem(board, input.item);
      if (map === null) continue;

      const id = input.id ?? freshId(map);
      const stroke = new Y.Map<unknown>();
      stroke.set("tool", input.tool);
      stroke.set("color", input.color);
      stroke.set("size", input.size);
      stroke.set("opacity", input.opacity ?? 1);
      stroke.set("seed", input.seed ?? newSeed());
      // Above every stroke already in this item or this tile, not on the board.
      // Ink stacks within the surface it is on, and two people annotating two
      // photographs — or two corners of the cork — have no ordering to argue
      // about. Two runs of the *same* gesture landing on the same surface stack
      // in the order they were drawn, because this is re-read per run.
      stroke.set("z", keyAbove(topStroke(map)));
      stroke.set("bbox", [...p.bbox]);
      stroke.set("pts", p.pts);
      map.set(id, stroke as YMap);
      out.push({ id, item: input.item, tile });
    }
    return out;
  });
}

/**
 * Whether a run can go in the document at all — invariant 1, for ink.
 *
 * > Every number in the document is finite. — DATA-MODEL section 13
 *
 * Items and pins have guarded this since T-155 and this file did not, on the
 * reasonable-looking grounds that samples come from pointer events and pointer
 * events carry numbers. They do; a *transform* is what does not. Every sample
 * here has been through the camera and, for ink on an item, through that item's
 * inverse rotation as well — so one NaN in a pose reaches this function as a
 * whole strokeful of NaN, which is how the same class of bug reached items in
 * the first place.
 *
 * Nothing downstream catches it. The first step is shared: `Math.round(NaN)` is
 * NaN and `zigzag(NaN)` is NaN, so `writeVarint` pushes NaN — and
 * `Uint8Array.from` **coerces that to 0**. The bytes are therefore non-empty and
 * the empty-stroke guard below does not fire. What lands in the document from
 * there depends on how much of the run was spoilt, and both shapes were run
 * with this guard removed rather than argued from the source:
 *
 * - **Every sample** — the transform case, and the common one. Every comparison
 *   in the packer's bbox loop is false against NaN, so the box is stored at the
 *   `±Infinity` it was seeded with: four separate breaches of invariant 1. On
 *   bare cork it is worse again, because `inkTileKey` is then handed
 *   `(Infinity + -Infinity) / 2` and the stroke is filed under the tile
 *   `"NaN,NaN"`, where nothing will ever look for it and from which nothing can
 *   evict it.
 * - **One sample, at an end of the run.** The packer deltas each point against
 *   the last, so a single NaN poisons `px`/`py` and *every* delta after it is
 *   NaN too — all of them coerced to zero. A forty-sample stroke stores as
 *   eight bytes and unpacks to two points at the origin, while the bbox was
 *   measured off the real coordinates and knows nothing about it. That is
 *   invariant 7: a box that contains no point in the stroke it belongs to.
 *
 * A NaN in the *middle* of a run is the one shape that is harmless, and only by
 * accident: the simplify ranks points by `chordError`, `NaN > worst` is false,
 * so the bad sample loses every comparison and is dropped as an unremarkable
 * interior point. It is not a case worth having, and this guard takes it too.
 *
 * An *infinite* sample is worse and is why this runs before the pack rather
 * than checking the packer's output: `writeVarint` divides by 128 until the
 * value drops below 128, and Infinity never does. It is an unbounded loop
 * pushing NaN into an array, inside a pen-up, on the main thread.
 *
 * The **whole run** goes, not the offending sample. Partly because a mark with
 * a point missing out of the middle is a movement the hand did not make, and
 * partly because of the provenance above: a bad transform does not produce one
 * bad sample among good ones, it produces nothing but bad samples, and a rule
 * that salvages three points out of four hundred would be dressing that up as a
 * stroke. Skipped rather than coerced for `createItems`' reason — nothing
 * refers to a stroke that does not exist yet, so refusing costs only the mark,
 * and the caller already reads the returned list rather than assuming it
 * matches the input one for one.
 *
 * `size`, `opacity` and `seed` are checked too. They are written to the map
 * unexamined a few lines below, and invariant 1 is about every number in the
 * document rather than about the interesting ones.
 */
function writable(input: CommitStrokeInput): boolean {
  if (!Number.isFinite(input.size)) return false;
  if (input.opacity !== undefined && !Number.isFinite(input.opacity)) return false;
  if (input.seed !== undefined && !Number.isFinite(input.seed)) return false;
  for (const sample of input.samples) {
    if (!Number.isFinite(sample.x)) return false;
    if (!Number.isFinite(sample.y)) return false;
    if (!Number.isFinite(sample.pressure)) return false;
  }
  return true;
}

/**
 * An item's strokes map, or null when there is not one to write to.
 *
 * Null is an item that has gone while the pointer was down, and an item written
 * by a version of this application that predates the strokes map or by a peer
 * that broke it. Skipped, never repaired — a read that heals the document causes
 * write storms in a shared session (DATA-MODEL section 8.1), and this one would
 * fire on every pen-up.
 */
function strokesOfItem(board: BoardDoc, itemId: string): Y.Map<YMap> | null {
  const item = board.items.get(itemId);
  if (!item) return null;
  const map = item.get("strokes");
  return map instanceof Y.Map ? (map as Y.Map<YMap>) : null;
}

/**
 * A tile's strokes map, created on first use.
 *
 * Created here and never anywhere else, which is what keeps "a tile exists"
 * and "a tile has ink in it" the same statement — so the binding can mirror a
 * tile going empty as the tile disappearing, and the renderer never mounts a
 * canvas for a bucket somebody once drew in and then undid.
 *
 * Two peers drawing into the same fresh tile concurrently both create a map and
 * one of the two wins, taking the loser's stroke with it. That is a real hole
 * and it is the document's, not this function's: DATA-MODEL section 8.1's
 * janitor is where nested-map contention gets resolved, and it is Phase 7 work
 * (T-77). Locally there is one writer and no race at all.
 */
function tileMap(board: BoardDoc, key: string): Y.Map<YMap> {
  const existing = board.boardInk.get(key);
  if (existing) return existing;
  const created = new Y.Map<YMap>();
  board.boardInk.set(key, created);
  return created;
}

/**
 * Remove whole records.
 *
 * > **Erasing deletes stroke records.** Ink is never rasterised and flattened;
 * > that would destroy both undo and merge. — DATA-MODEL section 6.2
 *
 * One transaction for the batch, because a stroke eraser dragged across four
 * marks is one thing the user did. `Origin.LOCAL_USER` rather than
 * `INK_COMMIT`: the origins are both tracked and the difference is only what the
 * entry is called, but "one stroke, one entry" is a statement about drawing, and
 * a rub-out that took four strokes should undo as the one gesture it was.
 */
export function deleteStrokes(
  board: BoardDoc,
  itemId: string,
  strokeIds: readonly string[],
): void {
  if (strokeIds.length === 0) return;
  mutate(board, Origin.LOCAL_USER, () => {
    const item = board.items.get(itemId);
    if (!item) return;
    const strokes = item.get("strokes");
    if (!(strokes instanceof Y.Map)) return;
    for (const id of strokeIds) (strokes as Y.Map<YMap>).delete(id);
  });
}

/**
 * The same, for ink on the cork.
 *
 * Separate from `deleteStrokes` rather than a branch inside it, because the one
 * thing this has to do that the item path does not is **take the tile with the
 * last stroke in it**. A bucket exists only because somebody drew in it
 * (`tileMap` is the only thing that creates one), and an empty one left behind
 * is a mount candidate with nothing in it on every peer that loads the board.
 *
 * Both in one transaction, so undo brings the bucket and its contents back
 * together and no peer ever observes a tile that is present and empty.
 */
export function deleteBoardStrokes(
  board: BoardDoc,
  tileKey: string,
  strokeIds: readonly string[],
): void {
  if (strokeIds.length === 0) return;
  mutate(board, Origin.LOCAL_USER, () => {
    const tile = board.boardInk.get(tileKey);
    if (!tile) return;
    for (const id of strokeIds) tile.delete(id);
    if (tile.size === 0) board.boardInk.delete(tileKey);
  });
}

/** The highest `z` among the strokes already on one surface, or null for the
 *  first one. One item or one tile — never the board — see `commitStroke`. */
function topStroke(strokes: Y.Map<YMap>): string | null {
  let highest: string | null = null;
  for (const [, stroke] of strokes) {
    const z = stroke.get("z");
    if (typeof z !== "string") continue;
    if (highest === null || z > highest) highest = z;
  }
  return highest;
}
