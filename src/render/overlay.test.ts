/**
 * @vitest-environment happy-dom
 *
 * happy-dom has no 2D context, so one is stubbed. That is not a limitation
 * here: what is worth pinning down is *when* the overlay touches the canvas at
 * all, and the calls it makes when it does — both of which are countable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { Overlay } from "@/render/overlay";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemCold, type ItemPose } from "@/state/scene";
import { Selection } from "@/state/selection";

interface Calls {
  clearRect: number;
  fillRect: [number, number, number, number][];
  strokeRect: [number, number, number, number][];
  rotate: number[];
  translate: [number, number][];
  lineWidths: number[];
  /** The rotation knob: centre and radius of every arc drawn. */
  arcs: [number, number, number][];
  lines: [number, number][];
  /** The `lineWidth` in force at each `stroke()`. Separate from `lineWidths`,
   *  which is the width at each `strokeRect` — the two chrome families do not
   *  share a stroke call and must not share an assertion. */
  strokeWidths: number[];
  /** Wet ink is the one thing on this canvas that is filled from a `Path2D`. */
  fills: number;
}

let calls: Calls;
let camera: Camera;
let scene: Scene;
let selection: Selection;
let dirty: DirtySets;
let overlay: Overlay;

function stubCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 800;
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    translate: (...args: [number, number]) => calls.translate.push(args),
    rotate: (angle: number) => calls.rotate.push(angle),
    clearRect: () => {
      calls.clearRect++;
    },
    fillRect: (...args: [number, number, number, number]) => calls.fillRect.push(args),
    strokeRect: (...args: [number, number, number, number]) => {
      calls.strokeRect.push(args);
      calls.lineWidths.push(ctx.lineWidth);
    },
    beginPath: vi.fn(),
    moveTo: (...args: [number, number]) => calls.lines.push(args),
    lineTo: (...args: [number, number]) => calls.lines.push(args),
    arc: (x: number, y: number, r: number) => calls.arcs.push([x, y, r]),
    stroke: () => {
      calls.strokeWidths.push(ctx.lineWidth);
    },
    fill: () => {
      calls.fills++;
    },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
  };
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  return canvas;
}

/** Centred on the origin, so screen coordinates come out of the camera alone. */
function add(id: string, pose: Partial<ItemPose> = {}, cold: Partial<ItemCold> = {}): void {
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
      ...cold,
    },
    { x: 0, y: 0, rot: 0, w: 100, h: 100, ...pose },
  );
}

/** One frame of the OVERLAY phase, with the marquee off unless asked for. */
function frame(marquee: Parameters<Overlay["draw"]>[3] = null): void {
  overlay.draw(camera, scene, selection, marquee, dirty);
}

beforeEach(() => {
  calls = {
    clearRect: 0,
    fillRect: [],
    strokeRect: [],
    rotate: [],
    translate: [],
    lineWidths: [],
    arcs: [],
    lines: [],
    strokeWidths: [],
    fills: 0,
  };
  camera = new Camera();
  camera.resize(1000, 800);
  scene = new Scene();
  selection = new Selection();
  dirty = new DirtySets();
  overlay = new Overlay(stubCanvas());
});

describe("Overlay", () => {
  it("costs nothing on a frame with nothing to draw", () => {
    frame();
    frame();
    expect(calls.clearRect).toBe(0);
  });

  it("draws the marquee through the camera, in screen space", () => {
    camera.zoomTo(2, 0, 0);
    frame({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
    expect(calls.fillRect).toEqual([[20, 40, 200, 100]]);
    expect(calls.strokeRect).toHaveLength(1);
  });

  it("clears the frame after the marquee goes, and then stops", () => {
    frame({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(calls.clearRect).toBe(1);

    // One clear to take the marquee away...
    frame();
    expect(calls.clearRect).toBe(2);
    // ...and none at all after that.
    frame();
    expect(calls.clearRect).toBe(2);
  });

  /**
   * AC-140, and the reason the chrome moved off the item's own DOM. As a CSS
   * outline its 1.5px was 1.5 *board* units: 0.075 screen pixels at the 5% floor
   * and 6 at the 400% ceiling.
   */
  it("holds its width and its offset in screen pixels across the whole zoom range", () => {
    add("a");
    selection.add("a");
    camera.centreOn(0, 0);

    const padAt = (zoom: number): number => {
      calls.strokeRect.length = 0;
      calls.lineWidths.length = 0;
      camera.zoomTo(zoom, 500, 400);
      frame();
      const [x, , w] = calls.strokeRect[0]!;
      expect(calls.lineWidths[0]).toBe(1.5);
      // The item is 100 units wide, so whatever the stroke is wider than
      // `100 * zoom` is the offset, in screen pixels, twice over.
      expect(w).toBeCloseTo(-2 * x, 6);
      return (w - 100 * zoom) / 2;
    };

    expect(padAt(0.05)).toBeCloseTo(3.25, 6);
    expect(padAt(1)).toBeCloseTo(3.25, 6);
    expect(padAt(4)).toBeCloseTo(3.25, 6);
  });

  it("rides the angle the item is actually drawn at, swing and all", () => {
    add("a", { rot: 0.2 });
    scene.swing[scene.slotOf("a")!] = 0.05;
    selection.add("a");
    frame();
    // Approximate because the scene stores Float32 — 0.2 + 0.05 comes back as
    // 0.2500000037, which is three billionths of a radian.
    expect(calls.rotate).toHaveLength(1);
    expect(calls.rotate[0]).toBeCloseTo(0.25, 6);
  });

  it("grows with the carry, so a photograph being dragged keeps its outline", () => {
    add("a");
    selection.add("a");
    frame();
    const resting = calls.strokeRect[0]![2];

    calls.strokeRect.length = 0;
    scene.lift[scene.slotOf("a")!] = 1;
    dirty.item("a");
    frame();
    // 2% of 100 units at zoom 1, and the offset is unchanged either side of it.
    expect(calls.strokeRect[0]![2]).toBeCloseTo(resting + 2, 6);
  });

  it("does not redraw an idle board just because something is selected", () => {
    add("a");
    selection.add("a");
    frame();
    expect(calls.clearRect).toBe(1);

    // Nothing has moved, nothing has been selected or deselected, and the camera
    // is where it was. Redrawing would reach the identical picture.
    frame();
    frame();
    expect(calls.clearRect).toBe(1);

    // A selected item under a drag is exactly what makes it stale again.
    dirty.item("a");
    frame();
    expect(calls.clearRect).toBe(2);
    // As is a pan, because the chrome is in screen space.
    dirty.clear();
    camera.panByScreen(10, 0);
    frame();
    expect(calls.clearRect).toBe(3);
  });

  it("hangs a rotation knob off one selected item, on its own side of the paper", () => {
    add("a", { rot: 0 });
    selection.add("a");
    camera.centreOn(0, 0);
    frame();

    // 50 units of item, 3.25 of chrome offset and 26 of stalk, straight up.
    expect(calls.arcs).toHaveLength(1);
    const [x, y, r] = calls.arcs[0]!;
    expect(x).toBeCloseTo(500, 6);
    expect(y).toBeCloseTo(400 - 79.25, 6);
    expect(r).toBeCloseTo(4.5, 6);
    // The stalk starts at the outline, not at the item's centre — it is a mark
    // in the cork, not a line drawn across the photograph.
    expect(calls.lines[0]![1]).toBeCloseTo(400 - 53.25, 6);
  });

  it("gives a group no knob — DESIGN hands group rotation to R+drag", () => {
    add("a", { x: -200 });
    add("b", { x: 200 });
    selection.replace(["a", "b"]);
    camera.centreOn(0, 0);
    frame();
    expect(calls.strokeRect).toHaveLength(2);
    expect(calls.arcs).toHaveLength(0);
  });

  it("ignores an item that moved but is not selected", () => {
    add("a");
    add("b");
    selection.add("a");
    frame();
    dirty.item("b");
    frame();
    expect(calls.clearRect).toBe(1);
  });

  it("leaves nothing behind when the selection is cleared", () => {
    add("a");
    selection.add("a");
    frame();
    expect(calls.strokeRect).toHaveLength(1);

    calls.strokeRect.length = 0;
    selection.clear();
    frame();
    expect(calls.clearRect).toBe(2);
    expect(calls.strokeRect).toHaveLength(0);
  });

  it("does not clear a blank canvas to arrive at a blank canvas", () => {
    // A selection entirely off screen is stale on every frame of a pan and draws
    // nothing on any of them, so the clear has to be deferred until something is
    // actually about to be drawn.
    add("far", { x: 100_000, y: 100_000 });
    selection.add("far");
    camera.centreOn(0, 0);
    frame();
    camera.panByScreen(10, 0);
    frame();
    camera.panByScreen(10, 0);
    frame();
    expect(calls.clearRect).toBe(0);
    expect(calls.strokeRect).toHaveLength(0);
  });

  it("skips a selected item the viewport cannot see", () => {
    // Selection is not culled — a marquee can take in the whole board — so
    // whether an off-screen one costs a stroke is this module's decision.
    add("near");
    add("far", { x: 100_000, y: 100_000 });
    selection.replace(["near", "far"]);
    camera.centreOn(0, 0);
    frame();
    expect(calls.strokeRect).toHaveLength(1);
  });

  it("survives a selection holding an item a collaborator deleted", () => {
    add("a");
    selection.add("a");
    frame();

    scene.removeItem("a");
    dirty.item("a");
    // `Selection.prune` clears the ghost, but not before this frame draws.
    expect(() => frame()).not.toThrow();
    expect(calls.strokeRect).toHaveLength(1);
  });
});

/**
 * String chrome: the point on the rope under the cursor, and the halo along a
 * selected one (DESIGN section 3.4).
 *
 * Both are walked from the rope particles rather than from the pins, so the
 * geometry here is a stand-in pool with the sag left in it — a straight line
 * would not tell the two apart.
 */
describe("Overlay, strings", () => {
  /** Three particles hanging between (0, 0) and (200, 0), sagging to y = 40. */
  const pool = new Float64Array([0, 0, 100, 40, 200, 0]);
  const ropes = {
    positions: pool,
    visit: (id: string, fn: (at: number, count: number) => void): void => {
      if (id === "s") fn(0, 3);
    },
  };

  function putString(thickness = 3): void {
    scene.putString({
      id: "s",
      nodes: [
        { nodeId: "n0", pin: "p0", slackAfter: 0.2 },
        { nodeId: "n1", pin: "p1", slackAfter: 0.2 },
      ],
      color: "#a8322c",
      thickness,
      material: "string",
      layer: "over",
      closed: false,
    });
  }

  function draw(hover: { x: number; y: number } | null = null): void {
    overlay.draw(camera, scene, selection, null, dirty, null, null, ropes, hover);
  }

  it("marks the point on the string under the cursor", () => {
    camera.centreOn(0, 0);
    draw({ x: 0, y: 0 });
    // A disc, at the point itself — not at the cursor, and not on the chord.
    expect(calls.arcs).toHaveLength(1);
    expect(calls.arcs[0]![0]).toBeCloseTo(500, 6);
    expect(calls.arcs[0]![1]).toBeCloseTo(400, 6);
  });

  it("clears the frame after the highlight goes, and then costs nothing", () => {
    camera.centreOn(0, 0);
    draw({ x: 0, y: 0 });
    const cleared = calls.clearRect;

    // It was there and is not now, so the canvas is wrong until it is wiped...
    draw(null);
    expect(calls.clearRect).toBe(cleared + 1);
    // ...and once wiped, an idle board with nothing on the canvas is free.
    draw(null);
    expect(calls.clearRect).toBe(cleared + 1);
  });

  it("traces a selected string along its particles, not its chord", () => {
    putString();
    selection.replaceStrings(["s"]);
    camera.centreOn(0, 0);
    draw();

    expect(calls.lines).toEqual([
      [500, 400],
      [600, 440],
      [700, 400],
    ]);
  });

  /**
   * The halo is an outline, not a wash: a wide pale stroke, then the band over
   * the string itself taken back out. Stroke the first without the second and
   * the selected string reads as faded — which is what it did on a real board
   * the first time, and what no unit test would have noticed.
   */
  it("rings the string rather than painting over it", () => {
    putString(9);
    selection.replaceStrings(["s"]);
    // `strokeRect` is what records widths, so read the context back instead.
    const seen: { width: number; op: string }[] = [];
    const ctx = overlay as unknown as {
      ctx: { lineWidth: number; globalCompositeOperation: string; stroke: () => void };
    };
    const stroke = ctx.ctx.stroke;
    ctx.ctx.globalCompositeOperation = "source-over";
    ctx.ctx.stroke = (): void => {
      seen.push({ width: ctx.ctx.lineWidth, op: ctx.ctx.globalCompositeOperation });
      stroke();
    };
    draw();

    expect(seen).toHaveLength(2);
    expect(seen[0]!.op).toBe("source-over");
    expect(seen[0]!.width).toBeGreaterThan(9);
    // The cut-out is narrower than the halo and no narrower than the string, so
    // what survives is a fringe either side and nothing over the top.
    expect(seen[1]!.op).toBe("destination-out");
    expect(seen[1]!.width).toBeLessThan(seen[0]!.width);
    expect(seen[1]!.width).toBeGreaterThanOrEqual(9);
  });

  it("restrokes a selected string that is still moving, and nothing else", () => {
    putString();
    selection.replaceStrings(["s"]);
    draw();
    const cleared = calls.clearRect;

    // A rope settling is the one thing that changes this picture without
    // touching the camera, the selection or any item.
    dirty.rope("s");
    draw();
    expect(calls.clearRect).toBe(cleared + 1);

    dirty.clear();
    draw();
    expect(calls.clearRect).toBe(cleared + 1);
  });

  it("survives a selection holding a string a collaborator deleted", () => {
    putString();
    selection.replaceStrings(["s"]);
    draw();
    const lines = calls.lines.length;

    scene.removeString("s");
    dirty.string("s");
    expect(() => draw()).not.toThrow();
    expect(calls.lines).toHaveLength(lines);
  });
});

/**
 * Selected pins, which arrive only as part of a thread (DESIGN section 3.3).
 *
 * Two things are worth pinning down and both are countable: the ring is drawn
 * where the pin actually is, and a still board holding a thread does not
 * restroke — while a thread whose pins are moving does.
 */
describe("chrome for a selected pin", () => {
  function putPin(id: string, parent: string | null, x: number, y: number): void {
    scene.putPin({ id, parent, lx: x, ly: y, kind: "pushpin", color: "#c8352f", wx: x, wy: y });
  }

  it("rings each selected pin where the pin is", () => {
    putPin("p", null, 0, 0);
    putPin("q", null, 100, 0);
    selection.replaceThread([], [], ["p"]);
    frame();

    // Two passes over one pin, dark under pale — so two arcs, same centre.
    expect(calls.arcs.length).toBe(2);
    const [x, y, r] = calls.arcs[0]!;
    const at = camera.boardToScreen(0, 0);
    expect(x).toBeCloseTo(at.x, 5);
    expect(y).toBeCloseTo(at.y, 5);
    expect(r).toBeGreaterThan(0);
    expect(calls.arcs[1]!.slice(0, 2)).toEqual([x, y]);
  });

  it("rings every pin of a thread, and no others", () => {
    for (let i = 0; i < 4; i++) putPin(`p${i}`, null, i * 50, 0);
    selection.replaceThread([], [], ["p0", "p2"]);
    frame();
    expect(calls.arcs.length).toBe(4); // two pins, two passes
    const centres = calls.arcs.map(([x]) => Math.round(x)).sort((a, b) => a - b);
    const p0 = Math.round(camera.boardToScreen(0, 0).x);
    const p2 = Math.round(camera.boardToScreen(100, 0).x);
    expect(centres).toEqual([p0, p0, p2, p2]);
  });

  /** The whole point of the staleness gate: a thread sitting still is free. */
  it("does not restroke a still board holding a thread", () => {
    putPin("p", null, 0, 0);
    selection.replaceThread([], [], ["p"]);
    frame();
    const drawn = calls.arcs.length;
    frame();
    frame();
    expect(calls.arcs.length).toBe(drawn);
  });

  /**
   * A free pin dragged across bare cork moves without any item moving, which is
   * exactly what `dirty.pins` is for — and a gate that only watched
   * `dirty.items` would leave the ring behind at the pin's old position.
   */
  it("redraws when a selected free pin moves", () => {
    putPin("p", null, 0, 0);
    selection.replaceThread([], [], ["p"]);
    frame();
    const drawn = calls.arcs.length;

    scene.pins.get("p")!.wx = 200;
    dirty.pin("p");
    frame();
    expect(calls.arcs.length).toBeGreaterThan(drawn);
    expect(Math.round(calls.arcs[drawn]![0]!)).toBe(
      Math.round(camera.boardToScreen(200, 0).x),
    );
  });

  /** And a parented one rides the photograph it is pushed into, where the item
   *  is what is dirty. */
  it("redraws when the item a selected pin is pushed into moves", () => {
    add("a", { x: 0, y: 0 });
    putPin("p", "a", 0, 0);
    selection.replaceThread([], [], ["p"]);
    frame();
    const drawn = calls.arcs.length;

    scene.setPose("a", { x: 300 });
    scene.layoutPins();
    dirty.item("a");
    frame();
    expect(calls.arcs.length).toBeGreaterThan(drawn);
  });

  it("skips a pin a collaborator deleted before prune caught up", () => {
    putPin("p", null, 0, 0);
    selection.replaceThread([], [], ["p", "ghost"]);
    frame();
    expect(calls.arcs.length).toBe(2);
  });

  it("draws nothing at all for a selection of no kind", () => {
    putPin("p", null, 0, 0);
    frame();
    expect(calls.arcs.length).toBe(0);
  });
});

/**
 * > | See its threads | Hover | Every string through the pin highlights |
 * > — DESIGN section 3.3
 *
 * The lit wash is one stroke per string at the string's own width, so what is
 * countable here is how many strokes and how wide — which is exactly the
 * difference between this and the selection halo, and the thing that would
 * silently drift if somebody reused the halo's constants.
 */
describe("Overlay, hovering a pin lights its threads", () => {
  const pool = new Float64Array([0, 0, 100, 40, 200, 0, 200, 0, 300, 40, 400, 0]);
  const ropes = {
    positions: pool,
    visit: (id: string, fn: (at: number, count: number) => void): void => {
      if (id === "s0") fn(0, 3);
      if (id === "s1") fn(6, 3);
    },
  };

  function run(id: string, thickness: number, ...pins: string[]): void {
    scene.putString({
      id,
      nodes: pins.map((p, i) => ({ nodeId: `${id}-n${i}`, pin: p, slackAfter: 0.2 })),
      color: "#a8322c",
      thickness,
      material: "string",
      layer: "over",
      closed: false,
    });
  }

  function draw(hoveredPin: string | null): void {
    overlay.draw(camera, scene, selection, null, dirty, null, null, ropes, null, hoveredPin);
  }

  it("lights the string through the pin, at the string's own width", () => {
    run("s0", 7, "hub", "far");
    draw("hub");
    // One stroke at the string's own thickness — not the halo's two, and not
    // widened. A hover must not look like a selection.
    expect(calls.lines.length).toBe(3);
    expect(calls.strokeWidths).toEqual([7]);
  });

  /** A hub can host strings of different thicknesses, so the width is set per
   *  string rather than hoisted out of the loop with the colour. */
  it("uses each string's own thickness", () => {
    run("s0", 3, "hub", "a");
    run("s1", 9, "hub", "b");
    draw("hub");
    expect([...calls.strokeWidths].sort((a, b) => a - b)).toEqual([3, 9]);
  });

  /** The hub pin of DESIGN section 2.3, which is what makes this worth having:
   *  hover it and the whole junction lights up at once. */
  it("lights every string of a hub pin", () => {
    run("s0", 3, "hub", "a");
    run("s1", 3, "hub", "b");
    draw("hub");
    // Two polylines of three points each: six moveTo/lineTo calls.
    expect(calls.lines.length).toBe(6);
  });

  it("lights nothing for a pin with no strings on it", () => {
    run("s0", 3, "hub", "a");
    draw("bare");
    expect(calls.lines.length).toBe(0);
  });

  it("lights nothing when the cursor is on no pin at all", () => {
    run("s0", 3, "hub", "a");
    draw(null);
    expect(calls.lines.length).toBe(0);
  });

  /** Moving off a pin has to clear, or the last thread stays lit for as long as
   *  nothing else happens to touch this canvas. */
  it("clears the frame the cursor leaves the pin", () => {
    run("s0", 3, "hub", "a");
    draw("hub");
    const before = calls.clearRect;
    const lit = calls.lines.length;
    draw(null);
    expect(calls.clearRect).toBeGreaterThan(before);
    // Cleared, and nothing drawn in its place.
    expect(calls.lines.length).toBe(lit);
  });

  /** A still board with the cursor resting on a pin is free, like everything
   *  else on this canvas. */
  it("does not restroke while the cursor rests on the same pin", () => {
    run("s0", 3, "hub", "a");
    draw("hub");
    const drawn = calls.lines.length;
    draw("hub");
    draw("hub");
    expect(calls.lines.length).toBe(drawn);
  });

  /** The lit strings sag and settle like any others. */
  it("restrokes when a lit string moves", () => {
    run("s0", 3, "hub", "a");
    draw("hub");
    const drawn = calls.lines.length;
    dirty.rope("s0");
    draw("hub");
    expect(calls.lines.length).toBeGreaterThan(drawn);
  });
});

/**
 * Wet ink — the stroke being drawn, on the canvas DESIGN section 6.2 names for
 * it. `render/ink/wet.test.ts` covers what the fill looks like; what matters here
 * is that this canvas notices a stroke at all, and notices when one has gone.
 */
describe("the stroke in progress", () => {
  class StubPath {
    moveTo(): void {}
    quadraticCurveTo(): void {}
    closePath(): void {}
  }

  function wet(count: number, item: string | null = null): Parameters<Overlay["draw"]>[10] {
    const samples = [];
    for (let i = 0; i < count; i++) samples.push({ x: i * 20, y: 0, pressure: 0.5 });
    return { tool: "marker", color: "#1f1b17", size: 6, opacity: 1, item, samples };
  }

  function draw(count: number, item: string | null = null): void {
    overlay.draw(
      camera,
      scene,
      selection,
      null,
      dirty,
      null,
      null,
      null,
      null,
      null,
      wet(count, item),
    );
  }

  beforeEach(() => {
    (globalThis as { Path2D?: unknown }).Path2D = StubPath;
  });

  it("fills the stroke on every frame it grows", () => {
    draw(4);
    expect(calls.fills).toBe(1);
    draw(5);
    expect(calls.fills).toBe(2);
  });

  it("clears the mark on the frame after the release", () => {
    draw(4);
    const cleared = calls.clearRect;
    // The release changes nothing else on this canvas, so without a flag of its
    // own the mark would sit there until something unrelated happened to move.
    frame();
    expect(calls.clearRect).toBe(cleared + 1);
    expect(calls.fills).toBe(1);
  });

  it("costs nothing for a press that has not moved yet", () => {
    draw(1);
    expect(calls.fills).toBe(0);
    expect(calls.clearRect).toBe(0);
  });

  it("resolves the item a glued stroke names, so the ink can be placed", () => {
    add("p", { x: 400, y: 0 });
    draw(4, "p");
    expect(calls.fills).toBe(1);
  });

  it("draws nothing when the paper the stroke is glued to has gone", () => {
    // A peer's delete with the pen still down. There is no frame to put the
    // samples in, and the origin is not a reasonable guess at one.
    draw(4, "gone");
    expect(calls.fills).toBe(0);
  });
});
