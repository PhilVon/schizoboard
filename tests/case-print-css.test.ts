/**
 * The still clipped to a tape, asserted as arithmetic on the stylesheet — T-270.
 *
 * The drawing itself is a judgement and was made by looking at it. What this
 * file defends is the thing looking at it cannot: that the print goes on
 * clearing the three parts of the face it was placed to clear, at every size an
 * object on this board can be, after somebody has adjusted one number in a
 * 2,800-line stylesheet.
 *
 * ## What "clear" means here, and why it is not a preference
 *
 * The face was signed off before this task existed and every part of it is
 * load-bearing. The two windows are the transport — T-268's whole argument is
 * that a tape says where it is through its spools rather than through a bar
 * drawn over it — and the label is where the object's identity is written. So a
 * print that covered a reel would be trading the transport reading for a
 * picture of what is on the tape, and one that reached the label would be
 * trading the object's name for it. Both were drawn, both were rejected on
 * sight, and neither is recoverable from a screenshot of the version that was
 * kept.
 *
 * The measured face, from the rules this file reads:
 *
 *     window            27% to 79%          (`.case-window`, VHS)
 *     reel              74% of the window   → the disc starts at 33.8%
 *     label             starts at 25%       (`.case-label`, VHS)
 *
 * A print's foot is its top plus its own height, and its height is a function of
 * a width in percent of the object, a padding in percent of the object, and the
 * aspect of whatever film it came off. So the assertions below are that
 * arithmetic, run at the widest frame anybody is going to paste.
 *
 * Nothing here renders. `npm run check` has no layout engine; a run has, and the
 * run is what settled the placement. This stops it drifting afterwards.
 */

import { describe, expect, it } from "vitest";

import { PRINT_W } from "@/render/items/dom";

import { bare, declarations } from "./css-declarations";

const print = declarations('.item-case[data-kind="vhs"] .case-print');
const empty = declarations('.item-case[data-kind="vhs"] .case-print.is-empty');
const still = declarations(".case-still");
const clip = declarations(".case-clip");
const label = declarations('.item-case[data-kind="vhs"] .case-label');
const window_ = declarations('.item-case[data-kind="vhs"] .case-window');
const reel = declarations('.item-case[data-kind="vhs"] .case-reel');

/**
 * A VHS as `lib/objects.ts` sizes it. Percentages resolve against these two, and
 * a padding in percent resolves against the *width* whichever edge it is on —
 * which is the CSS rule that makes a print keep its proportions and is also the
 * one most likely to be forgotten by whoever edits these numbers next.
 */
const W = 290;
const H = 160;

/**
 * The most a print is ever turned, in degrees — read off the rule rather than
 * written here twice, because it is a term in the clearance above.
 */
const MAX_TILT = Number.parseFloat(
  /var\(--print-tilt[^)]*\)\s*\*\s*([\d.]+)deg/.exec(print.get("transform") ?? "")?.[1] ?? "NaN",
);

/** The default behind a `var(--name, fallback)`, as a number of percent. */
function fallback(value: string, name: string): number {
  const at = value.indexOf(`var(${name},`);
  expect(at, `${name} is read with a fallback`).toBeGreaterThanOrEqual(0);
  const rest = value.slice(at + `var(${name},`.length);
  return Number.parseFloat(rest);
}

/** A plain `n%` declaration. */
function pct(value: string): number {
  return Number.parseFloat(value);
}

/**
 * How tall the print is, in per cent of the object, for a film of this aspect.
 *
 * The picture's height is its own width times the film's aspect — and its own
 * width is the print's width less two paddings, all of which are percentages of
 * the object's *width*. The border at the foot is 2.4 paddings, which is what
 * `calc()` in the rule says.
 */
function printHeight(aspect: number): number {
  const w = (fallback(print.get("width")!, "--print-w") / 100) * W;
  const pad = (fallback(print.get("padding")!, "--print-pad") / 100) * W;
  const picture = (w - pad * 2) * aspect;
  return ((pad + picture + pad * 2.4) / H) * 100;
}

describe("the still clipped to a tape", () => {
  it("keeps the print clear of the near reel at every aspect a film can be", () => {
    const top = fallback(print.get("top")!, "--print-top");
    const windowTop = pct(window_.get("top")!);
    const windowBottom = 100 - pct(window_.get("bottom")!);
    const discTop = windowTop + ((windowBottom - windowTop) * (1 - pct(reel.get("height")!) / 100)) / 2;
    expect(discTop).toBeCloseTo(33.8, 1);

    // 4:3 is the tallest frame anybody is realistically pasting — an interview
    // off a camcorder, which is exactly what a VHS on this board is for. It is
    // the case that decides the geometry, because a 16:9 print is shorter and
    // clears by more, and every screenshot taken while this was being placed
    // was of a 16:9 clip.
    const foot = top + printHeight(3 / 4);
    expect(foot).toBeLessThan(discTop);

    // And with the tilt on, which is what the clearance actually has to hold
    // for: the print is turned about its clip, so the far bottom corner drops
    // by half the width times the sine of the angle.
    const width = (fallback(print.get("width")!, "--print-w") / 100) * W;
    const swing = ((width / 2) * Math.sin((MAX_TILT * Math.PI) / 180) * 100) / H;
    expect(foot + swing).toBeLessThan(discTop);

    // Lapping the window's black surround is wanted and is what makes the print
    // read as lying on the object rather than as a panel let into it. Only the
    // reel is out of bounds.
    expect(foot).toBeGreaterThan(windowTop);
  });

  it("keeps the print clear of the label, so the tape's name is never covered", () => {
    const left = fallback(print.get("left")!, "--print-left");
    const width = fallback(print.get("width")!, "--print-w");
    // `inset` is top right bottom left.
    const labelLeft = Number.parseFloat(label.get("inset")!.split(/\s+/)[3]!);
    expect(labelLeft).toBeCloseTo(25, 0);
    expect(left + width).toBeLessThan(labelLeft);
  });

  it("asks for the still at the size it is drawn, in both languages", () => {
    // Two authors for one number, which is the drift `--kraft-top` was written
    // to stop (T-315) and the one case that cannot use that fix: the stylesheet
    // needs a percentage of an element and `variantFor` needs a fraction of a
    // screen width. The render asked for a `display` variant of a picture drawn
    // a third that wide until this assertion existed.
    expect(PRINT_W * 100).toBeCloseTo(fallback(print.get("width")!, "--print-w"), 6);
  });

  it("takes the print out of the box model when there is no still, rather than hiding it", () => {
    // `display` and not an opacity or a visibility: a board of films whose
    // frames are on another machine must cost no image decode and no
    // compositing layer for a picture nobody can see.
    expect(empty.get("display")).toBe("none");
  });

  it("lets the still keep its own shape", () => {
    // A forced box would crop somebody's face out of the one frame this object
    // gets to show, and a 4:3 interview and a 16:9 clip are different prints.
    expect(still.get("height")).toBe("auto");
    expect(still.get("width")).toBe("100%");
    expect(still.has("aspect-ratio")).toBe(false);
    expect(still.get("object-fit")).toBeUndefined();
  });

  it("sits the clip across the paper's edge rather than above it", () => {
    // A third of the loop proud of the head and two thirds lying on the print,
    // which is where a clip pushed onto one actually sits. All of it above is a
    // ring hanging over nothing — the first version drew that, and it read as a
    // floating hoop rather than as a fastener.
    const top = pct(clip.get("top")!);
    const height = pct(clip.get("height")!);
    expect(top).toBeLessThan(0);
    expect(-top).toBeLessThan(height / 2);
    // Two concentric loops, which is what survives being drawn eight pixels
    // wide on a wall of tapes where one reads as a smudge.
    expect(bare).toContain(".case-clip::before");
  });

  it("counter-turns the light on the print and never the print itself", () => {
    // T-313's two readings. A wash across a face is the light falling on it, so
    // its angle is turned back into board space; the print is an object stuck to
    // the tape and turns *with* it, which is what `--print-tilt` is and what
    // `--turn` is not allowed to touch.
    expect(print.get("background")).toContain("var(--turn, 0deg)");
    expect(print.get("transform")).toContain("--print-tilt");
    expect(print.get("transform")).not.toContain("--turn");
  });
});
