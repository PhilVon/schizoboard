/**
 * The per-item style vocabulary — `lib/style.ts`.
 *
 * Small, because the file is a vocabulary rather than a machine. What is worth
 * pinning is the guards, since they are what stands between a document written
 * by a future build and this one's renderer.
 */

import { describe, expect, it } from "vitest";

import { isItemFace, isPaperStock, isPlain, NO_STYLE } from "@/lib/style";

describe("recognising a paper stock", () => {
  it("takes the five of DESIGN 4.4", () => {
    for (const stock of ["white", "cream", "legal", "graph", "index"]) {
      expect(isPaperStock(stock)).toBe(true);
    }
  });

  /** A later build's sixth stock, and everything else that is not a string. */
  it("refuses anything it does not know", () => {
    for (const junk of ["vellum", "", 3, null, undefined, {}, ["white"]]) {
      expect(isPaperStock(junk)).toBe(false);
    }
  });
});

describe("recognising a face", () => {
  it("takes the board's hand and the clean one", () => {
    expect(isItemFace("hand")).toBe(true);
    expect(isItemFace("clean")).toBe(true);
  });

  /** Deliberately not a font family — see the note on `ItemFace`. */
  it("refuses a font name", () => {
    expect(isItemFace("Patrick Hand")).toBe(false);
    expect(isItemFace("serif")).toBe(false);
  });
});

describe("whether anything is overridden", () => {
  it("calls an empty style plain, which is nearly every item", () => {
    expect(isPlain(NO_STYLE)).toBe(true);
    expect(isPlain({})).toBe(true);
  });

  it("counts each property on its own", () => {
    expect(isPlain({ paperStock: "graph" })).toBe(false);
    expect(isPlain({ fontFamily: "clean" })).toBe(false);
    expect(isPlain({ torn: false })).toBe(false);
    expect(isPlain({ tapeStyle: 0 })).toBe(false);
    expect(isPlain({ tint: { hue: 0, light: 0 } })).toBe(false);
  });

  /**
   * The two that would be wrong under a falsy test, and both are real choices:
   * `torn: false` is "this one was cut, not torn off a pad" and `tapeStyle: 0`
   * is "take the tape off this one". Neither means "ask the seed".
   */
  it("does not mistake a falsy override for an absent one", () => {
    expect(isPlain({ torn: false })).toBe(false);
    expect(isPlain({ tapeStyle: 0 })).toBe(false);
  });
});
