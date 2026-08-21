/**
 * What the board is made of — T-408, Q-369.
 *
 * One op, and it is the first thing in this directory that writes to `meta`
 * rather than to one of the five keyed maps. That is what makes it worth its
 * own file: everything else here edits *what is on the cork*, and this edits
 * the cork.
 *
 * ## Absent is `natural`
 *
 * `sourceAbout`'s convention in `items.ts` and `WRITTEN_TIMER_MODES`' in
 * `timers.ts`, for the third time and the same reason: a key holding the
 * default on every board ever made is a key nobody can read anything from. So
 * choosing the cork we ship *deletes*, and an unpainted board puts nothing on
 * the wire and is byte-identical to one made before this existed.
 *
 * ## It does **not** raise the schema version, and that was a correction
 *
 * The plan for this task said it would, and `schema.ts` says why it must not:
 *
 * > Raise the baseline only for a change an older build cannot survive
 * > *reading* — never for one it merely does not use.
 *
 * A build that does not know `corkColor` opens a painted board and sees the
 * beige it always saw. Nothing is invisible, nothing is lost, nothing it does
 * damages the key, and compaction re-emits `meta` verbatim. That is the second
 * kind of change, not the first.
 *
 * The timer is the first kind and the contrast is the whole argument: an item
 * of an unknown *type* reads as null, is skipped by the binding, and is
 * therefore **invisible while remaining perfectly intact** — somebody can edit
 * around a thing they cannot see. A wrong-coloured wall is not that.
 *
 * Raising it anyway would have made 1.1.0 refuse to edit a board whose only
 * difference was being painted slate — a board going read-only over a cosmetic
 * key, which is exactly the over-reaction that sentence exists to prevent.
 */

import { mutate, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { corkColorOf, DEFAULT_CORK } from "@/lib/palette";

/**
 * Paint the cork, or put it back to what it was.
 *
 * The id is validated here rather than trusted, so nothing this build writes
 * can be an id it would not itself recognise — `corkColorOf` is total, so an
 * unknown id lands on the default and therefore on a delete. That is the same
 * shape `setTimerMode` has: the writer is ours and it writes only vocabulary we
 * have, while the *reader* tolerates whatever arrives (DATA-MODEL section 8.1).
 *
 * Last-write-wins, and it is a plain value for the reason D-73 gives about the
 * five timer fields: two people cannot meaningfully paint different halves of
 * one colour, and a merge between two choices would be the one answer neither
 * of them asked for.
 */
export function setCorkColor(board: BoardDoc, id: string | null): void {
  const chosen = id === null ? DEFAULT_CORK : corkColorOf(id);
  mutate(board, Origin.LOCAL_USER, () => {
    if (chosen.id === DEFAULT_CORK.id) board.meta.delete("corkColor");
    else board.meta.set("corkColor", chosen.id);
  });
}
