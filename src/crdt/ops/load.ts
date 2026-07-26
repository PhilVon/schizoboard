/**
 * Replaying the document from disk.
 *
 * An op like any other, for the reason rule 1 exists: applying a stored update
 * is a document mutation, and a mutation outside `crdt/ops/` is a transaction
 * whose origin nobody registered. This one's origin matters more than most —
 * `Origin.LOAD` is untracked, so the first Ctrl+Z of a session cannot undo the
 * board into existence, and `crdt/persistence.ts` uses the same tag to tell its
 * own replay apart from an edit and not write back every frame it just read.
 *
 * The frames are opaque here as well as in Rust. Nothing in this file knows
 * what an item is; it hands bytes to Yjs in the order they were written.
 */

import * as Y from "yjs";

import { mutate, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";

/**
 * Apply stored frames, snapshot first, in one transaction.
 *
 * One transaction rather than one per frame because the binding is downstream
 * of this: fifty frames applied separately are fifty rounds of observers and
 * fifty scene resyncs to arrive at a board nobody has seen yet.
 *
 * Throws if a frame is not a Yjs update. That is deliberate and the caller is
 * expected to treat it as fatal for persistence — a document that only half
 * decoded must not then be snapshotted back over the half that did (AC-146).
 */
export function applyPersisted(board: BoardDoc, frames: readonly Uint8Array[]): void {
  const present = frames.filter((frame) => frame.byteLength > 0);
  if (present.length === 0) return;
  mutate(board, Origin.LOAD, () => {
    for (const frame of present) Y.applyUpdate(board.doc, frame, Origin.LOAD);
  });
}
