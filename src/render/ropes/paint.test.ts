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

import { STRING_THICKNESSES } from "@/lib/palette";
import { DEFAULT_SLACK, MIN_SLACK, presetSlack } from "@/lib/slack";
import { lighten, RopeLayer, slackRung, twistDash } from "@/render/ropes/paint";
import { LIGHT_DX, LIGHT_DY } from "@/render/items/shadow";
import { RopeSet } from "@/sim/ropes";
import { Camera } from "@/state/camera";
import { DirtySets } from "@/state/dirty";
import { Scene, type StringNodes } from "@/state/scene";

interface Calls {
  clearRect: number;
  strokes: Array<{
    width: number;
    style: string;
    tx: number;
    ty: number;
    dash: number[];
    cap: string;
  }>;
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
  //
  // The dash is saved and restored alongside it, because that is a real thing
  // that can go wrong: `setLineDash` is context state on the same stack, and a
  // dash left set by one batch's highlight would come out on the *next* batch's
  // shadow. Recording it per stroke is what makes that assertable.
  let tx = 0;
  let ty = 0;
  let dash: number[] = [];
  const stack: Array<[number, number, number[], string]> = [];
  const ctx = {
    save: () => stack.push([tx, ty, dash, ctx.lineCap]),
    restore: () => {
      const previous = stack.pop();
      if (previous) [tx, ty, dash, ctx.lineCap] = previous;
    },
    setTransform: vi.fn(),
    translate: (x: number, y: number) => {
      tx += x;
      ty += y;
    },
    setLineDash: (segments: number[]) => {
      dash = segments;
    },
    clearRect: () => {
      calls.clearRect++;
    },
    stroke: () => {
      calls.strokes.push({
        width: ctx.lineWidth,
        style: String(ctx.strokeStyle),
        tx,
        ty,
        dash,
        cap: ctx.lineCap,
      });
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
  scene.putPin({ id, parent: null, lx: x, ly: y, kind: "pushpin", color: "#c8352f", page: null, wx: x, wy: y });
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
 * T-143 - and the *absence* of a lift shadow.
 *
 * DESIGN section 4.6 asks for a second, raised shadow where a string lies on an
 * item. It was built (T-66) and taken out again after looking at it on a real
 * board: `shadowBlur` is forbidden (AC-69), so "softer" can only be faked as
 * "wider", and a wider hard-edged stroke vanishes into mottled cork and becomes
 * a grey bar on white paper. These pin the decision, so a well-meant
 * reintroduction has to argue with a failing test rather than with a comment.
 */
/**
 * The export path, and the one thing that separates it from the board's.
 *
 * `draw` owns its canvas and clears it; `drawInto` is given somebody else's,
 * with the cork, the board ink, the items and the other rope layer already on
 * it. The first export driven with a string on the board came back as a single
 * blue curve on white — the last painter's, alone — which looks like four
 * layers failing rather than like one layer wiping them.
 */
describe("drawing into an export canvas", () => {
  /** A layer and the context it was built over, which is the one an export
   *  hands back to it. */
  const exportLayer = (which: "over" | "under") => {
    const canvas = stubCanvas();
    return {
      layer: new RopeLayer(canvas, which),
      ctx: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
    };
  };

  it("does not clear what four other painters have already put down", () => {
    const { layer, ctx } = exportLayer("over");
    string("s1", "p1", "p2");
    const drawn = layer.drawInto(ctx, scene, ropes, camera);

    expect(drawn).toBeGreaterThan(0);
    expect(calls.clearRect).toBe(0);
  });

  it("still clears when it is drawing on its own canvas", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    expect(calls.clearRect).toBeGreaterThan(0);
  });

  /**
   * Every pass, not merely the first — T-214 and T-215 were both a layer that
   * silently did not reach an image export, and the twist is exactly the shape
   * of thing that goes missing there: one line of context state inside one pass.
   * A thick string, because a default one is declined the dash anyway and would
   * pass this test with the dash dropped.
   */
  it("draws the same three passes it would on the board", () => {
    const { layer, ctx } = exportLayer("over");
    string("s1", "p1", "p2", { thickness: 6 });
    layer.drawInto(ctx, scene, ropes, camera);
    const exported = calls.strokes.map((stroke) => ({ ...stroke }));

    calls.strokes.length = 0;
    layer.invalidate();
    draw(layer);

    expect(exported).toHaveLength(calls.strokes.length);
    for (const [i, stroke] of exported.entries()) {
      expect(stroke.style).toBe(calls.strokes[i]!.style);
      expect(stroke.width).toBeCloseTo(calls.strokes[i]!.width, 6);
      expect(stroke.dash).toEqual(calls.strokes[i]!.dash);
    }
    // And the twist really was in what was compared, rather than absent from
    // both sides.
    expect(exported[2]!.dash).toHaveLength(2);
  });

  /**
   * The paths an export leaves behind were walked at the *export* camera, while
   * the layer still believes it is cached at the window's. A later frame that
   * dirties one string rebuilds only that one and keeps the rest — so without
   * this, one string moving on a board somebody has just exported redraws every
   * other string at the export's scale.
   *
   * Two strings, because with one there is nothing left to reuse.
   */
  it("leaves no path cached at a camera the window is not at", () => {
    const { layer, ctx } = exportLayer("over");
    pin("p3", 0, 120);
    pin("p4", 200, 120);
    string("s1", "p1", "p2");
    string("s2", "p3", "p4");

    // What a full walk of both strings costs, and what a walk of one costs.
    layer.invalidate();
    calls.lines.length = 0;
    draw(layer);
    const both = calls.lines.length;

    calls.lines.length = 0;
    dirty.rope("s1");
    draw(layer);
    const one = calls.lines.length;
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(both);

    // Now export at a different camera, and dirty the same one string. The
    // layer must re-walk *everything*: what it has cached for `s2` was built
    // for the export's scale, and reusing it draws that string into the window
    // at the wrong size while `s1` alone comes out right.
    const exportCamera = new Camera();
    exportCamera.resize(4000, 3000);
    exportCamera.zoomTo(0.25, 0, 0);
    layer.drawInto(ctx, scene, ropes, exportCamera);

    calls.lines.length = 0;
    dirty.rope("s1");
    draw(layer);
    expect(calls.lines.length).toBe(both);
  });

  /**
   * `inked` is a fact about the layer's *own* canvas, and an export never
   * touches it. A `drawInto` that cleared the flag would tell the layer its
   * canvas is blank while the last ropes are still on it — and the next frame
   * that finds no strings left skips the clear, so they stay there for ever.
   */
  it("does not tell the layer its own canvas has been emptied", () => {
    const { layer, ctx } = exportLayer("over");
    string("s1", "p1", "p2");
    draw(layer);
    layer.drawInto(ctx, scene, ropes, camera);

    // Every string gone: the layer has to clear what it drew.
    ropes.removeString(dirty, "s1");
    scene.strings.delete("s1");
    calls.clearRect = 0;
    draw(layer);
    expect(calls.clearRect).toBeGreaterThan(0);
  });

  it("draws only its own layer", () => {
    const { layer: under, ctx } = exportLayer("under");
    string("s1", "p1", "p2");
    expect(under.drawInto(ctx, scene, ropes, camera)).toBe(0);
    expect(calls.strokes).toEqual([]);
  });
});

describe("the shadow of a string lying on an item", () => {
  /** Put a photograph under the string and let the rope settle onto it. */
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

  it("is the same shadow it has on bare cork, and there is only one of it", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);
    const onCork = calls.strokes.map((stroke) => ({ ...stroke }));

    drapeOverItem();
    calls.strokes.length = 0;
    draw(layer);

    expect(calls.strokes).toHaveLength(3);
    expect(calls.strokes[0]!.tx).toBeCloseTo(onCork[0]!.tx, 6);
    expect(calls.strokes[0]!.ty).toBeCloseTo(onCork[0]!.ty, 6);
    expect(calls.strokes[0]!.width).toBeCloseTo(onCork[0]!.width, 6);
    expect(calls.strokes[0]!.style).toBe(onCork[0]!.style);
  });

  /** One walk of the points for the one path, not three for a split. */
  it("walks the polyline once", () => {
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
    expect(calls.lines).toHaveLength(links);
  });

  /**
   * > Shadow colour is never black. It's a desaturated warm brown drawn from
   * > the cork, at low alpha. - DESIGN section 4.1
   *
   * Every other shadow in the application obeys this; the rope painter did not
   * until T-143. Black at low alpha survives against mottled brown cork and
   * reads as grey ink the moment a string lies on a white note.
   */
  it("is warm brown and never black", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2");
    draw(layer);

    const channels = /rgba\((\d+), (\d+), (\d+),/.exec(calls.strokes[0]!.style);
    expect(channels).not.toBeNull();
    const [r, g, b] = channels!.slice(1).map(Number);
    expect(r! + g! + b!).toBeGreaterThan(0);
    expect(r!).toBeGreaterThan(b!);
  });
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
    expect(shadow.style).toMatch(/^rgba\(\d+, \d+, \d+, 0\./);
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

/**
 * > Twist and fibre come from a subtle repeating variation along the length
 * > rather than from simulation. — DESIGN section 4.6
 *
 * A dash is the only thing canvas repeats along *arc length* without a second
 * walk of the points, so what is worth pinning here is that it lands on the
 * highlight and nowhere else, that it never escapes the pass, and that the
 * strings it declines to draw it on are declined for the stated reason.
 */
/**
 * > Twist and fibre come from a subtle repeating variation along the length
 * > rather than from simulation. — DESIGN section 4.6
 *
 * A dash is the only thing canvas repeats along *arc length* without a second
 * walk of the points, so what is worth pinning here is that it lands on the
 * highlight and nowhere else, that neither it nor the cap it needs escapes the
 * pass, and that the nick stays sub-pixel — which is the whole difference
 * between a twist and a dashed line, and the one thing a number here can lose.
 */
describe("the twist", () => {
  /** The highlight is the last pass; yarn puts a halo pass before the body, so
   *  counting from the end is the only way that holds for every fibre. */
  const highlightOf = () => calls.strokes[calls.strokes.length - 1]!;

  it("breaks the highlight and leaves the other passes solid", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { thickness: 6 });
    draw(layer);

    const [shadow, body, highlight] = calls.strokes;
    expect(shadow.dash).toEqual([]);
    expect(body.dash).toEqual([]);
    expect(highlight.dash).toHaveLength(2);
  });

  /**
   * The nick is sub-pixel, and it is meant to stay that way.
   *
   * A gap that clears a pixel is one the rasteriser can actually empty, and the
   * highlight stops dimming and starts *breaking* — driven on a ladder, 0.8 px
   * is where a thick string reads as a row of white ticks. Under a pixel it can
   * only ever be partial coverage, which is a modulation. Every material at
   * every rung, because the pitch scales with the width and the temptation to
   * scale the nick with it is exactly what this forbids.
   */
  it("keeps the nick sub-pixel on every material and every rung", () => {
    for (const material of ["string", "yarn"]) {
      for (const thickness of STRING_THICKNESSES) {
        calls.strokes.length = 0;
        const layer = new RopeLayer(stubCanvas(), "over");
        dirty.everything();
        string("s1", "p1", "p2", { thickness, material });
        draw(layer);

        const [lit, nick] = highlightOf().dash;
        expect(nick).toBeLessThan(1);
        expect(nick).toBeGreaterThan(0);
        // And the lit run is the rest of a pitch, not a second small number:
        // two comparable dashes would be a dotted line whatever their size.
        expect(lit!).toBeGreaterThan(nick! * 3);
      }
    }
  });

  /**
   * Every rung of every *spun* fibre carries it, which is what being sub-pixel
   * buys. An earlier version bounded the nick in whole pixels and had to
   * decline the thin end of the ladder outright, because a whole-pixel break in
   * a 1.25 px highlight is a dotted line; half a pixel needs no room.
   */
  it("leaves no rung of a spun fibre without one", () => {
    for (const material of ["string", "yarn"]) {
      for (const thickness of STRING_THICKNESSES) {
        calls.strokes.length = 0;
        const layer = new RopeLayer(stubCanvas(), "over");
        dirty.everything();
        string("s1", "p1", "p2", { thickness, material });
        draw(layer);
        expect(highlightOf().dash).toHaveLength(2);
      }
    }
  });

  /**
   * Wire has none, at any thickness, and keeps its round cap with it.
   *
   * Metal is the one fibre here whose highlight really is continuous, and the
   * drawing agrees emphatically: wire's specular is the brightest thing on the
   * board and its width sits on `HIGHLIGHT_MIN`, so a nick that is invisible on
   * cotton reads as a row of beads on it. Driven, it was the one string of six
   * anybody would have noticed.
   */
  it("gives wire no twist at all", () => {
    for (const thickness of STRING_THICKNESSES) {
      calls.strokes.length = 0;
      const layer = new RopeLayer(stubCanvas(), "over");
      dirty.everything();
      string("s1", "p1", "p2", { thickness, material: "wire" });
      draw(layer);
      expect(highlightOf().dash).toEqual([]);
      expect(highlightOf().cap).toBe("round");
    }
  });

  /**
   * The dash is butt-capped, and every other pass is not.
   *
   * A round cap puts a semicircle of half the line width *past* the end of its
   * dash, at both ends of every gap — so a gap narrower than the highlight is
   * closed by the two dashes either side of it and the twist is not drawn at
   * all. With a sub-pixel nick that is every string on the board. It failed
   * worst where the string is widest: a top-rung yarn draws a 5.6 px highlight,
   * which swallowed a 2.2 px gap whole. What caught it was sampling a driven
   * board and finding twelve pixels of flat highlight where a groove should
   * have been; from in here it looked like a working feature.
   *
   * The other passes keep their round caps, which is what stops a string
   * ending in a square edge at the pin.
   */
  it("butt-caps the dashed pass and nothing else", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { thickness: 6 });
    draw(layer);

    const [shadow, body, highlight] = calls.strokes;
    expect(highlight.cap).toBe("butt");
    expect(shadow.cap).toBe("round");
    expect(body.cap).toBe("round");
  });

  /**
   * Neither the dash nor the cap leaks. Both are context state on the same
   * stack as the transform, so either one left set would come out on the *next*
   * batch — a dashed shadow under a solid string, or every string on the board
   * squared off at its pins.
   */
  it("does not leak the dash or the cap into the next batch", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { thickness: 6 });
    string("s2", "p1", "p2", { thickness: 6, color: "#2c5aa8" });
    draw(layer);

    expect(calls.strokes).toHaveLength(6);
    for (const stroke of calls.strokes.slice(3, 5)) {
      expect(stroke.dash).toEqual([]);
      expect(stroke.cap).toBe("round");
    }
  });

  /**
   * The pitch is a multiple of the *drawn* width, not of the authored
   * thickness — see `StringFibre.twist`.
   *
   * Which only means anything where the two differ, so this asks yarn: its
   * weight is 1.5, so a thickness of 6 draws at 9, and a pitch taken off the
   * wrong one comes out two thirds of the size. On plain string the numbers are
   * equal and the same test passes with the bug in.
   */
  it("takes its pitch from the width the string actually draws at", () => {
    const layer = new RopeLayer(stubCanvas(), "over");
    string("s1", "p1", "p2", { thickness: 6, material: "yarn" });
    draw(layer);

    const dash = highlightOf().dash;
    expect(dash[0]! + dash[1]!).toBeCloseTo(6 * 1.5 * 2.7, 6);
  });

  /** Yarn is spun wool and takes a longer, slower turn than plain cotton
   *  string — per unit of drawn width, so this is about the ply and not about
   *  yarn simply being fatter. */
  it("gives yarn a slower ply than plain string", () => {
    const pitchOf = (material: string): number => {
      calls.strokes.length = 0;
      const layer = new RopeLayer(stubCanvas(), "over");
      dirty.everything();
      string("s1", "p1", "p2", { thickness: 6, material });
      draw(layer);
      const dash = highlightOf().dash;
      return dash[0]! + dash[1]!;
    };

    expect(pitchOf("string") / 6).toBeLessThan(pitchOf("yarn") / (6 * 1.5));
  });

  /** The pitch scales with the width; the nick is the same half pixel at every
   *  size, which is what keeps a thick rope from being drawn as a dashed one. */
  it("scales the pitch and holds the nick", () => {
    for (const w of [3, 4.5, 6.5, 10]) {
      const dash = twistDash(w, 1.9);
      expect(dash).not.toBeNull();
      const [lit, nick] = dash!;
      expect(lit! + nick!).toBeCloseTo(w * 1.9, 6);
      expect(nick).toBeCloseTo(0.5, 6);
    }

    // Zero twist is a fibre with no visible ply — nothing today, and honoured
    // so that a smooth one added later needs no code here.
    expect(twistDash(6, 0)).toBeNull();
  });

  /**
   * Under the shortest legible pitch the repeat stops reading as a rhythm and
   * starts reading as beading — a nick every three pixels along the brightest
   * specular on the board. Wire is what found it and wire is what this holds:
   * its ply is the tightest and it draws the thinnest, so it is the fibre that
   * reaches the floor first, and at the thin end of the ladder every material
   * converges on the same pitch.
   */
  it("floors the pitch where a repeat stops being a texture", () => {
    const pitch = (w: number, t: number): number => {
      const [lit, nick] = twistDash(w, t)!;
      return lit! + nick!;
    };

    // A thin string on the bottom rung draws 2 px wide and would otherwise come
    // out at a 3.8 px pitch.
    expect(2 * 1.9).toBeLessThan(4.5);
    expect(pitch(2, 1.9)).toBeCloseTo(4.5, 6);
    // Wide enough and the fibre's own ply governs again.
    expect(pitch(6, 1.9)).toBeCloseTo(11.4, 6);
  });
});
