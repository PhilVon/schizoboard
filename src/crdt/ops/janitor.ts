/**
 * Compaction — the write half of DATA-MODEL section 8.1's janitor.
 *
 * > Repairing on read causes write storms in a shared session — every client
 * > racing to fix the same inconsistency — and makes undo incoherent. Instead,
 * > a single elected client (lowest present client id) compacts a few seconds
 * > later under a maintenance origin that undo doesn't track. — section 8.1
 *
 * `crdt/janitor.ts` owns the election and the "few seconds later"; this owns the
 * transaction, because a document mutation belongs in `crdt/ops/` and nowhere
 * else (ARCHITECTURE section 1, rule 1). Splitting them is what lets the policy
 * be tested with a clock nobody has to wait for, and this be tested with no
 * clock at all.
 *
 * ## Why there is a second check inside the transaction
 *
 * The caller decided what to collect from a document it read some milliseconds
 * ago, and in a shared session the interesting thing that can happen in between
 * is the pin coming back — an undo of the deletion that stranded the string, or
 * simply a peer's update arriving in the other order. Re-reading inside the
 * transaction is the same discipline T-53 settled on for concurrent segment
 * insertion, and it is cheap: the strings named are a handful, not the board.
 *
 * The cost of getting it wrong is asymmetric and that is the whole argument.
 * Collecting a string a moment too late costs nothing — it stays invisible until
 * the next pass. Collecting one a moment too early destroys a record under an
 * origin undo does not track, so there is no way back.
 */

import { mutate, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { isRenderableString, readString, type YMap } from "@/crdt/schema";

/**
 * Delete the named strings, but only the ones still beyond repair.
 *
 * Returns the ids actually collected, which is what a caller reports and what a
 * test asserts on — a count would hide the case this function exists for, which
 * is the string that was saved between the decision and the write.
 */
export function collectStrings(board: BoardDoc, stringIds: readonly string[]): string[] {
  if (stringIds.length === 0) return [];
  return mutate(board, Origin.JANITOR, () => {
    const pinIds = new Set(board.pins.keys());
    const collected: string[] = [];
    for (const id of stringIds) {
      const map = board.strings.get(id);
      if (map === undefined) continue;
      const read = readString(id, map as YMap);
      // Unreadable is not "beyond repair" — it is a record this version of the
      // schema does not understand, which section 8.1's tolerance is aimed
      // squarely at. A janitor that deleted what it could not parse would be a
      // forward-compatibility bug that only shows up as data loss.
      if (read === null) continue;
      if (isRenderableString(read.nodes, pinIds)) continue;
      board.strings.delete(id);
      collected.push(id);
    }
    return collected;
  });
}
