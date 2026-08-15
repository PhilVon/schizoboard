/**
 * The fifth item type in a document — D-73, T-392.
 *
 * Two halves. The **migration**, which is what makes the fifth type defensible
 * at all: a board with no timer on it stays readable by 1.0.2, and the first
 * timer seals it in the same breath that creates it. And the **six writes** of a
 * timer's life, which are all of them, because nothing is written per second.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  boardSchemaVersion,
  initialiseBoard,
  openBoardDoc,
  futureSchema,
  type BoardDoc,
} from "@/crdt/doc";
import {
  copySubgraph,
  createItems,
  pasteClip,
  pauseTimer,
  resetTimer,
  setTimerLength,
  setTimerLights,
  setTimerMode,
  startTimer,
} from "@/crdt/ops";
import { readItem, SCHEMA_BASELINE, SCHEMA_VERSION, type YMap } from "@/crdt/schema";
import { elapsedOf } from "@/lib/timer";

const T = 1_770_000_000_000;

function board(): BoardDoc {
  const b = openBoardDoc();
  initialiseBoard(b);
  return b;
}

/** The one timer on a board, read back the way a renderer would get it. */
function only(b: BoardDoc): NonNullable<ReturnType<typeof readItem>> {
  const [id, map] = [...b.items][0]!;
  return readItem(id, map)!;
}

function mapOf(b: BoardDoc, id: string): YMap {
  return b.items.get(id)!;
}

function putTimer(b: BoardDoc, timer?: Parameters<typeof createItems>[1][number]["timer"]): string {
  return createItems(b, [{ type: "timer", x: 0, y: 0, w: 90, h: 70, timer, withPin: false }])[0]!
    .itemId;
}

describe("a board with nothing new on it", () => {
  /**
   * The half that would be easy to skip and is the whole reason the constant is
   * split. Raising `SCHEMA_VERSION` alone would seal an older peer on every
   * board this build ever made, for a feature nobody on it had used.
   */
  it("is stamped with the baseline and not with what this build understands", () => {
    expect(boardSchemaVersion(board())).toBe(SCHEMA_BASELINE);
    expect(SCHEMA_BASELINE).toBeLessThan(SCHEMA_VERSION);
  });

  it("does not seal a 1.0.2 peer, however much is put on it", () => {
    const b = board();
    createItems(b, [
      { type: "polaroid", x: 0, y: 0, w: 100, h: 100 },
      { type: "note", x: 10, y: 10, w: 100, h: 100 },
      { type: "card", x: 20, y: 20, w: 100, h: 100 },
    ]);
    // What the older build asks. Its `SCHEMA_VERSION` is 1, and 1 is not less
    // than this board's 1, so nothing seals.
    expect(boardSchemaVersion(b)).toBe(SCHEMA_BASELINE);
    expect(futureSchema(b)).toBe(false);
  });
});

describe("the first timer", () => {
  it("raises the version, and the second raises nothing", () => {
    const b = board();
    // Counted as writes to `meta` rather than as a value: the value is 2 after
    // either timer, so only the write says whether the second one churned. That
    // churn is the whole reason `noteSchemaNeeds` guards instead of setting.
    let metaWrites = 0;
    b.meta.observe(() => {
      metaWrites += 1;
    });

    putTimer(b);
    expect(boardSchemaVersion(b)).toBe(SCHEMA_VERSION);
    expect(metaWrites).toBe(1);

    putTimer(b);
    putTimer(b, { mode: "countdown", runsFor: 60_000 });
    expect(metaWrites).toBe(1);
  });

  /**
   * The sentence D-73 rests on: *the seal and its cause reach a peer together*.
   *
   * One update carrying both, and not two. If the item could arrive without the
   * version, there is a window in which an older peer holds a board it cannot
   * read and does not know it — which is the silent state the whole schema
   * version was spent abolishing.
   */
  it("arrives at a peer in the same update as the item it is for", () => {
    const b = board();
    // Level with the board and holding no timer, which is the peer this is
    // about — a build already in the room when somebody puts one up. Synced in
    // full first because Yjs delivers causally: an update whose predecessors are
    // missing is buffered rather than applied, and a test that skipped this
    // would prove only that.
    const peer = openBoardDoc();
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(b.doc));
    expect(peer.meta.get("schemaVersion")).toBe(SCHEMA_BASELINE);

    const updates: Uint8Array[] = [];
    b.doc.on("update", (update: Uint8Array) => updates.push(update));
    putTimer(b, { mode: "countdown", runsFor: 300_000 });
    expect(updates).toHaveLength(1);

    // One update, carrying both. If the item could arrive without the version
    // there would be a window in which the peer holds a board it cannot fully
    // read and does not know it, which is the state D-73 spent a version on.
    Y.applyUpdate(peer.doc, updates[0]!);
    expect(peer.items.size).toBe(1);
    expect(only(peer).type).toBe("timer");
    expect(only(peer).timer).toEqual({
      mode: "countdown",
      runsFor: 300_000,
      runFrom: null,
      banked: 0,
      lights: null,
    });
    expect(peer.meta.get("schemaVersion")).toBe(SCHEMA_VERSION);
  });

  /** What that costs the peer, said out loud: it is the 1.0.2 build that stops
   *  writing, not this one. */
  it("puts the board in the future as far as a build that reads 1 is concerned", () => {
    const b = board();
    putTimer(b);
    expect(boardSchemaVersion(b)).toBeGreaterThan(SCHEMA_BASELINE);
    expect(futureSchema(b)).toBe(false);
  });

  it("does not drag a board that is already further forward back to 2", () => {
    const b = board();
    b.meta.set("schemaVersion", 7);
    putTimer(b);
    expect(boardSchemaVersion(b)).toBe(7);
  });
});

describe("reading a timer back", () => {
  it("accepts the fifth type where the four are accepted", () => {
    const b = board();
    const id = putTimer(b, { mode: "stopwatch" });
    const item = readItem(id, mapOf(b, id))!;
    expect(item).not.toBeNull();
    expect(item.type).toBe("timer");
    expect(item.timer).toEqual({
      mode: "stopwatch",
      runsFor: 0,
      runFrom: null,
      banked: 0,
      lights: null,
    });
  });

  it("gives every other type no timer at all rather than a clock's worth of defaults", () => {
    const b = board();
    const id = createItems(b, [{ type: "note", x: 0, y: 0, w: 10, h: 10 }])[0]!.itemId;
    expect(readItem(id, mapOf(b, id))!.timer).toBeNull();
  });

  /**
   * A later build's fourth mode, and a peer's nonsense. Absent is `clock` and so
   * is everything unrecognised, which is `sourceAbout`'s rule — the question is
   * "is this one of the modes we know", and every answer short of yes is the
   * default.
   */
  it("coerces a mode it does not know to clock", () => {
    const b = board();
    const id = putTimer(b);
    for (const junk of ["alarm", "", 3, null, { mode: "countdown" }]) {
      mapOf(b, id).set("mode", junk);
      expect(readItem(id, mapOf(b, id))!.timer!.mode).toBe("clock");
    }
    mapOf(b, id).delete("mode");
    expect(readItem(id, mapOf(b, id))!.timer!.mode).toBe("clock");
  });

  it("reads a nonsense duration as zero and a nonsense start as paused", () => {
    const b = board();
    const id = putTimer(b);
    const map = mapOf(b, id);
    for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, -5, "600", null]) {
      map.set("runsFor", junk);
      map.set("banked", junk);
      map.set("runFrom", junk);
      const timer = readItem(id, map)!.timer!;
      expect(timer.runsFor).toBe(0);
      expect(timer.banked).toBe(0);
      // Not repaired to zero the way the durations are: zero is a fine duration
      // and a catastrophic instant, and `now - 0` is fifty-six years.
      expect(timer.runFrom).toBeNull();
      expect(elapsedOf(timer, T)).toBe(0);
    }
  });
});

describe("nothing is written per second", () => {
  /**
   * The rule the whole feature hangs off, asserted as the thing it actually
   * means: a timer that has been running for an hour is a document nobody has
   * touched since it was started.
   */
  it("puts one write on the wire for a start and none for the running", () => {
    const b = board();
    const id = putTimer(b, { mode: "stopwatch" });
    const updates: Uint8Array[] = [];
    b.doc.on("update", (update: Uint8Array) => updates.push(update));

    startTimer(b, [id], T);
    expect(updates).toHaveLength(1);

    // An hour of wall clock. Reading is arithmetic on a `now` that is never
    // stored, so there is nothing here to write.
    const timer = readItem(id, mapOf(b, id))!.timer!;
    expect(elapsedOf(timer, T + 3_600_000)).toBe(3_600_000);
    expect(updates).toHaveLength(1);
  });

  /** Six over the whole life, all of them user actions. */
  it("takes six writes to set, run, stop, reset and re-mode one", () => {
    const b = board();
    const id = putTimer(b);
    const updates: Uint8Array[] = [];
    b.doc.on("update", (update: Uint8Array) => updates.push(update));

    setTimerMode(b, [id], "countdown");
    setTimerLength(b, [id], 300_000);
    startTimer(b, [id], T);
    pauseTimer(b, [id], T + 60_000);
    resetTimer(b, [id]);
    setTimerLights(b, id, "some-other-item");

    expect(updates).toHaveLength(6);
  });
});

describe("working a timer", () => {
  it("writes a mode only when it is not the default, and clears it going back", () => {
    const b = board();
    const id = putTimer(b);
    expect(mapOf(b, id).get("mode")).toBeUndefined();
    setTimerMode(b, [id], "countdown");
    expect(mapOf(b, id).get("mode")).toBe("countdown");
    setTimerMode(b, [id], "clock");
    // Deleted, not written as "clock". A key holding the default on every timer
    // ever made is a key nobody can read anything from.
    expect(mapOf(b, id).get("mode")).toBeUndefined();
  });

  it("keeps the length across a change of mode, the way a dial keeps its setting", () => {
    const b = board();
    const id = putTimer(b, { mode: "countdown", runsFor: 300_000 });
    setTimerMode(b, [id], "clock");
    setTimerMode(b, [id], "countdown");
    expect(readItem(id, mapOf(b, id))!.timer!.runsFor).toBe(300_000);
  });

  it("banks the run on a pause and reads the same before and after", () => {
    const b = board();
    const id = putTimer(b, { mode: "stopwatch" });
    startTimer(b, [id], T);
    const running = readItem(id, mapOf(b, id))!.timer!;
    expect(elapsedOf(running, T + 90_000)).toBe(90_000);

    pauseTimer(b, [id], T + 90_000);
    const paused = readItem(id, mapOf(b, id))!.timer!;
    expect(paused.runFrom).toBeNull();
    expect(paused.banked).toBe(90_000);
    // The reading does not jump across the pause, which is the only thing the
    // two writes together are for.
    expect(elapsedOf(paused, T + 90_000)).toBe(90_000);
    expect(elapsedOf(paused, T + 9_000_000)).toBe(90_000);
  });

  it("resumes onto what was banked rather than starting again", () => {
    const b = board();
    const id = putTimer(b, { mode: "stopwatch" });
    startTimer(b, [id], T);
    pauseTimer(b, [id], T + 30_000);
    startTimer(b, [id], T + 100_000);
    expect(elapsedOf(readItem(id, mapOf(b, id))!.timer!, T + 130_000)).toBe(60_000);
  });

  /** A double press must not rewind a stopwatch. */
  it("ignores a start on a timer that is already running", () => {
    const b = board();
    const id = putTimer(b, { mode: "stopwatch" });
    startTimer(b, [id], T);
    startTimer(b, [id], T + 50_000);
    expect(mapOf(b, id).get("runFrom")).toBe(T);
  });

  it("banks nothing when the pause arrives before the start", () => {
    // Two real clocks on two real walls. The clamp is what turns skew into a
    // zero-length run rather than into a negative one.
    const b = board();
    const id = putTimer(b, { mode: "stopwatch" });
    startTimer(b, [id], T + 4_000);
    pauseTimer(b, [id], T);
    const timer = readItem(id, mapOf(b, id))!.timer!;
    expect(timer.banked).toBe(0);
    expect(timer.runFrom).toBeNull();
  });

  it("pauses a paused timer without re-banking anything", () => {
    const b = board();
    const id = putTimer(b, { mode: "stopwatch" });
    startTimer(b, [id], T);
    pauseTimer(b, [id], T + 30_000);
    pauseTimer(b, [id], T + 90_000);
    expect(readItem(id, mapOf(b, id))!.timer!.banked).toBe(30_000);
  });

  it("resets to nothing and keeps the mode and the length", () => {
    const b = board();
    const id = putTimer(b, { mode: "countdown", runsFor: 300_000 });
    startTimer(b, [id], T);
    pauseTimer(b, [id], T + 30_000);
    resetTimer(b, [id]);
    expect(readItem(id, mapOf(b, id))!.timer).toEqual({
      mode: "countdown",
      runsFor: 300_000,
      runFrom: null,
      banked: 0,
      lights: null,
    });
  });

  it("refuses a length that is not a duration", () => {
    const b = board();
    const id = putTimer(b, { mode: "countdown", runsFor: 300_000 });
    for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      setTimerLength(b, [id], junk);
      expect(readItem(id, mapOf(b, id))!.timer!.runsFor).toBe(300_000);
    }
  });

  it("will not let a timer light itself", () => {
    const b = board();
    const id = putTimer(b);
    setTimerLights(b, id, id);
    expect(readItem(id, mapOf(b, id))!.timer!.lights).toBeNull();
  });

  it("leaves every item in a selection that is not a timer alone", () => {
    const b = board();
    const note = createItems(b, [{ type: "note", x: 0, y: 0, w: 10, h: 10 }])[0]!.itemId;
    const id = putTimer(b, { mode: "stopwatch" });
    startTimer(b, [note, id], T);
    expect(mapOf(b, note).get("runFrom")).toBeUndefined();
    expect(mapOf(b, id).get("runFrom")).toBe(T);
  });
});

describe("copying a timer", () => {
  /**
   * A copy is a new object. A pasted countdown should arrive set to five minutes
   * and ready to be started, not five minutes into somebody else's run — so the
   * mode and the length are carried and `runFrom` and `banked` are not.
   */
  it("keeps the mode and the length, and arrives unstarted", () => {
    const b = board();
    const id = putTimer(b, { mode: "countdown", runsFor: 300_000 });
    startTimer(b, [id], T);
    pauseTimer(b, [id], T + 120_000);

    const clip = copySubgraph(b, { items: [id], pins: [] })!;
    const pasted = pasteClip(b, clip, { x: 500, y: 500 });
    const copy = readItem(pasted.items[0]!, mapOf(b, pasted.items[0]!))!;

    expect(copy.type).toBe("timer");
    expect(copy.timer).toEqual({
      mode: "countdown",
      runsFor: 300_000,
      runFrom: null,
      banked: 0,
      lights: null,
    });
  });

  it("carries what it lights when that came too, and points at the copy", () => {
    const b = board();
    const note = createItems(b, [{ type: "note", x: 0, y: 0, w: 10, h: 10, withPin: false }])[0]!
      .itemId;
    const id = putTimer(b);
    setTimerLights(b, id, note);

    const clip = copySubgraph(b, { items: [id, note], pins: [] })!;
    const pasted = pasteClip(b, clip, { x: 500, y: 500 });
    const copies = new Set(pasted.items);
    const timer = pasted.items.map((i) => readItem(i, mapOf(b, i))!).find((i) => i.timer !== null)!;

    expect(timer.timer!.lights).not.toBe(note);
    expect(copies.has(timer.timer!.lights!)).toBe(true);
  });

  /** The same all-or-nothing a string whose pin did not come gets. */
  it("drops what it lights when that item was not copied", () => {
    const b = board();
    const note = createItems(b, [{ type: "note", x: 0, y: 0, w: 10, h: 10, withPin: false }])[0]!
      .itemId;
    const id = putTimer(b);
    setTimerLights(b, id, note);

    const clip = copySubgraph(b, { items: [id], pins: [] })!;
    const pasted = pasteClip(b, clip, { x: 500, y: 500 });
    expect(readItem(pasted.items[0]!, mapOf(b, pasted.items[0]!))!.timer!.lights).toBeNull();
  });

  it("seals a board that had no timer on it until the paste", () => {
    const source = board();
    const id = putTimer(source, { mode: "stopwatch" });
    const clip = copySubgraph(source, { items: [id], pins: [] })!;

    const target = board();
    expect(boardSchemaVersion(target)).toBe(SCHEMA_BASELINE);
    pasteClip(target, clip, { x: 0, y: 0 });
    expect(boardSchemaVersion(target)).toBe(SCHEMA_VERSION);
  });

  it("leaves a board alone when the clip had no timer in it", () => {
    const source = board();
    const note = createItems(source, [{ type: "note", x: 0, y: 0, w: 10, h: 10 }])[0]!.itemId;
    const clip = copySubgraph(source, { items: [note], pins: [] })!;

    const target = board();
    pasteClip(target, clip, { x: 0, y: 0 });
    expect(boardSchemaVersion(target)).toBe(SCHEMA_BASELINE);
  });
});
