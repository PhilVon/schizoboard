/**
 * The link card's wash and its emboss, asserted as arithmetic on the stylesheet
 * — T-339.
 *
 * ## Why this is a test and not a screenshot
 *
 * The whole claim behind the card is that a page's picture can be the card's
 * *paper* and still have printing legible over it. That claim is about a range,
 * not about a card: the banner may be a saturated brand colour, a white product
 * page or a night photograph, and an effect tuned on any one of those is
 * invisible on another. A screenshot of one pasted link says nothing about the
 * other two, which is exactly the shape of mistake that has been made on this
 * board before — and a look at the running app cannot enumerate every banner on
 * the web, where two lines of arithmetic can bound them all.
 *
 * So the design is written down as a bound rather than as a taste: at
 * `--card-wash` over `--card-stock`, *every possible banner* lands inside a
 * known lightness band, and the ink and the emboss have to read against both
 * ends of it. Nothing here re-tests Chromium. It is a guard against the two
 * tempting undoings — raising the wash until the picture "reads", and dropping
 * one of the emboss's two copies because the other one is doing the work on
 * whichever card was on screen at the time.
 */

import { describe, expect, it } from "vitest";

import { declarations, layers } from "./css-declarations";

const card = declarations(".item-card");
const shot = declarations(".card-shot");
/**
 * `.card-title`'s declarations, which include the block the three printed lines
 * share — `declarations` merges every rule naming a selector, in source order,
 * so the shared `text-shadow` and the title's own rules arrive together.
 */
const type = declarations(".card-title");

const WASH = Number.parseFloat(card.get("--card-wash")!);

type Rgb = [number, number, number];

/** `#f2ece0` as three 8-bit channels. */
function rgb(hex: string): Rgb {
  const h = hex.trim().replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

/**
 * WCAG relative luminance, which is not the same as luma and the difference is
 * not academic here.
 *
 * The first version of this file used a straight Rec. 709 weighting of the 8-bit
 * channels, and it said the ink cleared the floor by 3.6:1 — a fail. The
 * channels have to be linearised first, and once they are the same two colours
 * come out at 7:1. An estimate that lands on the wrong side of the threshold it
 * is being compared against is worse than no measurement, because it reads as a
 * design that does not work.
 */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const STOCK = rgb(card.get("--card-stock")!);
const INK = rgb(card.get("--card-ink")!);

/**
 * What the compositor actually produces: the banner at `--card-wash` over the
 * stock, channel by channel in 8-bit sRGB, which is where `opacity` does its
 * work.
 */
function washed(banner: Rgb): Rgb {
  return banner.map((c, i) => WASH * c + (1 - WASH) * STOCK[i]!) as Rgb;
}

const BLACKEST: Rgb = [0, 0, 0];
const WHITEST: Rgb = [255, 255, 255];

describe("the wash bounds what any banner can do to the card", () => {
  it("is the picture at partial opacity over the stock, and not a filter", () => {
    // Not a stylistic preference. A `filter` anywhere inside an item rasterises
    // the nearest stacking context containing it, and `.item` is one because it
    // carries a transform — so a filtered card would export every glyph on
    // itself as pixels, on a board where an unfiltered item's photograph is
    // passed through as its original JPEG.
    expect(shot.get("opacity")).toBe("var(--card-wash)");
    expect(shot.has("filter")).toBe(false);
    expect(card.has("filter")).toBe(false);
    expect(declarations(".card-body").has("filter")).toBe(false);
  });

  it("leaves the darkest possible banner light enough to print on", () => {
    // Solid black, which is the floor of the whole web — a night photograph or
    // a dark-mode screenshot lands near it. The ink has to read against *this*
    // and not against the pale banner that happens to be on screen.
    expect(contrast(washed(BLACKEST), INK)).toBeGreaterThan(4.5);
  });

  it("holds every line of the printing against that floor, not just the title", () => {
    // The defect this test was extended for, found by looking at a card with a
    // black banner on it. The company and address lines had their own quieter
    // greys, chosen — like every colour anybody picks — against whatever was on
    // screen at the time, which was cream. At the dark end of the range the
    // smallest line on the card came out at 4.4:1 with a white emboss highlight
    // sitting on top of it, and it was the one thing you could not read.
    //
    // The hierarchy on a card is carried by size and weight. Contrast is not
    // spare capacity to spend on it, because contrast is the thing that runs out
    // at an end of the range nobody is looking at.
    const floor = washed(BLACKEST);
    for (const [line, colour] of [
      [".card-title", card.get("--card-ink")!],
      [".card-site", declarations(".card-site").get("color")!],
      [".card-address", declarations(".card-address").get("color")!],
    ] as const) {
      expect(contrast(floor, rgb(colour)), `${line} against the darkest banner`).toBeGreaterThan(4.5);
    }
  });

  it("leaves the lightest possible banner still visibly card", () => {
    // A white product page, which is the ceiling. If the wash let it through,
    // the card would be a white rectangle and there would be nothing to
    // recognise it by across a board — the failure the whole idea exists to
    // avoid — and the highlight half of the emboss would have nothing to sit on.
    const top = washed(WHITEST);
    expect(Math.max(...top)).toBeLessThan(250);
    // And the two ends have to be far enough apart that a wall of these is not
    // one colour: a black banner and a white one are still plainly different
    // cards after the wash.
    expect(contrast(washed(BLACKEST), top)).toBeGreaterThan(1.8);
  });

  it("keeps the whole range narrow enough that one ink suits all of it", () => {
    // The band every banner on the web collapses into is `1 - wash` of the way
    // to the stock, by construction — which is why the printing can be one
    // colour rather than a per-card decision nobody could take.
    const spread = (washed(WHITEST)[0]! - washed(BLACKEST)[0]!) / 255;
    expect(spread).toBeCloseTo(WASH, 6);
    expect(WASH).toBeLessThan(0.45);
  });
});

describe("the emboss reads at both ends of that range", () => {
  const shadows = layers(type.get("text-shadow")!);

  /** The `rgba(r, g, b, a)` at the end of one shadow layer. */
  function colourOf(layer: string): { rgb: Rgb; alpha: number } {
    const m = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(layer);
    expect(m, `a colour in "${layer}"`).not.toBeNull();
    const [r, g, b, a] = m!.slice(1).map(Number) as [number, number, number, number];
    return { rgb: [r, g, b], alpha: a };
  }

  it("paints a highlight and a shadow, never one of them", () => {
    // The tempting undoing. On pale stock the shadow is doing all the work and
    // the highlight looks redundant; on a dark banner it is the other way round.
    // Drop either and the emboss is invisible over half the web.
    //
    // Read as luminance rather than matched against the literal colours, so
    // that retuning either one is not a broken test — what has to hold is that
    // one of them is lighter than the stock and the other darker, which is what
    // makes it relief instead of a drop shadow.
    expect(shadows.length).toBe(2);
    const [highlight, shadow] = shadows.map(colourOf) as [
      ReturnType<typeof colourOf>,
      ReturnType<typeof colourOf>,
    ];
    // Both are measured against the **stock**, because both are things that
    // happen to the card's surface where the letter stands off it — not against
    // the ink. The cast side is a warm brown lighter than the ink itself and
    // should be: it is a shadow falling on cream board, not more printing.
    expect(luminance(highlight.rgb)).toBeGreaterThan(luminance(STOCK));
    expect(luminance(shadow.rgb)).toBeLessThan(luminance(STOCK));
    // Both partly transparent. An opaque highlight is an outline: it replaces
    // whatever the banner put under the letter instead of lifting it, and on a
    // dark card that reads as a white halo round the smallest line rather than
    // as a raised edge — which is exactly what a close-up showed.
    expect(highlight.alpha).toBeLessThan(0.65);
    expect(shadow.alpha).toBeLessThan(0.65);
  });

  it("offsets them against each other, along the board's one light", () => {
    // Raised type catches the light on the faces turned toward it and throws a
    // shadow off the faces turned away. `--lx`/`--ly` is the direction from an
    // object *toward* its shadow (`shadow.ts`), so the shadow copy rides it and
    // the highlight copy rides its negation — and both are in the card's own
    // frame, which is what `writeLight` is for.
    const [highlight, shadow] = shadows as [string, string];
    expect(highlight).toContain("var(--lx, 0.5) * -1");
    expect(highlight).toContain("var(--ly, 0.87) * -1");
    expect(shadow).toContain("var(--lx, 0.5) * var(--relief");
    expect(shadow).toContain("var(--ly, 0.87) * var(--relief");
    // Both off the same length, so the relief is one number and not two that can
    // drift into a highlight further out than its own shadow.
    expect(highlight).toContain("var(--relief");
  });

  it("is a fraction of the letter, so every line is embossed for its own size", () => {
    // An `em` and never a length. It was a length written per item from the
    // card's *width*, which made one relief serve three lines set at 1.9, 0.8
    // and 0.78 em — five times the relief, for its size, on the smallest of
    // them. A raised letter's relief belongs to the letter.
    //
    // Riding on the type size also keeps the proportion through a zoom and a
    // resize for free, since the block's own size is a fraction of the card.
    expect(card.get("--relief")).toMatch(/^[\d.]+em$/);
    // Every length in the shadow is `var(--relief, …)`; strike those out and no
    // absolute one is left. The `var()` fallback is the at-rest value for a node
    // the renderer has not sized yet, not an offset anything is drawn at.
    const offsets = type.get("text-shadow")!.replace(/var\(--relief[^)]*\)/g, "");
    expect(offsets).not.toMatch(/[\d.]+(px|em)/);
  });
});
