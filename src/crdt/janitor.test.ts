import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { unrepairableStrings } from "@/crdt/invariants";
import { CHECK_MS, elected, Janitor, SETTLE_MS } from "@/crdt/janitor";
import { createItems, createPin, createStringThrough, deletePins } from "@/crdt/ops";
import { collectStrings } from "@/crdt/ops/janitor";
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

describe("collectStrings", () => {
  it("deletes a string that is beyond repair", () => {
    const { p1, p2 } = furnish();
    const id = strand(p1, p2);
    expect(collectStrings(a, [id])).toEqual([id]);
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

    expect(collectStrings(a, [id])).toEqual([]);
    expect(a.strings.has(id)).toBe(true);
  });

  it("leaves a string it cannot parse alone rather than deleting it", () => {
    const { p1, p2 } = furnish();
    const id = createStringThrough(a, [{ pin: p1 }, { pin: p2 }])!;
    // A record from a schema this build does not know. Section 8.1's tolerance
    // is aimed squarely at this, and a janitor that deleted what it could not
    // read would be a forward-compatibility bug that surfaces as data loss.
    a.strings.get(id)!.set("nodes", "some future shape");
    expect(collectStrings(a, [id])).toEqual([]);
    expect(a.strings.has(id)).toBe(true);
  });

  it("writes under an origin undo does not track", () => {
    const { p1, p2 } = furnish();
    const id = strand(p1, p2);
    const origins: unknown[] = [];
    a.doc.on("afterTransaction", (tx: Y.Transaction) => origins.push(tx.origin));
    collectStrings(a, [id]);
    expect(origins).toContain(Origin.JANITOR);
    expect(isTracked(Origin.JANITOR)).toBe(false);
  });

  it("is idempotent, so two clients collecting at once converge", () => {
    const { p1, p2 } = furnish();
    const id = strand(p1, p2);
    // Both peers decide independently — which is what the election makes rare
    // and cannot make impossible, since presence lags.
    expect(collectStrings(a, [id])).toEqual([id]);
    expect(collectStrings(b, [id])).toEqual([id]);
    merge(a, b);
    expect(a.strings.has(id)).toBe(false);
    expect(b.strings.has(id)).toBe(false);
    expect(unrepairableStrings(a)).toEqual([]);
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
});
