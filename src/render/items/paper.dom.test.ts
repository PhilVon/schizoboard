/**
 * @vitest-environment happy-dom
 *
 * One grain tile per stock, and not one for the board (T-222).
 *
 * > Paper stock varies: white, cream, yellow legal, graph, index card. Each has
 * > its own grain texture at low opacity — DESIGN section 4.4
 *
 * `paperGrainUrl` memoised into a module-level variable, so the first sheet to
 * mount generated a tile and every sheet after it — of any stock — got that one
 * back. `stock` was not a parameter at all. The only thing telling two sheets
 * apart was `grainPosition`, which is a background offset into the same bitmap.
 *
 * ## Why there is a fake canvas in here
 *
 * happy-dom has no 2D context, so the real function's `getContext` returns null
 * and it bails before drawing anything. A test that ran against that would pass
 * whatever this file did. The fake below is not a canvas — it is a *recorder*:
 * every drawing call folds into a hash, and `toDataURL` returns that hash. Two
 * tiles drawn differently therefore have different URLs and two tiles drawn
 * identically have the same one, which is exactly the distinction being tested
 * and none of the ones that would need real pixels.
 *
 * It cannot say whether the five tiles *look* different, and nothing here
 * pretends to. That is a judgement for a real board.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaperStock } from "@/render/items/paper";

const STOCKS: PaperStock[] = ["white", "cream", "legal", "graph", "index"];

/** Every canvas the module asked for during one test. */
let made: FakeCanvas[] = [];
/** Whether `getContext` will hand one back — the out-of-memory browser. */
let contextAvailable = true;
let realCreateElement: typeof document.createElement;

class FakeCanvas {
  width = 0;
  height = 0;
  /** Everything drawn, folded down. */
  hash = 2166136261;

  private readonly ctx = {
    lineWidth: 0,
    strokeStyle: "",
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image: { data: Uint8ClampedArray }) => {
      // Every fourth byte: the speckle is written to all three colour channels
      // and alpha is a constant, so one channel carries the whole signal.
      for (let i = 0; i < image.data.length; i += 4) this.fold(image.data[i]!);
    },
    beginPath: () => this.fold(1),
    moveTo: (x: number, y: number) => this.fold(x * 1000 + y),
    lineTo: (x: number, y: number) => this.fold(x * 1000 + y),
    stroke: () => this.fold(strHash(this.ctx.strokeStyle)),
  };

  getContext(kind: string): unknown {
    return kind === "2d" && contextAvailable ? this.ctx : null;
  }

  toDataURL(): string {
    return `data:image/png;recorded,${this.hash >>> 0}`;
  }

  private fold(value: number): void {
    this.hash = Math.imul(this.hash ^ Math.round(value * 64), 16777619);
  }
}

function strHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash * 31 + text.charCodeAt(i), 1) >>> 0;
  return hash;
}

/**
 * A fresh copy of the module, because the tile cache it holds is module state
 * and every test here is about what that cache does.
 */
async function freshModule(): Promise<typeof import("@/render/items/paper")> {
  vi.resetModules();
  return import("@/render/items/paper");
}

beforeEach(() => {
  made = [];
  contextAvailable = true;
  realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") return realCreateElement(tag);
    const canvas = new FakeCanvas();
    made.push(canvas);
    return canvas as unknown as HTMLElement;
  }) as typeof document.createElement);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the grain of a sheet", () => {
  /** The defect, stated as the property it broke. */
  it("gives each of the five stocks its own tile", async () => {
    const { paperGrainUrl } = await freshModule();

    const urls = STOCKS.map((stock) => paperGrainUrl(stock));
    for (const url of urls) expect(url).not.toBe("");
    expect(new Set(urls).size).toBe(STOCKS.length);
  });

  /**
   * The half that was right and has to stay right. Five tiles is the budget; a
   * board is five hundred sheets, and one tile each would be five hundred data
   * URLs and five hundred decodes.
   */
  it("draws one tile per stock however many sheets ask for it", async () => {
    const { paperGrainUrl } = await freshModule();

    const first = paperGrainUrl("cream");
    for (let i = 0; i < 20; i++) expect(paperGrainUrl("cream")).toBe(first);
    expect(made).toHaveLength(1);

    paperGrainUrl("legal");
    paperGrainUrl("legal");
    expect(made).toHaveLength(2);
  });

  /**
   * The tile must not depend on which sheet asked first. That is the shape of
   * the original bug and it would come straight back if the seed came off a
   * sheet rather than off the stock.
   */
  it("gives a stock the same tile whatever order the stocks are asked for in", async () => {
    const forwards = await freshModule();
    const inOrder = STOCKS.map((stock) => forwards.paperGrainUrl(stock));

    const backwards = await freshModule();
    const reversed = [...STOCKS].reverse().map((stock) => backwards.paperGrainUrl(stock));

    expect(reversed.reverse()).toEqual(inOrder);
  });

  /**
   * A browser with no 2D context is a condition that passes, so the empty
   * string must not be remembered — a board that lost its grain for the rest of
   * the session over one failed allocation would be a worse bug than the one
   * this file is about.
   */
  it("caches nothing when there is no context to draw on", async () => {
    const { paperGrainUrl } = await freshModule();

    contextAvailable = false;
    expect(paperGrainUrl("white")).toBe("");

    contextAvailable = true;
    expect(paperGrainUrl("white")).not.toBe("");
  });
});
