/**
 * The gummed label on a folder, asserted on the stylesheet — T-386.
 *
 * The bug this pins was a layout one no unit test in `src/` could see: the
 * label is the grid item of the front's `1fr` column, and without its own
 * `min-width: 0` a long filename's nowrap min-content inflated the track
 * itself — a 67-character name resolved the column to 541px inside a 329px
 * front, the label's percentage max-width then resolved against the phantom
 * track so the ellipsis cut landed off the folder, and the page-count chip in
 * the second column was pushed past the edge entirely. happy-dom lays nothing
 * out, so what is asserted is that the stylesheet still says the two things
 * that prevent it, and that the strip's line budget agrees with the constant
 * `sizeLabels` fits the type against.
 */

import { describe, expect, it } from "vitest";

import { declarations } from "./css-declarations";

const label = declarations(".folder-label");
const number = declarations(".folder-label > .case-number");

describe("the gummed label on a folder", () => {
  it("cannot inflate the front's name column with its own min-content", () => {
    // The whole of the T-386 bug. Remove this and every folder with a long
    // name lays its label, its title and its page count against a track wider
    // than the folder.
    expect(label.get("min-width")).toBe("0");
  });

  it("is capped by a percentage of the track, so the cap needs the track sane", () => {
    // Here as the other half of the assertion above: a percentage max-width is
    // only a cap on the folder if the track it resolves against is the
    // folder's. The number is free to move; its being a percentage is not.
    expect(label.get("max-width")).toMatch(/%$/);
  });

  it("holds two lines and then cuts, and the type is fitted to the same two", () => {
    // `sizeLabels` fits the name across LABEL_LINES (2) times the label's box,
    // so the wrap and the size are one decision. If the clamp here moves,
    // `LABEL_LINES` in `dom.ts` moves with it — this is the tripwire.
    expect(number.get("-webkit-line-clamp")).toBe("2");
    expect(number.get("white-space")).toBe("normal");
    expect(number.get("overflow")).toBe("hidden");
  });
});
