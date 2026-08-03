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

import {
  DEFAULT_HIGHLIGHTER_COLOR,
  DEFAULT_HIGHLIGHTER_OPACITY,
  DEFAULT_HIGHLIGHTER_SIZE,
  DEFAULT_INK_SIZE,
  DEFAULT_MARKER_COLOR,
  INK_SIZES,
  type WetStroke,
} from "@/lib/ink";
import { PRESSURE_NEUTRAL } from "@/lib/pressure";
import { rotateOut } from "@/lib/rotate";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene } from "@/state/scene";
import { Selection } from "@/state/selection";
import { MarkerTool } from "@/state/tools/marker";
import type { PointerSample, ToolContext } from "@/state/tools/tool";

let done: number;
/** Every stroke the tool handed to the writer, in order — the dry half of the
 *  release, which the tool only ever asks for. */
let committed: WetStroke[];
/** The same, kept as the calls rather than flattened — for the one test that is
 *  about there being exactly one of them. */
let commits: (readonly WetStroke[])[];
let tool: MarkerTool;
let ctx: ToolContext;
let camera: Camera;
let scene: Scene;
/** What `ctx.hitTest` answers — the item the press lands on, or the bare cork. */
let under: string | null;
/**
 * When set, `ctx.hitTest` answers by geometry instead of by [`under`].
 *
 * Which is what the app really does, and what a crossing test needs: T-137 asks
 * the hit test on every sample, so a stroke can only run off a photograph if the
 * answer depends on where the sample is.
 */
let byGeometry: boolean;

function at(x: number, y: number, pressure?: number): PointerSample {
  return { x, y, shift: false, ctrl: false, alt: false, pressure };
}

/** A photograph to draw on, at a pose the test chooses. */
function photo(id: string, x: number, y: number, rot = 0): void {
  scene.putItem(
    {
      id,
      type: "polaroid",
      z: "a0",
      seed: 1,
      assetId: null,
      createdBy: 1,
      createdAt: 0,
      text: "",
    },
    { x, y, rot, w: 200, h: 200 },
  );
  under = id;
}

/** Where a sample of the current stroke actually is on the cork — the inverse of
 *  what the tool did on the way in. */
function boardAt(index: number): { x: number; y: number } {
  const sample = live()!.samples[index]!;
  const item = live()!.item;
  if (item === null) return { x: sample.x, y: sample.y };
  const slot = scene.slotOf(item)!;
  const angle = scene.rot[slot]! + scene.swing[slot]!;
  return rotateOut(
    sample.x,
    sample.y,
    scene.renderX(slot),
    scene.renderY(slot),
    Math.cos(angle),
    Math.sin(angle),
  );
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
  return live()?.samples ?? [];
}

/**
 * The run the overlay would draw last — the live one while a pointer is down,
 * or the last drying one after a release.
 *
 * `runsInFlight` is a list because one gesture can cross onto several surfaces
 * (T-137). Almost every test here is about a stroke that stays on one, so they
 * ask for the last run and the list stays out of the way.
 */
function live(): WetStroke | null {
  const runs = tool.runsInFlight;
  return runs[runs.length - 1] ?? null;
}

/**
 * Where the *paper* is, when a test needs it to differ from where the rectangle
 * is — the strip a torn edge gives up (T-186). Null means the two agree, which
 * is what every test written before T-186 assumes.
 */
let paperAt: ((bx: number, by: number) => string | null) | null = null;
/** Which page of the surface under the pen is showing, for `shownPage` — T-278.
 *  Null is a board with nothing open, which is every test above the ones about
 *  redaction. */
let openPage: number | null = null;
/**
 * Every page turn the tool asked for, in order - T-278.
 *
 * A spy rather than the `() => false` this harness held before, because the
 * arrows are the one thing the pen does that leaves no trace: no stroke, no
 * write, nothing in the scene. A call that never happened and a call that
 * happened are identical from everywhere else in this file.
 */
let turned: number[];

/** Every run in flight, for the tests that are about the crossing itself. */
function runs(): readonly WetStroke[] {
  return tool.runsInFlight;
}

beforeEach(() => {
  done = 0;
  committed = [];
  commits = [];
  camera = new Camera();
  camera.resize(1000, 800);
  scene = new Scene();
  under = null;
  byGeometry = false;
  paperAt = null;
  openPage = null;
  turned = [];
  tool = new MarkerTool({ onDone: () => done++ });
  ctx = {
    scene,
    dirty: new DirtySets(),
    camera,
    selection: new Selection(),
    hitTest: (bx, by) => {
      if (!byGeometry) return under;
      for (const id of scene.itemIds()) {
        const pose = scene.poseOf(id);
        if (!pose) continue;
        if (Math.abs(bx - pose.x) <= pose.w / 2 && Math.abs(by - pose.y) <= pose.h / 2) return id;
      }
      return null;
    },
    /**
     * The pen's boundary, which is a *different question* from the grab's
     * (T-186, Q-149) — so the harness has to be able to answer them
     * differently, or the tests that are about the difference cannot be
     * written. `paperAt` is null by default and the two agree.
     */
    inkHitTest: (bx, by) => (paperAt ?? ctx.hitTest)(bx, by),
    /** Which face the surface is showing (T-278). Null unless a test has opened
     *  something, which is every test written before this one. */
    shownPage: () => openPage,
    hitPin: () => null,
    hitString: () => null,
    // Nothing to put a caret in, in a harness with no presentation (T-179).
    edit: () => undefined,
    open: () => false,
    /** True, because a test that presses an arrow has something open. The tool
     *  ignores the answer either way, which is what leaves the count as the only
     *  thing an arrow can be observed by. */
    clip: () => undefined,
    turnPage: (by) => {
      turned.push(by);
      return true;
    },
    follow: () => false,
    held: new Set<string>(),
    write: {
      setPoses: () => {},
      setSizes: () => {},
      deleteItems: () => {},
      setItemStyle: () => {},
      bringToFront: () => {},
      sendToBack: () => {},
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
      commitStrokes: (runs) => {
        commits.push(runs);
        committed.push(...runs);
      },
      eraseStrokes: () => {},
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
    expect(live()).toBeNull();
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
 * T-56 and AC-78.
 *
 * > The stroke's coordinate space is fixed at pen-down: item-local if the press
 * > landed on a photograph, board if it landed on cork. `Ctrl` forces board
 * > space. — DESIGN section 3.9
 *
 * Two halves, and each fails invisibly on its own. Get the space wrong and the
 * mark still appears exactly where you drew it — until the photograph moves,
 * which is the next thing that happens and no longer part of the gesture. Get the
 * *fixing* wrong and a line that crosses an edge is silently cut in half.
 */
describe("which space the stroke is in", () => {
  it("is the board's when the press lands on bare cork", () => {
    camera.setView(0, 0, 1);
    down(600, 500);
    move([at(620, 500)]);

    expect(live()!.item).toBeNull();
    const board = camera.screenToBoard(620, 500);
    expect(boardAt(1).x).toBeCloseTo(board.x, 6);
  });

  it("is the photograph's when the press lands on one", () => {
    camera.setView(0, 0, 1);
    photo("p", 300, 200);
    down(600, 500);
    move([at(620, 500)]);

    expect(live()!.item).toBe("p");
    // Stored local, but still under the cursor: the round trip back out through
    // the item's frame is the board point the hand was actually at.
    const board = camera.screenToBoard(620, 500);
    expect(boardAt(1).x).toBeCloseTo(board.x, 6);
    expect(boardAt(1).y).toBeCloseTo(board.y, 6);
    // And genuinely converted — a tool that stored board coordinates and merely
    // labelled them with an item id would pass the line above only by accident.
    expect(live()!.samples[1]!.x).not.toBeCloseTo(board.x, 1);
  });

  it("stores the samples relative to a photograph that is turned", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0, Math.PI / 3);
    down(500, 400);
    move([at(540, 430)]);

    expect(live()!.item).toBe("p");
    const board = camera.screenToBoard(540, 430);
    expect(boardAt(1).x).toBeCloseTo(board.x, 3);
    expect(boardAt(1).y).toBeCloseTo(board.y, 3);
    // Both axes genuinely turned. A conversion with the sine's sign flipped puts
    // the point back on the cork at the wrong end of the paper, and the round trip
    // through the same flipped frame would hide it.
    expect(live()!.samples[1]!.y).not.toBeCloseTo(board.y, 1);
  });

  /**
   * The press decides where a stroke *starts*. Until T-137 it decided the whole
   * thing — because there was nowhere for the part that ran off the paper to go.
   * Now there is, and what a crossing does is its own suite at the bottom of this
   * file; what is still true here is that the first run is the press's.
   */
  it("gives the first run to whatever the press landed on", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0);
    down(500, 400);
    move([at(520, 400)]);

    expect(committed).toHaveLength(0);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]!.item).toBe("p");
  });

  it("is the board's when Ctrl is held at the press, photograph or not", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0);
    tool.handle({ kind: "down", at: { ...at(500, 400), ctrl: true } }, ctx);
    move([at(520, 400)]);

    // The escape hatch for a mark you want on the cork *behind* a photograph,
    // which the hit test cannot otherwise reach.
    expect(live()!.item).toBeNull();
    const board = camera.screenToBoard(520, 400);
    expect(live()!.samples[1]!.x).toBeCloseTo(board.x, 6);
  });

  it("does not un-glue a stroke when Ctrl is let go of halfway down it", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0);
    tool.handle({ kind: "down", at: { ...at(500, 400), ctrl: true } }, ctx);
    move([at(520, 400)]);
    expect(live()!.item).toBeNull();
  });
});

/**
 * AC-78 itself: "Ink started on a photo stays glued to it through move and
 * rotation."
 *
 * The samples never change. That *is* the mechanism — they are in the paper's
 * own frame, so the paper moving moves them for nothing, and the assertion worth
 * making is the one about where they end up on the cork.
 */
describe("ink glued to a photograph that moves under it", () => {
  it("travels with the paper, without a sample being rewritten", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0);
    down(500, 400);
    move([at(540, 400)]);

    const before = boardAt(1);
    const local = { ...live()!.samples[1]! };
    scene.setPose("p", { x: 250, y: -80 });
    const after = boardAt(1);

    expect(after.x - before.x).toBeCloseTo(250, 6);
    expect(after.y - before.y).toBeCloseTo(-80, 6);
    expect(live()!.samples[1]).toEqual(local);
  });

  it("turns with the paper rather than staying flat on the cork", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0);
    down(500, 400);
    // A sample well off the item's centre, so a rotation has something to move.
    move([at(560, 400)]);

    const before = boardAt(1);
    scene.setPose("p", { rot: Math.PI / 2 });
    const after = boardAt(1);

    // A quarter turn clockwise about the origin — y-down, so `(x, y)` goes to
    // `(-y, x)` (`lib/rotate.ts`). To three places, because the scene holds a
    // rotation as a `Float32Array` and `Math.PI / 2` does not survive that whole.
    expect(after.x).toBeCloseTo(-before.y, 3);
    expect(after.y).toBeCloseTo(before.x, 3);
  });

  it("swings with a photograph hanging from its pin", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0);
    down(500, 400);
    move([at(560, 400)]);
    const before = boardAt(1);

    // The transient half of the rendered pose, which is in nobody's document and
    // is exactly what `itemLocal` exists to account for (`state/tools/frame.ts`).
    const slot = scene.slotOf("p")!;
    scene.swing[slot] = 0.4;
    const after = boardAt(1);

    expect(after.x).not.toBeCloseTo(before.x, 3);
  });

  it("goes when the paper it was drawn on goes", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0);
    down(500, 400);
    move([at(540, 400)]);

    // A peer's delete, or an undo, with the pen still down. Nothing was written,
    // so this costs the mark and nothing else — but the samples already collected
    // have no frame left to be in, and drawing them against the origin would be
    // worse than not drawing them.
    scene.removeItem("p");
    under = null;
    move([at(560, 400), at(580, 400)]);

    expect(live()).toBeNull();
    expect(tool.stroking).toBe(false);
  });

  it("does not restart a spaceless stroke from the rest of the same trail", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0);
    down(500, 400);
    scene.removeItem("p");
    // One call carrying a dozen samples is what the machine delivers, and the
    // stroke ends partway down it.
    move([at(520, 400), at(540, 400), at(560, 400)]);

    expect(live()).toBeNull();
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
    expect(live()!.samples[0]!.pressure).toBe(1);
  });

  it("does not carry one stroke's speed into the next", () => {
    tool.handle({ kind: "down", at: mouse(0, 0, 0) }, ctx);
    move([mouse(60, 0, 5), mouse(120, 0, 10)]);
    const fast = live()!.samples[2]!.pressure;

    tool.handle({ kind: "up", at: mouse(120, 0, 15) }, ctx);
    tool.handle({ kind: "down", at: mouse(500, 500, 100) }, ctx);
    move([mouse(502, 500, 108)]);

    // A stroke that inherited the last one's speed would start at whatever width
    // that one finished at.
    expect(fast).toBeLessThan(0.5);
    expect(live()!.samples[0]!.pressure).toBe(1);
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
    expect(live()).toBeNull();
    down(10, 10);
    // A press that has not moved is not yet evidence of a dot or of a line, and a
    // blob under every click would be the cost of guessing.
    expect(live()).toBeNull();
    move([at(11, 10)]);
    expect(live()).not.toBeNull();
  });

  it("carries the tool, the colour and the board-unit width", () => {
    down(0, 0);
    move([at(10, 0)]);
    expect(live()).toMatchObject({
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
    expect(highlighter.runsInFlight[0]).toMatchObject({ tool: "highlighter", color: "#c9a227", size: 20 });
  });

  it("is a whole pen from a tool name, because a caller that has to remember will forget", () => {
    const highlighter = new MarkerTool({ tool: "highlighter" });
    highlighter.handle({ kind: "down", at: at(0, 0) }, ctx);
    highlighter.handle({ kind: "move", at: at(10, 0), trail: [at(10, 0)] }, ctx);

    // A wide translucent yellow nib, and none of those three named at the call
    // site — `app/main.ts` says which pen it wants and nothing else.
    expect(highlighter.runsInFlight[0]).toMatchObject({
      color: DEFAULT_HIGHLIGHTER_COLOR,
      size: DEFAULT_HIGHLIGHTER_SIZE,
      opacity: DEFAULT_HIGHLIGHTER_OPACITY,
    });
    expect(DEFAULT_HIGHLIGHTER_SIZE).toBeGreaterThan(DEFAULT_INK_SIZE);
  });

  it("gives the marker no translucency at all", () => {
    down(0, 0);
    move([at(10, 0)]);
    // > Marker | Opaque — DESIGN section 3.9. An opacity of anything but 1 here
    // > is a marker that is quietly a highlighter.
    expect(live()!.opacity).toBe(1);
  });
});

describe("letting go", () => {
  it("hands the whole stroke to the writer, once", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0);
    down(500, 400);
    move([at(510, 400), at(520, 400)]);
    up(530, 400);

    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      tool: "marker",
      color: DEFAULT_MARKER_COLOR,
      size: DEFAULT_INK_SIZE,
      item: "p",
    });
    // The release's own position is part of the mark: four samples, not three.
    expect(committed[0]!.samples).toHaveLength(4);
    expect(tool.stroking).toBe(false);
  });

  it("commits a stroke drawn on bare cork the same way, naming no item", () => {
    down(0, 0);
    move([at(10, 0)]);
    up(20, 0);

    // The tool does not know which map the stroke lands in. `item: null` means
    // board space and nothing more; turning that into a `boardInk` tile key is
    // `crdt/ops/ink.ts`'s call (T-61), and a tool that second-guessed it would
    // have to be found and changed again the next time the tiling did.
    expect(committed).toHaveLength(1);
    expect(committed[0]!.item).toBeNull();
  });

  it("commits a click as the dot it is", () => {
    photo("p", 0, 0);
    down(500, 400);
    up(500, 400);

    // The overlay withholds a one-sample stroke because a press that has not
    // moved is not yet evidence of anything. The release is the evidence, and a
    // dot is a mark somebody meant to make — `perfect-freehand` renders these two
    // coincident samples as a round one.
    expect(committed).toHaveLength(1);
    expect(committed[0]!.samples).toHaveLength(2);
    expect(live()).toBe(committed[0]);
  });

  it("commits nothing when the paper went while the pointer was down", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0);
    down(500, 400);
    move([at(520, 400)]);
    scene.removeItem("p");
    under = null;
    move([at(540, 400)]);
    up(560, 400);

    // The samples have no frame left to be in, so there is nothing honest to
    // write. The release finds no stroke in progress and says so.
    expect(committed).toEqual([]);
    expect(live()).toBeNull();
  });

  it("abandons the stroke on a lost pointer, and keeps the tool", () => {
    down(0, 0);
    move([at(10, 0)]);
    tool.handle({ kind: "cancel" }, ctx);

    expect(live()).toBeNull();
    // A window that lost focus mid-stroke has not finished with the marker —
    // `state/tools/note.ts` makes the same argument.
    expect(done).toBe(0);
  });

  it("hands the board back on Escape", () => {
    down(0, 0);
    move([at(10, 0)]);
    tool.handle({ kind: "key", code: "Escape", shift: false, ctrl: false, alt: false }, ctx);

    expect(live()).toBeNull();
    expect(done).toBe(1);
  });

  it("stays in the marker for every other key — nobody draws one stroke", () => {
    tool.handle({ kind: "key", code: "Enter", shift: false, ctrl: false, alt: false }, ctx);
    expect(done).toBe(0);
  });
});

/**
 * T-58's other half, and the reason the commit is not the end of the gesture.
 *
 * The write lands in phase 9 and the item's canvas is filled in phase 6 of a
 * later frame, so a release that stopped drawing the stroke there and then would
 * leave it on neither surface for a frame — a blink under every pen-up. The tool
 * goes on offering the committed stroke to the overlay until its owner says the
 * ink has landed.
 */
describe("drying — the frame between the commit and the ink", () => {
  it("goes on offering the stroke to the overlay after the release", () => {
    camera.setView(0, 0, 1);
    photo("p", 0, 0);
    down(500, 400);
    move([at(520, 400)]);
    up(540, 400);

    // The same stroke that was handed to the writer, not a second copy of it.
    expect(live()).toBe(committed[0]);
    // And not a gesture: nothing is captured, so no hover affordance is
    // suppressed and nothing else on the board thinks a pointer is down.
    expect(tool.stroking).toBe(false);
  });

  it("stops when the owner says the ink has landed", () => {
    down(0, 0);
    move([at(10, 0)]);
    up(20, 0);
    expect(live()).not.toBeNull();

    tool.dry();
    expect(live()).toBeNull();
    // Twice is not an error: the owner calls it both when a commit is refused
    // and when a re-raster completes, and those can be the same stroke.
    tool.dry();
    expect(live()).toBeNull();
  });

  it("drops it on the next press, so it cannot shadow the live stroke", () => {
    down(0, 0);
    move([at(10, 0)]);
    up(20, 0);

    down(500, 500);
    move([at(510, 500)]);

    // The overlay draws one stroke, and it has to be the one under the pointer.
    expect(live()!.samples.map((s) => s.x)).toEqual([500, 510]);
  });

  it("keeps it through a lost pointer, which cannot un-write a record", () => {
    down(0, 0);
    move([at(10, 0)]);
    up(20, 0);
    tool.handle({ kind: "cancel" }, ctx);

    // Losing the window is a reason to forget a stroke that was never written.
    // This one is in the document, and it would appear on the item a frame later
    // whether or not the overlay stopped drawing it.
    expect(live()).toBe(committed[0]);
  });

  it("hands the writer an array the next stroke cannot append to", () => {
    down(0, 0);
    move([at(10, 0)]);
    up(20, 0);
    const held = committed[0]!.samples;

    down(500, 500);
    move([at(510, 500)]);

    // The write is queued to phase 9 and packs the array it was given. A press
    // in between must not have pushed its own samples into it.
    expect(held.map((s) => s.x)).toEqual([0, 10, 20]);
  });
});

describe("the stroke the renderer is handed", () => {
  it("is the live array, so a long stroke is not copied every frame", () => {
    down(0, 0);
    move([at(10, 0)]);
    const first = live()!.samples;
    move([at(20, 0)]);
    expect(live()!.samples).toBe(first);
    expect(first).toHaveLength(3);
  });

  it("is not the array the next stroke appends to", () => {
    down(0, 0);
    move([at(10, 0)]);
    const held = live()!.samples;
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
    expect(live()!.samples).not.toBe(held);
  });
});

/**
 * T-134. `[` and `]` walk a ladder (DESIGN section 3.9), and the right-click
 * menu loads a colour. Both are per *pen* rather than per stroke, which is the
 * property worth pinning: a nib that changed halfway down a line would be a
 * stroke with two widths in it that the document cannot store.
 */
describe("loading the pen", () => {
  it("takes a colour and a width, and gives them to the next stroke", () => {
    tool.load({ color: "#b8342a", size: 15 });
    down(0, 0);
    move([at(10, 0)]);

    expect(live()).toMatchObject({ color: "#b8342a", size: 15 });
    expect(tool.color).toBe("#b8342a");
    expect(tool.size).toBe(15);
  });

  it("does not change the stroke already in progress", () => {
    down(0, 0);
    move([at(10, 0)]);
    tool.load({ size: 48 });
    move([at(20, 0)]);
    up(30, 0);

    // The width is read once, at the release. A stroke that picked up a new nib
    // partway has no way to be stored and no way to be drawn.
    expect(committed[0]!.size).toBe(DEFAULT_INK_SIZE);
  });

  it("steps the ladder rather than scaling by a factor", () => {
    const seen: number[] = [];
    for (let i = 0; i < INK_SIZES.length + 2; i++) {
      seen.push(tool.size);
      tool.step(1);
    }
    // Every size a pen can hold is on the ladder, so every one of them can be
    // marked as current in the menu — which a free-running multiplier would
    // quietly stop being true.
    for (const size of seen) expect(INK_SIZES).toContain(size);
  });

  it("clamps at both ends instead of wrapping round", () => {
    for (let i = 0; i < 20; i++) tool.step(1);
    expect(tool.size).toBe(INK_SIZES[INK_SIZES.length - 1]);

    for (let i = 0; i < 20; i++) tool.step(-1);
    // A held-down `[` is somebody asking for "finer" repeatedly; landing on the
    // fattest nib on the board is the opposite of what they asked for.
    expect(tool.size).toBe(INK_SIZES[0]);
  });

  it("starts each pen on its own default, from a tool name alone", () => {
    expect(tool.kind).toBe("marker");
    expect(tool.color).toBe(DEFAULT_MARKER_COLOR);
    expect(tool.size).toBe(DEFAULT_INK_SIZE);

    const highlighter = new MarkerTool({ tool: "highlighter" });
    expect(highlighter.kind).toBe("highlighter");
    expect(highlighter.color).toBe(DEFAULT_HIGHLIGHTER_COLOR);
    expect(highlighter.size).toBe(DEFAULT_HIGHLIGHTER_SIZE);
  });
});

/**
 * T-137, and Q-37's answer: a line that runs off the paper it started on is
 * broken at the edge and each piece is glued to what it is actually over.
 *
 * The failures here are all quiet ones. Get the split wrong and the mark still
 * looks right until the photograph moves; get the crossing sample wrong and there
 * is a gap the width of one hand-movement, which at speed is several units and at
 * a crawl is nothing at all — so the slow test stroke everybody tries first is the
 * one that cannot detect it.
 */
describe("a stroke that crosses off its surface", () => {
  /** A photograph spanning board 0..200 on both axes, so screen coordinates and
   *  the edge are readable. Board and screen coincide at the default camera. */
  function paper(id: string, cx = 100, cy = 100): void {
    scene.putItem(
      { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
      { x: cx, y: cy, rot: 0, w: 200, h: 200 },
    );
    byGeometry = true;
  }

  it("commits one run per surface, in the order the hand made them", () => {
    paper("p");
    down(100, 100);
    move([at(150, 100), at(250, 100)]);
    up(300, 100);

    expect(committed).toHaveLength(2);
    expect(committed[0]!.item).toBe("p");
    expect(committed[1]!.item).toBeNull();
  });

  /**
   * The crossing point is in both runs, which is what makes the two marks meet.
   * Compared in *board* space because that is the only frame both are expressed
   * in — one is item-local and the other is not.
   */
  it("puts the crossing point in both runs, so they meet at the edge", () => {
    paper("p");
    down(100, 100);
    move([at(150, 100), at(250, 100)]);
    up(250, 100);

    const first = committed[0]!;
    const second = committed[1]!;
    // The photograph's centre is (100, 100), so local + centre is board.
    const endOfFirst = first.samples[first.samples.length - 1]!;
    expect(endOfFirst.x + 100).toBeCloseTo(second.samples[0]!.x, 6);
    expect(endOfFirst.y + 100).toBeCloseTo(second.samples[0]!.y, 6);
  });

  it("converts each run into its own frame and not the other's", () => {
    paper("p");
    down(100, 100);
    move([at(150, 100), at(250, 100)]);
    up(300, 100);

    // Item-local: measured from the photograph's centre.
    expect(committed[0]!.samples.map((s) => s.x)).toEqual([0, 50, 150]);
    // Board: measured from the origin.
    expect(committed[1]!.samples.map((s) => s.x)).toEqual([250, 300]);
  });

  it("crosses back on, and each crossing is another run", () => {
    paper("p");
    down(100, 100);
    // Out over the cork and back onto the paper.
    move([at(250, 100)]);
    up(150, 100);

    expect(committed.map((run) => run.item)).toEqual(["p", null, "p"]);
  });

  it("hands over between two photographs with no cork in between", () => {
    paper("a", 100, 100);
    paper("b", 300, 100);
    down(100, 100);
    move([at(250, 100)]);
    up(300, 100);

    expect(committed.map((run) => run.item)).toEqual(["a", "b"]);
  });

  /**
   * `Ctrl` at the press is the escape hatch for the mark you want on the cork
   * *behind* a photograph. A Ctrl stroke that hopped onto the paper the moment it
   * crossed one would be the opposite of that.
   */
  it("never hands over when Ctrl forced the cork at the press", () => {
    paper("p");
    tool.handle({ kind: "down", at: { x: 300, y: 100, shift: false, ctrl: true, alt: false } }, ctx);
    // Straight across the photograph and out the other side.
    move([at(200, 100), at(100, 100), at(20, 100)]);
    up(-50, 100);

    expect(committed).toHaveLength(1);
    expect(committed[0]!.item).toBeNull();
    expect(committed[0]!.samples.map((s) => s.x)).toEqual([300, 200, 100, 20, -50]);
  });

  /** Ctrl is read at the press and never again — a key let go of halfway down a
   *  line must not change what the line is stuck to. */
  it("ignores Ctrl arriving partway through a stroke", () => {
    paper("p");
    down(100, 100);
    tool.handle(
      { kind: "move", at: { x: 150, y: 100, shift: false, ctrl: true, alt: false }, trail: [] },
      ctx,
    );
    up(150, 100);

    expect(committed).toHaveLength(1);
    expect(committed[0]!.item).toBe("p");
  });

  /**
   * The piece behind the hand has to go on being drawn. It has stopped growing
   * but nothing has rastered it yet, so dropping it would make the part of the
   * mark you had already drawn vanish for two or three frames — mid-stroke, which
   * is worse than the pen-up blink the drying slot exists to prevent.
   */
  it("keeps drawing the runs already behind the hand", () => {
    paper("p");
    down(100, 100);
    move([at(150, 100), at(250, 100), at(300, 100)]);

    expect(runs()).toHaveLength(2);
    expect(runs()[0]!.item).toBe("p");
    expect(runs()[1]!.item).toBeNull();
  });

  /** One point that is the first sample past an edge is the continuation of a
   *  mark that is plainly already there — withholding it opens a gap. */
  it("draws the new run from its very first sample", () => {
    paper("p");
    down(100, 100);
    move([at(150, 100), at(250, 100)]);

    // The second run holds only the crossing point so far, and is drawn anyway.
    expect(runs()).toHaveLength(2);
    expect(runs()[1]!.samples).toHaveLength(1);
  });

  it("makes every run with the pen the press was holding", () => {
    paper("p");
    tool.load({ color: "#b8342a", size: 15 });
    down(100, 100);
    tool.load({ color: "#2a4d8f", size: 2 });
    move([at(250, 100)]);
    up(300, 100);

    for (const run of committed) {
      expect(run).toMatchObject({ color: "#b8342a", size: 15 });
    }
  });

  /** One gesture, one write — which is what makes it one undo entry. Several
   *  calls would be several transactions and several Ctrl+Zs. */
  it("hands every run over in a single call", () => {
    paper("p");
    down(100, 100);
    move([at(250, 100), at(150, 100)]);
    up(300, 100);

    expect(commits).toHaveLength(1);
    expect(commits[0]).toHaveLength(4);
  });
});

/**
 * A run's name, decided at pen-down — T-167.
 *
 * > Rule: keep rendering the ghost, keyed by stroke id, until the document
 * > contains that stroke id. — docs/DATA-MODEL.md section 9.2
 *
 * That rule needs a name that exists while the ink is still wet, which is a
 * whole gesture before the commit that used to mint one. The properties worth
 * holding are the two that make a name a name: it is stable for the life of the
 * run, and no two runs share one.
 */
describe("the id a run is filed under", () => {
  /** A photograph at the origin, 200 square, hit-tested by geometry - the same
   *  fixture the crossing tests above use. */
  function paper(id: string): void {
    scene.putItem(
      { id, type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
      { x: 100, y: 100, rot: 0, w: 200, h: 200 },
    );
    byGeometry = true;
  }

  /** The earliest a run can be observed at all: `runsInFlight` withholds a
   *  one-sample stroke until the gesture proves it was a line rather than a
   *  click, so the first frame with an id on it is the first frame with a run. */
  it("has one on the first frame it is drawn", () => {
    down(100, 100);
    move([at(150, 100)]);
    expect(live()!.id).not.toBe("");
  });

  it("keeps it for the whole run, and hands the same one to the commit", () => {
    down(100, 100);
    move([at(150, 100)]);
    const born = live()!.id;
    move([at(200, 100), at(220, 100)]);
    expect(live()!.id).toBe(born);
    up(250, 100);
    expect(committed).toHaveLength(1);
    expect(committed[0]!.id).toBe(born);
  });

  /** A gesture that crosses an edge is several records, and a peer has to be
   *  able to tell the halves apart — see [`handOver`]. */
  it("gives each run of a crossing gesture its own", () => {
    paper("p");
    down(100, 100);
    move([at(250, 100)]);
    up(300, 100);

    const ids = committed.map((run) => run.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  /** Two marks with one name would be one mark to every peer, and the second
   *  would arrive claiming to be the first's commit. */
  it("never reuses one across gestures", () => {
    down(100, 100);
    move([at(200, 100)]);
    up(250, 100);
    down(400, 400);
    move([at(500, 400)]);
    up(550, 400);

    expect(committed).toHaveLength(2);
    expect(committed[0]!.id).not.toBe(committed[1]!.id);
  });

  it("takes the id source it is given, so a test can name what it is watching", () => {
    let n = 0;
    const named = new MarkerTool({ newId: () => `run-${(n += 1)}` });
    named.handle({ kind: "down", at: at(100, 100) }, ctx);
    named.handle({ kind: "move", at: at(150, 100), trail: [at(150, 100)] }, ctx);
    expect(named.runsInFlight[0]!.id).toBe("run-1");
  });
});

/**
 * The strip a torn edge gives up — T-186, Q-149.
 *
 * The marker asks `inkHitTest` and the select tool asks `hitTest`, and after
 * T-186 those are **different questions with different right answers**. A
 * sheet's silhouette recedes from its rectangle by up to nine board units along
 * a torn head, and ink may not land in the gap.
 *
 * What is asserted here is the *tool's* half: that the pen follows the paper
 * boundary rather than the grab boundary, and that a sample landing in the
 * strip is handed to the surface below by the same crossing rule that handles
 * running off the edge entirely. Whether the polygon itself is right is
 * `render/items/edge.test.ts`'s business, and whether the walk continues past a
 * rejected sheet is `render/items/dom.test.ts`'s.
 */
describe("the strip between a sheet's rectangle and its paper", () => {
  /** A sheet spanning board 0..200 on both axes. */
  function sheet(id: string, cx = 100, cy = 100): void {
    scene.putItem(
      { id, type: "note", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
      { x: cx, y: cy, rot: 0, w: 200, h: 200 },
    );
    byGeometry = true;
  }

  /**
   * The sheet is paper everywhere except a nine-unit band along its head, which
   * is what a torn legal pad looks like: still inside the rectangle, no longer
   * inside the silhouette.
   */
  function torn(id: string): void {
    paperAt = (bx, by) => {
      if (bx < 0 || bx > 200 || by < 0 || by > 200) return null;
      return by < 9 ? null : id;
    };
  }

  it("does not file ink in the strip on the sheet it is inside the rectangle of", () => {
    sheet("s");
    torn("s");
    // Straight down the head of the sheet, four units in — inside the
    // rectangle for its whole length, and on no paper at all.
    down(40, 4);
    move([at(80, 4), at(120, 4)]);
    up(160, 4);

    expect(committed).toHaveLength(1);
    // The cork, because the paper is not there. Before T-186 this said "s".
    expect(committed[0]!.item).toBeNull();
  });

  it("hands the run over at the paper's edge, not at the rectangle's", () => {
    sheet("s");
    torn("s");
    // Down through the strip and onto the paper below it.
    down(100, 2);
    move([at(100, 6), at(100, 40)]);
    up(100, 80);

    expect(committed).toHaveLength(2);
    expect(committed[0]!.item).toBeNull();
    expect(committed[1]!.item).toBe("s");
  });

  it("still draws in the strip — it is a different surface, not a dead zone", () => {
    // The failure Q-149 warns about: narrowing the clip without moving the
    // boundary would leave ink filed on the item and painted nowhere, a hole in
    // the line as wide as the tear. Nothing is ever dropped.
    sheet("s");
    torn("s");
    down(100, 2);
    move([at(100, 6), at(100, 40)]);
    up(100, 80);

    const all = committed.flatMap((run) => run.samples);
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(committed.every((run) => run.samples.length >= 2)).toBe(true);
  });

  it("leaves the grab boundary alone, which is the whole of Q-149's answer", () => {
    // Same board point, two questions. The pen says cork; what you would pick
    // up is still the sheet, because a grab target wants to be forgiving and
    // the strip is the notch of a hand-torn edge, which is where a hand aims.
    sheet("s");
    torn("s");
    expect(ctx.inkHitTest(100, 4)).toBeNull();
    expect(ctx.hitTest(100, 4)).toBe("s");
    // And on the paper proper they agree, which is nearly the whole sheet.
    expect(ctx.inkHitTest(100, 100)).toBe("s");
    expect(ctx.hitTest(100, 100)).toBe("s");
  });

  it("is not consulted when Ctrl forced the gesture onto the cork", () => {
    // `forced` opts the whole gesture out of asking at all, so a torn edge
    // cannot re-file a mark the person deliberately put on the board.
    sheet("s");
    torn("s");
    tool.handle({ kind: "down", at: { ...at(100, 100), ctrl: true } }, ctx);
    move([at(100, 40), at(100, 4)]);
    up(100, 2);
    // One run, on the cork, all the way through — the strip never gets a say
    // because nothing asked it anything.
    expect(committed).toHaveLength(1);
    expect(committed[0]!.item).toBeNull();
  });
});

/**
 * Which face of the paper the mark went on - T-278.
 *
 * A mark made on an open case file belongs to the page that was showing; a mark
 * on anything else belongs to the object. The two are one field on the run and
 * both halves fail silently, because ink with the wrong page on it is drawn in
 * exactly the right place for as long as you stay on the page you drew it on.
 * You find out by turning to page five and reading a redaction that was struck
 * through page three, or by turning back to three and finding it gone.
 *
 * `shownPage` is the *application's* answer rather than the scene's, for the
 * reason `state/tools/tool.ts` gives: the scene knows an item is open and
 * nothing about what is on the paper. So the harness holds it in [`openPage`]
 * and these tests set it the way a reader would: open the folder, then draw.
 */
describe("which page a mark is filed against", () => {
  /**
   * A case file: a sheet spanning board 0..200 on both axes, hit-tested by
   * geometry so that a stroke can genuinely run off it. The same fixture the
   * crossing suite uses, with an asset on it. The item type is a document's
   * (`app/ingest.ts`), and nothing in this file reads either field.
   */
  function folder(id: string, cx = 100, cy = 100): void {
    scene.putItem(
      {
        id,
        type: "polaroid",
        z: "a0",
        seed: 1,
        assetId: "doc",
        createdBy: 1,
        createdAt: 0,
        text: "",
      },
      { x: cx, y: cy, rot: 0, w: 200, h: 200 },
    );
    byGeometry = true;
  }

  it("files a run against the page that was showing under the pen", () => {
    folder("f");
    openPage = 3;
    down(100, 100);
    move([at(120, 100)]);
    up(140, 100);

    expect(committed).toHaveLength(1);
    expect(committed[0]!.item).toBe("f");
    expect(committed[0]!.page).toBe(3);
  });

  it("files a run on the same paper against no page when nothing is open", () => {
    folder("f");
    down(100, 100);
    move([at(120, 100)]);
    up(140, 100);

    // Null is the *object* - the folder's own kraft cover, and the whole of what
    // a photograph has. Not page zero and not "the first page": a tool that
    // coalesced the missing answer to a number would file every mark on the
    // board onto a page of a document most items do not have, and every one of
    // them would disappear the first time something was opened.
    expect(committed[0]!.item).toBe("f");
    expect(committed[0]!.page).toBeNull();
  });

  /**
   * The crossing, which is where the field has to move rather than merely be
   * set. T-137 breaks a line at the edge of the paper and glues each piece to
   * what it is actually over; the face travels with the surface because it is a
   * fact *about* the surface, and the cork has exactly one.
   */
  it("gives the page to the run on the paper and none to the run on the cork", () => {
    folder("f");
    openPage = 3;
    down(100, 100);
    move([at(150, 100), at(250, 100)]);
    up(300, 100);

    expect(committed.map((run) => run.item)).toEqual(["f", null]);
    // A hand-over that carried the page across would file the cork's half of the
    // line onto page three of a folder it is not inside, and the cork would then
    // show that half only while the folder happened to be open at it.
    expect(committed.map((run) => run.page)).toEqual([3, null]);
  });

  it("picks the page up at the edge when the hand crosses the other way", () => {
    folder("f");
    openPage = 3;
    down(300, 100);
    move([at(250, 100), at(150, 100)]);
    up(100, 100);

    expect(committed.map((run) => run.item)).toEqual([null, "f"]);
    // The direction a hand-over that merely *cleared* the page would still pass.
    // This one has to go and ask.
    expect(committed.map((run) => run.page)).toEqual([null, 3]);
  });

  it("carries no page when Ctrl at the press forced the cork under an open folder", () => {
    folder("f");
    openPage = 3;
    tool.handle({ kind: "down", at: { ...at(100, 100), ctrl: true } }, ctx);
    move([at(150, 100)]);
    up(180, 100);

    // `Ctrl` is the escape hatch for a mark you want on the cork *behind* the
    // paper, and the cork has no pages. One filed on page three of the folder it
    // was deliberately put behind would vanish the moment the reader turned
    // over, which is the opposite of what the escape hatch is for.
    expect(committed).toHaveLength(1);
    expect(committed[0]!.item).toBeNull();
    expect(committed[0]!.page).toBeNull();
  });
});

/**
 * Turning a page with the pen still in hand - T-278.
 *
 * The binding is the select tool's (T-321), and the reason the marker needs it
 * too is the gesture page-aware ink was built for: blacking out a name on page
 * four of a fifty page filing means *getting to* page four, and a pen that could
 * not turn one would make that Escape, arrow, `M` for every page.
 */
describe("turning the page while the marker is held", () => {
  function key(
    code: string,
    mods: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {},
  ): void {
    tool.handle(
      {
        kind: "key",
        code,
        shift: mods.shift ?? false,
        ctrl: mods.ctrl ?? false,
        alt: mods.alt ?? false,
      },
      ctx,
    );
  }

  it("turns forward on the right arrow and back on the left", () => {
    key("ArrowRight");
    key("ArrowRight");
    key("ArrowLeft");

    expect(turned).toEqual([1, 1, -1]);
    // And it is not Escape by another name: the pen stays in the reader's hand,
    // because the next thing they are going to do is draw on the page they just
    // turned to.
    expect(done).toBe(0);
  });

  it("refuses while the hand is down, so a run cannot outlive the page it is on", () => {
    camera.setView(0, 0, 1);
    photo("f", 0, 0);
    openPage = 3;
    down(500, 400);
    move([at(520, 400)]);
    key("ArrowRight");
    up(540, 400);

    // The run's page is fixed at the press and is not re-asked, so a turn
    // accepted here would leave the mark filed against a page that is no longer
    // the one the hand is drawing on. The mark would simply be somewhere nobody
    // is looking.
    expect(turned).toEqual([]);
    expect(committed[0]!.page).toBe(3);
  });

  it("refuses with a modifier held, which is somebody else's shortcut", () => {
    key("ArrowRight", { shift: true });
    key("ArrowRight", { ctrl: true });
    key("ArrowLeft", { alt: true });

    expect(turned).toEqual([]);
  });
});
