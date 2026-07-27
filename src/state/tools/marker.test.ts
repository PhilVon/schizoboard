/**
 * The marker, with no document, no renderer and no browser — the same seam the
 * note and select tools' tests use.
 *
 * What is worth pinning down here is not what the mark looks like
 * (`render/ink/geometry.test.ts` has that) but what the tool *collects*: every
 * sample the machine handed it, converted once, in the order the hand made them.
 * Dropping samples is AC-76's failure mode and it is silent — the stroke still
 * appears, just with the corners cut off.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_INK_SIZE, DEFAULT_MARKER_COLOR } from "@/lib/ink";
import { PRESSURE_NEUTRAL } from "@/lib/pressure";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";
import { Selection } from "@/state/selection";
import { MarkerTool } from "@/state/tools/marker";
import type { PointerSample, ToolContext } from "@/state/tools/tool";

let done: number;
let tool: MarkerTool;
let ctx: ToolContext;
let camera: Camera;

function at(x: number, y: number, pressure?: number): PointerSample {
  return { x, y, shift: false, ctrl: false, alt: false, pressure };
}

/** A sample from a real pen: a pressure reading, and a `pointerType` that says
 *  the reading means something. */
function pen(x: number, y: number, pressure: number, time = 0): PointerSample {
  return { x, y, shift: false, ctrl: false, alt: false, pressure, pointer: "pen", time };
}

/** A sample from a mouse — which reports `PRESSURE_NEUTRAL` forever, whatever the
 *  hand is doing, and carries a timestamp that is the only real information. */
function mouse(x: number, y: number, time: number): PointerSample {
  return {
    x,
    y,
    shift: false,
    ctrl: false,
    alt: false,
    pressure: PRESSURE_NEUTRAL,
    pointer: "mouse",
    time,
  };
}

function down(x: number, y: number, pressure?: number): void {
  tool.handle({ kind: "down", at: at(x, y, pressure) }, ctx);
}
/** A move carrying its coalesced trail, which is what the machine delivers. */
function move(trail: readonly PointerSample[]): void {
  tool.handle({ kind: "move", at: trail[trail.length - 1]!, trail }, ctx);
}
function up(x: number, y: number): void {
  tool.handle({ kind: "up", at: at(x, y) }, ctx);
}
function samples(): ReadonlyArray<{ x: number; y: number; pressure: number }> {
  return tool.wet?.samples ?? [];
}

beforeEach(() => {
  done = 0;
  camera = new Camera();
  camera.resize(1000, 800);
  tool = new MarkerTool({ onDone: () => done++ });
  ctx = {
    scene: new Scene(),
    dirty: new DirtySets(),
    camera,
    selection: new Selection(),
    hitTest: () => null,
    hitPin: () => null,
    hitString: () => null,
    pluck: () => {},
    held: new Set<string>(),
    write: {
      setPoses: () => {},
      setSizes: () => {},
      deleteItems: () => {},
      createNote: () => {},
      createPin: () => {},
      placePin: () => {},
      deletePins: () => {},
      createString: () => {},
      insertPin: () => {},
      setNodeSlack: () => {},
      scaleNodeSlack: () => {},
      setStringSlack: () => {},
      scaleStringSlack: () => {},
      setStringLayer: () => {},
      deleteStrings: () => {},
      setStringStyle: () => {},
      movePins: () => {},
    },
  };
});

describe("collecting a stroke", () => {
  it("keeps every sample of the trail, not just where the pointer ended up", () => {
    down(0, 0);
    move([at(10, 0), at(20, 5), at(30, 12), at(40, 20)]);
    move([at(50, 30), at(60, 41)]);

    // Seven: the press, then all six. Reading `at` instead would have kept two of
    // the six, which is a stroke sampled at frame rate — DESIGN section 6.5.
    expect(samples().map((s) => s.x)).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });

  it("falls back to the position where the move carries no trail", () => {
    down(0, 0);
    tool.handle({ kind: "move", at: at(25, 25) }, ctx);
    expect(samples().map((s) => s.x)).toEqual([0, 25]);
  });

  it("converts to board coordinates once, on the way in", () => {
    camera.setView(100, 50, 1.75);
    down(0, 0);
    move([at(200, 400)]);

    // Board space, not screen: the wheel still zooms while a pointer is down, and
    // screen pixels would slide off the cork as it did (`WetStroke.samples`).
    const board = camera.screenToBoard(200, 400);
    const last = samples()[1]!;
    expect(last.x).toBeCloseTo(board.x, 6);
    expect(last.y).toBeCloseTo(board.y, 6);
  });

  it("ignores a move that arrives with no button down", () => {
    move([at(10, 10), at(20, 20)]);
    expect(tool.wet).toBeNull();
    expect(tool.stroking).toBe(false);
  });

  it("starts a fresh stroke on the next press rather than continuing the last", () => {
    down(0, 0);
    move([at(10, 0), at(20, 0)]);
    up(20, 0);
    down(500, 500);
    move([at(510, 500)]);

    expect(samples().map((s) => s.x)).toEqual([500, 510]);
  });
});

/**
 * AC-77, and the whole of DESIGN section 6.5's warning: "a mouse always reports
 * exactly 0.5, so mouse and touch use velocity-derived simulated pressure
 * instead. Getting this wrong produces dead, uniform lines."
 *
 * Every assertion here would pass with a flat 0.5 in place of the branch, except
 * the ones that say it varies. Those are the test.
 */
describe("how hard the nib is pressed", () => {
  it("varies down the length of a mouse stroke, though the device never does", () => {
    // 5 ms apart throughout, and accelerating: 4 px, then 12, then 40.
    tool.handle({ kind: "down", at: mouse(0, 0, 0) }, ctx);
    move([mouse(4, 0, 5), mouse(16, 0, 10), mouse(56, 0, 15)]);

    const read = samples().map((s) => s.pressure);
    // Every one of them arrived as PRESSURE_NEUTRAL and not one of them is it.
    expect(read).not.toContain(PRESSURE_NEUTRAL);
    // And the mark thins as the hand speeds up, which is the point.
    expect(read[1]!).toBeGreaterThan(read[2]!);
    expect(read[2]!).toBeGreaterThan(read[3]!);
  });

  it("starts a stroke at full width, because a stroke starts from rest", () => {
    tool.handle({ kind: "down", at: mouse(0, 0, 0) }, ctx);
    expect(samples()).toEqual([]);
    move([mouse(2, 0, 8)]);
    expect(tool.wet!.samples[0]!.pressure).toBe(1);
  });

  it("does not carry one stroke's speed into the next", () => {
    tool.handle({ kind: "down", at: mouse(0, 0, 0) }, ctx);
    move([mouse(60, 0, 5), mouse(120, 0, 10)]);
    const fast = tool.wet!.samples[2]!.pressure;

    tool.handle({ kind: "up", at: mouse(120, 0, 15) }, ctx);
    tool.handle({ kind: "down", at: mouse(500, 500, 100) }, ctx);
    move([mouse(502, 500, 108)]);

    // A stroke that inherited the last one's speed would start at whatever width
    // that one finished at.
    expect(fast).toBeLessThan(0.5);
    expect(tool.wet!.samples[0]!.pressure).toBe(1);
  });

  it("believes a pen, and does not measure it", () => {
    tool.handle({ kind: "down", at: pen(0, 0, 0.2, 0) }, ctx);
    // Moving fast, which would thin a mouse stroke — and pressing harder, which
    // is what the pen actually said.
    move([pen(80, 0, 0.6, 5), pen(160, 0, 0.95, 10)]);

    expect(samples().map((s) => s.pressure)).toEqual([0.2, 0.6, 0.95]);
  });

  it("measures a pen that reports no pressure at all", () => {
    tool.handle(
      { kind: "down", at: { x: 0, y: 0, shift: false, ctrl: false, alt: false, pointer: "pen" } },
      ctx,
    );
    move([{ x: 40, y: 0, shift: false, ctrl: false, alt: false, pointer: "pen", time: 5 }]);

    // `undefined` is not a reading, and defaulting it to the neutral constant
    // would be the flat line by another route.
    expect(samples().map((s) => s.pressure)).toEqual([1, expect.any(Number)]);
    expect(samples()[1]!.pressure).toBeLessThan(1);
  });

  it("still varies where the timestamps are useless", () => {
    // Some engines stamp a whole coalesced batch identically. The distance
    // between samples then has to carry it alone.
    tool.handle({ kind: "down", at: mouse(0, 0, 0) }, ctx);
    move([mouse(3, 0, 0), mouse(9, 0, 0), mouse(49, 0, 0)]);

    const read = samples().map((s) => s.pressure);
    expect(read).not.toContain(PRESSURE_NEUTRAL);
    expect(read[3]!).toBeLessThan(read[1]!);
  });
});

describe("what the overlay is offered", () => {
  it("is nothing until there are two samples to draw between", () => {
    expect(tool.wet).toBeNull();
    down(10, 10);
    // A press that has not moved is not yet evidence of a dot or of a line, and a
    // blob under every click would be the cost of guessing.
    expect(tool.wet).toBeNull();
    move([at(11, 10)]);
    expect(tool.wet).not.toBeNull();
  });

  it("carries the tool, the colour and the board-unit width", () => {
    down(0, 0);
    move([at(10, 0)]);
    expect(tool.wet).toMatchObject({
      tool: "marker",
      color: DEFAULT_MARKER_COLOR,
      size: DEFAULT_INK_SIZE,
    });
  });

  it("is the same class with the highlighter's geometry when asked for one", () => {
    const highlighter = new MarkerTool({ tool: "highlighter", color: "#c9a227", size: 20 });
    highlighter.handle({ kind: "down", at: at(0, 0) }, ctx);
    highlighter.handle({ kind: "move", at: at(10, 0), trail: [at(10, 0)] }, ctx);
    expect(highlighter.id).toBe("highlighter");
    expect(highlighter.wet).toMatchObject({ tool: "highlighter", color: "#c9a227", size: 20 });
  });
});

describe("letting go", () => {
  it("takes the mark with it, because nothing was ever written down", () => {
    down(0, 0);
    move([at(10, 0), at(20, 0)]);
    up(30, 0);

    // Not a lost write — a wet stroke is never in the document. The commit needs
    // the packing (T-59) and a canvas to raster into (T-57); T-58 joins them.
    expect(tool.wet).toBeNull();
    expect(tool.stroking).toBe(false);
  });

  it("keeps the release's own position while it is still a stroke", () => {
    down(0, 0);
    move([at(10, 0)]);
    // The last sample is part of the mark; it is the discard that follows, not
    // the release itself, that ends it.
    up(99, 0);
    expect(tool.wet).toBeNull();
  });

  it("abandons the stroke on a lost pointer, and keeps the tool", () => {
    down(0, 0);
    move([at(10, 0)]);
    tool.handle({ kind: "cancel" }, ctx);

    expect(tool.wet).toBeNull();
    // A window that lost focus mid-stroke has not finished with the marker —
    // `state/tools/note.ts` makes the same argument.
    expect(done).toBe(0);
  });

  it("hands the board back on Escape", () => {
    down(0, 0);
    move([at(10, 0)]);
    tool.handle({ kind: "key", code: "Escape", shift: false, ctrl: false, alt: false }, ctx);

    expect(tool.wet).toBeNull();
    expect(done).toBe(1);
  });

  it("stays in the marker for every other key — nobody draws one stroke", () => {
    tool.handle({ kind: "key", code: "Enter", shift: false, ctrl: false, alt: false }, ctx);
    expect(done).toBe(0);
  });
});

describe("the stroke the renderer is handed", () => {
  it("is the live array, so a long stroke is not copied every frame", () => {
    down(0, 0);
    move([at(10, 0)]);
    const first = tool.wet!.samples;
    move([at(20, 0)]);
    expect(tool.wet!.samples).toBe(first);
    expect(first).toHaveLength(3);
  });

  it("is not the array the next stroke appends to", () => {
    down(0, 0);
    move([at(10, 0)]);
    const held = tool.wet!.samples;
    up(10, 0);
    const finished = held.length;
    down(500, 500);
    move([at(510, 500)]);

    // The renderer may still be holding the previous one — a press replaces the
    // array rather than emptying it, so what it holds cannot change under it. The
    // release appending its own position is the *same* stroke and is fine; the
    // next stroke arriving in the middle of it is not.
    expect(held.map((s) => s.x)).toEqual([0, 10, 10]);
    expect(held).toHaveLength(finished);
    expect(tool.wet!.samples).not.toBe(held);
  });
});
