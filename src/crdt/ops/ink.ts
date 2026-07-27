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
 * ## Board ink is not written yet
 *
 * DATA-MODEL section 2 tiles bare-cork strokes into `boardInk`, and `doc.ts`
 * already has the map and the tile key for it. Nothing renders it, and this file
 * therefore refuses to write it: `commitStroke` with no item returns null and
 * does nothing.
 *
 * That looks over-cautious and is not. This codebase already carried three
 * writes with no reader — `boardInk` unobserved, `item.strokes` created by every
 * item and read by nothing, `dirty.ink` with neither producer nor consumer — and
 * every one of them cost somebody an afternoon working out whether the feature
 * was half-built or merely half-wired. A fourth, where a stroke drawn on cork
 * lands in the document and silently never appears, would be worse than a stroke
 * that is honestly discarded. T-61 renders board ink; T-58 decides what the
 * marker does about the cork in the meantime.
 */

import * as Y from "yjs";

import type { BoardDoc } from "@/crdt/doc";
import { freshId, mutate } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import type { YMap } from "@/crdt/schema";
import { keyAbove } from "@/crdt/zindex";
import type { InkSample, InkTool } from "@/lib/ink";
import { newSeed } from "@/lib/seed";
import { packStroke } from "@/lib/strokepack";

export interface CommitStrokeInput {
  /**
   * The item the samples are local to. **Null is not written** — see the note at
   * the top of the file.
   */
  item: string | null;
  tool: InkTool;
  color: string;
  /** Board units, which are the item's local units too — the same scale. */
  size: number;
  /** 0 to 1; the highlighter's translucency. Defaults to opaque. */
  opacity?: number;
  seed?: number;
  /** In the space `item` names — `state/tools/marker.ts` decided which at
   *  pen-down and has been converting into it ever since. */
  samples: readonly InkSample[];
}

/**
 * Write one stroke. Returns its id, or null when there was nothing worth
 * keeping.
 *
 * Null covers three cases that are all the same case: no item, an item that has
 * gone, and a gesture whose samples packed to no bytes. The last is a click
 * rather than a stroke, and `lib/strokepack.ts` deliberately does not throw on
 * it — deciding a click is not worth committing belongs here, to the caller that
 * knows a pointer was involved.
 *
 * `bbox` is the packer's rather than measured here, which is what makes
 * invariant 7 — "a stroke's `bbox` always contains its unpacked points" — true
 * by construction: the same function that decided where the points ended up
 * measured the box round them.
 */
export function commitStroke(board: BoardDoc, input: CommitStrokeInput): string | null {
  if (input.item === null) return null;
  const packed = packStroke(input.samples);
  if (packed.pts.length === 0) return null;

  const itemId = input.item;
  return mutate(board, Origin.INK_COMMIT, () => {
    const item = board.items.get(itemId);
    if (!item) return null;
    const map = item.get("strokes");
    // An item written by a version of this application that predates the strokes
    // map, or by a peer that broke it. Skipped, never repaired — a read that
    // heals the document causes write storms in a shared session (DATA-MODEL
    // section 8.1), and this one would fire on every pen-up.
    if (!(map instanceof Y.Map)) return null;

    const id = freshId(map as Y.Map<YMap>);
    const stroke = new Y.Map<unknown>();
    stroke.set("tool", input.tool);
    stroke.set("color", input.color);
    stroke.set("size", input.size);
    stroke.set("opacity", input.opacity ?? 1);
    stroke.set("seed", input.seed ?? newSeed());
    // Above every stroke already on this item, not on the board: an item's ink
    // stacks within the item, and two people annotating two photographs have no
    // ordering to argue about.
    stroke.set("z", keyAbove(topStroke(map as Y.Map<YMap>)));
    stroke.set("bbox", [...packed.bbox]);
    stroke.set("pts", packed.pts);
    (map as Y.Map<YMap>).set(id, stroke as YMap);
    return id;
  });
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

/** The highest `z` among an item's existing strokes, or null for the first one.
 *  Scans the item's ink rather than the board's — see `commitStroke`. */
function topStroke(strokes: Y.Map<YMap>): string | null {
  let highest: string | null = null;
  for (const [, stroke] of strokes) {
    const z = stroke.get("z");
    if (typeof z !== "string") continue;
    if (highest === null || z > highest) highest = z;
  }
  return highest;
}
