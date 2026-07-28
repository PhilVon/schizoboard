/**
 * The fuzz harness — two documents, randomised concurrent operations, and all
 * nine invariants after every merge.
 *
 * > **3 · The CRDT edge case nobody thought of.** *Mitigation:* a fuzz harness
 * > from day one — two documents, randomised concurrent operation sequences,
 * > assert every invariant after each merge. — DESIGN section 9.5, risk 3
 *
 * `crdt/invariants.ts` is the assertion half and this is the randomised half.
 * The point of the split is that a harness which finds nothing is
 * indistinguishable from a harness which checks nothing, so the checker is
 * unit-tested against hand-broken documents (`invariants.test.ts`) and this file
 * is only responsible for reaching states nobody thought to write down.
 *
 * ## Why it lives in `crdt/`
 *
 * Because merging two documents means `Y.applyUpdate`, and rule 1 of
 * ARCHITECTURE section 1 — enforced by `eslint.config.js` since T-87 — is that
 * nothing outside `crdt/` imports Yjs. `tests/sync-interop.test.ts` obeys the
 * same rule by going through `WireProvider`; there is no provider here, because
 * the wire is not what is under test.
 *
 * ## Reproducibility is the whole design
 *
 * A fuzz failure that cannot be replayed is a bug report with no repro, and this
 * codebase generates randomness in three places that have nothing to do with the
 * harness: `crdt/ids.ts` mints ids from `crypto.getRandomValues`, `createItems`
 * mints a seed the same way, and `crdt/zindex.ts` appends four random base-62
 * digits to every key it generates — which is *precisely* the mechanism whose
 * concurrent behaviour is interesting.
 *
 * So `crypto.getRandomValues` is replaced for the duration of a run by the same
 * seeded generator that picks the operations, and both documents are given fixed
 * client ids. A seed therefore reproduces a run exactly, down to which two z
 * keys collided — and `compareOrder`'s tie-break on client id, which is what
 * saves the total order when they do, is deterministic too.
 *
 * ## Fixed seeds, not a fresh one per run
 *
 * A harness that seeds itself from the clock fails on somebody else's machine
 * and passes on yours, and lands in CI as a flake that gets retried away. This
 * runs a fixed list, so a green run means the same thing every time and a red
 * one is red for everybody. `FUZZ_SEEDS=400` widens it for a soak; the seeds are
 * consecutive, so widening only ever adds runs and never renumbers the ones
 * already passing.
 *
 * ## What it deliberately does not do
 *
 * Feed the ops `NaN`, `Infinity` or ids that were never minted. Section 13's
 * sentence is about "randomised concurrent operation sequences" — the adversary
 * is concurrency, not a malformed caller. Several ops would take a non-finite
 * coordinate straight into the document (`createItems` does no finiteness check
 * and `Math.max(1, NaN)` is `NaN`), so a harness that fed them one would fail
 * invariant 1 on the first round, every round, and drown everything the merge
 * has to say. That gap is real and it is its own task.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { Binding } from "@/crdt/binding";
import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import {
  checkConverged,
  checkInvariants,
  describe as explain,
  unrepairableStrings,
} from "@/crdt/invariants";
import {
  appendStringNode,
  bringToFront,
  commitStroke,
  createItems,
  createPin,
  createStringThrough,
  deleteBoardStrokes,
  deleteItems,
  deletePins,
  deleteStrings,
  deleteStrokes,
  insertPinIntoString,
  insertStringNode,
  movePins,
  removeStringNodes,
  reparentPin,
  resizeItems,
  scaleNodeSlack,
  scaleStringSlack,
  sendToBack,
  setItemPoses,
  setNodeSlack,
  setStringSlack,
  setStringStyle,
  type StringAnchor,
} from "@/crdt/ops";
import { readString, type YMap } from "@/crdt/schema";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";

/**
 * `mulberry32`. Thirty-two bits of state, a period past four billion, and it
 * passes the tests a fuzz harness actually needs it to pass — which is that
 * consecutive seeds produce unrelated streams, so `FUZZ_SEEDS` widening the run
 * explores new ground rather than more of the same.
 */
class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(from: readonly T[]): T | null {
    return from.length === 0 ? null : from[this.int(from.length)]!;
  }

  /** A random subset of `from`, never empty when `from` is not. */
  some<T>(from: readonly T[], most = 3): T[] {
    if (from.length === 0) return [];
    const want = 1 + this.int(Math.min(most, from.length));
    const pool = [...from];
    const out: T[] = [];
    for (let i = 0; i < want; i += 1) out.push(...pool.splice(this.int(pool.length), 1));
    return out;
  }
}

/**
 * Point `crypto.getRandomValues` at the harness's own generator.
 *
 * Ids, item seeds and the z-key jitter all come through here, and all three
 * affect what a merge does — two peers whose jitter collides is the case
 * `compareOrder` exists for. Returns the undo, which the caller runs in a
 * `finally`: leaving a seeded `crypto` behind would make every test that runs
 * after this one quietly deterministic, and that is the kind of contamination
 * that shows up a fortnight later as a different file's flake.
 */
function seedCrypto(rng: Rng): () => void {
  const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  const stub = <T extends ArrayBufferView | null>(array: T): T => {
    if (array === null) return array;
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = rng.int(256);
    return array;
  };
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    value: stub,
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      value: real,
      configurable: true,
      writable: true,
    });
  };
}

const itemIds = (board: BoardDoc): string[] => [...board.items.keys()];
const pinIds = (board: BoardDoc): string[] => [...board.pins.keys()];
const stringIds = (board: BoardDoc): string[] => [...board.strings.keys()];

/** A coordinate anywhere on a board a person might plausibly have made. */
const coord = (rng: Rng): number => rng.range(-2000, 2000);

/**
 * One operation, named so a failure can say what happened rather than only what
 * is wrong.
 *
 * Each returns a short description of what it actually did, or `null` when the
 * document had nothing for it to act on — an early board has no strings to
 * restyle, and a run that spent half its operations on an empty board would be
 * half as long as it looks.
 */
interface Operation {
  readonly name: string;
  /**
   * How often this is chosen, relative to the others.
   *
   * Not uniform, and the harness's own self-check is what proved it could not
   * be: with every operation equally likely the board never held a single
   * string, because each destructive op removes up to three records and there
   * are as many of them as there are constructive ones. A fuzz run against an
   * empty board passes every invariant by having nothing to check. Creation is
   * weighted three to one so the population grows to something worth merging
   * and then stays there.
   */
  readonly weight: number;
  readonly run: (board: BoardDoc, rng: Rng) => string | null;
}

/** Chosen once, since the weights are constants. */
function weightedPick(rng: Rng): Operation {
  let ticket = rng.next() * TOTAL_WEIGHT;
  for (const op of OPERATIONS) {
    ticket -= op.weight;
    if (ticket < 0) return op;
  }
  return OPERATIONS[OPERATIONS.length - 1]!;
}

const OPERATIONS: readonly Operation[] = [
  {
    name: "createItems",
    weight: 4,
    run: (board, rng) => {
      const many = 1 + rng.int(3);
      const inputs = Array.from({ length: many }, () => ({
        type: rng.pick(["polaroid", "note", "scrap", "card"] as const)!,
        x: coord(rng),
        y: coord(rng),
        w: rng.range(20, 400),
        h: rng.range(20, 400),
        rot: rng.range(-Math.PI, Math.PI),
        withPin: rng.chance(0.7),
      }));
      return `createItems x${createItems(board, inputs).length}`;
    },
  },
  {
    name: "setItemPoses",
    weight: 3,
    run: (board, rng) => {
      const ids = rng.some(itemIds(board));
      if (ids.length === 0) return null;
      const poses = new Map(
        ids.map((id) => [id, { x: coord(rng), y: coord(rng), rot: rng.range(-Math.PI, Math.PI) }]),
      );
      setItemPoses(board, poses);
      return `setItemPoses ${ids.join(",")}`;
    },
  },
  {
    name: "resizeItems",
    weight: 2,
    run: (board, rng) => {
      const ids = rng.some(itemIds(board), 2);
      if (ids.length === 0) return null;
      const extents = new Map(
        ids.map((id) => [
          id,
          { x: coord(rng), y: coord(rng), w: rng.range(1, 500), h: rng.range(1, 500) },
        ]),
      );
      resizeItems(board, extents);
      return `resizeItems ${ids.join(",")}`;
    },
  },
  {
    name: "deleteItems",
    weight: 1,
    run: (board, rng) => {
      const ids = rng.some(itemIds(board), 2);
      if (ids.length === 0) return null;
      // Both halves of DESIGN section 3.8: `Delete` takes an item's pins with it
      // and heals the strings through them; `Shift`+`Delete` leaves the pins
      // free-floating, which is the path that converts their coordinates.
      const keepPins = rng.chance(0.35);
      deleteItems(board, ids, { keepPins });
      return `deleteItems${keepPins ? " keepPins" : ""} ${ids.join(",")}`;
    },
  },
  {
    name: "stack",
    weight: 2,
    run: (board, rng) => {
      const ids = rng.some(itemIds(board), 3);
      if (ids.length === 0) return null;
      // The z-key growth hazard DATA-MODEL section 7 names, and the one place
      // two peers reliably generate keys against the same neighbour.
      if (rng.chance(0.5)) {
        bringToFront(board, ids);
        return `bringToFront ${ids.join(",")}`;
      }
      sendToBack(board, ids);
      return `sendToBack ${ids.join(",")}`;
    },
  },
  {
    name: "createPin",
    weight: 4,
    run: (board, rng) => {
      const parent = rng.chance(0.6) ? rng.pick(itemIds(board)) : null;
      const id = createPin(board, {
        parent,
        lx: parent === null ? coord(rng) : rng.range(-150, 150),
        ly: parent === null ? coord(rng) : rng.range(-150, 150),
      });
      return `createPin ${id} parent=${parent ?? "cork"}`;
    },
  },
  {
    name: "movePins",
    weight: 2,
    run: (board, rng) => {
      const ids = rng.some(pinIds(board), 3);
      if (ids.length === 0) return null;
      movePins(board, new Map(ids.map((id) => [id, { lx: coord(rng), ly: coord(rng) }])));
      return `movePins ${ids.join(",")}`;
    },
  },
  {
    name: "reparentPin",
    weight: 2,
    run: (board, rng) => {
      const pin = rng.pick(pinIds(board));
      if (pin === null) return null;
      // Sometimes onto an item, sometimes into bare cork, and sometimes onto an
      // item id chosen before the other document deleted it — which is the
      // concurrent case invariant 5 is about.
      const parent = rng.chance(0.6) ? rng.pick(itemIds(board)) : null;
      reparentPin(board, pin, parent, coord(rng), coord(rng));
      return `reparentPin ${pin} -> ${parent ?? "cork"}`;
    },
  },
  {
    name: "deletePins",
    weight: 1,
    run: (board, rng) => {
      const ids = rng.some(pinIds(board), 2);
      if (ids.length === 0) return null;
      deletePins(board, ids);
      return `deletePins ${ids.join(",")}`;
    },
  },
  {
    name: "createStringThrough",
    weight: 4,
    run: (board, rng) => {
      const pins = pinIds(board);
      const many = 2 + rng.int(3);
      const anchors: StringAnchor[] = [];
      for (let i = 0; i < many; i += 1) {
        const existing = rng.chance(0.65) ? rng.pick(pins) : null;
        anchors.push(
          existing === null
            ? { parent: rng.chance(0.5) ? rng.pick(itemIds(board)) : null, lx: coord(rng), ly: coord(rng) }
            : { pin: existing },
        );
      }
      const id = createStringThrough(board, anchors, {
        slack: rng.range(0.02, 0.6),
        thickness: rng.pick([2, 3, 4.5, 6.5])!,
        material: rng.pick(["string", "yarn", "wire"] as const)!,
        layer: rng.pick(["over", "under"] as const)!,
        closed: rng.chance(0.2),
      });
      return `createStringThrough x${anchors.length} -> ${id ?? "nothing"}`;
    },
  },
  {
    name: "appendStringNode",
    weight: 2,
    run: (board, rng) => {
      const stringId = rng.pick(stringIds(board));
      const pin = rng.pick(pinIds(board));
      if (stringId === null || pin === null) return null;
      appendStringNode(board, stringId, pin, rng.range(0.02, 0.5));
      return `appendStringNode ${stringId} += ${pin}`;
    },
  },
  {
    name: "insertStringNode",
    weight: 2,
    run: (board, rng) => {
      const stringId = rng.pick(stringIds(board));
      const pin = rng.pick(pinIds(board));
      if (stringId === null || pin === null) return null;
      const index = rng.int(6);
      insertStringNode(board, stringId, index, pin);
      return `insertStringNode ${stringId} @${index} = ${pin}`;
    },
  },
  {
    name: "insertPinIntoString",
    weight: 2,
    run: (board, rng) => {
      const stringId = rng.pick(stringIds(board));
      if (stringId === null) return null;
      // DESIGN section 3.4's mid-string pin, with a plausible split: the two
      // half-chords have to add up to something like the whole one, or the
      // proportional slack division is being handed nonsense rather than a
      // geometry it can be wrong about.
      const chord = rng.range(40, 600);
      const t = rng.range(0.1, 0.9);
      const index = rng.int(5);
      insertPinIntoString(
        board,
        stringId,
        index,
        { parent: rng.chance(0.4) ? rng.pick(itemIds(board)) : null, lx: coord(rng), ly: coord(rng) },
        { chord, first: chord * t, second: chord * (1 - t), t },
      );
      return `insertPinIntoString ${stringId} @${index}`;
    },
  },
  {
    name: "removeStringNodes",
    weight: 1,
    run: (board, rng) => {
      const stringId = rng.pick(stringIds(board));
      if (stringId === null) return null;
      const map = board.strings.get(stringId);
      if (map === undefined) return null;
      const read = readString(stringId, map as YMap);
      if (read === null || read.nodes.length === 0) return null;
      const nodeIds = rng.some(read.nodes.map((node) => node.nodeId), 2);
      removeStringNodes(board, stringId, new Set(nodeIds));
      return `removeStringNodes ${stringId} -${nodeIds.length}`;
    },
  },
  {
    name: "slack",
    weight: 2,
    run: (board, rng) => {
      const stringId = rng.pick(stringIds(board));
      if (stringId === null) return null;
      const map = board.strings.get(stringId);
      const read = map === undefined ? null : readString(stringId, map as YMap);
      const node = read === null ? null : rng.pick(read.nodes);
      // All four of DESIGN section 3.4's slack controls, since the clamp at
      // `MIN_SLACK` is what invariant 2 rests on and each of them reaches it by
      // a different route.
      switch (rng.int(4)) {
        case 0:
          if (node === null) return null;
          setNodeSlack(board, stringId, node.nodeId, rng.range(-0.2, 0.8));
          return `setNodeSlack ${stringId}`;
        case 1:
          if (node === null) return null;
          scaleNodeSlack(board, stringId, node.nodeId, rng.range(0.05, 4));
          return `scaleNodeSlack ${stringId}`;
        case 2:
          setStringSlack(board, [stringId], rng.range(-0.2, 0.8));
          return `setStringSlack ${stringId}`;
        default:
          scaleStringSlack(board, [stringId], rng.range(0.05, 4));
          return `scaleStringSlack ${stringId}`;
      }
    },
  },
  {
    name: "setStringStyle",
    weight: 1,
    run: (board, rng) => {
      const ids = rng.some(stringIds(board), 2);
      if (ids.length === 0) return null;
      setStringStyle(board, ids, {
        color: rng.pick(["#a8322c", "#2c5aa8", "#4a7a4e", "#c9a227"])!,
        thickness: rng.pick([2, 3, 4.5, 6.5])!,
        material: rng.pick(["string", "yarn", "wire"] as const)!,
        layer: rng.pick(["over", "under"] as const)!,
      });
      return `setStringStyle ${ids.join(",")}`;
    },
  },
  {
    name: "deleteStrings",
    weight: 1,
    run: (board, rng) => {
      const ids = rng.some(stringIds(board), 2);
      if (ids.length === 0) return null;
      deleteStrings(board, ids);
      return `deleteStrings ${ids.join(",")}`;
    },
  },
  {
    name: "commitStroke",
    weight: 3,
    run: (board, rng) => {
      // On a photograph, or on bare cork — the second routes into a `boardInk`
      // tile, which is the nested map invariant 8 is about.
      const item = rng.chance(0.5) ? rng.pick(itemIds(board)) : null;
      const at = { x: coord(rng), y: coord(rng) };
      const samples = Array.from({ length: 2 + rng.int(8) }, (_, i) => ({
        x: at.x + i * rng.range(1, 12),
        y: at.y + i * rng.range(-8, 8),
        pressure: rng.next(),
      }));
      const done = commitStroke(board, {
        item,
        tool: rng.pick(["marker", "highlighter"] as const)!,
        color: "#1f1b17",
        size: rng.range(1, 12),
        samples,
      });
      return `commitStroke ${item ?? "cork"} -> ${done?.id ?? "nothing"}`;
    },
  },
  {
    name: "deleteStrokes",
    weight: 1,
    run: (board, rng) => {
      // The cork half is the one that can orphan: `deleteBoardStrokes` removes
      // the tile with its last stroke, and a tile is a sibling of its ink rather
      // than its owner.
      if (rng.chance(0.5)) {
        const tileKey = rng.pick([...board.boardInk.keys()]);
        if (tileKey === null) return null;
        const tile = board.boardInk.get(tileKey)!;
        const ids = rng.some([...tile.keys()], 3);
        deleteBoardStrokes(board, tileKey, ids);
        return `deleteBoardStrokes ${tileKey} -${ids.length}`;
      }
      const itemId = rng.pick(itemIds(board));
      if (itemId === null) return null;
      const strokes = board.items.get(itemId)?.get("strokes");
      if (!(strokes instanceof Y.Map)) return null;
      const ids = rng.some([...strokes.keys()], 3);
      if (ids.length === 0) return null;
      deleteStrokes(board, itemId, ids);
      return `deleteStrokes ${itemId} -${ids.length}`;
    },
  },
];

const TOTAL_WEIGHT = OPERATIONS.reduce((sum, op) => sum + op.weight, 0);

/**
 * Exchange everything each document has that the other has not.
 *
 * Both state vectors are taken **before** either update is applied. Taken one at
 * a time, the second diff would be computed against a document that has already
 * merged the first — which converges just as well and quietly tests half of what
 * this is meant to test, because one side would never see a genuinely concurrent
 * update.
 */
function merge(a: BoardDoc, b: BoardDoc): void {
  const av = Y.encodeStateVector(a.doc);
  const bv = Y.encodeStateVector(b.doc);
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, bv), "fuzz/remote");
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, av), "fuzz/remote");
}

/**
 * Mirror the document into a scene, the way the application does.
 *
 * This is invariant 4 and 5's other half — "skipped cleanly at render" and
 * "renders free-floating" are claims about the renderer, and the only honest way
 * to assert them is to run the thing that does the skipping. `crdt/binding.ts`
 * is the only translator between the document and the scene, so a dangling
 * reference that it cannot handle throws here and nowhere else.
 */
function mirror(board: BoardDoc): Scene {
  const scene = new Scene();
  const binding = new Binding(board, scene, new DirtySets());
  binding.start();
  binding.stop();
  return scene;
}

/** One run: two documents from a common base, N rounds of concurrent edits. */
/** What one run observed, for the caller to assert on. */
interface Run {
  /**
   * The most strings invariant 3 would have collected at any one merge — see
   * `unrepairableStrings`.
   *
   * The peak across the run rather than the state at the end of it, because
   * these come and go: a later operation deletes the string, or deletes the item
   * whose pins it hung from, and the record tidies itself by accident. Measured
   * at the end, eight seeds of twelve rounds reported zero — which says only
   * that the board had churned, not that the state was never reached. What the
   * janitor has to catch is it existing at all.
   */
  readonly unrepairable: number;
  readonly items: number;
  readonly strings: number;
}

function fuzz(seed: number, rounds: number, opsPerRound: number): Run {
  const rng = new Rng(seed);
  const restore = seedCrypto(rng);
  try {
    const a = openBoardDoc();
    // Fixed and different, because `createdBy` is the tie-break `compareOrder`
    // falls back on when two peers generate the same z key — which the jitter
    // makes rare and this harness makes reproducible.
    a.doc.clientID = 1;
    initialiseBoard(a);

    const b = openBoardDoc();
    b.doc.clientID = 2;
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), "fuzz/remote");

    const log: string[] = [];
    let unrepairable = 0;
    for (let round = 1; round <= rounds; round += 1) {
      // Each document edits without seeing the other. That is the whole
      // experiment: everything either of them chose to act on was chosen from a
      // board the other was simultaneously changing.
      for (const [name, board] of [["A", a] as const, ["B", b] as const]) {
        for (let i = 0; i < opsPerRound; i += 1) {
          const op = weightedPick(rng);
          const did = op.run(board, rng);
          if (did !== null) log.push(`r${round} ${name}: ${did}`);
        }
      }

      merge(a, b);

      const context = `seed ${seed}, round ${round} of ${rounds}\n${log.slice(-40).join("\n")}`;
      const broken = [
        ...checkInvariants(a).map((v) => ({ ...v, path: `A:${v.path}` })),
        ...checkInvariants(b).map((v) => ({ ...v, path: `B:${v.path}` })),
        ...checkConverged(a, b),
      ];
      if (broken.length > 0) {
        throw new Error(`${broken.length} invariant violation(s)\n${explain(broken)}\n\n${context}`);
      }

      // And the renderer's half of 4 and 5. Not folded into the checker: it
      // needs a `Scene`, which is `state/`, and a checker that shipped a
      // renderer dependency could not be run from anywhere the renderer is not.
      let scenes: [Scene, Scene];
      try {
        scenes = [mirror(a), mirror(b)];
      } catch (error) {
        // The cause carried, not just stringified: the whole value of this
        // failing is the binding's own stack, and a fuzz report that dropped it
        // would name the round and lose the line.
        throw new Error(`the binding threw building a scene\n\n${context}`, { cause: error });
      }
      if (scenes[0].size !== scenes[1].size) {
        throw new Error(
          `the two documents mirror to different scenes: ${scenes[0].size} items vs ${scenes[1].size}\n\n${context}`,
        );
      }

      unrepairable = Math.max(unrepairable, unrepairableStrings(a).length);
    }

    // Invariant 3 is reported, not asserted. `crdt/invariants.ts` carries the
    // argument; the short of it is that no guard evaluated against one document
    // can constrain the union of two, section 8.1 already says the answer is a
    // janitor rather than a check, and the janitor is not built.
    return { unrepairable, items: a.items.size, strings: a.strings.size };
  } finally {
    restore();
  }
}

/**
 * How many seeds. Twenty-four is a couple of seconds and covers a lot of shapes;
 * `FUZZ_SEEDS=400 npm test` is the soak, and because the seeds are consecutive
 * it only ever adds runs.
 */
const SEEDS = Number(
  // Through `globalThis` because `tsconfig.test.json` does not pull in Node's
  // types, and a harness is not a reason to give the whole test project them.
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.FUZZ_SEEDS ?? 24,
);
const ROUNDS = 12;
const OPS_PER_ROUND = 6;

describe("fuzz — two documents, concurrent operations, all nine invariants", () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    it(`holds every invariant on seed ${seed}`, () => {
      expect(() => fuzz(seed, ROUNDS, OPS_PER_ROUND)).not.toThrow();
    });
  }

  /**
   * Invariant 3, as two named mechanisms rather than a seed number.
   *
   * These are the harness's findings written down so they cannot quietly change:
   * a janitor that fixes them should turn these tests around deliberately, and
   * a refactor that stops reaching them should have to say so.
   */
  describe("invariant 3 — what no cascade can maintain", () => {
    /** Two peers on one board, an item and two pins on it. */
    function pair(): { a: BoardDoc; b: BoardDoc; item: string; p1: string; p2: string } {
      const a = openBoardDoc();
      a.doc.clientID = 1;
      initialiseBoard(a);
      const b = openBoardDoc();
      b.doc.clientID = 2;
      const item = createItems(a, [
        { type: "note", x: 0, y: 0, w: 100, h: 100, withPin: false },
      ])[0]!.itemId;
      const p1 = createPin(a, { parent: item, lx: -30, ly: 0 });
      const p2 = createPin(a, { parent: item, lx: 30, ly: 0 });
      merge(a, b);
      return { a, b, item, p1, p2 };
    }

    it("a string tied to a pin somebody else is deleting keeps a node pointing at nothing", () => {
      const { a, b, p1, p2 } = pair();

      // Three operations. A ties the string; B, who has not heard of it, pulls
      // one of its pins out. B's cascade heals every string it can see, and it
      // cannot see this one.
      const id = createStringThrough(a, [{ pin: p1 }, { pin: p2 }])!;
      deletePins(b, [p2]);
      merge(a, b);

      const nodes = readString(id, a.strings.get(id) as YMap)!.nodes;
      const pins = new Set(a.pins.keys());
      expect(a.strings.has(id)).toBe(true);
      expect(nodes).toHaveLength(2);
      expect(nodes.filter((node) => pins.has(node.pin))).toHaveLength(1);
      expect(unrepairableStrings(a)).toContain(id);

      // And nothing will ever collect it. The pin cascade is the only thing that
      // removes a node, and it has already run — on a document where this node
      // did not exist.
      deletePins(a, [p1]);
      expect(unrepairableStrings(a).length + (a.strings.has(id) ? 0 : 1)).toBeGreaterThan(0);
    });

    it("two peers each reducing a string to the legal minimum leave it below it", () => {
      const { a, b, item } = pair();
      // A four-pin run, so each peer can take one node and still be correct.
      const pins = [0, 1, 2, 3].map((i) => createPin(a, { parent: item, lx: i * 20 - 30, ly: 0 }));
      const id = createStringThrough(a, pins.map((pin) => ({ pin })))!;
      merge(a, b);
      expect(readString(id, a.strings.get(id) as YMap)!.nodes).toHaveLength(4);

      // A takes one node out and checks: two would remain, so the string stays.
      const nodes = readString(id, a.strings.get(id) as YMap)!.nodes;
      removeStringNodes(a, id, new Set([nodes[0]!.nodeId]));
      expect(readString(id, a.strings.get(id) as YMap)!.nodes).toHaveLength(3);

      // B, concurrently, deletes two pins. Its own cascade checks too, and is
      // also right: two nodes would remain on B.
      deletePins(b, [pins[2]!, pins[3]!]);
      expect(readString(id, b.strings.get(id) as YMap)!.nodes).toHaveLength(2);

      merge(a, b);

      // Both were right. The union is not.
      expect(a.strings.has(id)).toBe(true);
      expect(readString(id, a.strings.get(id) as YMap)!.nodes.length).toBeLessThan(2);
      expect(unrepairableStrings(a)).toContain(id);
    });

    it("is reached by the random runs too, not only by hand", () => {
      // If this ever goes to zero the harness has stopped exercising the case
      // and the two tests above are the only thing holding it.
      const seen = Array.from({ length: 8 }, (_, i) => fuzz(i + 1, ROUNDS, OPS_PER_ROUND));
      expect(seen.reduce((n, run) => n + run.unrepairable, 0)).toBeGreaterThan(0);
    });
  });

  /**
   * The harness's own claim about itself: that it is actually building a board
   * rather than spending every operation on an empty one. A run that deletes as
   * fast as it creates would pass every invariant by having nothing to check.
   */
  it("builds a board with something on it", () => {
    const rng = new Rng(99);
    const restore = seedCrypto(rng);
    try {
      const board = openBoardDoc();
      board.doc.clientID = 1;
      initialiseBoard(board);
      for (let i = 0; i < 400; i += 1) weightedPick(rng).run(board, rng);

      expect(board.items.size).toBeGreaterThan(3);
      expect(board.pins.size).toBeGreaterThan(3);
      expect(board.strings.size).toBeGreaterThan(0);
      expect(board.boardInk.size).toBeGreaterThan(0);
      // And every operation has to have been reachable at least once, or one of
      // them is quietly returning null for the whole run.
      const reached = new Set<string>();
      for (let i = 0; i < 2000; i += 1) {
        const op = weightedPick(rng);
        if (op.run(board, rng) !== null) reached.add(op.name);
      }
      expect([...reached].sort()).toEqual(OPERATIONS.map((op) => op.name).sort());
    } finally {
      restore();
    }
  });
});
