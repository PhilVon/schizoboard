/**
 * The hole in a compact cassette's label, asserted as a measurement — T-304.
 *
 * A cassette's label is a five-row grid and the window is one of its rows, so
 * that the writing above and below it does not have to know it is there. That
 * arrangement had a defect nothing could see: the row was `auto` and the window
 * was sized by `aspect-ratio` off a width, and Chromium sized the *track* from
 * the window's contents — about fifteen units of reel — rather than from the
 * ratio. The window rendered its full 21.6 units, overflowed its row by six, and
 * rows 3 and 4 were drawn underneath the spools. It shipped invisible because a
 * cassette had nothing to write on those rows until T-302 read a title.
 *
 * ## Why this is a test at all, and why it is this one
 *
 * `render/items/dom.test.ts` asserts `textContent`, which was correct and said
 * nothing about what was on top of what — the writing was in the DOM and legible
 * there the whole time. The suite runs on happy-dom, which has no layout engine,
 * so no test in `src/` can measure a grid track. What *can* be checked without a
 * browser is that the stylesheet still describes the hole it is supposed to:
 * every length involved is a percentage of an object whose size is settled in
 * `lib/objects.ts`, so the geometry is arithmetic on the source.
 *
 * That makes this a guard against the fix being undone rather than a re-test of
 * Chromium. The specific undoing it is written for is the tempting one: giving
 * the window back a `width`, so that two declarations state the size of one hole
 * and a later change to either can silently disagree with the other.
 *
 * In `tests/` rather than beside the stylesheet because it reads a file, and
 * `tsconfig.json` deliberately withholds Node's types from `src/`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { objectSizeFor } from "../src/lib/objects";

const css = readFileSync(
  fileURLToPath(new URL("../src/render/items/items.css", import.meta.url)),
  "utf8",
);

/**
 * Every declaration under a selector, merged in source order.
 *
 * A hand-rolled scan rather than a regex because `@keyframes` nests, and rather
 * than a CSS parser because pulling one in to read five numbers is a dependency
 * for the sake of a dependency. Only top-level rules are collected, which is
 * exactly where these five live.
 */
function declarations(selector: string): Map<string, string> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open === -1) break;
    const head = src.slice(i, open).trim();
    // Walk to the matching brace, so a nested `@keyframes` block is stepped
    // over whole rather than mistaken for the end of a rule.
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    if (head.split(",").some((s) => s.trim() === selector)) {
      for (const decl of src.slice(open + 1, j - 1).split(";")) {
        const at = decl.indexOf(":");
        if (at === -1) continue;
        out.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
      }
    }
    i = j;
  }
  return out;
}

/** `9% 7% 12% 7%` and friends, as four numbers in CSS's own order. */
function sides(shorthand: string): { top: number; right: number; bottom: number; left: number } {
  const n = shorthand.split(/\s+/).map((s) => Number.parseFloat(s));
  expect(n.every((v) => Number.isFinite(v)), `every side of "${shorthand}" is a number`).toBe(true);
  const [a, b = a, c = a, d = b] = n as [number, number?, number?, number?];
  return { top: a, right: b, bottom: c, left: d };
}

const CASSETTE = objectSizeFor("audio")!;
const label = declarations('.item-case[data-kind="cassette"] .case-label');
const shared = declarations(".case-label");
const window_ = declarations('.item-case[data-kind="cassette"] .case-window');

/**
 * The label's content box, in board units.
 *
 * The padding is a percentage of the *object*, not of the label — an absolutely
 * positioned box resolves percentage padding against its containing block — and
 * percentage padding resolves against that block's **width** on all four sides,
 * which is why the top and bottom are fractions of 155 rather than of 99.
 */
function labelContentBox(): { w: number; h: number } {
  const inset = sides(label.get("inset")!);
  const pad = sides(shared.get("padding")!);
  return {
    w:
      (CASSETTE.w * (100 - inset.left - inset.right)) / 100 -
      (CASSETTE.w * (pad.left + pad.right)) / 100,
    h:
      (CASSETTE.h * (100 - inset.top - inset.bottom)) / 100 -
      (CASSETTE.w * (pad.top + pad.bottom)) / 100,
  };
}

/** The hole, derived the way the browser derives it: the track gives the height
 *  and `aspect-ratio` gives the width. */
function hole(): { w: number; h: number } {
  const rows = label.get("grid-template-rows")!.split(/\s+/);
  const track = Number.parseFloat(rows[1]!);
  const ratio = Number.parseFloat(window_.get("aspect-ratio")!);
  const h = (labelContentBox().h * track) / 100;
  return { w: h * ratio, h };
}

const UNITS_PER_MM = 1.55;

describe("the hole in a compact cassette's label", () => {
  /**
   * The numbers a real one gives up to a ruler: the window is a shade under
   * 60 mm across and a shade under 14 mm deep, on a 100 by 64 mm face. They are
   * also the hole this had *before* T-304, when it was `78%` of the label's
   * content width at a ratio of 4.26 — that is where the two figures come from,
   * and the point of the test is that turning the declaration round did not move
   * the hole by so much as a tenth.
   *
   * Held to a twentieth of a millimetre, and deliberately: it is the tolerance
   * that caught the track being written as 36.48% instead of 36.5% when the
   * label's foot moved on Q-228, which is a hole 0.05 mm narrower than the one
   * above this comment.
   */
  it("is still the 59 by 14 mm window a compact cassette has", () => {
    const { w, h } = hole();
    expect(w / UNITS_PER_MM).toBeCloseTo(59.28, 1);
    expect(h / UNITS_PER_MM).toBeCloseTo(13.92, 1);
  });

  it("fits inside the label it is cut through", () => {
    const box = labelContentBox();
    const { w, h } = hole();
    expect(w).toBeLessThan(box.w);
    expect(h).toBeLessThan(box.h);
  });

  /**
   * The row is what states the height. An `auto` track here is the defect T-304
   * fixed — it takes its size from the reels inside the window instead of from
   * the window — and it would come back looking like a simplification.
   */
  it("is a definite grid track rather than an auto one", () => {
    const rows = label.get("grid-template-rows")!.split(/\s+/);
    expect(rows).toHaveLength(5);
    expect(rows[1]).toMatch(/%$/);
  });

  /**
   * And the window states nothing about its own size beyond the ratio. This is
   * the half that keeps the test honest for the next person: with a `width` as
   * well, the hole has two authors, and the bug that started this was precisely
   * two answers to one question.
   */
  it.each(["width", "margin", "margin-top", "margin-bottom", "height"])(
    "leaves %s to the track rather than restating it",
    (prop) => {
      if (prop === "height") {
        expect(window_.get("height")).toBe("100%");
        return;
      }
      expect(window_.has(prop)).toBe(false);
    },
  );

  /**
   * The foot of the label, bounded from both sides.
   *
   * Below: the shell's own furniture. The felt-pad end is the bottom 10% and the
   * capstan cutouts sit between 91% and 96.5% — a label over either is a label
   * printed on a hole.
   *
   * Above: the writing. The foot moved on T-304 because putting the window in its
   * own row without moving it just relocated the clipping onto the case number,
   * and it stopped at 18% on Q-228 because that is the shortest label at which an
   * ordinary cassette — a name, a title off the container, a runtime — clips
   * nothing. 22% loses a line of it. So this holds the foot inside the band the
   * ladder measured rather than pinning it to one value: the choice inside the
   * band is taste, and going outside it is a defect in one direction or the
   * other.
   */
  it("stops short of the shell's furniture and long of the writing", () => {
    const foot = 100 - sides(label.get("inset")!).bottom;
    const holes = declarations(".case-holes");
    const cutoutTop =
      100 - Number.parseFloat(holes.get("bottom")!) - Number.parseFloat(holes.get("height")!);
    expect(foot).toBeLessThan(cutoutTop);
    expect(foot).toBeGreaterThanOrEqual(82);
  });
});
