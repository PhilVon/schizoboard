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

import { DEFAULT_SLACK, MIN_SLACK, presetSlack } from "@/lib/slack";
import { lighten, RopeLayer, slackRung } from "@/render/ropes/paint";
import { LIGHT_DX, LIGHT_DY, RESTING_LIFT } from "@/render/items/shadow";
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
  scene.putString({
    id,
    nodes: [
      { nodeId: `${id}-n0`, pin: a, slackAfter: 0.2 },
      { nodeId: `${id}-n1`, pin: b, slackAfter: 0.2 },
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

/**
 * T-66 — the lift shadow.
 *
 * > Where the string crosses over an item it's physically lifted off the cork,
 * > so the offset widens and the alpha drops. That single detail is what sells
 * > draping. — DESIGN section 4.6
 *
 * The sim decides *where* (`sim/collide.ts` flags the particles); what is
 * checked here is that the painter turns those flags into a second, further,
 * fainter shadow pass and leaves everything else alone.
 */
describe("the lift shadow", () => {
  /** Put a photograph under the string and let the rope settle onto it, which
   *  is what sets the flags the painter reads. */
  function drapeOverItem(): void {
    scene.putItem(
      { id: "photo", type: "polaroid", z: "a0", seed: 1, assetId: null, createdBy: 1, createdAt: 0, text: "" },
      { x: 100, y: 60, rot: 0, w: 200, h: 100 },
    );
    dirty.item("photo");
    ropes.wake("s1");
    for (let i = 0; i < 400 && ropes.awake > 0; i++) {
      ropes.step(scene, dirty, 1000 / 60);
      dirty.clear();
    }
    dirty.rope("s1");
  }

  it("adds a fourth pass, further down-light and fainter", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    drapeOverItem();
    calls.strokes.length = 0;
    draw(layer);

    expect(calls.strokes).toHaveLength(4);
    const [flat, lift, body] = calls.strokes;
    // Same light, further along it, wider and weaker.
    expect(lift!.tx / lift!.ty).toBeCloseTo(LIGHT_DX / LIGHT_DY, 6);
    expect(lift!.ty).toBeGreaterThan(flat!.ty);
    expect(lift!.width).toBeGreaterThan(flat!.width);
    expect(alphaOf(lift!.style)).toBeLessThan(alphaOf(flat!.style));
    // And it is still a shadow, not a second string.
    expect(lift!.style).toMatch(/^rgba\(0, 0, 0, 0\./);
    expect(body!.style).toBe("#a8322c");
  });

  /** A board with nothing draped on it must cost exactly what it always did —
   *  three strokes, and no second walk of the points to split. */
  it("costs nothing on a string that is lying on bare cork", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    expect(calls.strokes).toHaveLength(3);
  });

  /** The lift is the *item's* thickness. A string whose shadow said it was
   *  further off the cork than the paper it lies on is the one thing this
   *  effect cannot survive, so the number is the item sprite's own. */
  it("lifts the string by exactly as much as the item is lifted", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    drapeOverItem();
    calls.strokes.length = 0;
    draw(layer);

    const [flat, lift] = calls.strokes;
    expect(Math.hypot(lift!.tx, lift!.ty) - Math.hypot(flat!.tx, flat!.ty)).toBeCloseTo(
      RESTING_LIFT,
      6,
    );
  });

  /**
   * And it shrinks with the zoom, which nothing else in this painter does.
   *
   * A line width is about legibility and must not shrink; this is a physical
   * height — the thickness of a sheet of paper — and the item's own shadow is
   * displaced by that height in *board* units, so it does. Left in screen
   * pixels the two disagree everywhere but 100%: at 50% the string's shadow sat
   * three times further from the string than the note's from the note, and read
   * as the string floating above the paper. Reported off a real board.
   */
  it("scales that lift with the zoom, so it agrees with the item's own shadow", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    drapeOverItem();

    const liftAt = (zoom: number): number => {
      camera.zoom = zoom;
      calls.strokes.length = 0;
      draw(layer);
      const [flat, lift] = calls.strokes;
      return Math.hypot(lift!.tx, lift!.ty) - Math.hypot(flat!.tx, flat!.ty);
    };

    expect(liftAt(1)).toBeCloseTo(RESTING_LIFT, 6);
    expect(liftAt(0.5)).toBeCloseTo(RESTING_LIFT / 2, 6);
    expect(liftAt(2)).toBeCloseTo(RESTING_LIFT * 2, 6);
  });

  /**
   * The two shadows partition the string; neither link is drawn by both.
   *
   * The first version put the link spanning the change into both paths, meaning
   * to soften the join — but two translucent strokes over each other are just
   * darker, so every place a string climbed onto a photograph grew a short dark
   * dash. Reported off a real board.
   */
  it("never draws the flat and lifted shadows over each other", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    drapeOverItem();

    let links = 0;
    ropes.visit("s1", (_at, count) => {
      links += count - 1;
    });
    expect(links).toBeGreaterThan(4);

    calls.lines.length = 0;
    draw(layer);

    // One walk for the body path, and one for the two shadow paths between
    // them. Any link claimed twice shows up here as an extra `lineTo`.
    expect(calls.lines).toHaveLength(links * 2);
  });

  /** An `under` string passes behind items and is never flagged, so the layer
   *  that draws it never splits a shadow. */
  it("never appears on the under layer", () => {
    const layer = new RopeLayer(stubCanvas(), "under");
    string("s1", "p1", "p2", { layer: "under" });
    ropes.setString(scene, dirty, "s1", ["p1", "p2"], [0.2, 0.2], false, "string", "under");
    draw(layer);
    drapeOverItem();
    calls.strokes.length = 0;
    draw(layer);
    expect(calls.strokes).toHaveLength(3);
  });
});

function alphaOf(style: string): number {
  return Number(/rgba\(0, 0, 0, ([0-9.]+)\)/.exec(style)?.[1] ?? "1");
}

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

describe("what a string is made of", () => {
  /**
   * AC-268's second half — "yarn reads thicker and fuzzier". Thicker is the
   * body width and fuzzier is a fourth stroke, and the fourth stroke is the
   * one worth pinning down: it is the only place in this file that departs
   * from DESIGN section 4.6's three, so it had better be there for yarn and
   * absent for everything else.
   */
  it("gives yarn a fourth pass, wider than the body and under it", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { material: "yarn" });
    draw(layer);

    expect(calls.strokes).toHaveLength(4);
    const [, halo, body] = calls.strokes;
    // The body's own colour rather than a tint, at reduced alpha — stray fibre
    // is the same wool, not a highlight on it.
    expect(halo.style).toBe(body.style);
    expect(halo.width).toBeGreaterThan(body.width);
    // Not offset: it surrounds the strand rather than sitting to one side of
    // it, which is what separates fuzz from a second shadow.
    expect([halo.tx, halo.ty]).toEqual([0, 0]);
  });

  it("leaves string and wire on DESIGN 4.6's three", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { material: "wire" });
    draw(layer);
    expect(calls.strokes).toHaveLength(3);

    calls.strokes.length = 0;
    string("s2", "p1", "p2", { material: "string" });
    draw(layer);
    // Two strings now, both on three passes, and both in the same batch as
    // each other only if they agree on everything — they do not, so six.
    expect(calls.strokes).toHaveLength(6);
  });

  /** One thickness, three materials, three widths — with wire the thinnest
   *  thing on the board and yarn the fattest. */
  it("draws yarn wider than string and wire thinner, at one thickness", () => {
    // One string, restyled — the same id each time, so each draw has exactly
    // one thing on it and the passes below are unambiguously that thing's.
    const widths = (material: string): number => {
      calls.strokes.length = 0;
      const layer = new RopeLayer(stubCanvas(), "over");
      string("s1", "p1", "p2", { material, thickness: 4.5 });
      draw(layer);
      // The body is the pass at no offset drawn in the full body colour.
      return calls.strokes.find((s) => s.tx === 0 && s.ty === 0 && s.style === "#a8322c")!.width;
    };
    expect(widths("wire")).toBeLessThan(widths("string"));
    expect(widths("yarn")).toBeGreaterThan(widths("string"));
  });

  /**
   * `palette.ts` floors its ladder at 2 px because a 1 px body rasterises to a
   * smear, and notes it has no floor of its own to save it. A material weight
   * is what can push it back under, so this is that floor being load-bearing
   * rather than decorative: the thinnest rung in the thinnest material.
   */
  it("will not draw a wire thinner than the eye can resolve", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { material: "wire", thickness: 2 });
    draw(layer);
    expect(calls.strokes[1].width).toBeGreaterThanOrEqual(1.75);
  });

  /** Bright and tight for metal, dim and spread for wool — the two knobs have
   *  to move in opposite directions or the pair are just two cottons. */
  it("makes wire's highlight brighter and narrower than yarn's", () => {
    const highlightOf = (material: string): { width: number; style: string } => {
      calls.strokes.length = 0;
      const layer = new RopeLayer(stubCanvas(), "over");
      string("s1", "p1", "p2", { material, thickness: 4.5 });
      draw(layer);
      return calls.strokes[calls.strokes.length - 1];
    };
    const wire = highlightOf("wire");
    const yarn = highlightOf("yarn");

    expect(wire.width).toBeLessThan(yarn.width);
    // "Brighter" as the lift toward white: a higher red channel on the same
    // body colour is the whole of what more sheen means.
    const red = (hex: string): number => Number.parseInt(hex.slice(1, 3), 16);
    expect(red(wire.style)).toBeGreaterThan(red(yarn.style));
    // And still a colour rather than white, or a red wire and a blue one would
    // be the same wire — see HIGHLIGHT_LIFT_MAX.
    expect(wire.style).not.toBe("#ffffff");
  });

  /**
   * The batch key. Two materials can land on the same body width off different
   * rungs of the ladder — yarn at 2 and plain string at 3 are both 3 px — and
   * merging them would draw one of them with the other's highlight.
   */
  it("keeps two materials apart even when they draw the same width", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { material: "yarn", thickness: 2 });
    string("s2", "p1", "p2", { material: "string", thickness: 3 });
    draw(layer);
    // Four for the yarn and three for the string. One batch would be three.
    expect(calls.strokes).toHaveLength(7);
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

/**
 * > A taut string is very slightly thinner than a slack one.
 * > — DESIGN section 4.6
 *
 * Which is a fact about one *gap*, so the interesting half of this is that a
 * single run can be drawn at two widths — and the other interesting half is
 * that doing so did not cost the batching.
 */
describe("a taut gap draws thinner than a slack one", () => {
  /** A run of pins along y=0, with a slack per gap. */
  function run(id: string, pins: readonly string[], slacks: readonly number[]): void {
    for (let i = 0; i < pins.length; i++) pin(pins[i]!, i * 200, 0);
    scene.putString({
      id,
      nodes: pins.map((p, i) => ({ nodeId: `${id}-n${i}`, pin: p, slackAfter: slacks[i] ?? 0.2 })),
      color: "#a8322c",
      thickness: 6,
      material: "string",
      layer: "over",
      closed: false,
    });
    ropes.setString(scene, dirty, id, [...pins], [...slacks], false);
  }

  /** The body pass: no offset, drawn in the string's own colour. */
  function bodyWidths(): number[] {
    return calls.strokes.filter((s) => s.tx === 0 && s.ty === 0 && s.style === "#a8322c").map((s) => s.width);
  }

  /**
   * The rungs are boundaries on the same geometric ladder the `1`-`9` presets
   * walk, so pressing a preset lands squarely on one rather than a hair either
   * side of it. That is the whole reason they are derived rather than chosen.
   */
  it("puts its boundaries where the presets stop", () => {
    expect([1, 2].map((p) => slackRung(presetSlack(p)))).toEqual([0, 0]);
    expect([3, 4].map((p) => slackRung(presetSlack(p)))).toEqual([1, 1]);
    expect([5, 6, 7].map((p) => slackRung(presetSlack(p)))).toEqual([2, 2, 2]);
    expect([8, 9].map((p) => slackRung(presetSlack(p)))).toEqual([3, 3]);
  });

  /** So no board that has not been deliberately re-slacked changes width. */
  it("leaves an untouched string on the rung that draws at the width it always did", () => {
    expect(slackRung(DEFAULT_SLACK)).toBe(2);

    const layer = new RopeLayer(stubCanvas(), "over");
    run("s", ["a", "b"], [DEFAULT_SLACK, DEFAULT_SLACK]);
    draw(layer);
    expect(bodyWidths()).toEqual([6]);
  });

  it("draws a taut run thinner than a draped one", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    run("taut", ["t0", "t1"], [MIN_SLACK, MIN_SLACK]);
    run("draped", ["d0", "d1"], [presetSlack(9), presetSlack(9)]);
    draw(layer);

    const [taut, draped] = bodyWidths().sort((a, b) => a - b);
    expect(taut).toBeLessThan(6);
    expect(draped).toBeGreaterThan(6);
    // "Very slightly" — the whole span, end to end, is under a fifth.
    expect(draped / taut).toBeLessThan(1.2);
  });

  /**
   * AC-242. Pull a pin out of the middle of a run and one side goes tight
   * while the other keeps its drape; a width averaged over the string would
   * say neither, and this is the case that catches it.
   */
  it("varies by segment, so one run can be two widths", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    run("mixed", ["m0", "m1", "m2"], [MIN_SLACK, presetSlack(9), 0]);
    draw(layer);
    const widths = bodyWidths().sort((a, b) => a - b);
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeLessThan(widths[1]!);
  });

  /**
   * AC-243, which is the constraint the whole quantisation exists to satisfy:
   * a run of five gaps that agree is one batch and therefore three strokes, not
   * three per gap. Sleeping boards of five hundred strings are a handful of
   * calls only for as long as that holds.
   */
  it("still batches — a run of five equal gaps is one stroke set", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    run("long", ["l0", "l1", "l2", "l3", "l4", "l5"], Array.from({ length: 6 }, () => DEFAULT_SLACK));
    draw(layer);
    expect(calls.strokes).toHaveLength(3);
    // And it really did walk all five gaps into that one path.
    expect(calls.moves).toHaveLength(5);
  });

  /** And a mixed run costs one stroke set per rung it uses, not per gap. */
  it("costs a stroke set per rung, not per segment", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    run("mixed", ["m0", "m1", "m2", "m3", "m4"], [MIN_SLACK, MIN_SLACK, presetSlack(9), presetSlack(9), 0]);
    draw(layer);
    expect(calls.strokes).toHaveLength(6);
    expect(calls.moves).toHaveLength(4);
  });

  /**
   * The floor `bodyWidth` applies is still the last word: the thinnest rung of
   * the thinnest material must not go under the width the same argument
   * already called illegible.
   */
  it("will not let the thin rung push a wire under the floor", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    pin("w0", 0, 0);
    pin("w1", 200, 0);
    scene.putString({
      id: "w",
      nodes: [
        { nodeId: "w-n0", pin: "w0", slackAfter: MIN_SLACK },
        { nodeId: "w-n1", pin: "w1", slackAfter: MIN_SLACK },
      ],
      color: "#a8322c",
      thickness: 2,
      material: "wire",
      layer: "over",
      closed: false,
    });
    ropes.setString(scene, dirty, "w", ["w0", "w1"], [MIN_SLACK, MIN_SLACK], false);
    draw(layer);
    expect(bodyWidths()).toEqual([1.75]);
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
