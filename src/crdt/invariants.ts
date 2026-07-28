/**
 * The nine invariants of DATA-MODEL section 13, as a function.
 *
 * > The fuzz harness (Risk 3 in `DESIGN.md`) runs two documents through
 * > randomised concurrent operation sequences and asserts all of these after
 * > every merge. — docs/DATA-MODEL.md section 13
 *
 * This is the assertion half of that sentence; `tests/fuzz.test.ts` is the
 * randomised half. Split because they fail differently: a harness that finds
 * nothing is a harness nobody can tell from a harness that checks nothing, and
 * the only cure is a checker that can be pointed at a hand-built document and
 * shown to fire.
 *
 * ## Why it reads raw values and not the schema readers
 *
 * `crdt/schema.ts`'s readers coerce by policy — section 8.1's "dangling and
 * malformed data is tolerated and rendered gracefully, never repaired on read".
 * `readItem` turns a `NaN` width into `MIN_ITEM_SIZE` and a missing `slackAfter`
 * into `DEFAULT_SLACK`. Both are right for a renderer and fatal for a checker:
 * invariants 1, 2 and 6 are statements about *what is stored*, and asking them
 * through a reader that repairs on the way past is a test that cannot fail.
 *
 * So the structural invariants go straight at the `Y.Map`. The two that are
 * about *resolution* rather than storage — 4 and 5, a dangling reference that
 * has to degrade rather than break — necessarily go through the readers, because
 * degrading gracefully is the property being asserted.
 *
 * ## It never throws and never writes
 *
 * A checker that throws on the first problem finds one problem per run, and a
 * fuzz run that has found one thing wrong usually has more to say. Every check
 * appends to a list and carries on. And nothing here mutates: a checker that
 * repaired what it found would be the write storm section 8.1 exists to forbid,
 * and would hide the next occurrence from itself.
 */

import * as Y from "yjs";

import { pinWorldPosition } from "@/crdt/ops/cascade";
import {
  isRenderableString,
  readItem,
  readString,
  readStroke,
  type YMap,
} from "@/crdt/schema";
import { compareOrder, isOrderKey } from "@/crdt/zindex";
import { unpackStroke } from "@/lib/strokepack";
import type { BoardDoc } from "@/crdt/doc";

/**
 * One thing that is wrong, and enough to find it again.
 *
 * `path` is a document path — `items/k3f9a2.w`, `strings/p1.nodes[2].slackAfter`
 * — because a fuzz failure is read once, at the top of a stack trace, by
 * somebody who has to locate the record before they can think about it.
 */
export interface Violation {
  /** Which of section 13's nine. */
  readonly invariant: number;
  readonly path: string;
  readonly detail: string;
}

/** The one-line form, which is what a failing expectation prints. */
export function describe(violations: readonly Violation[]): string {
  return violations
    .map((v) => `  [${v.invariant}] ${v.path}: ${v.detail}`)
    .join("\n");
}

/**
 * Invariants 1 to 9's single-document half, against one board.
 *
 * The order-agrees half of 9 needs two documents and is [`checkConverged`].
 */
export function checkInvariants(board: BoardDoc): Violation[] {
  const out: Violation[] = [];
  const pinIds = new Set(board.pins.keys());

  checkFinite(board, out);
  checkItems(board, out);
  checkStrings(board, pinIds, out);
  checkPins(board, out);
  checkStrokes(board, out);
  return out;
}

// --- 1. no numeric field is NaN or infinite --------------------------------

/**
 * Every number anywhere in the document, whatever it is called.
 *
 * A walk rather than a list of fields, and that is the point: the failure this
 * catches is a value arriving somewhere nobody thought to look, and an
 * enumeration only ever checks the places somebody already worried about. It
 * costs a traversal of the whole document per merge, which is affordable
 * precisely because a fuzz board is small.
 */
function checkFinite(board: BoardDoc, out: Violation[]): void {
  for (const [name, root] of roots(board)) walkNumbers(root, name, out);
}

function roots(board: BoardDoc): [string, unknown][] {
  return [
    ["items", board.items],
    ["pins", board.pins],
    ["strings", board.strings],
    ["assets", board.assets],
    ["boardInk", board.boardInk],
    ["meta", board.meta],
  ];
}

function walkNumbers(value: unknown, path: string, out: Violation[]): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      out.push({ invariant: 1, path, detail: `is ${String(value)}` });
    }
    return;
  }
  // Packed ink. Every byte in it is finite by construction and there can be
  // thousands per stroke, so walking one is a long way to prove nothing.
  if (ArrayBuffer.isView(value)) return;
  // A `Y.Text` holds no numbers, and asking it for its content per merge is the
  // one traversal here that is not free.
  if (value instanceof Y.Text) return;
  if (value instanceof Y.Map) {
    for (const [key, inner] of value.entries()) walkNumbers(inner, `${path}/${key}`, out);
    return;
  }
  if (value instanceof Y.Array) {
    value.toArray().forEach((inner, i) => walkNumbers(inner, `${path}[${i}]`, out));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((inner, i) => walkNumbers(inner, `${path}[${i}]`, out));
    return;
  }
  // A plain object inside a `Y.Map` — `crop`, and `bbox` when it was written as
  // one. Anything with a prototype of its own is not ours and is left alone.
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, inner] of Object.entries(value)) walkNumbers(inner, `${path}.${key}`, out);
  }
}

// --- 6 and 9's validity half -----------------------------------------------

function checkItems(board: BoardDoc, out: Violation[]): void {
  for (const [id, map] of board.items.entries()) {
    // 6 — merging never produces an item with zero or negative dimensions.
    // Read raw: `readItem` clamps to `MIN_ITEM_SIZE`, which is the renderer
    // being forgiving and would make this assertion unfailable.
    for (const field of ["w", "h"] as const) {
      const size = map.get(field);
      if (typeof size !== "number" || !(size > 0)) {
        out.push({
          invariant: 6,
          path: `items/${id}.${field}`,
          detail: `is ${JSON.stringify(size)}, wanted a number greater than zero`,
        });
      }
    }

    // 9 — every `z` key is a valid fractional index.
    const z = map.get("z");
    if (typeof z !== "string" || z.length === 0) {
      out.push({
        invariant: 9,
        path: `items/${id}.z`,
        detail: `is ${JSON.stringify(z)}, wanted a non-empty string`,
      });
    } else if (!isOrderKey(z)) {
      out.push({
        invariant: 9,
        path: `items/${id}.z`,
        detail: `${JSON.stringify(z)} is not a key fractional-indexing will accept, so nothing can ever be stacked next to it`,
      });
    }
  }
}

// --- 2, 3 and 4 ------------------------------------------------------------

function checkStrings(board: BoardDoc, pinIds: ReadonlySet<string>, out: Violation[]): void {
  for (const [id, map] of board.strings.entries()) {
    const nodes = map.get("nodes");
    if (!(nodes instanceof Y.Array)) {
      out.push({
        invariant: 3,
        path: `strings/${id}.nodes`,
        detail: "is not a Y.Array, so this string has no nodes at all",
      });
      continue;
    }

    // 2 — every `slackAfter` is greater than zero. Raw, for `checkItems`'
    // reason: `readStringNodes` substitutes `DEFAULT_SLACK` for anything it
    // does not like, so a missing or negative value never reaches a reader.
    nodes.toArray().forEach((node, i) => {
      if (!(node instanceof Y.Map)) {
        out.push({
          invariant: 3,
          path: `strings/${id}.nodes[${i}]`,
          detail: "is not a Y.Map",
        });
        return;
      }
      const slack = node.get("slackAfter");
      if (typeof slack !== "number" || !(slack > 0)) {
        out.push({
          invariant: 2,
          path: `strings/${id}.nodes[${i}].slackAfter`,
          detail: `is ${JSON.stringify(slack)}, wanted a number greater than zero`,
        });
      }
    });

    const read = readString(id, map as YMap);
    if (read === null) {
      out.push({
        invariant: 3,
        path: `strings/${id}`,
        detail: "survives but does not read as a string at all",
      });
      continue;
    }

    // 3 — no string survives with fewer than two valid nodes, where "valid"
    // means resolving to a pin. `isRenderableString` is the schema's own answer
    // to "is this still a string", so asking it here is what keeps the invariant
    // and the code that maintains it from drifting apart.
    //
    // **No cascade maintains this and none can.** T-76's fuzz harness found two
    // ways to break it, both now pinned in `fuzz.test.ts`, and both the same
    // shape: a guard evaluated against one document cannot constrain the union
    // of two. What maintains it is `crdt/janitor.ts`, a few seconds later, which
    // is what section 8.1 says the answer is. So this check is only satisfiable
    // on a board the janitor has been allowed to run on — which is what the
    // harness gives it, and what the application does every second.
    if (!isRenderableString(read.nodes, pinIds)) {
      const resolved = read.nodes.filter((node) => pinIds.has(node.pin)).length;
      out.push({
        invariant: 3,
        path: `strings/${id}`,
        detail: `survives with ${read.nodes.length} node(s) of which ${resolved} resolve to a pin, wanted at least 2 — the janitor has not collected it`,
      });
    }

    // 4 — every node's `pin` either resolves or is skipped cleanly at render.
    // A dangling node is *allowed*: the second half of this invariant is that
    // the string it is in still renders, which is invariant 3 above. What is
    // checked here is the part that is not implied — that the reference is at
    // least a string, so the renderer's `pins.has(node.pin)` is a lookup and not
    // an accident.
    read.nodes.forEach((node, i) => {
      if (typeof node.pin !== "string" || node.pin.length === 0) {
        out.push({
          invariant: 4,
          path: `strings/${id}.nodes[${i}].pin`,
          detail: `is ${JSON.stringify(node.pin)}, which resolves to nothing and is not skippable either`,
        });
      }
    });
  }
}

/**
 * Invariant 3's work-list, because invariant 3 is not an assertion.
 *
 * > 3. No string survives with fewer than two valid nodes. — section 13
 *
 * That is true of every cascade and false of every merge, and the fuzz harness
 * found both ways in its first run. Neither is a bug in a cascade; both are the
 * same shape, which is that a guard evaluated against one document cannot
 * constrain the union of two:
 *
 *   - **Two peers each reduce a string to the legal minimum.** A four-node run;
 *     one peer removes two nodes and correctly keeps the string at two, the
 *     other deletes a pin whose cascade removes a third. Both checked, both were
 *     right, and the merge takes all three removals and leaves one node.
 *   - **A string is tied to a pin somebody else is deleting.** Three operations.
 *     The pin cascade heals every string it can see and cannot see one that does
 *     not exist on that peer yet, so the node survives pointing at nothing — and
 *     nothing will ever remove it, because the cascade that would have has
 *     already run.
 *
 * No local check fixes either. Section 8.1 already says so and already names the
 * answer, which is not a check at all:
 *
 *   > Repairing on read causes write storms in a shared session — every client
 *   > racing to fix the same inconsistency — and makes undo incoherent. Instead,
 *   > a single elected client (lowest present client id) compacts a few seconds
 *   > later under a maintenance origin that undo doesn't track.
 *
 * That janitor is not built. So this returns what it would collect rather than
 * pretending the invariant holds: asserting it today would be asserting that the
 * janitor exists, and asserting it in a weakened form would be a check that
 * passes for the wrong reason. What the harness does with this number is
 * *report* it.
 *
 * `isRenderableString` is the schema's own answer to "is this still a string",
 * documented against this very invariant — and until this function it was wired
 * to nothing at all, which is its own small piece of evidence about how far the
 * invariant had been taken.
 */
export function unrepairableStrings(board: BoardDoc): string[] {
  const pinIds = new Set(board.pins.keys());
  const out: string[] = [];
  for (const [id, map] of board.strings.entries()) {
    const read = readString(id, map as YMap);
    // Not readable as a string at all is a different thing, and is invariant 3's
    // one genuinely structural case — reported above rather than here.
    if (read === null) continue;
    if (!isRenderableString(read.nodes, pinIds)) out.push(id);
  }
  return out;
}

// --- 5 ---------------------------------------------------------------------

/**
 * Every pin's `parent` either resolves or the pin renders free-floating.
 *
 * Asserted as "`pinWorldPosition` hands back a finite point", because that is
 * what "renders free-floating" cashes out to — a dangling parent is not an
 * error, it means the stored `lx`/`ly` are read as board coordinates instead of
 * item-local ones (`crdt/ops/cascade.ts`). Through the reader on purpose, and
 * the one place in this file where that is right: what is being asserted is
 * that the graceful path exists and produces a number.
 */
function checkPins(board: BoardDoc, out: Violation[]): void {
  for (const id of board.pins.keys()) {
    const at = pinWorldPosition(board, id);
    if (at === null) {
      out.push({
        invariant: 5,
        path: `pins/${id}`,
        detail: "has no world position at all, so it can be neither parented nor free",
      });
      continue;
    }
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) {
      out.push({
        invariant: 5,
        path: `pins/${id}`,
        detail: `resolves to (${at.x}, ${at.y})`,
      });
    }
  }
}

// --- 7 and 8 ---------------------------------------------------------------

function checkStrokes(board: BoardDoc, out: Violation[]): void {
  for (const [itemId, item] of board.items.entries()) {
    const strokes = item.get("strokes");
    if (strokes instanceof Y.Map) {
      checkStrokeMap(strokes as Y.Map<YMap>, `items/${itemId}/strokes`, out);
    }
  }

  for (const [key, tile] of board.boardInk.entries()) {
    // 8 — cascades leave no orphaned strokes. Under an item there is nothing to
    // orphan: the strokes are nested inside the item's own map and go with it.
    // A tile is the case that can go wrong, because a tile is a sibling of the
    // ink in it rather than its owner — `crdt/ops/ink.ts` keeps "a tile exists"
    // and "a tile has ink in it" the same statement precisely so the binding can
    // mirror one as the other, and an empty tile breaks that equivalence: the
    // renderer mounts a canvas for a bucket somebody drew in and then undid.
    if (tile.size === 0) {
      out.push({
        invariant: 8,
        path: `boardInk/${key}`,
        detail: "is an empty tile, which is a canvas mounted for ink that is not there",
      });
      continue;
    }
    checkStrokeMap(tile, `boardInk/${key}`, out);
  }
}

function checkStrokeMap(map: Y.Map<YMap>, path: string, out: Violation[]): void {
  for (const [id, stroke] of map.entries()) {
    if (!(stroke instanceof Y.Map)) {
      out.push({ invariant: 8, path: `${path}/${id}`, detail: "is not a Y.Map" });
      continue;
    }
    const read = readStroke(id, stroke as YMap);
    // A stroke the reader refuses is one nothing will ever draw, which is the
    // orphan invariant 8 is about even though it still has a key.
    if (read === null) {
      out.push({
        invariant: 8,
        path: `${path}/${id}`,
        detail: "does not read as a stroke — no points, or no z key",
      });
      continue;
    }

    // 7 — a stroke's `bbox` always contains its unpacked points. Exactly, with
    // no epsilon: `packStroke` computes the box off the *quantised* values, so
    // the box and the points it describes are on the same grid by construction.
    // An epsilon here would hide the merge that replaced one and not the other.
    const [x0, y0, x1, y1] = read.bbox;
    for (const point of unpackStroke(read.pts)) {
      if (point.x < x0 || point.x > x1 || point.y < y0 || point.y > y1) {
        out.push({
          invariant: 7,
          path: `${path}/${id}.bbox`,
          detail: `is [${x0}, ${y0}, ${x1}, ${y1}] and does not contain (${point.x}, ${point.y})`,
        });
        break;
      }
    }
  }
}

// --- 9's other half --------------------------------------------------------

/**
 * The paint order of a document: every item id, in DATA-MODEL section 7's total
 * order.
 *
 * `(z, clientId, itemId)` and not `z` alone, because `z` alone is not a total
 * order — two peers can generate the same key even with the jitter, and the two
 * further fields are what both of them agree on (`crdt/zindex.ts`).
 */
export function paintOrder(board: BoardDoc): string[] {
  const ordered = [...board.items.entries()]
    .map(([id, map]) => {
      const item = readItem(id, map as YMap);
      return item === null ? null : { z: item.z, clientId: item.createdBy, id };
    })
    .filter((entry): entry is { z: string; clientId: number; id: string } => entry !== null);
  ordered.sort(compareOrder);
  return ordered.map((entry) => entry.id);
}

/**
 * Two documents that have seen each other's updates, compared.
 *
 * The second half of invariant 9 — "the total order is identical on both
 * documents" — plus the thing that has to be true for that question to mean
 * anything: that the two converged at all. Yjs guarantees convergence, which is
 * exactly why it is worth asserting: what this actually catches is a merge that
 * was never performed, or performed one way only, which would otherwise make
 * every other check in this file a check of one document twice.
 */
export function checkConverged(a: BoardDoc, b: BoardDoc): Violation[] {
  const out: Violation[] = [];

  const left = paintOrder(a);
  const right = paintOrder(b);
  if (left.length !== right.length || left.some((id, i) => id !== right[i])) {
    out.push({
      invariant: 9,
      path: "items",
      detail: `paint order differs\n    A: ${left.join(" ")}\n    B: ${right.join(" ")}`,
    });
  }

  // Everything else, field by field, through Yjs's own serialisation. Not an
  // encoded-state comparison: two documents can hold identical content and
  // different state vectors — a peer that saw the same updates in a different
  // order, or that has a tombstone the other has garbage collected — and that
  // difference is not a disagreement about the board.
  for (const [name, root] of roots(a)) {
    const other = roots(b).find(([n]) => n === name)![1];
    const one = JSON.stringify(json(root));
    const two = JSON.stringify(json(other));
    if (one !== two) {
      out.push({
        invariant: 9,
        path: name,
        detail: `did not converge\n    A: ${one}\n    B: ${two}`,
      });
    }
  }
  return out;
}

/** `toJSON` on a root, with `Uint8Array` rendered as something comparable. */
function json(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array((value as Uint8Array).buffer, (value as Uint8Array).byteOffset, (value as Uint8Array).byteLength));
  }
  if (value instanceof Y.Map) {
    const out: Record<string, unknown> = {};
    // Sorted, because a `Y.Map`'s iteration order is its own business and two
    // peers that inserted the same keys in a different order would otherwise
    // read as a disagreement about content.
    for (const key of [...value.keys()].sort()) out[key] = json(value.get(key));
    return out;
  }
  if (value instanceof Y.Array) return value.toArray().map(json);
  if (value instanceof Y.Text) return value.toString();
  if (Array.isArray(value)) return value.map(json);
  return value;
}
