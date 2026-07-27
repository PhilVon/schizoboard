/**
 * Cascades.
 *
 * > **Every cascade runs in a single transaction, or undo is not atomic.**
 * > — docs/DATA-MODEL.md section 8
 *
 * Nothing in here opens a transaction of its own. Each function is a *step*,
 * called from inside an op's `mutate()`, so that deleting an item and healing
 * the strings that ran through its pins is one entry in the undo stack and one
 * update on the wire. Half a cascade is worse than none: undo would restore
 * half a board.
 */

import type * as Y from "yjs";

import type { BoardDoc } from "@/crdt/doc";
import { readItem, readPin, readStringNodes, type YMap } from "@/crdt/schema";
import { mergeSlack } from "@/lib/slack";
import { rotateIn, rotateOut } from "@/lib/rotate";

/**
 * Remove every node referencing one of `pinIds` from every string, merging the
 * segments either side of a removed *middle* node, and delete any string that
 * drops below two nodes.
 *
 * > the neighbouring segments merge, with rest lengths summed and converted
 * > back to a ratio against the new chord — DATA-MODEL section 5.3
 *
 * The merge is the inverse of the split a mid-string insertion does
 * (`lib/slack.ts`), and it is the difference between a string that heals and
 * one that *snaps*: without it the surviving node keeps only its own
 * `slackAfter` and the other gap's rest length is thrown away, so pulling a pin
 * out of a draped run hauls the whole thing tight. Measured at up to 74 screen
 * pixels of lift on an ordinary board — T-131.
 *
 * Only a middle node merges. A node removed from either *end* of an open run
 * takes its gap with it, which is right: that length of string went with the
 * pin, and the run simply starts or stops one stop sooner. A closed run has no
 * ends, so every node in it is a middle one.
 *
 * ## Why the geometry is read here rather than passed in
 *
 * The merge needs the chords — the distances between the surviving pins — and
 * a chord is a question about where pins *are*, which for a parented pin means
 * its item's pose. Every bit of that is in the document, so this reads it from
 * the document (`pinWorldPosition`) rather than taking it from a caller. That
 * matters because removal is reached from three places and only one of them is
 * a gesture: a pin deleted, an item deleted taking its pins with it, and a
 * janitor sweep. A number handed in by one caller would be absent in the other
 * two, and a cascade that only conserves sag when a human pressed the key is
 * not a cascade.
 *
 * Positions are read **before** anything is deleted, which is why every caller
 * runs this before dropping the pins themselves.
 */
export function removePinsFromStrings(board: BoardDoc, pinIds: ReadonlySet<string>): void {
  if (pinIds.size === 0) return;

  const doomed: string[] = [];

  for (const [stringId, stringMap] of board.strings) {
    const nodes = stringMap.get("nodes");
    if (!nodes || typeof (nodes as Y.Array<YMap>).length !== "number") continue;
    const array = nodes as Y.Array<YMap>;

    healSlack(board, array, stringMap.get("closed") === true, pinIds);

    // Walk backwards: deleting by index while iterating forwards renumbers
    // everything after the deletion.
    for (let i = array.length - 1; i >= 0; i--) {
      const pin = array.get(i)?.get("pin");
      if (typeof pin === "string" && pinIds.has(pin)) array.delete(i, 1);
    }

    // "A string left with fewer than two valid nodes deletes itself."
    if (readStringNodes(array).length < 2) doomed.push(stringId);
  }

  for (const id of doomed) board.strings.delete(id);
}

/**
 * Give each surviving node the slack of the whole stretch it is about to
 * inherit — run before the doomed nodes are deleted, while the geometry is
 * still readable.
 *
 * Walks the run once. Every surviving node opens a stretch; each doomed node
 * after it folds its gap into that stretch with `mergeSlack`, against a running
 * chord that is only there to carry the rest length along — the *last* fold is
 * the one told the real new chord, and every fold conserves rest length
 * exactly, so the intermediate value cannot drift. A stretch that swallowed
 * nothing is left alone: its two ends have not moved, so neither has its sag.
 */
function healSlack(
  board: BoardDoc,
  array: Y.Array<YMap>,
  closed: boolean,
  doomed: ReadonlySet<string>,
): void {
  const count = array.length;
  if (count < 2) return;

  /** Node index → its pin's board position, or null if it cannot be placed. */
  const at: ({ x: number; y: number } | null)[] = [];
  const gone: boolean[] = [];
  for (let i = 0; i < count; i++) {
    const pin = array.get(i)?.get("pin");
    const id = typeof pin === "string" ? pin : null;
    at.push(id === null ? null : pinWorldPosition(board, id));
    gone.push(id !== null && doomed.has(id));
  }

  const span = (a: number, b: number): number | null => {
    const p = at[a];
    const q = at[b];
    return p && q ? Math.hypot(q.x - p.x, q.y - p.y) : null;
  };
  const slackOf = (i: number): number | null => {
    const value = array.get(i)?.get("slackAfter");
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  // Gaps run from a node to the next one; a closed run has one more, from the
  // last node back to the first.
  const gaps = closed ? count : count - 1;

  for (let i = 0; i < count; i++) {
    if (gone[i]) continue;

    // How far this stretch reaches: past every doomed node in front of it.
    let steps = 1;
    while (steps < gaps && gone[(i + steps) % count]) steps++;
    if (steps === 1) continue;
    // An open run stops at its end rather than wrapping — the stretch would run
    // off the end of the string, and those gaps are simply gone.
    if (!closed && i + steps >= count) continue;

    const end = (i + steps) % count;
    const chord = span(i, end);
    let accChord = span(i, (i + 1) % count);
    let accSlack = slackOf(i);
    if (chord === null || accChord === null || accSlack === null) continue;

    let broken = false;
    for (let k = 1; k < steps; k++) {
      const from = (i + k) % count;
      const nextChord = span(from, (from + 1) % count);
      const nextSlack = slackOf(from);
      if (nextChord === null || nextSlack === null) {
        broken = true;
        break;
      }
      const last = k === steps - 1;
      accSlack = mergeSlack(accChord, accSlack, nextChord, nextSlack, last ? chord : accChord + nextChord);
      accChord = last ? chord : accChord + nextChord;
    }
    // A pin that has gone missing takes the chord with it, and a slack guessed
    // from half a run would be worse than the one already written down.
    if (broken) continue;

    array.get(i)?.set("slackAfter", accSlack);
  }
}

/**
 * Where a pin actually is, in board coordinates.
 *
 * A pin whose parent has vanished "renders as free-floating at its last known
 * board position, computed locally with no write" (DATA-MODEL section 8.1) —
 * so a missing parent resolves to the stored coordinates rather than to an
 * error. Invariant 5.
 */
export function pinWorldPosition(board: BoardDoc, pinId: string): { x: number; y: number } | null {
  const pinMap = board.pins.get(pinId);
  if (!pinMap) return null;
  const pin = readPin(pinId, pinMap);
  if (!pin) return null;
  if (pin.parent === null) return { x: pin.lx, y: pin.ly };

  const itemMap = board.items.get(pin.parent);
  const item = itemMap ? readItem(pin.parent, itemMap) : null;
  if (!item) return { x: pin.lx, y: pin.ly };
  return localToBoard(pin.lx, pin.ly, item.x, item.y, item.rot);
}

/** Every pin currently parented to one of these items. */
export function pinsOfItems(board: BoardDoc, itemIds: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const [pinId, pin] of board.pins) {
    const parent = pin.get("parent");
    if (typeof parent === "string" && itemIds.has(parent)) out.add(pinId);
  }
  return out;
}

/**
 * Rotate a point out of an item's local frame into board coordinates.
 *
 * Pins parented to an item store un-rotated local coordinates, which is what
 * makes rotating an item transport its pins for free. Un-parenting has to
 * undo that.
 *
 * The arithmetic is `lib/rotate.ts`, which is where the sign convention lives;
 * these two are the ops-shaped door onto it — they take an angle rather than
 * its trig, and they hand back the field names their callers store.
 */
export function localToBoard(
  lx: number,
  ly: number,
  itemX: number,
  itemY: number,
  itemRot: number,
): { x: number; y: number } {
  return rotateOut(lx, ly, itemX, itemY, Math.cos(itemRot), Math.sin(itemRot));
}

export function boardToLocal(
  x: number,
  y: number,
  itemX: number,
  itemY: number,
  itemRot: number,
): { lx: number; ly: number } {
  const local = rotateIn(x, y, itemX, itemY, Math.cos(itemRot), Math.sin(itemRot));
  return { lx: local.x, ly: local.y };
}
