import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { checkInvariants, compactableStrings, unrepairableStrings } from "@/crdt/invariants";
import { CHECK_MS, elected, Janitor, SETTLE_MS } from "@/crdt/janitor";
import { createItems, createPin, createStringThrough, deletePins } from "@/crdt/ops";
import { compactStrings } from "@/crdt/ops/janitor";
import { isTracked, Origin } from "@/crdt/origins";
import { readString, type YMap } from "@/crdt/schema";

let a: BoardDoc;
let b: BoardDoc;

function merge(one: BoardDoc, two: BoardDoc): void {
  const av = Y.encodeStateVector(one.doc);
  const bv = Y.encodeStateVector(two.doc);
  Y.applyUpdate(two.doc, Y.encodeStateAsUpdate(one.doc, bv), "remote");
  Y.applyUpdate(one.doc, Y.encodeStateAsUpdate(two.doc, av), "remote");
}

/** An item with two pins on it, shared by both documents. */
function furnish(): { item: string; p1: string; p2: string } {
  const item = createItems(a, [
    { type: "note", x: 0, y: 0, w: 200, h: 100, withPin: false },
  ])[0]!.itemId;
  const p1 = createPin(a, { parent: item, lx: -50, ly: 0 });
  const p2 = createPin(a, { parent: item, lx: 50, ly: 0 });
  merge(a, b);
  return { item, p1, p2 };
}

/**
 * The state the janitor exists for, made the way T-76's harness found it: A ties
 * a string, B — who has never heard of it — pulls one of its pins out. B's
 * cascade heals every string it can see and cannot see this one.
 */
function strand(p1: string, p2: string): string {
  const id = createStringThrough(a, [{ pin: p1 }, { pin: p2 }])!;
  deletePins(b, [p2]);
  merge(a, b);
  return id;
}

/** Tick past the settle period, one check interval at a time. */
function run(janitor: Janitor, present: number[], forMs: number, from = 0): string[] {
  const collected: string[] = [];
  for (let t = from; t <= from + forMs; t += CHECK_MS) {
    collected.push(...janitor.tick(t, present));
  }
  return collected;
}

beforeEach(() => {
  a = openBoardDoc();
  a.doc.clientID = 1;
  initialiseBoard(a);
  b = openBoardDoc();
  b.doc.clientID = 2;
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc), "remote");
});

describe("elected", () => {
  it("is the lowest present client id", () => {
    expect(elected(1, [1, 2, 7])).toBe(true);
    expect(elected(2, [1, 2, 7])).toBe(false);
    expect(elected(7, [7])).toBe(true);
  });

  /**
   * A provider that has not connected knows nobody, which is not the same as
   * being alone — and the difference matters, because a client that assumed it
   * was alone would compact a board it has only half received.
   */
  it("elects nobody when the caller cannot say who is present", () => {
    expect(elected(1, [])).toBe(false);
    expect(elected(1, [2, 3])).toBe(false);
  });
});

describe("compactStrings", () => {
  it("deletes a string that is beyond repair", () => {
    const { p1, p2 } = furnish();
    const id = strand(p1, p2);
    expect(compactStrings(a, [id])).toEqual({ collected: [id], pruned: [] });
    expect(a.strings.has(id)).toBe(false);
  });

  /**
   * The re-read inside the transaction. The caller decided from a document it
   * read milliseconds ago, and the interesting thing that happens in between is
   * the pin coming back.
   */
  it("spares a string that was saved between the decision and the write", () => {
    const { item, p1, p2 } = furnish();
    const id = strand(p1, p2);
    expect(unrepairableStrings(a)).toContain(id);

    // A peer pushes a pin back in under the node that was dangling — or an undo
    // restores one. Either way the string reads as a string again.
    const nodes = readString(id, a.strings.get(id) as YMap)!.nodes;
    const orphaned = nodes.findIndex((node) => !a.pins.has(node.pin));
    expect(orphaned).toBeGreaterThanOrEqual(0);
    const revived = createPin(a, { parent: item, lx: 50, ly: 0 });
    (a.strings.get(id)!.get("nodes") as Y.Array<YMap>).get(orphaned).set("pin", revived);

    expect(compactStrings(a, [id])).toEqual({ collected: [], pruned: [] });
    expect(a.strings.has(id)).toBe(true);
  });

  it("leaves a string it cannot parse alone rather than deleting it", () => {
    const { p1, p2 } = furnish();
    const id = createStringThrough(a, [{ pin: p1 }, { pin: p2 }])!;
    // A record from a schema this build does not know. Section 8.1's tolerance
    // is aimed squarely at this, and a janitor that deleted what it could not
    // read would be a forward-compatibility bug that surfaces as data loss.
    a.strings.get(id)!.set("nodes", "some future shape");
    expect(compactStrings(a, [id])).toEqual({ collected: [], pruned: [] });
    expect(a.strings.has(id)).toBe(true);
  });

  it("writes under an origin undo does not track", () => {
    const { p1, p2 } = furnish();
    const id = strand(p1, p2);
    const origins: unknown[] = [];
    a.doc.on("afterTransaction", (tx: Y.Transaction) => origins.push(tx.origin));
    compactStrings(a, [id]);
    expect(origins).toContain(Origin.JANITOR);
    expect(isTracked(Origin.JANITOR)).toBe(false);
  });

  it("is idempotent, so two clients collecting at once converge", () => {
    const { p1, p2 } = furnish();
    const id = strand(p1, p2);
    // Both peers decide independently — which is what the election makes rare
    // and cannot make impossible, since presence lags.
    expect(compactStrings(a, [id]).collected).toEqual([id]);
    expect(compactStrings(b, [id]).collected).toEqual([id]);
    merge(a, b);
    expect(a.strings.has(id)).toBe(false);
    expect(b.strings.has(id)).toBe(false);
    expect(unrepairableStrings(a)).toEqual([]);
  });
});

/**
 * The second kind of decay: a string that still draws, carrying a node that
 * resolves to nothing.
 *
 * Nothing else on the board will ever touch it. It is not a violation —
 * invariant 4 permits it, `sim/ropes.ts` steps over it and the run closes up —
 * so it is invisible, and it arrives once per pin deletion that raced an edit to
 * the same run.
 */
describe("pruning a dead node", () => {
  /** A three-pin run that loses its middle pin to a peer, the way `strand`
   *  loses an end one: B's cascade cannot see a string it does not have. */
  function stranded3(): { id: string; live: [string, string]; dead: string } {
    const { item } = { item: createItems(a, [{ type: "note", x: 0, y: 0, w: 400, h: 100, withPin: false }])[0]!.itemId };
    const p1 = createPin(a, { parent: item, lx: -150, ly: 0 });
    const mid = createPin(a, { parent: item, lx: 0, ly: 0 });
    const p3 = createPin(a, { parent: item, lx: 150, ly: 0 });
    merge(a, b);
    const id = createStringThrough(a, [{ pin: p1 }, { pin: mid }, { pin: p3 }])!;
    deletePins(b, [mid]);
    merge(a, b);
    return { id, live: [p1, p3], dead: mid };
  }

  it("is on the work list even though the string is perfectly renderable", () => {
    const { id } = stranded3();
    // Not a violation, and not beyond repair — which is why nothing collected
    // it before and why it needed its own list.
    expect(unrepairableStrings(a)).toEqual([]);
    expect(checkInvariants(a)).toEqual([]);
    expect(compactableStrings(a)).toEqual([id]);
  });

  it("drops the node and keeps the string", () => {
    const { id, live } = stranded3();
    expect(compactStrings(a, [id])).toEqual({ collected: [], pruned: [id] });
    expect(a.strings.has(id)).toBe(true);
    expect(readString(id, a.strings.get(id) as YMap)!.nodes.map((n) => n.pin)).toEqual(live);
    expect(compactableStrings(a)).toEqual([]);
  });

  /**
   * The gap the survivors hang from is the one the renderer was already
   * drawing, so the write moves nothing. `sim/ropes.ts` gives a spanning gap the
   * slack of the node it *starts* at and merges nothing into it, and this has to
   * agree exactly or compaction would be seen as a twitch.
   */
  it("leaves the surviving nodes' slack exactly alone", () => {
    const { id } = stranded3();
    const before = readString(id, a.strings.get(id) as YMap)!.nodes;
    compactStrings(a, [id]);
    const after = readString(id, a.strings.get(id) as YMap)!.nodes;
    expect(after.map((n) => n.slackAfter)).toEqual([before[0]!.slackAfter, before[2]!.slackAfter]);
  });

  it("is idempotent, so two clients pruning at once converge", () => {
    const { id, live } = stranded3();
    expect(compactStrings(a, [id]).pruned).toEqual([id]);
    expect(compactStrings(b, [id]).pruned).toEqual([id]);
    merge(a, b);
    for (const board of [a, b]) {
      expect(readString(id, board.strings.get(id) as YMap)!.nodes.map((n) => n.pin)).toEqual(live);
    }
  });

  /**
   * A malformed node is not a dangling one. `readStringNodes` drops it, so its
   * index is not the array's — pruning by an index off that list would take a
   * live node out of somebody's string.
   */
  it("does not miscount past a node it cannot read", () => {
    const { id, live } = stranded3();
    const nodes = a.strings.get(id)!.get("nodes") as Y.Array<YMap>;
    // A fourth node, first in the run, from a build that wrote no `pin`.
    const alien = new Y.Map<unknown>();
    a.doc.transact(() => {
      nodes.insert(0, [alien as unknown as YMap]);
      alien.set("nodeId", "n-alien");
      alien.set("slackAfter", 0.2);
    });

    compactStrings(a, [id]);

    const survivors = (nodes.toArray() as YMap[]).map((n) => n.get("pin"));
    expect(survivors).toEqual([undefined, ...live]);
  });
});

describe("Janitor", () => {
  it("collects a stranded string, once it has stayed stranded", () => {
    const { p1, p2 } = furnish();
    const id = strand(p1, p2);
    const janitor = new Janitor(a);

    // Not on the first sight of it, however many times it is asked.
    expect(run(janitor, [1, 2], SETTLE_MS - CHECK_MS * 2)).toEqual([]);
    expect(a.strings.has(id)).toBe(true);
    expect(janitor.pending).toBe(1);

    // And then it goes.
    expect(run(janitor, [1, 2], CHECK_MS * 3, SETTLE_MS - CHECK_MS)).toEqual([id]);
    expect(a.strings.has(id)).toBe(false);
    expect(janitor.pending).toBe(0);
  });

  /**
   * The reason the delay exists, and the failure it prevents is not subtle: on a
   * fresh connection a peer receives strings before the pins they name, so for a
   * moment every string on the board is beyond repair. A janitor acting on one
   * observation would empty it.
   */
  it("does not collect a board it has only half received", () => {
    const { p1, p2 } = furnish();
    const good = createStringThrough(a, [{ pin: p1 }, { pin: p2 }])!;
    merge(a, b);

    // A third document, given the strings first and the pins a moment later —
    // which is exactly what an arriving peer sees.
    const late = openBoardDoc();
    late.doc.clientID = 3;
    late.strings.set(good, a.strings.get(good)!.clone());
    expect(unrepairableStrings(late)).toContain(good);

    const janitor = new Janitor(late);
    // Alone as far as it knows, so elected, and the string looks beyond repair.
    expect(run(janitor, [3], CHECK_MS * 3)).toEqual([]);

    // The pins land, well inside the settle period.
    Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(a.doc), "remote");
    expect(unrepairableStrings(late)).toEqual([]);

    expect(run(janitor, [3], SETTLE_MS * 2, CHECK_MS * 4)).toEqual([]);
    expect(late.strings.has(good)).toBe(true);
    expect(janitor.pending).toBe(0);
  });

  it("restarts the clock on a string that was repaired and broke again", () => {
    const { item, p1, p2 } = furnish();
    const id = strand(p1, p2);
    const janitor = new Janitor(a);
    run(janitor, [1], SETTLE_MS - CHECK_MS * 2);
    expect(janitor.pending).toBe(1);

    // Repaired, so it drops off the clock entirely...
    const revived = createPin(a, { parent: item, lx: 50, ly: 0 });
    (a.strings.get(id)!.get("nodes") as Y.Array<YMap>).get(1).set("pin", revived);
    janitor.tick(SETTLE_MS, [1]);
    expect(janitor.pending).toBe(0);

    // ...and breaking again buys it a full settle period, not the remainder.
    deletePins(a, [revived]);
    // The cascade deletes the string outright here, which is the local path
    // working. Rebuild the merge-only state to test the clock rather than it.
    const again = strand(p1, createPin(a, { parent: item, lx: 60, ly: 0 }));
    expect(run(janitor, [1], CHECK_MS * 2, SETTLE_MS + CHECK_MS)).toEqual([]);
    expect(a.strings.has(again)).toBe(true);
  });

  it("does nothing at all when it is not the elected client", () => {
    const { p1, p2 } = furnish();
    const id = strand(p1, p2);
    const janitor = new Janitor(a);
    // Client 1 is us, and there is a 0 on the board.
    expect(run(janitor, [0, 1, 2], SETTLE_MS * 3)).toEqual([]);
    expect(a.strings.has(id)).toBe(true);
    expect(janitor.pending).toBe(0);
  });

  it("serves its own settle period after taking over from a peer that left", () => {
    const { p1, p2 } = furnish();
    const id = strand(p1, p2);
    const janitor = new Janitor(a);

    // Somebody lower was responsible for the whole of one settle period.
    run(janitor, [0, 1], SETTLE_MS * 2);
    expect(a.strings.has(id)).toBe(true);

    // They leave. The clock starts now, not then — this client may be taking
    // over from a peer that was about to collect, or that knew something it
    // does not.
    const from = SETTLE_MS * 2 + CHECK_MS;
    expect(run(janitor, [1], SETTLE_MS - CHECK_MS * 2, from)).toEqual([]);
    expect(a.strings.has(id)).toBe(true);
    expect(run(janitor, [1], CHECK_MS * 3, from + SETTLE_MS - CHECK_MS)).toEqual([id]);
  });

  it("reads the document at most once a check interval", () => {
    furnish();
    const janitor = new Janitor(a);
    let reads = 0;
    const real = a.strings.keys.bind(a.strings);
    a.strings.keys = () => {
      reads += 1;
      return real();
    };
    // Sixty ticks, as the frame loop would deliver them, inside one interval.
    for (let i = 0; i < 60; i += 1) janitor.tick(i * 16, [1]);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it("says nothing on a healthy board, however long it runs", () => {
    const { p1, p2 } = furnish();
    createStringThrough(a, [{ pin: p1 }, { pin: p2 }]);
    const janitor = new Janitor(a);
    expect(run(janitor, [1], SETTLE_MS * 4)).toEqual([]);
    expect(janitor.pending).toBe(0);
  });

  /** A dead node inside a live string is on the same clock, for the same
   *  reason: on a fresh connection every node on the board looks like one. */
  it("prunes a dead node once it has stayed dead", () => {
    const item = createItems(a, [{ type: "note", x: 0, y: 0, w: 400, h: 100, withPin: false }])[0]!.itemId;
    const p1 = createPin(a, { parent: item, lx: -150, ly: 0 });
    const mid = createPin(a, { parent: item, lx: 0, ly: 0 });
    const p3 = createPin(a, { parent: item, lx: 150, ly: 0 });
    merge(a, b);
    const id = createStringThrough(a, [{ pin: p1 }, { pin: mid }, { pin: p3 }])!;
    deletePins(b, [mid]);
    merge(a, b);
    const janitor = new Janitor(a);

    expect(run(janitor, [1, 2], SETTLE_MS - CHECK_MS * 2)).toEqual([]);
    expect(readString(id, a.strings.get(id) as YMap)!.nodes).toHaveLength(3);

    expect(run(janitor, [1, 2], CHECK_MS * 3, SETTLE_MS - CHECK_MS)).toEqual([id]);
    expect(readString(id, a.strings.get(id) as YMap)!.nodes.map((n) => n.pin)).toEqual([p1, p3]);
  });
});

/**
 * DATA-MODEL section 5.4's advisory lock, read for the first time on this board
 * (Q-88). The distinction it has to keep is between waiting and enforcing: this
 * *waits*, so a hint that is wrong costs a second of tidying and never a write
 * that should have gone through.
 */
describe("a string somebody has hold of", () => {
  it("is left alone while the claim stands, and swept the moment it goes", () => {
    const { p1, p2 } = furnish();
    const id = strand(p1, p2);
    const janitor = new Janitor(a);
    const held = (stringId: string): boolean => stringId === id;

    // Ripe several times over, and untouched every time.
    for (let t = 0; t <= SETTLE_MS * 3; t += CHECK_MS) {
      expect(janitor.tick(t, [1], held)).toEqual([]);
    }
    expect(a.strings.has(id)).toBe(true);
    // Still on the clock — it has been beyond repair continuously, and the
    // claim says nothing about that.
    expect(janitor.pending).toBe(1);

    // They let go. No fresh settle period: the wait was courtesy, not doubt.
    expect(janitor.tick(SETTLE_MS * 3 + CHECK_MS, [1])).toEqual([id]);
    expect(a.strings.has(id)).toBe(false);
  });

  it("does not hold up the strings nobody is in", () => {
    const { item, p1, p2 } = furnish();
    const p3 = createPin(a, { parent: item, lx: -60, ly: 0 });
    const p4 = createPin(a, { parent: item, lx: 60, ly: 0 });
    merge(a, b);
    const free = strand(p1, p2);
    const claimed = strand(p3, p4);
    const janitor = new Janitor(a);
    const held = (id: string): boolean => id === claimed;

    // Well past ripe, with the claim standing the whole time.
    const swept: string[] = [];
    for (let t = 0; t <= SETTLE_MS * 2; t += CHECK_MS) {
      swept.push(...janitor.tick(t, [1], held));
    }
    expect(swept).toEqual([free]);
    expect(a.strings.has(claimed)).toBe(true);
  });
});
