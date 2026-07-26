/**
 * @vitest-environment happy-dom
 *
 * happy-dom has no 2D context and no `Path2D`, so both are stubbed. That is
 * not much of a limitation for what is worth pinning down here, which is not
 * what the pixels look like but *what calls the painter makes*: three strokes
 * per batch, a line width that does not move with the zoom, an offset pass
 * instead of a blur, and nothing at all on a frame where nothing changed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { lighten, RopeLayer } from "@/render/ropes/paint";
import { LIGHT_DX, LIGHT_DY } from "@/render/items/shadow";
import { RopeSet } from "@/sim/ropes";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene, type StringNodes } from "@/state/scene";

interface Calls {
  clearRect: number;
  strokes: Array<{ width: number; style: string; tx: number; ty: number }>;
  /** Anything that would be a blur rather than a second pass — AC-69. */
  forbidden: string[];
  moves: Array<[number, number]>;
  lines: Array<[number, number]>;
}

let calls: Calls;
let scene: Scene;
let ropes: RopeSet;
let camera: Camera;
let dirty: DirtySets;

class StubPath {
  moveTo(x: number, y: number): void {
    calls.moves.push([x, y]);
  }
  lineTo(x: number, y: number): void {
    calls.lines.push([x, y]);
  }
  addPath(): void {
    /* batching is counted through `strokes`, not here */
  }
}

function stubCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 800;
  // The context tracks its own translate stack so a stroke can report where it
  // was actually drawn — which is the whole of the shadow and highlight test.
  let tx = 0;
  let ty = 0;
  const stack: Array<[number, number]> = [];
  const ctx = {
    save: () => stack.push([tx, ty]),
    restore: () => {
      const previous = stack.pop();
      if (previous) [tx, ty] = previous;
    },
    setTransform: vi.fn(),
    translate: (x: number, y: number) => {
      tx += x;
      ty += y;
    },
    clearRect: () => {
      calls.clearRect++;
    },
    stroke: () => {
      calls.strokes.push({ width: ctx.lineWidth, style: String(ctx.strokeStyle), tx, ty });
    },
    beginPath: vi.fn(),
    strokeStyle: "" as string,
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    set shadowBlur(_v: number) {
      calls.forbidden.push("shadowBlur");
    },
    set shadowColor(_v: string) {
      calls.forbidden.push("shadowColor");
    },
    set filter(_v: string) {
      calls.forbidden.push("filter");
    },
  };
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  return canvas;
}

function pin(id: string, x: number, y: number): void {
  scene.putPin({ id, parent: null, lx: x, ly: y, kind: "pushpin", color: "#c8352f", wx: x, wy: y });
}

/** A string in both the scene mirror and the rope set, the way the binding
 *  and `RopeSet.sync` between them would leave it. */
function string(id: string, a: string, b: string, style: Partial<StringNodes> = {}): void {
  scene.strings.set(id, {
    id,
    nodes: [
      { pin: a, slackAfter: 0.2 },
      { pin: b, slackAfter: 0.2 },
    ],
    color: "#a8322c",
    thickness: 3,
    material: "string",
    layer: "over",
    closed: false,
    ...style,
  });
  ropes.setString(scene, dirty, id, [a, b], [0.2, 0.2], false);
}

/** A frame with something to draw, then the dirty sets consumed. */
function draw(layer: RopeLayer): boolean {
  const drew = layer.draw(scene, ropes, camera, dirty);
  dirty.clear();
  return drew;
}

beforeEach(() => {
  calls = { clearRect: 0, strokes: [], forbidden: [], moves: [], lines: [] };
  (globalThis as { Path2D?: unknown }).Path2D = StubPath;
  scene = new Scene();
  ropes = new RopeSet();
  camera = new Camera();
  camera.resize(1000, 800);
  dirty = new DirtySets();
  pin("p1", 0, 0);
  pin("p2", 200, 0);
});

describe("the three passes", () => {
  it("strokes shadow, body and highlight — and nothing else", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    expect(calls.strokes).toHaveLength(3);
  });

  /** > Shadow — offset along the light direction, dark, low alpha, wider than
   *  > the string. — DESIGN section 4.6 */
  it("puts the shadow down-light, wider and translucent", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);

    const [shadow, body] = calls.strokes;
    expect(shadow.style).toMatch(/^rgba\(0, 0, 0, 0\./);
    expect(shadow.width).toBeGreaterThan(body.width);
    // Offset along the light, which is down and to the right.
    expect(shadow.tx / shadow.ty).toBeCloseTo(LIGHT_DX / LIGHT_DY, 6);
    expect(shadow.ty).toBeGreaterThan(0);
  });

  it("draws the body at the string's own colour and width, unoffset", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { color: "#2c5aa8", thickness: 4 });
    draw(layer);

    const body = calls.strokes[1];
    expect(body.style).toBe("#2c5aa8");
    expect(body.width).toBe(4);
    expect([body.tx, body.ty]).toEqual([0, 0]);
  });

  /** > Highlight — a brighter tint at reduced width, offset perpendicular to
   *  > the light by about a pixel. — DESIGN section 4.6 */
  it("puts the highlight across the light, brighter and narrower", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);

    const [, body, highlight] = calls.strokes;
    expect(highlight.width).toBeLessThan(body.width);
    // Never so thin it rasterises to a smear — see HIGHLIGHT_MIN.
    expect(highlight.width).toBeGreaterThanOrEqual(1.25);
    expect(highlight.style).toBe(lighten("#a8322c", 0.42));
    // Perpendicular: the dot product with the light direction is zero.
    expect(highlight.tx * LIGHT_DX + highlight.ty * LIGHT_DY).toBeCloseTo(0, 6);
    expect(Math.hypot(highlight.tx, highlight.ty)).toBeGreaterThan(0);
  });

  /**
   * AC-69, stated as the thing that would be slow rather than as a style
   * preference: `shadowBlur` is per-pixel gaussian work on every stroke and
   * would dominate the frame on a board of any size.
   */
  it("never reaches for a blur", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    expect(calls.forbidden).toEqual([]);
  });
});

describe("the highlight floor", () => {
  /** A default three-pixel string is the common case, and a plain fraction of
   *  it is a one-pixel stroke that reads as nothing at all. */
  it("keeps the highlight visible on a thin string", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { thickness: 3 });
    draw(layer);
    expect(calls.strokes[2].width).toBe(1.25);
  });

  it("still scales with a thick one", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { thickness: 10 });
    draw(layer);
    expect(calls.strokes[2].width).toBeCloseTo(3.8, 6);
  });
});

describe("line widths at every zoom (AC-70)", () => {
  /**
   * The whole argument for drawing in screen space. A board-space stroke would
   * be five times thinner at 20% and four times fatter at 400%; here the only
   * thing the camera touches is the *points*.
   */
  it("is the same width zoomed out to 15% as in at 400%", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { thickness: 3 });

    const widthsAt = (zoom: number): number[] => {
      calls.strokes.length = 0;
      camera.zoomTo(zoom, 500, 400);
      dirty.rope("s1");
      draw(layer);
      return calls.strokes.map((s) => s.width);
    };

    const wide = widthsAt(0.15);
    const close = widthsAt(4);
    expect(wide).toEqual(close);
    expect(wide[1]).toBe(3);
  });

  /** And the points *do* move with the camera, or nothing would be drawn in
   *  the right place. */
  it("moves the geometry with the camera even though the width holds", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    const first = calls.moves[0];

    calls.moves.length = 0;
    // About the viewport centre, so the pin at the board origin genuinely
    // lands somewhere else on screen.
    camera.zoomTo(2, 500, 400);
    draw(layer);
    expect(calls.moves[0]).not.toEqual(first);
  });
});

describe("batching", () => {
  /** > Strokes batch by colour and width into as few paths as possible.
   *  > — DESIGN section 6.4 */
  it("draws forty identical strings in three strokes", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    for (let i = 0; i < 40; i++) {
      pin(`a${i}`, i * 10, 0);
      pin(`b${i}`, i * 10, 200);
      string(`s${i}`, `a${i}`, `b${i}`);
    }
    draw(layer);
    expect(calls.strokes).toHaveLength(3);
  });

  it("splits a batch when the colour or the width differs", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    pin("p3", 0, 200);
    pin("p4", 200, 200);
    pin("p5", 0, 400);
    pin("p6", 200, 400);
    string("s1", "p1", "p2");
    string("s2", "p3", "p4", { color: "#2c5aa8" });
    string("s3", "p5", "p6", { thickness: 6 });
    draw(layer);
    expect(calls.strokes).toHaveLength(9);
  });
});

describe("the two canvases", () => {
  /** > `'over'` draws above items and collides with them; `'under'` draws
   *  > beneath and doesn't. — DESIGN section 5.6 */
  it("each draws only the strings that belong to it", () => {
    const over = new RopeLayer(stubCanvas(), "over");
    pin("p3", 0, 200);
    pin("p4", 200, 200);
    string("s1", "p1", "p2", { layer: "over" });
    string("s2", "p3", "p4", { layer: "under" });

    draw(over);
    // One batch, not two: the under string was not this canvas's business.
    expect(calls.strokes).toHaveLength(3);
  });

  /** A blank canvas being cleared is a full backing-store write for nothing,
   *  and on a board where every string is over the items that would be the
   *  `under` layer's contribution to every single frame. */
  it("does not even clear when it has nothing to draw and nothing on it", () => {
    const under = new RopeLayer(stubCanvas(), "under");
    string("s1", "p1", "p2", { layer: "over" });
    expect(draw(under)).toBe(false);
    expect(calls.strokes).toHaveLength(0);
    expect(calls.clearRect).toBe(0);
  });

  /** It does clear when there *was* something, or last frame's picture would
   *  linger after the string was tucked behind. */
  it("clears when its last string moves to the other layer", () => {
    const under = new RopeLayer(stubCanvas(), "under");
    string("s1", "p1", "p2", { layer: "under" });
    draw(under);
    expect(calls.strokes).toHaveLength(3);

    calls.clearRect = 0;
    calls.strokes.length = 0;
    scene.strings.get("s1")!.layer = "over";
    dirty.string("s1");
    expect(draw(under)).toBe(true);
    expect(calls.clearRect).toBe(1);
    expect(calls.strokes).toHaveLength(0);
  });
});

describe("an idle board", () => {
  /** The other half of AC-65: a frame where the camera is still and no rope
   *  moved is a frame where the canvas already holds the right picture. */
  it("does not touch the canvas when nothing changed", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    expect(draw(layer)).toBe(true);
    calls.clearRect = 0;
    calls.strokes.length = 0;

    for (let i = 0; i < 20; i++) expect(draw(layer)).toBe(false);
    expect(calls.clearRect).toBe(0);
    expect(calls.strokes).toHaveLength(0);
  });

  it("redraws when the camera moves, because the cache is in screen space", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    calls.strokes.length = 0;

    camera.panByScreen(40, 0);
    expect(draw(layer)).toBe(true);
    expect(calls.strokes).toHaveLength(3);
  });

  it("redraws the one string that moved without re-walking the rest", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    for (let i = 0; i < 5; i++) {
      pin(`a${i}`, i * 10, 0);
      pin(`b${i}`, i * 10, 200);
      string(`s${i}`, `a${i}`, `b${i}`);
    }
    draw(layer);
    const walked = calls.moves.length;
    expect(walked).toBe(5);

    calls.moves.length = 0;
    dirty.rope("s2");
    draw(layer);
    // Only the dirty string lost its cached path.
    expect(calls.moves).toHaveLength(1);
  });

  it("re-walks everything after an invalidate", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    calls.moves.length = 0;

    layer.invalidate();
    dirty.rope("s1");
    draw(layer);
    expect(calls.moves).toHaveLength(1);
  });
});

describe("culling", () => {
  it("skips a string nowhere near the viewport", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    pin("far1", 90000, 90000);
    pin("far2", 90200, 90000);
    string("near", "p1", "p2");
    string("far", "far1", "far2");
    draw(layer);
    // Two strings exist; one was walked.
    expect(calls.moves).toHaveLength(1);
  });
});

describe("the highlight tint", () => {
  it("pushes a colour toward white without changing its hue much", () => {
    expect(lighten("#000000", 0.5)).toBe("#808080");
    expect(lighten("#ffffff", 0.5)).toBe("#ffffff");
    expect(lighten("#a8322c", 0)).toBe("#a8322c");
    expect(lighten("#a8322c", 1)).toBe("#ffffff");
  });

  /** A colour the painter cannot parse draws a string with no highlight
   *  rather than throwing inside the paint path. */
  it("hands back anything it does not understand, unchanged", () => {
    expect(lighten("red", 0.5)).toBe("red");
    expect(lighten("#abc", 0.5)).toBe("#abc");
    expect(lighten("rgb(1,2,3)", 0.5)).toBe("rgb(1,2,3)");
  });
});
