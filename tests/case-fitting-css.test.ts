/**
 * Writing that has to fit its object, asserted for **every** object rather than
 * for the one in front of somebody — T-338.
 *
 * ## Why this file exists, which is the whole of the lesson
 *
 * T-306 found that `line-height: 1.15` is tighter than Patrick Hand descends, so
 * the `overflow: hidden` on a label shaved every `g`, `y` and `j` flat; and that
 * an `auto` grid row squeezed by a label with more in it than it holds cuts the
 * *last line in half*, which reads as a rendering fault where an ellipsis reads
 * as a label that ran out of room. It fixed both. It fixed them as
 * `.item-case[data-kind="cassette"] …`.
 *
 * So a VHS and a manilla folder kept the defect, and kept it for weeks, and the
 * way it surfaced was Phil pasting a link and seeing a tape's caption sliced
 * through the middle. Every test T-306 wrote passed the entire time, because
 * every one of them asked about a cassette.
 *
 * That is the failure this file guards: not the CSS, which is easy to get right
 * once, but **the scope of a rule**. Each test below iterates the kinds rather
 * than naming one, so a fix applied to a single object fails here the moment it
 * is written that way.
 *
 * The measurements behind the numbers are on T-338 and were taken on the running
 * app at the size ingest creates each object.
 */

import { describe, expect, it } from "vitest";

import { HAND_LINE } from "../src/lib/objects";

import { declarations } from "./css-declarations";

/** Every object with a file behind it. A new one belongs in this list. */
const KINDS = ["folder", "vhs", "cassette"] as const;

const base = declarations(".item-case");
/**
 * `declarations` matches a selector against each comma-separated part of a
 * rule's head, so asking for `.case-title` returns the shared block *and* the
 * title's own, merged in source order — which is what a browser resolves anyway.
 * Asking for the two-part selector itself would match nothing.
 */
const title = declarations(".case-title");
const caption = declarations(".case-caption:not(.item-field)");

/** `--case-title-lines` as this kind resolves it, falling back to the base. */
function linesFor(kind: string, which: "title" | "caption"): number {
  const own = declarations(`.item-case[data-kind="${kind}"]`).get(`--case-${which}-lines`);
  const fallback = base.get(`--case-${which}-lines`);
  return Number.parseFloat(own ?? fallback!);
}

describe("the rule is declared once, for every object", () => {
  it("puts the line box and the clamp on the shared rule and not on a kind", () => {
    // The declaration that would undo this task is one that names a kind. If the
    // mechanism ever moves back under `[data-kind="…"]`, the other two objects
    // silently stop getting it — which is exactly how this defect happened.
    for (const [rule, which] of [
      [title, "title"],
      [caption, "caption"],
    ] as const) {
      expect(rule.get("line-height"), `${which}'s line box`).toBe("var(--hand-line)");
      expect(rule.get("display"), `${which}'s clamp`).toBe("-webkit-box");
      expect(rule.get("-webkit-box-orient"), `${which}'s clamp`).toBe("vertical");
    }
    for (const kind of KINDS) {
      const own = declarations(`.item-case[data-kind="${kind}"] .case-title`);
      expect(own.has("line-height"), `${kind} restates the line box`).toBe(false);
      expect(own.has("display"), `${kind} restates the clamp mechanism`).toBe(false);
    }
  });

  it("sets the hand on a line its descenders fit inside", () => {
    // T-306's measurement, now true of every object that writes in the hand
    // rather than of a cassette — so it is declared on `.item`, not on
    // `.item-case`, and a polaroid's caption reads it too.
    const line = declarations(".item").get("--hand-line");
    expect(Number.parseFloat(line!)).toBeGreaterThanOrEqual(1.32);
    expect(declarations(".item-case").has("--hand-line"), "scoped to the cases again").toBe(false);
  });

  /**
   * And the same number on the other side of the seam. `fitWriting` has to know
   * how tall a line is to know how many fit in a caption's band, and CSS cannot
   * hand a number to arithmetic — so it exists twice and this is what stops the
   * two drifting. The same arrangement `A4_UNITS` has with the folder's
   * percentages.
   */
  it("agrees with the line box the arithmetic uses", () => {
    expect(Number.parseFloat(declarations(".item").get("--hand-line")!)).toBe(HAND_LINE);
  });

  it("writes a polaroid's caption in the same line box as a label", () => {
    // The place T-306 did not look. `.pol-caption` kept 1.15 and kept the shaved
    // descenders, for the same reason the tape did.
    expect(declarations(".pol-caption").get("line-height")).toBe("var(--hand-line)");
  });
});

describe("every label holds a whole number of lines", () => {
  it.each(KINDS)("%s clamps its title and caption to whole lines", (kind) => {
    for (const which of ["title", "caption"] as const) {
      const n = linesFor(kind, which);
      expect(Number.isInteger(n), `${kind}'s ${which} budget is ${n}`).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });

  /**
   * The `max-height` is the half that actually fixed the tape.
   *
   * A clamp counts lines; it does not stop a grid row being shorter than the
   * lines in it. What squeezed the VHS was the *row* — 26 units holding a 15.98
   * line box, one line and two thirds — and the clamp had nothing to say about
   * it. A `max-height` of exactly N line boxes makes the element hold a whole
   * number of lines whatever the grid does around it.
   */
  it("bounds the box in line boxes rather than trusting the grid", () => {
    for (const [rule, which] of [
      [title, "title"],
      [caption, "caption"],
    ] as const) {
      const max = rule.get("max-height");
      expect(max, `${which} has no max-height`).toBeDefined();
      // N line boxes, in `em`, so it is exactly the lines the clamp allows and
      // cannot drift from them.
      expect(max).toContain(`var(--case-${which}-lines)`);
      expect(max).toContain("var(--hand-line)");
      expect(max).toContain("1em");
    }
  });

  it("clamps each box to the same number it is bounded by", () => {
    expect(title.get("-webkit-line-clamp")).toBe("var(--case-title-lines)");
    expect(caption.get("-webkit-line-clamp")).toBe("var(--case-caption-lines)");
  });
});

/**
 * **The one that would be a real bug**, carried over from the cassette's own
 * file because it is now true of every object at once.
 *
 * The caption is the only line a caret can reach, and the editor over it is a
 * `<textarea>` wearing the same class. `display: -webkit-box` on a text field
 * takes the field apart, so the box treatment is written with `:not(.item-field)`
 * — and a selector is exactly the kind of thing a later tidy-up shortens.
 */
describe("the editor's field is left alone", () => {
  it("excludes the field from the box treatment", () => {
    // The bare `.case-caption` rule is the one the `<textarea>` also matches, so
    // nothing that would take a text field apart may appear in it.
    const loose = declarations(".case-caption");
    expect(loose.get("display"), "the box treatment reaches the textarea").not.toBe("-webkit-box");
    expect(loose.has("-webkit-line-clamp"), "the clamp reaches the textarea").toBe(false);
    // While the guarded one does have it.
    expect(caption.get("display")).toBe("-webkit-box");
  });
});
