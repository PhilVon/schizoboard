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
import { newId } from "@/crdt/ids";
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
 * > Typical range is 0.05 to 0.3. — DATA-MODEL section 5.2
 *
 * Near the bottom of that: a new string should read as a line drawn between
 * two things with a little weight in it, and the drape is something you add.
 */
export const DEFAULT_SLACK = 0.12;

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
  // brown cork vibrates unpleasantly. The same default `readString` falls back
  // to, written down explicitly so a string carries its own colour rather than
  // inheriting whatever the reader's default happens to be next year.
  map.set("color", input.color ?? "#a8322c");
  map.set("thickness", Math.max(0.5, input.thickness ?? 3));
  map.set("material", input.material ?? "string");
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

/** Set every gap at once — `Alt`+wheel, and the `1`-`9` presets. */
export function setStringSlack(board: BoardDoc, stringId: string, slack: number): void {
  mutate(board, Origin.LOCAL_USER, () => {
    const nodes = nodesOf(board, stringId);
    if (!nodes) return;
    const value = clampSlack(slack);
    for (const node of nodes) node.set("slackAfter", value);
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
