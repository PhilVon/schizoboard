/**
 * A business card's top line, where two kinds of string share one box — T-341.
 *
 * The line is set for a page's own title, which is prose. When the page has no
 * title the host takes the line instead (T-339), and a host is a single
 * unbreakable token: the `overflow-wrap: anywhere` that keeps one long word in a
 * real headline from riding off the card broke the host wherever the line ran
 * out — `news.ycombinator.` above `com`.
 *
 * ## Why the numbers are asserted here as well as used there
 *
 * `dom.ts` fits the host by arithmetic — how many `em` of its own type the
 * printed block is wide — and every term in that arithmetic is a length in this
 * stylesheet. CSS cannot hand a number to arithmetic, so the numbers are written
 * in both places and this file is what stops them drifting: a change to the
 * block's inset or to the title's size that is made in one of the two would
 * otherwise silently mis-fit every host on the board, in the direction that
 * writes past the edge of the card.
 *
 * The other half is the pair of rules themselves, and the reason to assert them
 * is that each is exactly what somebody would undo to "fix" the other case. Take
 * `overflow-wrap: anywhere` off the prose rule and a long word in a headline
 * overflows the card silently; leave it on for a host and the break comes back.
 */

import { describe, expect, it } from "vitest";

import { CARD_TEXT, CARD_TITLE_EM, CARD_TYPE_INSET } from "@/render/items/dom";

import { bare, declarations } from "./css-declarations";

const type = declarations(".card-type");
/**
 * `declarations` merges every rule whose head names this selector, so the block
 * the three printed lines share arrives together with the title's own.
 */
const title = declarations(".card-title");
const host = declarations(".card-title.is-host");

describe("the block the host has to fit", () => {
  it("insets the printed block by the fraction the fit is computed from", () => {
    // `inset: 14% 9% 12%` — top, sides, bottom. The sides are the term that
    // decides the measure.
    const sides = type.get("inset")!.split(/\s+/)[1];
    expect(sides).toBe(`${(CARD_TYPE_INSET * 100).toFixed(0)}%`);
  });

  it("sets the title at the size the fit takes as its ceiling", () => {
    expect(title.get("font-size")).toBe(`${CARD_TITLE_EM}em`);
  });

  it("agrees with `dom.ts` about how wide the block is in its own type", () => {
    // The measure a host is fitted against, as arithmetic on the two numbers
    // above and the one that sizes the block. About fifteen `em`, which is why
    // a twenty-character host has to come down from 1.9 and a ten-character one
    // does not — and if any of the three moves, this is the line that says so.
    const measure = (1 - 2 * CARD_TYPE_INSET) / CARD_TEXT;
    expect(measure).toBeCloseTo(14.91, 2);
    expect(measure / (20 * 0.52)).toBeLessThan(CARD_TITLE_EM);
    expect(measure / (10 * 0.52)).toBeGreaterThan(CARD_TITLE_EM);
  });
});

describe("the two kinds of string in one box", () => {
  it("wraps prose anywhere, so a long headline cannot ride off the card", () => {
    expect(title.get("overflow-wrap")).toBe("anywhere");
    expect(title.get("-webkit-line-clamp")).toBe("2");
    expect(title.get("overflow")).toBe("hidden");
  });

  it("sets a host as a label — one line, never broken inside the word", () => {
    // The same three declarations the company and address lines carry, because
    // a host on the top line is the same kind of string as the host below it.
    expect(host.get("white-space")).toBe("nowrap");
    expect(host.get("overflow-wrap")).toBe("normal");
    expect(host.get("text-overflow")).toBe("ellipsis");
    // Out of the `-webkit-box` the clamp needs: a box that lays out as one has
    // no ellipsis to give the address that could not be written small enough.
    expect(host.get("display")).toBe("block");
  });

  it("keeps an empty title hidden rather than merely one line", () => {
    // The rule that has to keep winning over the one above it. A card with no
    // source at all has neither a title nor a host, and a `display: block` that
    // outranked `display: none` would leave an empty row holding the grid open.
    expect(declarations(".card-title.is-empty").get("display")).toBe("none");
    // Two classes each, so the specificity is equal and *source order* is the
    // whole of the answer — which is a fact about the file rather than about
    // either rule, and is therefore invisible from the declarations alone.
    expect(bare.indexOf(".card-title.is-empty")).toBeGreaterThan(bare.indexOf(".card-title.is-host"));
  });
});
