/**
 * @vitest-environment happy-dom
 *
 * happy-dom has no 2D context, so one is recorded instead. The bake is a
 * bitmap and a bitmap is not worth asserting pixel by pixel; what is worth
 * pinning down is the *geometry of the lighting*, because that is the thing
 * DESIGN section 4.1 says breaks the illusion the moment one element disagrees
 * with the rest — and nothing else in the application would catch a pin lit
 * from the wrong side.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIGHT_DX, LIGHT_DY } from "@/render/items/shadow";
import { clearPinSpriteCache, pinSprite } from "@/render/pins/sprite";

interface Circle {
  x: number;
  y: number;
  r: number;
}

interface Recording {
  size: number;
  /** Centre and radius of every `arc` — the head, then the specular. */
  arcs: Circle[];
  /** Centre of every `ellipse` — the pin's own shadow. */
  ellipses: Circle[];
  /** Every point of every path — the shaft. */
  points: [number, number][];
  /**
   * Colour stops, in the order they were added, across every gradient.
   *
   * Only the head's colours arrive as `rgb(…)`: the shaft's steel is written
   * as hex and the shadow as `rgba(…)`, so a filter on the format separates
   * "what colour is this pin" from "what colour is metal" without the test
   * having to know which gradient was created first.
   */
  stops: string[];
}

let rec: Recording;

/** Captured before anything spies on it, so a second spy wraps the real one
 *  rather than the previous test's. */
const nativeCreateElement = document.createElement.bind(document);

afterEach(() => {
  vi.restoreAllMocks();
});

const RGB = /^rgb\((\d+), (\d+), (\d+)\)$/;

/** The head's colours, parsed. */
function headColours(): [number, number, number][] {
  return rec.stops
    .map((s) => RGB.exec(s))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
}

/** Channel spread. Zero for a grey, large for a saturated colour. */
function chroma([r, g, b]: [number, number, number]): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

beforeEach(() => {
  clearPinSpriteCache();
  rec = { size: 0, arcs: [], ellipses: [], points: [], stops: [] };

  const gradient = (): CanvasGradient =>
    ({
      addColorStop: (_offset: number, color: string) => rec.stops.push(color),
    }) as unknown as CanvasGradient;

  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: (...p: [number, number]) => rec.points.push(p),
    lineTo: (...p: [number, number]) => rec.points.push(p),
    arc: (x: number, y: number, r: number) => rec.arcs.push({ x, y, r }),
    ellipse: (x: number, y: number, r: number) => rec.ellipses.push({ x, y, r }),
    createRadialGradient: gradient,
    createLinearGradient: gradient,
    filter: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
  };

  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const el = nativeCreateElement(tag) as HTMLElement;
    if (tag !== "canvas") return el;
    const canvas = el as HTMLCanvasElement;
    // The bake sets width before asking for the context, so this records the
    // real sprite resolution rather than a number written down twice.
    canvas.getContext = (() => {
      rec.size = canvas.width;
      return ctx;
    }) as unknown as HTMLCanvasElement["getContext"];
    canvas.toDataURL = () => "data:image/png;base64,fake";
    return canvas;
  }) as typeof document.createElement);
});

describe("a baked pin", () => {
  /**
   * AC-59 — "string attachment point draws under the pin head".
   *
   * The pins layer is above both rope canvases already (DESIGN section 6.2), so
   * what is left to get right is *where* in the sprite the pin's position is. A
   * string ends at that position; if the head were drawn above it the string
   * would end in open cork just below the head instead of passing beneath it.
   */
  it("centres the head on the sprite's anchor, which is where a string ends", () => {
    pinSprite("pushpin", "#c8352f");
    const head = rec.arcs[0]!;
    expect(head.x).toBe(rec.size / 2);
    expect(head.y).toBe(rec.size / 2);
    expect(head.r).toBeGreaterThan(rec.size * 0.2);
  });

  it("puts the shaft below the head, where it goes into the board", () => {
    pinSprite("pushpin", "#c8352f");
    const below = rec.points.filter(([, y]) => y > rec.size / 2);
    expect(below.length).toBeGreaterThan(0);
    expect(rec.points.every(([, y]) => y >= rec.size / 2)).toBe(true);
  });

  it("throws its shadow along the one global light", () => {
    pinSprite("pushpin", "#c8352f");
    const shadow = rec.ellipses[0]!;
    const c = rec.size / 2;
    expect(Math.sign(shadow.x - c)).toBe(Math.sign(LIGHT_DX));
    expect(Math.sign(shadow.y - c)).toBe(Math.sign(LIGHT_DY));
    // Along the light, not merely on the right side of it.
    expect((shadow.x - c) / (shadow.y - c)).toBeCloseTo(LIGHT_DX / LIGHT_DY, 6);
  });

  /** The one line that makes a circle read as a sphere — and the one that
   *  would give the whole board away if it faced the wrong way. */
  it("puts the specular on the side the light comes from, opposite the shadow", () => {
    pinSprite("pushpin", "#c8352f");
    const c = rec.size / 2;
    const shadow = rec.ellipses[0]!;
    const spec = rec.arcs[rec.arcs.length - 1]!;
    expect(Math.sign(spec.x - c)).toBe(-Math.sign(shadow.x - c));
    expect(Math.sign(spec.y - c)).toBe(-Math.sign(shadow.y - c));
    // Inside the head it belongs to, not floating off the edge of it.
    const head = rec.arcs[0]!;
    expect(Math.hypot(spec.x - c, spec.y - c) + spec.r).toBeLessThan(head.r * 1.05);
  });

  it("bakes a pushpin's head in its own colour", () => {
    pinSprite("pushpin", "#c8352f");
    expect(Math.max(...headColours().map(chroma))).toBeGreaterThan(60);
  });

  it("bakes a thumbtack in its colour too", () => {
    pinSprite("thumbtack", "#2f6fc8");
    expect(Math.max(...headColours().map(chroma))).toBeGreaterThan(60);
  });

  /** A nail is steel. Its `color` is not a lie, it is simply not what a nail
   *  is made of. */
  it("bakes a nail in steel whatever colour it was given", () => {
    pinSprite("nail", "#c8352f");
    expect(Math.max(...headColours().map(chroma))).toBeLessThan(20);
  });

  it("falls back to the schema's own default for a colour nobody can parse", () => {
    pinSprite("pushpin", "chartreuse");
    expect(Math.max(...headColours().map(chroma))).toBeGreaterThan(60);
  });

  it("accepts three-digit hex as well as six", () => {
    pinSprite("pushpin", "#0a0");
    const greens = headColours();
    expect(greens.length).toBeGreaterThan(0);
    // Every shade of #00aa00, lightened or darkened, is greener than it is red.
    expect(greens.every(([r, g]) => g >= r)).toBe(true);
  });

  it("bakes once per kind and colour", () => {
    const first = pinSprite("pushpin", "#c8352f");
    const arcs = rec.arcs.length;
    expect(pinSprite("pushpin", "#c8352f")).toBe(first);
    expect(rec.arcs.length).toBe(arcs);
    pinSprite("pushpin", "#2f6fc8");
    expect(rec.arcs.length).toBeGreaterThan(arcs);
  });
});

describe("a pin with nothing to bake on", () => {
  it("hands back an empty url rather than a broken one", () => {
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = nativeCreateElement(tag) as HTMLElement;
      if (tag === "canvas") {
        (el as HTMLCanvasElement).getContext = (() =>
          null) as unknown as HTMLCanvasElement["getContext"];
      }
      return el;
    }) as typeof document.createElement);
    clearPinSpriteCache();
    expect(pinSprite("pushpin", "#c8352f").url).toBe("");
  });
});
