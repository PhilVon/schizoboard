/**
 * String operations.
 *
 * > **The string is the product.** It's the thing the name is about.
 * > Everything else — items, pins, ink — is in service of getting string
 * > between things. — DESIGN section 1.3
 *
 * A string is an ordered run of **nodes**, each holding a reference to a pin
 * and the slack in the gap that follows it. Not a list of pins with a parallel
 * list of slack values, and D-5 is emphatic about why:
 *
 * > The obvious model — `pins: Y.Array<pinId>` plus `slack: Y.Array<number>` —
 * > desynchronises the instant two clients insert at different indices. The
 * > arrays end up different lengths, with slack values attached to the wrong
 * > gaps, and there is no way to recover the intent. — DATA-MODEL section 5.1
 *
 * Making each element a `Y.Map` that carries its own reference *and* its own
 * slack makes concurrent insertion correct by construction: whatever order two
 * peers' inserts land in, every slack value is still welded to the gap it was
 * authored for. Nothing in this file has to think about it again.
 *
 * A node holds a **reference** to a pin rather than being one, which is the
 * whole of hub pins: any number of nodes, across any number of strings, may
 * name the same pin and none of them knows about the others.
 *
 * ## Slack is a ratio (AC-66)
 *
 * ```
 * restLength(i) = chord(P_i, P_i+1) * (1 + slackAfter_i)
 * ```
 *
 * There is no length in this file, and there is nowhere in the schema to put
 * one. A number of board units would be wrong twice over: it would have to be
 * rewritten every time either pin moved — physics writing to the document,
 * which DESIGN section 5.1 forbids outright — and the mid-string split would
 * have to do arithmetic to avoid changing the sag, which as a ratio it gets
 * for nothing (DATA-MODEL section 5.2).
 *
 * Every slack that enters the document goes through `clampSlack`, because a
 * rest length equal to the chord leaves the solver no slack to absorb error
 * and the rope jitters visibly. That is invariant 2, and it is enforced on the
 * way in rather than checked on the way out.
 *
 * ## The terminal node's slack (AC-67)
 *
 * > `slackAfter` on the terminal node of an open string is unused and
 * > undefined. When `closed` is `true` it becomes the wrap-around segment.
 * > State this explicitly or someone will write a bug against it.
 * > — DATA-MODEL section 5.2
 *
 * So: **the last node of an open string has a `slackAfter` and it means
 * nothing.** It is written, it is a valid number, and no reader may use it.
 * `sim/ropes.ts` builds `nodes.length - 1` segments for an open run and reads
 * slack only from the node each segment starts at, so the value is simply
 * never asked for. Closing the string is what gives it a meaning, and it
 * acquires one without being rewritten — which is the point of storing it
 * anyway rather than leaving a hole.
 */

import * as Y from "yjs";

import { freshId, mutate, type BoardDoc } from "@/crdt/doc";
import { DEFAULT_STRING_MATERIAL } from "@/lib/material";
import { DEFAULT_STRING_COLOR, DEFAULT_STRING_THICKNESS } from "@/lib/palette";
import { DEFAULT_SLACK, splitSlack } from "@/lib/slack";
import { newId } from "@/crdt/ids";
import { writePoses, type Pose } from "@/crdt/ops/items";
import { buildPin } from "@/crdt/ops/pins";
import { Origin } from "@/crdt/origins";
import {
  MIN_SLACK,
  readStringNodes,
  type StringLayer,
  type StringMaterial,
  type YMap,
} from "@/crdt/schema";

/**
 * The slack a string gets when nobody has said otherwise.
 *
 * Re-exported rather than declared, because `state/tools/select.ts` needs the
 * same number — a double-click on a segment "snaps between taut and default
 * slack" (DESIGN section 3.4) — and a tool may not import `crdt/`. So the
 * definition sits in `lib/slack.ts`, which anything may import, and this is the
 * name the ops and their tests have always known it by.
 *
 * The other direction round from `MIN_SLACK`, which `lib/slack.ts` mirrors from
 * `crdt/schema.ts` under test rather than importing; `lib/slack.ts` says why the
 * two constants are not the same kind of thing.
 */
export { DEFAULT_SLACK };

/**
 * Invariant 2, enforced on the way in.
 *
 * Also the door that keeps `NaN` out of the schema — a slack that fails every
 * comparison would propagate into a rest length, into a particle position, and
 * out to every peer as a rope that has left the board.
 */
export function clampSlack(slack: number): number {
  return Number.isFinite(slack) ? Math.max(MIN_SLACK, slack) : DEFAULT_SLACK;
}

export interface CreateStringInput {
  /** The ordered run. Two or more, or there is no string to make. */
  pins: readonly string[];
  /** Uniform starting slack, or one value per node. */
  slack?: number | readonly number[];
  color?: string;
  thickness?: number;
  material?: StringMaterial;
  layer?: StringLayer;
  closed?: boolean;
  createdBy?: number;
  createdAt?: number;
}

/** One node. Not exported as an op — a node outside a string is nothing. */
function buildNode(pin: string, slack: number): YMap {
  const node = new Y.Map<unknown>();
  node.set("nodeId", newId());
  node.set("pin", pin);
  node.set("slackAfter", clampSlack(slack));
  return node;
}

/** Builds the map. Caller supplies the transaction — cascades need to
 *  compose, and the string tool creates a pin and a string together. */
export function buildString(
  board: BoardDoc,
  input: CreateStringInput,
): { id: string; map: YMap } | null {
  if (input.pins.length < 2) return null;

  const id = freshId(board.strings);
  const map = new Y.Map<unknown>();
  const nodes = new Y.Array<YMap>();
  const slackAt = (i: number): number =>
    Array.isArray(input.slack) ? (input.slack[i] ?? DEFAULT_SLACK) : (input.slack as number ?? DEFAULT_SLACK);
  nodes.push(input.pins.map((pin, i) => buildNode(pin, slackAt(i))));

  map.set("nodes", nodes);
  // The cotton red of DESIGN section 4.6, not a pure red — saturated red on
  // brown cork vibrates unpleasantly. Written onto the string explicitly, so it
  // carries its own colour rather than inheriting whatever the reader's
  // fallback happens to be next year. `lib/palette.test.ts` holds the two
  // together, the same arrangement `DEFAULT_SLACK` already has.
  map.set("color", input.color ?? DEFAULT_STRING_COLOR);
  map.set("thickness", Math.max(0.5, input.thickness ?? DEFAULT_STRING_THICKNESS));
  // Plain string, written out for the same reason the colour is — see above.
  // `lib/material.test.ts` holds this and the reader's fallback together.
  map.set("material", input.material ?? DEFAULT_STRING_MATERIAL);
  map.set("layer", input.layer ?? "over");
  map.set("closed", input.closed ?? false);
  map.set("createdBy", input.createdBy ?? 0);
  map.set("createdAt", input.createdAt ?? Date.now());
  return { id, map };
}

/** A new string through an existing run of pins. Returns its id, or `null`
 *  if there were not two pins to run it through. */
export function createString(board: BoardDoc, input: CreateStringInput): string | null {
  return mutate(board, Origin.LOCAL_USER, () => {
    const built = buildString(board, input);
    if (!built) return null;
    board.strings.set(built.id, built.map);
    return built.id;
  });
}

/**
 * One stop on a run being drawn: a pin that already exists, or a place to push
 * a new one in.
 *
 * The second case is DESIGN section 3.4's fast path — "click an item rather
 * than a pin while stringing" and "click empty cork" — expressed as data, so
 * that the tool can hold a whole run of them before any of it is written down.
 */
export type StringAnchor =
  | { readonly pin: string }
  | { readonly parent: string | null; readonly lx: number; readonly ly: number };

/**
 * Where a segment was cut, as pure geometry — everything `lib/slack.ts`'s
 * `splitSlack` needs *except* the segment's own slack.
 *
 * That omission is the point. These four numbers are things only the caller can
 * know: three chord lengths measured off the scene, and the arc-length fraction
 * the cursor was at. The fifth input is the slack the segment already had,
 * which is document state and is therefore read in the transaction that writes
 * it rather than passed in from a gesture that started seconds ago — see
 * `insertPinIntoString` and DATA-MODEL section 5.4.
 */
export interface SegmentSplit {
  /** Chord of the segment being split, board units. */
  readonly chord: number;
  /** Chord from the segment's first pin to the new one. */
  readonly first: number;
  /** Chord from the new pin to the segment's second. */
  readonly second: number;
  /** Arc-length fraction along the original segment, 0 at its start. */
  readonly t: number;
}

/**
 * Make a string through a run of anchors, pushing in whatever pins the run
 * needs on the way.
 *
 * **One transaction for the run and every pin it created.** A four-click run
 * that made three pins is one thing the user did, so it is one undo entry and
 * one update on the wire — the same argument `createItems` makes for pasting
 * twenty photographs at once, and the same argument `cascade.ts` makes for
 * deletions. Without it, undoing a string would leave its pins behind as
 * litter nobody asked for.
 *
 * It is also what lets `state/tools/string.ts` exist without ever seeing an id.
 * A tool's writes are queued to phase 9, so a tool that had to name the pin it
 * just created could not: the id does not exist yet when the next click
 * arrives. Handing over the whole run at once removes the question.
 *
 * `settle` is `insertPinIntoString`'s argument, plural: a run can push a pin
 * into several items, and each one that had a single pin has stopped hanging by
 * the end of it. Their drawn poses land in this same transaction, so the run,
 * its pins and the paper they went into are one undo entry.
 */
export function createStringThrough(
  board: BoardDoc,
  anchors: readonly StringAnchor[],
  input: Omit<CreateStringInput, "pins"> = {},
  settle?: ReadonlyMap<string, Pose>,
): string | null {
  if (anchors.length < 2) return null;
  return mutate(board, Origin.LOCAL_USER, () => {
    if (settle) writePoses(board, settle);
    const pins: string[] = [];
    for (const anchor of anchors) {
      if ("pin" in anchor) {
        // A node naming a pin that has since gone would be dropped on read
        // anyway; skipping it here keeps the run contiguous instead.
        if (board.pins.has(anchor.pin)) pins.push(anchor.pin);
        continue;
      }
      const { id, map } = buildPin(board, anchor);
      board.pins.set(id, map);
      pins.push(id);
    }
    const built = buildString(board, { ...input, pins });
    if (!built) return null;
    board.strings.set(built.id, built.map);
    return built.id;
  });
}

/** The nodes array of a string, or `null` if the string is gone or malformed. */
function nodesOf(board: BoardDoc, stringId: string): Y.Array<YMap> | null {
  const map = board.strings.get(stringId);
  if (!map) return null;
  const nodes = map.get("nodes");
  return nodes instanceof Y.Array ? (nodes as Y.Array<YMap>) : null;
}

/**
 * Extend a run by one pin — the string tool's main verb, one click at a time.
 *
 * The slack of the gap this creates is taken from the node that now precedes
 * it, so a run built click by click keeps the drape it started with rather
 * than resetting to the default halfway along.
 */
export function appendStringNode(
  board: BoardDoc,
  stringId: string,
  pin: string,
  slack?: number,
): string | null {
  return mutate(board, Origin.LOCAL_USER, () => {
    const nodes = nodesOf(board, stringId);
    if (!nodes) return null;
    const previous = nodes.length > 0 ? nodes.get(nodes.length - 1) : undefined;
    const inherited = typeof previous?.get("slackAfter") === "number"
      ? (previous.get("slackAfter") as number)
      : DEFAULT_SLACK;
    const node = buildNode(pin, slack ?? inherited);
    nodes.push([node]);
    return node.get("nodeId") as string;
  });
}

/**
 * Put a node into the middle of a run, at `index`, so the run reads
 * `... P_(index-1), P_new, P_index ...`.
 *
 * `slackBefore` is what the *preceding* node's gap becomes and `slackAfter`
 * what the new node's gap is. Both are the caller's to compute, because
 * getting them right is geometry:
 *
 * > when the string splits at that point, the slack must split proportionally
 * > so the two new segments together sag exactly as the original did. Get this
 * > wrong and the string visibly jumps at the moment of insertion, which reads
 * > unmistakably as a bug. — DESIGN section 3.4
 *
 * That arithmetic needs both pins' world positions, which needs item
 * transforms, and it lands with T-47. Omitting them copies the parent gap's
 * slack to both halves, which is wrong by exactly the jump DESIGN describes —
 * correct only for a split at the midpoint of a straight segment. It is the
 * honest default: a caller that has not thought about the split gets a visible
 * artefact rather than a subtly wrong sag that nobody notices for a month.
 */
export function insertStringNode(
  board: BoardDoc,
  stringId: string,
  index: number,
  pin: string,
  slackBefore?: number,
  slackAfter?: number,
): string | null {
  return mutate(board, Origin.LOCAL_USER, () => {
    const nodes = nodesOf(board, stringId);
    if (!nodes) return null;
    const at = Math.max(0, Math.min(index, nodes.length));
    const previous = at > 0 ? nodes.get(at - 1) : undefined;
    const parent = typeof previous?.get("slackAfter") === "number"
      ? (previous.get("slackAfter") as number)
      : DEFAULT_SLACK;

    const node = buildNode(pin, slackAfter ?? parent);
    nodes.insert(at, [node]);
    if (previous) previous.set("slackAfter", clampSlack(slackBefore ?? parent));
    return node.get("nodeId") as string;
  });
}

/**
 * Push a pin into the middle of a run — the headline gesture, written down.
 *
 * > A new pin is born at that point on the string, free-floating, and follows
 * > your cursor. The string now runs *through* it — you're physically pulling
 * > a loop of string out to a new position. — DESIGN section 3.4
 *
 * One transaction for the pin and the node, like `createStringThrough` and for
 * the same two reasons: a tool never learns the id of a pin it just made, and
 * pulling a loop of string out is one thing the user did, so undoing it must
 * not leave a pin behind in the cork.
 *
 * `split` is geometry and a gesture, and it is the caller's because only the
 * caller knows where the pins actually are — chords live in the scene, which
 * `crdt/` may not read. Getting it wrong is the one visible failure this
 * gesture has (DESIGN section 3.4, AC-18).
 *
 * What the caller does **not** supply is the segment's own slack, and that is
 * the whole of DATA-MODEL section 5.4:
 *
 * > Read the prior state **inside** the transaction.
 *
 * The two halves used to arrive already divided, which meant they were divided
 * against whatever the segment's slack was when the *gesture began*. That is a
 * long time ago: the loop is picked up on pointer-down, dropped some seconds
 * later, and `app/main.ts` then queues the write to run at the next flush. A
 * peer who re-slacks that segment anywhere in that window had their value
 * silently overwritten by arithmetic that never saw it. So the division moved
 * in here, where `previous.get("slackAfter")` is read in the same transaction
 * that writes it and the two cannot disagree.
 *
 * It does not make concurrent splits of the *same* segment conflict-free —
 * nothing can, and 5.4 says so:
 *
 * > Accept the one-time sag change in this rare conflict. The result is always
 * > valid; it just sags slightly differently than either user expected.
 *
 * The window shrinks from a whole gesture to the instant of the transaction,
 * which is as far as a CRDT can take it.
 *
 * `settle` is the same argument `deletePins` takes, and it is here for the
 * mirror-image reason. An item that had one pin and now has two has stopped
 * hanging, so the swing and the drift it was drawn with cease to exist — and
 * the pin this writes was placed against exactly those. Its rendered pose,
 * written inside this transaction, is what keeps the paper and the pin still at
 * the moment the transients stop applying, and keeps it one undo entry. It
 * comes from the caller for the same reason the slack does.
 */
export function insertPinIntoString(
  board: BoardDoc,
  stringId: string,
  index: number,
  anchor: StringAnchor,
  split: SegmentSplit,
  settle?: ReadonlyMap<string, Pose>,
): string | null {
  return mutate(board, Origin.LOCAL_USER, () => {
    const nodes = nodesOf(board, stringId);
    if (!nodes) return null;
    if (settle) writePoses(board, settle);

    let pin: string;
    if ("pin" in anchor) {
      if (!board.pins.has(anchor.pin)) return null;
      pin = anchor.pin;
    } else {
      const built = buildPin(board, anchor);
      board.pins.set(built.id, built.map);
      pin = built.id;
    }

    const at = Math.max(0, Math.min(index, nodes.length));
    // Read the parent's slack before anything is written, so the division and
    // the write it feeds see one state — DATA-MODEL section 5.4.
    const previous = at > 0 ? nodes.get(at - 1) : undefined;
    const parent =
      typeof previous?.get("slackAfter") === "number"
        ? (previous.get("slackAfter") as number)
        : DEFAULT_SLACK;
    const [before, after] = splitSlack(split.chord, parent, split.first, split.second, split.t);

    nodes.insert(at, [buildNode(pin, after)]);
    if (previous) previous.set("slackAfter", clampSlack(before));
    return pin;
  });
}

/**
 * Drop nodes from a run, and delete the string if too little of it is left.
 *
 * > A string left with fewer than two valid nodes deletes itself.
 * > — DATA-MODEL section 5.3 (invariant 3)
 *
 * One transaction including that deletion, so undo restores the whole string
 * rather than an empty husk of one.
 *
 * Merging the slack of the two gaps either side of a removed middle node is
 * T-47, for the same reason the split is: it is geometry. `cascade.ts` says
 * the same thing about the pin-deletion path, which is the other way nodes
 * leave a string.
 */
export function removeStringNodes(
  board: BoardDoc,
  stringId: string,
  nodeIds: ReadonlySet<string>,
): void {
  if (nodeIds.size === 0) return;
  mutate(board, Origin.LOCAL_USER, () => {
    const nodes = nodesOf(board, stringId);
    if (!nodes) return;
    // Backwards: deleting by index while walking forwards renumbers
    // everything after the deletion.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const nodeId = nodes.get(i)?.get("nodeId");
      if (typeof nodeId === "string" && nodeIds.has(nodeId)) nodes.delete(i, 1);
    }
    if (readStringNodes(nodes).length < 2) board.strings.delete(stringId);
  });
}

/**
 * Set the slack of one gap — the wheel over a segment (DESIGN section 3.4).
 *
 * Addressed by the id of the node the gap *starts* at, not by index: an index
 * computed on one frame and written on the next is an index a concurrent
 * insert may have moved, and it would silently adjust the wrong gap.
 */
export function setNodeSlack(
  board: BoardDoc,
  stringId: string,
  nodeId: string,
  slack: number,
): void {
  mutate(board, Origin.LOCAL_USER, () => {
    const nodes = nodesOf(board, stringId);
    if (!nodes) return;
    for (const node of nodes) {
      if (node.get("nodeId") === nodeId) {
        node.set("slackAfter", clampSlack(slack));
        return;
      }
    }
  });
}

/**
 * Multiply one gap's slack — the wheel over a segment (DESIGN section 3.4).
 *
 * A factor rather than a value, which is not merely symmetry with
 * `scaleStringSlack` below. The alternative is the tool reading the current
 * slack out of the scene mirror and writing back the product, and a tool's
 * writes are queued to phase 9: the read is one frame older than the write every
 * time, so a roll of the wheel would be a run of edits each computed from a
 * value the previous one had already replaced. Rolling steadily would move the
 * sag by one notch and then stop. Handing over the factor and letting the
 * document compound it is the only version that adds up.
 *
 * It buys nothing at all against a *peer* rolling the same wheel, and it is
 * worth being clear about that: this writes an absolute `slackAfter` in the end,
 * and a `Y.Map` field is last-write-wins, so two people adjusting one gap at
 * once converge on one of the two answers rather than on the product. That is
 * the right resolution for a scalar — the alternative is a gap whose slack is
 * neither person's — and it is why the concurrency D-5 worries about is
 * insertion rather than adjustment.
 */
export function scaleNodeSlack(
  board: BoardDoc,
  stringId: string,
  nodeId: string,
  factor: number,
): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  mutate(board, Origin.LOCAL_USER, () => {
    const nodes = nodesOf(board, stringId);
    if (!nodes) return;
    for (const node of nodes) {
      if (node.get("nodeId") !== nodeId) continue;
      const current = node.get("slackAfter");
      node.set(
        "slackAfter",
        clampSlack((typeof current === "number" ? current : DEFAULT_SLACK) * factor),
      );
      return;
    }
  });
}

/**
 * Set every gap of every one of these strings to the same value — the `1`-`9`
 * presets (DESIGN section 3.4).
 *
 * Absolute rather than relative, and uniform, because that is what a preset
 * *is*: pressing `1` means taut, whatever the run happened to look like before,
 * and pressing it twice means the same thing twice. It is also the one verb here
 * that deliberately discards the unequal ratios a mid-string split left behind
 * — see `scaleStringSlack` for the one that must not.
 *
 * Takes a run of ids so that a preset applied to a multiple selection is one
 * transaction and therefore one undo entry.
 *
 * An array and not the `Iterable<string>` that `setStringStyle` and
 * `deleteStrings` take, because a bare string id *is* an `Iterable<string>` — of
 * its own characters — so `setStringSlack(board, id, 0.5)` type-checks and then
 * quietly looks up three strings called `"s"`, `"1"` and `"2"`. An array rejects
 * it where it is written instead.
 */
export function setStringSlack(
  board: BoardDoc,
  stringIds: readonly string[],
  slack: number,
): void {
  mutate(board, Origin.LOCAL_USER, () => {
    const value = clampSlack(slack);
    for (const stringId of stringIds) {
      const nodes = nodesOf(board, stringId);
      if (!nodes) continue;
      for (const node of nodes) node.set("slackAfter", value);
    }
  });
}

/**
 * Multiply every gap of every one of these strings — `Alt`+wheel.
 *
 * > | Adjust the whole string | `Alt`+wheel | All segments together |
 * > — DESIGN section 3.4
 *
 * "Together" is the word that makes this a different op from `setStringSlack`
 * rather than a caller of it. A run that has had a pin pulled out of its middle
 * has deliberately unequal ratios — `lib/slack.ts`'s split gives the short
 * chord the large ratio and the long one the small, which is what stops the sag
 * jumping at the instant of insertion — and setting them all to one value would
 * throw that away on the first notch of the wheel. Scaling adds drape to the
 * whole run and leaves its shape alone.
 *
 * A factor rather than a set of values because slack is a ratio and no geometry
 * is involved: unlike the split, this needs no chords, so there is nothing here
 * for the caller to compute and no reason for `crdt/` to be handed a map.
 *
 * The clamp bites asymmetrically and that is correct rather than merely
 * tolerable: scaling a run down far enough pins its slackest gaps to the floor
 * along with its tightest, so scaling back up does not restore the shape. There
 * is no more string to pay back out — the run went taut, which is a thing that
 * happens to real string and is not recoverable by turning the wheel the other
 * way either.
 */
export function scaleStringSlack(
  board: BoardDoc,
  stringIds: readonly string[],
  factor: number,
): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  mutate(board, Origin.LOCAL_USER, () => {
    for (const stringId of stringIds) {
      const nodes = nodesOf(board, stringId);
      if (!nodes) continue;
      for (const node of nodes) {
        const current = node.get("slackAfter");
        node.set("slackAfter", clampSlack((typeof current === "number" ? current : DEFAULT_SLACK) * factor));
      }
    }
  });
}

export interface StringStyle {
  color?: string;
  thickness?: number;
  material?: StringMaterial;
  /** `'over'` draws above items and collides with them; `'under'` passes
   *  behind and does not — DESIGN section 6.2's "tuck behind". */
  layer?: StringLayer;
  /** Loops the last node back to the first, which is what gives the terminal
   *  node's `slackAfter` a meaning. */
  closed?: boolean;
}

/** Restyle strings — colour, thickness, material, layer, closed. */
export function setStringStyle(
  board: BoardDoc,
  stringIds: Iterable<string>,
  style: StringStyle,
): void {
  mutate(board, Origin.LOCAL_USER, () => {
    for (const id of stringIds) {
      const map = board.strings.get(id);
      if (!map) continue;
      if (style.color !== undefined) map.set("color", style.color);
      if (style.thickness !== undefined) map.set("thickness", Math.max(0.5, style.thickness));
      if (style.material !== undefined) map.set("material", style.material);
      if (style.layer !== undefined) map.set("layer", style.layer);
      if (style.closed !== undefined) map.set("closed", style.closed);
    }
  });
}

/**
 * Cut strings.
 *
 * > String removed; its pins stay where they are. — DESIGN section 3.4
 *
 * Which is the whole op: a string owns nothing but its nodes, and a node owns
 * nothing but a reference. Pins outlive the strings through them exactly as
 * they outlive the items they were pushed into.
 */
export function deleteStrings(board: BoardDoc, stringIds: Iterable<string>): void {
  mutate(board, Origin.LOCAL_USER, () => {
    for (const id of stringIds) board.strings.delete(id);
  });
}

/** Which strings run through a pin — the reverse of a node's reference, and
 *  what "hover a pin and every string through it highlights" needs. */
export function stringsThroughPin(board: BoardDoc, pinId: string): string[] {
  const out: string[] = [];
  for (const [stringId, map] of board.strings) {
    const nodes = map.get("nodes");
    if (!(nodes instanceof Y.Array)) continue;
    for (const node of nodes as Y.Array<YMap>) {
      if (node.get("pin") === pinId) {
        out.push(stringId);
        break;
      }
    }
  }
  return out;
}
