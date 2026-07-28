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

import * as Y from "yjs";

import { mutate, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { isRenderableString, readString, type YMap } from "@/crdt/schema";

/** What one pass actually did. Two lists rather than a count, because the whole
 *  point of the re-check below is that some of what it was asked to do turns
 *  out not to want doing. */
export interface Swept {
  /** Strings deleted outright — fewer than two nodes resolve to a pin. */
  readonly collected: readonly string[];
  /** Strings that kept their shape and lost a dead node. */
  readonly pruned: readonly string[];
}

const NOTHING: Swept = Object.freeze({ collected: Object.freeze([]), pruned: Object.freeze([]) });

/**
 * Compact the named strings, each in whichever of the two ways it turns out to
 * need — and only if it still needs it.
 *
 * The caller hands over one list because both kinds of decay want the same
 * settle period (`crdt/invariants.ts`'s `compactableStrings`); which one a
 * string is, is a question about the document *now* and so is answered here.
 *
 * ## Dropping a node from a string that still draws
 *
 * The node points at a pin that is gone, so nothing draws it: the run already
 * closes up around it and hangs from the surviving pin either side. Removing it
 * is therefore invisible — the segment the renderer builds before and after is
 * the same segment, over the same two pins, carrying the same `slackAfter` off
 * the same surviving node. That equality is not a coincidence to be re-derived
 * whenever this changes; it is the reason `sim/ropes.ts` inherits the slack of
 * the node a gap *starts* at and merges nothing into it.
 *
 * So no slack is merged here either, and it is worth saying why not, because
 * the pin cascade in `crdt/ops/cascade.ts` very deliberately does merge. That
 * merge needs the chords either side of the departing pin, and it runs *before*
 * the pin is deleted, while there is still a position to measure. Here the pin
 * went some time ago on another machine. There is no chord to conserve, and a
 * rest length guessed from half a run would be worse than the one already
 * written down — which is exactly the case `healSlack` bails out of.
 *
 * A pruned string cannot fall below two nodes: only nodes that resolve to
 * nothing are dropped, and it had at least two that resolve or it would have
 * been collected instead. Invariant 3 survives by construction.
 *
 * ## What is lost, and the bound on it
 *
 * Undo does not track `Origin.JANITOR`, so undoing the pin deletion afterwards
 * brings the pin back and the node does not come with it: the pin returns with
 * no string through it. That is a real loss and it is the same one section 8.1
 * already accepted for a whole string — bounded by the settle period, so what
 * goes is never something anyone could still see. Before this runs the node
 * draws nothing; after it, the string draws exactly what it drew before.
 */
export function compactStrings(board: BoardDoc, stringIds: readonly string[]): Swept {
  if (stringIds.length === 0) return NOTHING;
  return mutate(board, Origin.JANITOR, () => {
    const pinIds = new Set(board.pins.keys());
    const collected: string[] = [];
    const pruned: string[] = [];
    for (const id of stringIds) {
      const map = board.strings.get(id);
      if (map === undefined) continue;
      const read = readString(id, map as YMap);
      // Unreadable is not "beyond repair" — it is a record this version of the
      // schema does not understand, which section 8.1's tolerance is aimed
      // squarely at. A janitor that deleted what it could not parse would be a
      // forward-compatibility bug that only shows up as data loss.
      if (read === null) continue;

      if (!isRenderableString(read.nodes, pinIds)) {
        board.strings.delete(id);
        collected.push(id);
        continue;
      }

      const nodes = map.get("nodes");
      if (!(nodes instanceof Y.Array)) continue;
      const array = nodes as Y.Array<YMap>;
      // Against the array and not against `read.nodes`, which is not the same
      // list: `readStringNodes` drops a node whose `pin` or `nodeId` is
      // malformed, so its indices are the array's only while every node is
      // well-formed. Deleting by an index off that list would take a live node
      // out of somebody's string.
      //
      // Which also settles what to do about a malformed node, and it is
      // nothing. It is not a dangling reference, it is a record this build does
      // not understand — the same thing as the unreadable string above, and
      // section 8.1's tolerance is aimed at both.
      let dropped = 0;
      for (let i = array.length - 1; i >= 0; i--) {
        const pin = array.get(i)?.get("pin");
        if (typeof pin !== "string") continue;
        if (pinIds.has(pin)) continue;
        array.delete(i, 1);
        dropped += 1;
      }
      if (dropped > 0) pruned.push(id);
    }
    return { collected, pruned };
  });
}
