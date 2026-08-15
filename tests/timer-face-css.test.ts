/**
 * The clock's dial, where the stylesheet holds the half `dom.ts` cannot — T-395.
 *
 * Three of this face's decisions live only in CSS and would fail *silently* if
 * somebody undid them, which is the bar the other files in this directory are
 * held to. None is a matter of taste:
 *
 * - **`tabular-nums`** is the whole of what a seven-segment font would have
 *   bought. Without it the figures sit on proportional advances and `12:09`
 *   becoming `12:10` shuffles the line sideways — on a clock that is being
 *   redrawn once a second, in front of somebody, forever. And the way to "fix"
 *   the jitter, if this were ever removed, is to reach for a segment font, which
 *   is the trap the class comment in `dom.ts` spends a paragraph on: `raster.ts`
 *   inlines board fonts as bytes into each export and a relative font URL inside
 *   a data SVG resolves to nothing at all, silently (D-34).
 * - **The counter-rotation on the glass.** `writeLight` publishes `--turn`, and
 *   a gradient that did not consume it is a clock lit from its own private sun
 *   (T-313). It is one `calc` and it looks removable.
 * - **What the card tier keeps.** The caption goes and the digits stay, because
 *   a clock you cannot read the time on is not a simplified clock.
 */

import { describe, expect, it } from "vitest";

import { BOARD_FONT_URLS } from "@/render/items/raster";

import { bare, declarations } from "./css-declarations";

const digits = declarations(".timer-digits");
const glass = declarations(".timer-glass");
const body = declarations(".timer-body");

/**
 * The declarations under a tier rule, read off the source rather than through
 * `declarations`.
 *
 * The tier selectors are `:is(.layer-world[data-lod], .item.is-coarse) .x`, and
 * that helper splits a rule head on commas at the top level — which is right for
 * an ordinary selector list and wrong for a comma *inside* `:is()`. Rather than
 * teach it to parse `:is()` for one caller, this reads the one block it needs.
 * The single-selector rules above still go through the helper.
 */
function tierRule(leaf: string): string {
  const head = `:is(.layer-world[data-lod], .item.is-coarse) ${leaf} {`;
  const at = bare.indexOf(head);
  expect(at, `no card-tier rule for ${leaf}`).toBeGreaterThan(-1);
  return bare.slice(at + head.length, bare.indexOf("}", at));
}

describe("the figures", () => {
  it("declares tabular figures, in both the modern property and the feature", () => {
    // Both, deliberately. `font-variant-numeric` is the property this webview
    // honours; `font-feature-settings` is the belt for a face whose `tnum` is
    // not exposed through the variant axis, and it costs one line.
    expect(digits.get("font-variant-numeric")).toBe("tabular-nums");
    expect(digits.get("font-feature-settings")).toContain("tnum");
  });

  it("wears a face the board already bundles, and adds no font file", () => {
    // The stack names Source Sans 3 first, which is one of exactly two files in
    // `BOARD_FONT_URLS`. The assertion is on the *count* as well as the name:
    // a seven-segment face added for this object would pass a name check on the
    // family and fail here.
    expect(digits.get("font-family")).toContain("Source Sans 3");
    expect(BOARD_FONT_URLS).toHaveLength(2);
    expect(BOARD_FONT_URLS.some((url) => url.includes("source-sans-3"))).toBe(true);
    // Exactly two `@font-face` blocks in the item stylesheet, and they are the
    // two `raster.ts` inlines as bytes into every export. A third declared for a
    // seven-segment dial would load in the app and resolve to nothing at all
    // inside an exported data SVG — silently, which is the failure D-34
    // measured as every note on the board coming out in the wrong hand.
    expect(bare.match(/@font-face/g)).toHaveLength(BOARD_FONT_URLS.length);
    for (const url of BOARD_FONT_URLS) expect(bare).toContain(url);
  });

  it("does not wrap, so a clock never reads on two lines", () => {
    expect(digits.get("white-space")).toBe("nowrap");
  });
});

describe("the light on the case", () => {
  it("counter-rotates the reflection into board space", () => {
    // A broad wash across a face is the light falling on the object rather than
    // a feature of it, so its angle belongs in board space — which is what
    // `--turn` is for, and it is the distinction `writeLight` draws between this
    // and a crease.
    expect(glass.get("background")).toContain("var(--turn");
  });

  it("takes the bezel's highlight and shade off the one light's direction", () => {
    // Both flanks, off `--lx`/`--ly`, in the sign convention a card's emboss
    // already uses: the highlight offset *against* the light and the shadow
    // *along* it. One without the other is a rim that is lit on a board where
    // nothing else is.
    const rim = body.get("box-shadow")!;
    expect(rim).toContain("var(--lx");
    expect(rim).toContain("var(--ly");
    expect(rim).toContain("* -0.9px");
    expect(rim).toContain("* 0.9px");
  });
});

describe("what survives being zoomed out", () => {
  it("drops the caption below the full tier and keeps the digits", () => {
    // At 30% a 90-unit case is 27 pixels across and the caption is under two
    // pixels tall. The digits are the object.
    expect(tierRule(".timer-caption")).toContain("display: none");
    const coarse = tierRule(".timer-digits");
    expect(coarse).not.toContain("display: none");
    // And they take the space the caption's row held: larger, and heavier,
    // because 600-weight glyphs at four device pixels are a grey smear.
    expect(coarse).toContain("font-size: calc(1.34em * var(--digit-fit, 1))");
    expect(coarse).toContain("font-weight: 700");
  });
});
