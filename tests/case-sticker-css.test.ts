/**
 * The NO TRANSCRIPT sticker, asserted as arithmetic on the stylesheet — T-334.
 *
 * Same bargain as `case-print-css.test.ts`, and for the same reason: the
 * placement was judged by looking at it, and what looking at it cannot defend is
 * that the sticker goes on clearing what it was placed to clear after somebody
 * adjusts one number in a three-thousand-line stylesheet. Every length on these
 * objects is a percentage of a size settled in `lib/objects.ts`, so the
 * clearances are arithmetic on the source.
 *
 * ## What it has to clear, and why each of those is load-bearing
 *
 * A **cassette** is the object that decides the size, because it is the one with
 * no choice. Its J-card is nearly the whole face and its capstan cutouts are the
 * detail that says which way up it is (`items.css`), so the sticker lives in the
 * strip between them — nine per cent of the face, and the only surface on a
 * compact cassette that is neither written on nor cut through.
 *
 * A **VHS** has room, and what it has to clear is the two things that identify
 * it: the print on the left of the same lip (T-270 placed that against three
 * constraints of its own) and the label below, which is where the object's name
 * is written.
 *
 * ## The one estimate in here, and why it is safe
 *
 * How wide two words are is a font metric, and there is no layout engine in this
 * suite. `EM_PER_CHAR` below is a deliberate over-estimate for upper-case Source
 * Sans 3 at semibold, so every width assertion is asking whether a sticker
 * *wider than the real one* still fits. A test that passes here can still be
 * wrong about the drawing; it cannot be wrong in the direction that matters,
 * which is a label quietly overlapping a reel on somebody's board.
 */

import { describe, expect, it } from "vitest";

import { STICKER_SIZE } from "@/render/items/dom";

import { declarations } from "./css-declarations";

const sticker = declarations(".case-sticker");
const empty = declarations(".case-sticker.is-empty");
const onVhs = declarations('.item-case[data-kind="vhs"] .case-sticker');
const onCassette = declarations('.item-case[data-kind="cassette"] .case-sticker');
const print = declarations('.item-case[data-kind="vhs"] .case-print');
const vhsLabel = declarations('.item-case[data-kind="vhs"] .case-label');
const cassetteLabel = declarations('.item-case[data-kind="cassette"] .case-label');
const holes = declarations(".case-holes");

/**
 * The two objects as `lib/objects.ts` sizes them — 187 x 103 and 100 x 64 mm.
 * A percentage on any edge of a box resolves against its container's *width*
 * when it is a padding and against the matching axis when it is an inset, which
 * is the rule most likely to be forgotten by whoever edits these numbers next.
 */
const VHS = { w: 187, h: 103 } as const;
const CASSETTE = { w: 100, h: 64 } as const;

/** The type size, as a fraction of the object's width — the number `sizeLabels`
 *  writes. Imported rather than restated, on `PRINT_W`'s argument: the
 *  stylesheet needs a percentage of an element and the render needs a fraction
 *  of a width, and two authors for one number is the drift T-315 was about. */
const SIZE = STICKER_SIZE;

/**
 * Upper-case Source Sans 3 semibold, generously — a driven run measured the
 * label at 22.4% of a cassette's width where this predicts 25.6%, so the
 * over-estimate is real and is in the safe direction.
 */
const EM_PER_CHAR = 0.68;
const TEXT = "NO TRANSCRIPT";

/** The most the sticker is ever turned, in degrees — read off the rule rather
 *  than written here twice, because it is a term in every clearance below. */
const MAX_TILT = Number.parseFloat(
  /var\(--sticker-tilt[^)]*\)\s*\*\s*([\d.]+)deg/.exec(sticker.get("transform") ?? "")?.[1] ?? "NaN",
);

/** A plain `n%` declaration. */
function pct(value: string | undefined): number {
  expect(value, "the declaration is there").toBeDefined();
  return Number.parseFloat(value!);
}

/** An `n.nnem` declaration, in ems. */
function em(value: string): number {
  return Number.parseFloat(value);
}

/** The padding shorthand, as [top, sides, bottom] in ems. */
function padding(): { top: number; side: number; bottom: number } {
  const parts = sticker.get("padding")!.split(/\s+/).map(em);
  return { top: parts[0]!, side: parts[1]!, bottom: parts[2]! };
}

/**
 * How tall the sticker is, in per cent of an object of this size.
 *
 * The line box plus the two paddings, all in ems of a type size that is itself a
 * fraction of the object's *width* — so the height of this thing depends on how
 * wide the object is, and then has to be expressed against how tall it is. That
 * conversion is the whole reason a cassette and a VHS wearing the same sticker
 * have different amounts of room for it.
 *
 * **The turn is part of the height**, and leaving it out is the mistake this
 * file made first. A rotated box occupies its own height plus its width times
 * the sine of the angle, and this label is four times wider than it is tall, so
 * the tilt is not a rounding term — it is a fifth of the answer. The arithmetic
 * without it said the sticker's foot was at 90% of a cassette and a driven run
 * measured 90.9%, against cutouts that start at 91%.
 *
 * `line-height` is unitless and is read as such. Dividing it by a hundred, as
 * though it were the percentage every other length in this file is, made every
 * clearance below pass by a factor of eighty — which is what a green suite
 * looked like the first time this was run.
 */
function heightPct(box: { w: number; h: number }): number {
  const pad = padding();
  const ems = Number.parseFloat(sticker.get("line-height")!) + pad.top + pad.bottom;
  const upright = ems * SIZE * box.w;
  const swing = ((widthPct() / 100) * box.w) * Math.sin((MAX_TILT * Math.PI) / 180);
  return ((upright + swing) / box.h) * 100;
}

/** And how wide, in per cent of its width — the over-estimate above. */
function widthPct(): number {
  const pad = padding();
  const spacing = em(sticker.get("letter-spacing")!);
  const ems = TEXT.length * (EM_PER_CHAR + spacing) + pad.side * 2;
  return ems * SIZE * 100;
}

describe("the NO TRANSCRIPT sticker", () => {
  it("fits a cassette's one free strip, which is the strip that sized it", () => {
    // The J-card's foot and the top of the capstan cutouts. `inset` is
    // top right bottom left, so the foot is 100 less the third value.
    const cardFoot = 100 - pct(cassetteLabel.get("inset")!.split(/\s+/)[2]);
    const cutoutsTop = 100 - (pct(holes.get("bottom")) + pct(holes.get("height")));
    expect(cardFoot).toBeCloseTo(82, 0);
    expect(cutoutsTop).toBeCloseTo(91, 0);

    const foot = 100 - pct(onCassette.get("bottom"));
    const head = foot - heightPct(CASSETTE);
    // Below the writing, above the holes, and touching neither. If this fails
    // the fix is the type size and not the offset: making the strip bigger
    // means moving the J-card, which is a signed-off face (T-304, T-306).
    expect(head).toBeGreaterThan(cardFoot);
    expect(foot).toBeLessThan(cutoutsTop);
  });

  it("stays inside a cassette's face rather than running off the side of it", () => {
    // The label's own side margin is the width anybody has ever drawn on, so it
    // is the right bound for a thing stuck on beside it.
    const margin = pct(cassetteLabel.get("inset")!.split(/\s+/)[1]);
    expect(pct(onCassette.get("right"))).toBeGreaterThanOrEqual(margin);
    expect(pct(onCassette.get("right")) + widthPct()).toBeLessThan(100 - margin);
  });

  it("keeps a tape's print and a tape's name uncovered", () => {
    // The two things on a VHS that identify it. The print was placed against
    // three constraints of its own (T-270) and the label is where the object's
    // name is written, so the sticker gets what is left of the lip and nothing
    // that was already spoken for.
    const printRight =
      Number.parseFloat(/var\(--print-left,\s*([\d.]+)%/.exec(print.get("left")!)![1]!) +
      Number.parseFloat(/var\(--print-w,\s*([\d.]+)%/.exec(print.get("width")!)![1]!);
    const stickerLeft = 100 - pct(onVhs.get("right")) - widthPct();
    expect(stickerLeft).toBeGreaterThan(printRight);

    // And clear of the label, which starts a quarter of the way down.
    const labelTop = pct(vhsLabel.get("inset")!.split(/\s+/)[0]);
    expect(pct(onVhs.get("top")) + heightPct(VHS)).toBeLessThan(labelTop);
  });

  it("sits on the lip a VHS actually has, rather than over the join", () => {
    // The moulded lip is the top 15% (`.case-shell::after`). A label lapping off
    // the bottom of it would be stuck across a moulded step, which is the one
    // place on the object nobody would put one.
    expect(pct(onVhs.get("top")) + heightPct(VHS)).toBeLessThan(15);
  });

  it("costs nothing at all on a recording that has its transcript", () => {
    // `display` and not an opacity: the ordinary case is a wall of interviews
    // that all have their `.srt`, and that board must be drawn exactly as it was
    // before this task — no box, no compositing layer, no paint.
    expect(empty.get("display")).toBe("none");
  });

  it("is one line of stock type and cannot become a note", () => {
    // Two short words off a roll. Wrapping would make it a sentence somebody
    // wrote, which is the one thing a stock label is not.
    expect(sticker.get("white-space")).toBe("nowrap");
    expect(sticker.get("width")).toBe("max-content");
    // And no `max-width`, deliberately: `nowrap` overflows one rather than
    // honouring it, so a cap there would hide a fitting problem instead of
    // failing on it. The type size is what governs the width.
    expect(sticker.has("max-width")).toBe(false);
  });

  it("is typed on the object rather than drawn over it", () => {
    // DESIGN 1.3. The face the case number and the runtime are set in — a
    // monospace here would read as chrome laid on the tape, which is what this
    // board does not do.
    expect(sticker.get("font-family")).toContain("Source Sans 3");
    expect(sticker.get("font-family")).not.toContain("mono");
  });

  it("throws its shadow away from the light at any angle the object is turned to", () => {
    // T-313: `--lx`/`--ly` is a unit vector from an object toward its shadow,
    // already counter-rotated into the item's own frame. Written flat down the
    // page it would turn with the element, and a tape stood on its head would
    // have a sticker lit from underneath.
    const shadow = sticker.get("box-shadow")!;
    expect(shadow).toContain("var(--lx");
    expect(shadow).toContain("var(--ly");
    // The tilt is the sticker's own and turns *with* the object, which is the
    // other half of the same distinction — it is a thing stuck on, not a wash
    // of light across a face.
    expect(sticker.get("transform")).toContain("--sticker-tilt");
    expect(sticker.get("transform")).not.toContain("--turn");
  });
});
