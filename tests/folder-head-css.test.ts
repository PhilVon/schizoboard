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

import { folderBulk } from "../src/lib/objects";

import { bare, declarations, layers } from "./css-declarations";

const sheets = declarations(".folder-sheets");
const edges = declarations(".folder-sheets::after");
const front = declarations(".folder-front");
const back = declarations(".folder-back");
const folder = declarations('.item-case[data-kind="folder"]');
const shell = declarations(".case-shell");

/**
 * A percentage, or `calc(A% ± var(--bulk, F) * B%)`, resolved at one page count.
 *
 * Small enough to write out and big enough to be worth it: T-312's fault was
 * arithmetic between two declarations in different rules, which is exactly the
 * kind nobody checks by reading.
 */
function atBulk(expr: string, bulk: number): number {
  const plain = /^([\d.]+)%$/.exec(expr.trim());
  if (plain) return Number.parseFloat(plain[1]!);
  const calc = /^calc\(\s*([\d.]+)%\s*([+-])\s*var\(--bulk,\s*[\d.]+\)\s*\*\s*([\d.]+)%\s*\)$/.exec(
    expr.trim(),
  );
  expect(calc, `"${expr}" is a percentage or a calc over --bulk`).not.toBeNull();
  const [, base, sign, span] = calc!;
  const step = bulk * Number.parseFloat(span!);
  return Number.parseFloat(base!) + (sign === "-" ? -step : step);
}

/**
 * Where the head of the paper stands at this page count if the document is all
 * here — the T-312 arithmetic on its own, before T-271 slid it.
 */
const fullHeadAt = (bulk: number) => atBulk(sheets.get("--head")!, bulk);

/**
 * And where it actually is, which is that head scaled by how much of the file
 * has arrived (T-271).
 *
 * `arrived` defaults to `1` because that is the *declaration's* fallback: a
 * folder whose document is present has no `--arrived` at all. Every existing
 * assertion below therefore reads exactly what it read before that task, which
 * is the point of testing it this way round rather than trusting the algebra.
 */
function headAt(bulk: number, arrived = 1): number {
  const calc =
    /^calc\(\s*([\d.]+)%\s*-\s*\(\s*([\d.]+)%\s*-\s*var\(--head\)\s*\)\s*\*\s*var\(--arrived,\s*([\d.]+)\)\s*\)$/.exec(
      sheets.get("top")!,
    );
  expect(calc, `"${sheets.get("top")}" slides --head by --arrived`).not.toBeNull();
  const [, foot, foot2, fallback] = calc!;
  expect(foot, "one foot, written twice").toBe(foot2);
  expect(Number.parseFloat(fallback!), "an absent --arrived is a folder that is here").toBe(1);
  const at = Number.parseFloat(foot!);
  return at - (at - fullHeadAt(bulk)) * arrived;
}
/** Where its foot is — `bottom` is measured from the object's own foot. */
const footAt = (bulk: number) => 100 - atBulk(sheets.get("bottom")!, bulk);
/** The front panel's cut edge, which is what hides the foot. */
const panelTop = Number.parseFloat(front.get("inset")!.split(" ")[0]!);
/** What anybody can actually see of the paper. */
const visibleAt = (bulk: number, arrived = 1) =>
  Math.min(footAt(bulk), panelTop) - headAt(bulk, arrived);

const LADDER = [0, 0.25, 0.5, 0.75, 1];

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
   * Both halves of T-269's page count, which neither fix may quietly cost: how
   * high the paper stands, and how far up it the edges reach. With the top sheet
   * gone the second is doing far more work than it was — it is the difference
   * between a memo and a case dump rather than a detail under a sheet.
   */
  it("still says the page count with the head and with the edges", () => {
    expect(sheets.get("--head")).toMatch(/--bulk/);
    expect(sheets.get("top")).toMatch(/--head/);
    expect(edges.get("inset")).toMatch(/--bulk/);
  });

  /**
   * **A folder whose document is here is drawn where it was drawn before T-271.**
   *
   * Not approximately and not within a pixel — the same number, at every page
   * count. `--arrived` is absent on an object whose file is present, so the whole
   * of that task has to disappear into a fallback, and the way that stops being
   * true is somebody reaching for the obvious `top: calc(... * var(--arrived))`
   * and shifting the resting pose by a fraction of a per cent nobody would see
   * in a screenshot. Two multipliers have already been caught this way.
   */
  it.each(LADDER)("leaves the resting head exactly where it was at bulk %s", (bulk) => {
    expect(headAt(bulk)).toBe(fullHeadAt(bulk));
  });

  /**
   * And an empty one shows no paper at all: the head slides down onto the foot,
   * which is itself behind the front panel, so what is at the top of the object
   * is back-panel kraft. That is the missing-file state (T-271) — a folder with
   * nothing in it, under a label still saying how many pages it had.
   */
  it("shows nothing of the paper before the document arrives", () => {
    expect(headAt(0.48, 0)).toBeCloseTo(footAt(0.48), 6);
    expect(visibleAt(0.48, 0)).toBeLessThanOrEqual(0);
  });

  /**
   * And it fills from there monotonically, which is what makes the transfer
   * legible without a bar drawn over the object.
   */
  it("fills upward as the document arrives", () => {
    const seen = [0, 0.25, 0.5, 0.75, 1].map((a) => visibleAt(0.48, a));
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!, `${i / 4} of the way in shows no more than the step before`).toBeGreaterThan(
        seen[i - 1]!,
      );
    }
  });

  /**
   * **The fault Phil found on a one-page folder.** The foot of the paper has to
   * finish *behind* the front panel at every page count, or there is nothing
   * between the paper and the folder but back-panel kraft and the paper floats
   * clear of the object it is in. Anchored at the head with a growing height, it
   * fell short of the panel below about six pages by 1.43% of the object.
   */
  it.each(LADDER)("tucks the foot behind the front panel at bulk %s", (bulk) => {
    expect(footAt(bulk)).toBeGreaterThan(panelTop + 1);
  });

  /**
   * **The fault behind that one, which is worse.** Growth below the panel's cut
   * edge cannot be seen, so a band pinned at the head and grown downward says
   * nothing: the visible paper measured 11.26%, 11.12% and 11.1% of the object
   * for eight, forty and two hundred pages. The declaration said how much was in
   * the folder and the drawing did not. Half again from empty to full is what
   * T-269 asked for and is roughly what the head-anchored version now gives.
   */
  it("grows what can be seen, not what the panel covers", () => {
    for (let i = 1; i < LADDER.length; i++) {
      expect(
        visibleAt(LADDER[i]!),
        `bulk ${LADDER[i]} shows no more paper than bulk ${LADDER[i - 1]}`,
      ).toBeGreaterThan(visibleAt(LADDER[i - 1]!));
    }
    expect(visibleAt(1) / visibleAt(0)).toBeGreaterThan(1.5);
  });

  /**
   * And neither end leaves the item's own box, at any page count — the pins, the
   * ink, the hit test and the baked shadow all agree about where the object is,
   * and it is the board's silhouette the paper breaks, not the item's.
   */
  it.each(LADDER)("stays inside the item box at bulk %s", (bulk) => {
    expect(headAt(bulk)).toBeGreaterThanOrEqual(0);
    expect(footAt(bulk)).toBeLessThanOrEqual(100);
  });

  /**
   * The band is drawn before the asset record arrives — which may be a peer's
   * write and a network away — so the CSS carries `folderBulk`'s own not-knowing
   * value as a fallback. Two authors for one number, in two languages.
   */
  it("falls back to the same not-knowing value folderBulk does", () => {
    const fallback = /var\(--bulk,\s*([\d.]+)\)/.exec(sheets.get("--head")!)![1]!;
    expect(Number.parseFloat(fallback)).toBeCloseTo(folderBulk(null), 2);
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
    const stack = layers(front.get("background")!);
    // The years are over the whole panel and so are the topmost layer of it
    // (T-316); the cut edge is the first thing the panel actually draws.
    expect(stack[0]).toBe("var(--paper-yellowing)");
    const profile = stack[1]!;
    // The alphas are expressions since T-313 gave the profile a light to be on
    // the right side of, so this holds the *shape* — the shine, then the hairline
    // of board thickness, in that order — rather than two numbers.
    expect(profile, "a shine and a hairline of board thickness, in that order").toMatch(
      /rgba\(255, 246, 228, .+?\) 0 [\d.]+%,\s*rgba\(96, 70, 40, /,
    );
  });
});

/**
 * Where a folder begins, and the one thing that was anchored to the box instead
 * — T-315.
 *
 * The kraft starts a little way down so the paper can have the top of the item to
 * itself. A strip of tape is positioned on the corner of the *drawn* thing, not
 * of the box, through `--edge-*`, which `PaperView` writes from its torn outline
 * and `CaseView` never wrote at all. So a folder's head corners fell back to
 * `0px` and the tape floated a clear thirteen board units above any kraft:
 * stuck to nothing, holding nothing. Phil saw it at the top right.
 */
describe("what a folder's tape is stuck to", () => {
  /**
   * One number, two readers. The whole fault was two places knowing where the
   * kraft starts and only one of them being told when it moved — so the test is
   * that there is only one place, rather than that the two agree today.
   */
  it("takes the head inset and the tape's anchor from the same declaration", () => {
    expect(back.get("inset")).toMatch(/^var\(--kraft-top/);
    expect(folder.get("--kraft-top"), "the folder's root declares it").toBeDefined();
    for (const prop of ["--edge-tl-y", "--edge-tr-y"]) {
      expect(folder.get(prop), `${prop} is the same number`).toBe("var(--kraft-top)");
    }
  });

  /**
   * And only the head. The back panel runs to the foot and the full width, so the
   * other six are flush and must stay at their `0px` fallback — "completing the
   * set" would walk the tape *off* the object at three corners out of four.
   */
  it.each(["--edge-tl-x", "--edge-tr-x", "--edge-br-x", "--edge-br-y", "--edge-bl-x", "--edge-bl-y"])(
    "leaves %s alone, because that edge is flush",
    (prop) => {
      expect(folder.has(prop)).toBe(false);
    },
  );

  /**
   * The reason this is the folder's problem alone: a VHS and a cassette *are*
   * their boxes. If a shell is ever inset, its tape needs the same treatment and
   * this is where that will be noticed.
   */
  it("needs none of it for the two plastic ones", () => {
    expect(shell.get("inset")).toBe("0");
    for (const prop of ["--edge-tl-y", "--edge-tr-y"]) {
      expect(declarations('.item-case[data-kind="vhs"]').has(prop)).toBe(false);
      expect(declarations('.item-case[data-kind="cassette"]').has(prop)).toBe(false);
    }
  });
});
