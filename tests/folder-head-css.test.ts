/**
 * The head of a manilla folder, asserted as arithmetic on the stylesheet — T-311.
 *
 * The fault it is written for was invisible to every existing test and obvious to
 * anybody looking at the board. A folder's contents were drawn as two things: a
 * pile of sheet *edges*, which is what a closed folder shows, and one opaque top
 * sheet lying over the whole span of them. The top sheet won. Averaged down its
 * depth it varied by three tenths of one level in eight bits from one end of a
 * 300 mm object to the other, so what the object actually wore was a flat pale
 * bar — and the two handling creases underneath, which had been in this file
 * since the folder was built, had never once been visible.
 *
 * Nothing here re-tests Chromium. Each of these is a decision that would come
 * back looking like an improvement, and the two arithmetic ones are bugs that
 * were really in the branch before they were caught by eye.
 */

import { describe, expect, it } from "vitest";

import { bare, declarations, layers } from "./css-declarations";

const sheets = declarations(".folder-sheets");
const edges = declarations(".folder-sheets::after");
const front = declarations(".folder-front");

/** The mask spans, as `[start, end]` pairs in percent of the band's width. */
function spans(): Array<[number, number]> {
  const widths = layers(sheets.get("mask-size")!).map((s) => Number.parseFloat(s));
  const places = layers(sheets.get("mask-position")!).map((s) => s.split(" ")[0]!);
  expect(widths, "one size per position").toHaveLength(places.length);
  return widths.map((w, i) => {
    const at = places[i]!;
    const start = at === "left" ? 0 : at === "right" ? 100 - w : (100 - w) / 2;
    expect(
      ["left", "center", "right"].includes(at),
      `"${at}" is a keyword — a percentage here aligns that point of the mask with ` +
        `the same point of the box, which is not "that far along"`,
    ).toBe(true);
    return [start, start + w] as [number, number];
  });
}

describe("what a closed folder shows", () => {
  /**
   * **The one that would put the bar back.** A pile is read from its edges, and
   * anything opaque drawn across the band hides all of them at once — the fault
   * was one `::before` doing exactly that, and it looked like the most reasonable
   * declaration in the file. `::after` is the edges themselves and is the only
   * pseudo-element this band is allowed.
   */
  it("draws nothing over the sheet edges", () => {
    expect(/\.folder-sheets::before/.test(bare)).toBe(false);
    expect(edges.size, "the edges are still drawn").toBeGreaterThan(0);
  });

  /**
   * Both halves of T-269's page count, which the fix must not have quietly cost:
   * how deep the band is, and how far up it the edges reach. With the top sheet
   * gone the second one is doing far more work than it was — it is now the
   * difference between a memo and a case dump rather than a detail under a sheet.
   */
  it("still says the page count with the band and with the edges", () => {
    expect(sheets.get("height")).toMatch(/--bulk/);
    expect(edges.get("inset")).toMatch(/--bulk/);
  });

  /**
   * A folder's sheets are squared off in groups and the groups do not agree, so
   * the head is cut to three heights. Three *equal* cuts is one height written
   * out three times, which is the fault again with more declarations.
   */
  it("cuts the head to more than one height", () => {
    const depths = layers(sheets.get("mask-image")!).map(
      (l) => Number.parseFloat(/rgba\(0, 0, 0, 0\) 0 ([\d.]+)%/.exec(l)![1]!),
    );
    expect(depths).toHaveLength(3);
    expect(new Set(depths).size).toBe(3);
  });

  /**
   * **A bug that was really in the branch.** Written as offsets first, the
   * right-hand span landed at 37% instead of 61% and the last quarter of the
   * paper was masked off the object altogether — the folder rendered with a
   * corner of its contents missing and the declaration read as correct.
   */
  it("masks a head, not a hole: the spans cover the whole width", () => {
    const sorted = spans().sort((a, b) => a[0] - b[0]);
    expect(sorted[0]![0], "the left end is covered").toBe(0);
    expect(sorted.at(-1)![1], "the right end is covered").toBe(100);
    for (let i = 1; i < sorted.length; i++) {
      expect(
        sorted[i]![0],
        `span ${i} starts at ${sorted[i]![0]}% and the one before it ends at ${sorted[i - 1]![1]}%`,
      ).toBeLessThanOrEqual(sorted[i - 1]![1]);
    }
  });

  /**
   * And the second bug: tiled edge to edge the spans abutted exactly, and the
   * seam between two hard-edged mask layers is a half-transparent column one
   * pixel wide running the whole depth of the band. Two ruled lines down the
   * paper is worse than the fault being fixed. They have to overlap.
   */
  it("overlaps the spans rather than abutting them", () => {
    const sorted = spans().sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]![0], "abutting spans leave a seam").toBeLessThan(sorted[i - 1]![1]);
    }
  });

  /**
   * The front panel throws no shadow onto the paper. It used to — a blurred dark
   * line offset *upward*, meant to say which of the two is nearer — and a soft
   * dark band immediately under a bright one is the most legible drop shadow
   * there is, so the eye gave it to the paper and the paper floated. What says
   * which is nearer is the panel's own cut edge, in its first gradient: DESIGN
   * 4.3's rule, and the same mistake tape made.
   */
  it("gives the front panel a cut edge rather than a cast shadow", () => {
    expect(front.has("box-shadow")).toBe(false);
    const profile = layers(front.get("background")!)[0]!;
    expect(profile, "a shine and a hairline of board thickness, in that order").toMatch(
      /rgba\(255, 246, 228, [\d.]+\) 0 [\d.]+%,\s*rgba\(96, 70, 40, [\d.]+\)/,
    );
  });
});
