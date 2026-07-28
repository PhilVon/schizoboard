/**
 * @vitest-environment happy-dom
 *
 * happy-dom has no 2D context, so one is stubbed — which is not a limitation
 * here. What is worth pinning down is *where* a peer is drawn, *in what colour*,
 * and whether the canvas is touched at all, and all three are countable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { PeerPainter } from "@/render/presence/draw";
import type { DrawnPeer, PeerSource } from "@/render/presence/peers";
import { Camera } from "@/state/camera";
import { Scene, type ItemCold, type ItemPose } from "@/state/scene";

interface Calls {
  cleared: number;
  /** Every path point, in the order it was laid down. */
  lines: [number, number][];
  /** Centre and radius of every arc. */
  arcs: [number, number, number][];
  translate: [number, number][];
  rotate: number[];
  /** `strokeRect` with the colour and width in force, which is the whole claim. */
  rects: { box: [number, number, number, number]; stroke: string; width: number }[];
  /** The colour in force at each `fill()` — the arrow's identity. */
  fills: string[];
  /** Text, and where it was put relative to the translate in force. */
  text: { value: string; at: [number, number] }[];
  /** The composite op at each `stroke()`, so the erase pass can be told apart. */
  strokes: { width: number; style: string; op: string }[];
}

let calls: Calls;
let ctx: CanvasRenderingContext2D;
let camera: Camera;
let scene: Scene;
let painter: PeerPainter;

function stub(): CanvasRenderingContext2D {
  const c = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    clip: vi.fn(),
    translate: (...a: [number, number]) => calls.translate.push(a),
    rotate: (a: number) => calls.rotate.push(a),
    moveTo: (...a: [number, number]) => calls.lines.push(a),
    lineTo: (...a: [number, number]) => calls.lines.push(a),
    arc: (x: number, y: number, r: number) => calls.arcs.push([x, y, r]),
    strokeRect: (...box: [number, number, number, number]) =>
      calls.rects.push({ box, stroke: c.strokeStyle, width: c.lineWidth }),
    stroke: () =>
      calls.strokes.push({
        width: c.lineWidth,
        style: c.strokeStyle,
        op: c.globalCompositeOperation,
      }),
    fill: () => calls.fills.push(c.fillStyle),
    strokeText: (value: string, x: number, y: number) => calls.text.push({ value, at: [x, y] }),
    fillText: (value: string, x: number, y: number) => calls.text.push({ value, at: [x, y] }),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
    font: "",
    textBaseline: "alphabetic",
    globalCompositeOperation: "source-over",
  };
  return c as unknown as CanvasRenderingContext2D;
}

/** The overlay's deferred clear, as this module sees it. */
const clear = (): void => {
  calls.cleared += 1;
};

function peer(over: Partial<DrawnPeer> = {}): DrawnPeer {
  return {
    id: "7",
    name: "Blue peer",
    color: "#2c5aa8",
    cursor: null,
    items: [],
    strings: [],
    pins: [],
    locks: [],
    ...over,
  };
}

function source(...list: DrawnPeer[]): PeerSource {
  return {
    version: 1,
    chromed: list.some(
      (p) => p.items.length + p.strings.length + p.pins.length + p.locks.length > 0,
    ),
    peers: () => list,
  };
}

/** Free-floating, so its world position is the one given rather than an item's. */
function pin(id: string, wx: number, wy: number): void {
  scene.putPin({ id, parent: null, lx: 0, ly: 0, kind: "pin", color: "#c0392b", wx, wy });
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

beforeEach(() => {
  calls = {
    cleared: 0,
    lines: [],
    arcs: [],
    translate: [],
    rotate: [],
    rects: [],
    fills: [],
    text: [],
    strokes: [],
  };
  ctx = stub();
  camera = new Camera();
  camera.resize(1000, 800);
  scene = new Scene();
  painter = new PeerPainter();
});

describe("PeerPainter cursors", () => {
  it("puts the arrow's tip at the peer's board position, through the camera", () => {
    camera.zoomTo(2, 0, 0);
    expect(painter.cursors(ctx, camera, source(peer({ cursor: { x: 100, y: 50 } })), clear)).toBe(
      true,
    );
    // The tip is the origin of the arrow's own path, and the translate is what
    // places it — so the translate *is* the claim about where the peer is.
    const at = camera.boardToScreen(100, 50, { x: 0, y: 0 });
    expect(calls.translate).toEqual([[at.x, at.y]]);
    expect(calls.lines[0]).toEqual([0, 0]);
  });

  it("fills the arrow in the peer's own colour", () => {
    painter.cursors(ctx, camera, source(peer({ color: "#4a7a4e", cursor: { x: 0, y: 0 } })), clear);
    expect(calls.fills).toContain("#4a7a4e");
  });

  it("draws every peer, and names each one", () => {
    painter.cursors(
      ctx,
      camera,
      source(
        peer({ id: "1", name: "Red peer", color: "#a8322c", cursor: { x: 0, y: 0 } }),
        peer({ id: "2", name: "Green peer", color: "#4a7a4e", cursor: { x: 20, y: 20 } }),
      ),
      clear,
    );
    expect(calls.translate).toHaveLength(2);
    // Outlined and then filled, so each name is painted twice.
    expect(calls.text.map((t) => t.value)).toEqual([
      "Red peer",
      "Red peer",
      "Green peer",
      "Green peer",
    ]);
  });

  it("does not touch the canvas for a peer whose pointer is off their board", () => {
    expect(painter.cursors(ctx, camera, source(peer({ cursor: null })), clear)).toBe(false);
    expect(calls.cleared).toBe(0);
  });

  /**
   * The tip is the anchor and the body hangs down and to the right of it, so the
   * reject is asymmetric — the arrow is off screen well before its tip is.
   */
  it("rejects a cursor whose whole arrow is off the viewport", () => {
    expect(painter.cursors(ctx, camera, source(peer({ cursor: { x: -600, y: 0 } })), clear)).toBe(
      false,
    );
    expect(painter.cursors(ctx, camera, source(peer({ cursor: { x: 1100, y: 0 } })), clear)).toBe(
      false,
    );
    expect(calls.cleared).toBe(0);
    // A tip just off the left edge still shows most of an arrow, and draws.
    expect(painter.cursors(ctx, camera, source(peer({ cursor: { x: -10, y: 0 } })), clear)).toBe(
      true,
    );
  });
});

describe("PeerPainter chrome", () => {
  it("outlines a peer's item outside our own chrome, in their colour", () => {
    add("i1");
    painter.chrome(ctx, camera, scene, source(peer({ color: "#c9a227", items: ["i1"] })), clear);

    expect(calls.rects).toHaveLength(1);
    const { box, stroke, width } = calls.rects[0]!;
    expect(stroke).toBe("#c9a227");
    expect(width).toBe(2);
    // 100 board units at zoom 1 is a 50 px half-extent; ours stands at
    // SELECT_PAD (3.25) and a peer's four further out.
    expect(box[2] / 2).toBeCloseTo(50 + 3.25 + 4, 5);
  });

  it("turns the outline with the item it is drawn round", () => {
    add("i1", { rot: 0.4 });
    painter.chrome(ctx, camera, scene, source(peer({ items: ["i1"] })), clear);
    // Out of a `Float32Array`, so it comes back a rounding short of what went in.
    expect(calls.rotate).toHaveLength(1);
    expect(calls.rotate[0]).toBeCloseTo(0.4, 6);
  });

  it("skips an item the peer names and this board does not have", () => {
    expect(painter.chrome(ctx, camera, scene, source(peer({ items: ["gone"] })), clear)).toBe(false);
    expect(calls.cleared).toBe(0);
  });

  it("rings a peer's pins", () => {
    pin("p1", 40, 20);
    expect(
      painter.chrome(ctx, camera, scene, source(peer({ color: "#a8322c", pins: ["p1"] })), clear),
    ).toBe(true);
    expect(calls.arcs).toHaveLength(1);
    const at = camera.boardToScreen(40, 20, { x: 0, y: 0 });
    expect(calls.arcs[0]![0]).toBeCloseTo(at.x, 5);
    expect(calls.arcs[0]![1]).toBeCloseTo(at.y, 5);
    expect(calls.strokes[0]!.style).toBe("#a8322c");
  });

  it("clears exactly once however much chrome one peer has", () => {
    add("i1");
    add("i2", { x: 200 });
    pin("p1", 0, 0);
    painter.chrome(ctx, camera, scene, source(peer({ items: ["i1", "i2"], pins: ["p1"] })), clear);
    // The callback is called per drawable thing; the overlay's own `clear` is
    // the one that deduplicates. What matters is that it was reached at all.
    expect(calls.cleared).toBeGreaterThan(0);
    expect(calls.rects).toHaveLength(2);
    expect(calls.arcs).toHaveLength(1);
  });
});

describe("PeerPainter strings", () => {
  const ropes = {
    positions: new Float64Array([0, 0, 50, 10, 100, 0]),
    visit(id: string, fn: (at: number, count: number) => void): void {
      if (id === "s1") fn(0, 3);
    },
    /** One gap, `p0` to `p1`, on the one string this fixture has. */
    segment(id: string, a: string, b: string, fn: (at: number, count: number) => void): void {
      if (id === "s1" && a === "p0" && b === "p1") fn(0, 3);
    },
  };

  it("outlines the string by laying a colour down and taking the middle back out", () => {
    scene.putString({
      id: "s1",
      nodes: [],
      color: "#2c5aa8",
      thickness: 3,
      material: "cotton",
      layer: "over",
      closed: false,
    });

    expect(
      painter.strings(ctx, camera, scene, ropes, source(peer({ strings: ["s1"] })), clear),
    ).toBe(true);
    expect(calls.strokes).toHaveLength(2);
    // Wide in the peer's colour...
    expect(calls.strokes[0]!.style).toBe("#2c5aa8");
    expect(calls.strokes[0]!.op).toBe("source-over");
    // ...then narrower, erasing, so what is left is a fringe rather than a wash.
    expect(calls.strokes[1]!.op).toBe("destination-out");
    expect(calls.strokes[1]!.width).toBeLessThan(calls.strokes[0]!.width);
  });

  it("skips a string this board no longer has", () => {
    expect(
      painter.strings(ctx, camera, scene, ropes, source(peer({ strings: ["s1"] })), clear),
    ).toBe(false);
    expect(calls.cleared).toBe(0);
  });
});

/**
 * The advisory lock of DATA-MODEL section 5.4, drawn — T-130, Q-83.
 *
 * It says "somebody has hold of this", which is the sentence the rest of the
 * peer chrome speaks, so it speaks it in the same words: their colour, laid
 * down and punched through, the same fringe a selected string gets. What tells
 * the two apart is the extent — a whole string lit is a selection, one gap lit
 * is somebody about to cut there.
 */
describe("PeerPainter locks", () => {
  const ropes = {
    positions: new Float64Array([0, 0, 50, 10, 100, 0]),
    visit(id: string, fn: (at: number, count: number) => void): void {
      if (id === "s1") fn(0, 3);
    },
    segment(id: string, a: string, b: string, fn: (at: number, count: number) => void): void {
      if (id === "s1" && a === "p0" && b === "p1") fn(0, 3);
    },
  };

  const HELD = { string: "s1", a: "p0", b: "p1" };

  function run(): void {
    scene.putString({
      id: "s1",
      nodes: [],
      color: "#a8322c",
      thickness: 3,
      material: "cotton",
      layer: "over",
      closed: false,
    });
  }

  it("does nothing for a peer holding nothing, which is nearly all of them", () => {
    run();
    expect(painter.locks(ctx, camera, scene, ropes, source(peer()), clear)).toBe(false);
    expect(calls.cleared).toBe(0);
  });

  it("lays the peer's colour down and takes the middle back out", () => {
    run();
    expect(
      painter.locks(ctx, camera, scene, ropes, source(peer({ color: "#2c5aa8", locks: [HELD] })), clear),
    ).toBe(true);

    expect(calls.strokes).toHaveLength(2);
    expect(calls.strokes[0]!.style).toBe("#2c5aa8");
    expect(calls.strokes[0]!.op).toBe("source-over");
    expect(calls.strokes[1]!.op).toBe("destination-out");
    expect(calls.strokes[1]!.width).toBeLessThan(calls.strokes[0]!.width);
  });

  /** Along the rope where it actually hangs, not along the chord between the
   *  two pins — a segment with drape in it is nowhere near its own chord. */
  it("walks the rope particles of that one gap", () => {
    run();
    painter.locks(ctx, camera, scene, ropes, source(peer({ locks: [HELD] })), clear);

    expect(calls.lines).toHaveLength(3);
    expect(calls.lines[1]![1]).not.toBe(calls.lines[0]![1]);
  });

  it("skips a string this board no longer has", () => {
    expect(
      painter.locks(ctx, camera, scene, ropes, source(peer({ locks: [HELD] })), clear),
    ).toBe(false);
    expect(calls.cleared).toBe(0);
  });

  /** A gap this rope does not have — a pin removed under them, or a claim from
   *  a board further ahead than this one. Nothing to light, and their cursor is
   *  still sitting on it. */
  it("draws nothing for a gap the rope cannot find", () => {
    run();
    expect(
      painter.locks(
        ctx,
        camera,
        scene,
        ropes,
        source(peer({ locks: [{ string: "s1", a: "p7", b: "p8" }] })),
        clear,
      ),
    ).toBe(false);
    expect(calls.strokes).toHaveLength(0);
  });
});
