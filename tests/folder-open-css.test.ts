/**
 * An open case file, asserted as arithmetic on the stylesheet — T-319.
 *
 * Three of these are decisions that would come back looking like an improvement,
 * and the other three are the shape of the fault this task was driven to find.
 *
 * The fold is one `scaleY` about the item's bottom edge, and that is not a
 * shortcut for a 3D rotation — it *is* the projection of one. A panel hinged on
 * its foot and rotating away from the viewer has its free edge move toward the
 * fold and the panel foreshorten, which is what a scale about that edge does.
 * Writing it with `preserve-3d` and a `perspective` would cost a rasterised
 * stacking context on every folder on the board for a picture identical through
 * the only ninety degrees that are ever drawn.
 *
 * The numbers below are A4 in a folder cut around A4, and they are asserted
 * against `objects.ts` rather than written out, because the whole argument for
 * the quarter turn is that the two agree without either being adjusted.
 */

import { describe, expect, it } from "vitest";

import { A4_UNITS, objectSizeFor } from "../src/lib/objects";

import { declarations } from "./css-declarations";

const page = declarations(".folder-page");
const leaf = declarations(".folder-leaf");
const cover = declarations('.item-case[data-kind="folder"] .folder-front');

/** A4 at this board's scale. Off `objects.ts` and never written out here: the
 *  whole point of these assertions is that the stylesheet agrees with the one
 *  place the two sizes are decided. */
const A4 = A4_UNITS;

/** What `inset: A% B%` resolves to for a box in a container of this size. */
function inset(expr: string): { top: number; side: number } {
  const parts = expr.trim().split(/\s+/);
  expect(parts, `"${expr}" is a two-value inset`).toHaveLength(2);
  return { top: Number.parseFloat(parts[0]!), side: Number.parseFloat(parts[1]!) };
}

describe("the sheet inside an open folder", () => {
  const folder = objectSizeFor("document");

  it("is A4, and it is A4 because the folder was cut around A4", () => {
    // Not a coincidence to be grateful for. `objects.ts` cuts the folder to 310
    // by 222 mm "holding A4 lying horizontal", so a sheet turned a quarter
    // inside it has to fit with a margin — and the margin is the same 6.5 mm of
    // board either side that the object was drawn from a photograph of.
    expect(folder).not.toBeNull();
    const { top, side } = inset(page.get("inset")!);

    // The unrotated box: `inset` is a percentage of the folder, top and bottom
    // negative because a portrait A4 is taller than a landscape folder.
    const width = folder!.w * (1 - (2 * side) / 100);
    const height = folder!.h * (1 - (2 * top) / 100);

    expect(width).toBeCloseTo(A4.w, 0);
    expect(height).toBeCloseTo(A4.h, 0);
  });

  it("is turned a quarter the other way, so the page stands portrait when the folder does", () => {
    // The two rotations cancel. `Scene.setOpen` turns the item by +90° and this
    // is the -90° that makes `text.rs`'s 66-by-46 grid the right way round
    // without a single number in either place moving (D-60).
    expect(page.get("transform")).toBe("rotate(-90deg)");

    const { top, side } = inset(page.get("inset")!);
    // Once turned, the sheet's long edge runs down the folder's long axis and
    // both fit: A4's height across the folder's width, and its width down the
    // folder's height.
    expect(A4.h).toBeLessThan(folder!.w + 2 * Math.abs((folder!.w * side) / 100) + 1);
    expect(A4.h).toBeLessThanOrEqual(folder!.w);
    expect(A4.w).toBeLessThanOrEqual(folder!.h);
    expect(top).toBeLessThan(0);
  });

  it("is centred, so the nine units of board show equally on both sides", () => {
    const { top, side } = inset(page.get("inset")!);
    // One value for both ends of each axis is what centres it, and it is worth
    // asserting because the tempting alternative — pinning the sheet to the
    // fold — puts the head of the page outside the folder at one end.
    expect(folder!.w * (side / 100)).toBeCloseTo((folder!.w - A4.w) / 2, 0);
    expect(folder!.h * (top / 100)).toBeCloseTo((folder!.h - A4.h) / 2, 0);
  });
});

describe("the cover folding back", () => {
  it("hinges on the fold, which is the foot", () => {
    // `.folder-front`'s kraft has darkened toward the bottom "because the bottom
    // of it is the fold" since the folder was built. A hinge written at `50% 0`
    // would fold the cover about its *cut edge*, which is the one edge of a
    // folder that is not attached to anything.
    expect(cover.get("transform-origin")).toBe("50% 100%");
  });

  it("folds by scaling, not by rotating in three dimensions", () => {
    expect(cover.get("transform")).toBe("scaleY(calc(1 - var(--open, 0)))");
    // And nothing anywhere near it asks for a 3D context.
    expect(cover.has("perspective")).toBe(false);
    expect(cover.has("transform-style")).toBe(false);
  });

  it("is exactly where it was when nothing has been opened", () => {
    // The rule this board keeps everywhere: a redraw that moves a folder nobody
    // was asking about is the failure the shape is chosen to make impossible.
    // `--open`'s fallback is 0, so this evaluates to `scaleY(1)`.
    const at = (open: number) =>
      Number.parseFloat(
        cover
          .get("transform")!
          .replace("scaleY(calc(", "")
          .replace("))", "")
          .replace("var(--open, 0)", String(open))
          .replace("1 - ", "")
          .trim(),
      );
    expect(1 - at(0)).toBe(1);
    expect(1 - at(1)).toBe(0);
    expect(1 - at(0.5)).toBe(0.5);
  });
});

describe("the page appearing", () => {
  /**
   * The fault the run found, and the reason this is asserted rather than left to
   * taste. A linear `opacity: var(--open)` put the page at 0.59 a fifth of the
   * way through the fold, and what that looks like is the gummed label on the
   * cover showing *through* the page — a cross-dissolve between two things that
   * are both physically there. The cover is what reveals the page; a fade is not.
   */
  it("is solid before the cover has uncovered any of it", () => {
    const opacity = page.get("opacity")!;
    const at = (open: number) => {
      const inner = /calc\(var\(--open,\s*0\)\s*\*\s*([\d.]+)\)/.exec(opacity);
      expect(inner, `"${opacity}" ramps --open`).not.toBeNull();
      return Math.min(1, Math.max(0, open * Number.parseFloat(inner![1]!)));
    };
    expect(opacity.startsWith("clamp(0,")).toBe(true);
    expect(at(0)).toBe(0);
    expect(at(0.2)).toBe(1);
    expect(at(1)).toBe(1);
  });

  it("draws nothing at all on a folder nobody has opened", () => {
    // Belt and braces with the ramp above, and a different claim: the *fallback*
    // is zero, so a folder that has never carried the property is invisible
    // rather than depending on the view having written a zero.
    expect(page.get("opacity")).toContain("var(--open, 0)");
  });
});

describe("the header at the head of the page", () => {
  it("is set in the typed face and not in the board's hand", () => {
    // Q-267: a case number at the head of a page is a filing convention, and it
    // is the same typed face the tab wears. The hand is for what a person wrote.
    expect(leaf.get("font-family")).toContain("Source Sans 3");
    expect(leaf.get("font-family")).not.toContain("Patrick Hand");
  });
});
