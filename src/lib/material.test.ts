/**
 * The material table on its own terms.
 *
 * Two things worth being strict about, and neither is a number that will be
 * fiddled with. The first is that **string is the identity**: every board that
 * exists is plain string, so if any of the reference row's five numbers ever
 * stops being 1 (or 0, for the halo) then every rope on every existing board
 * moves or changes colour on the frame that lands. The second is the floor
 * under `sagFor`, which is the one thing a stiffness multiplier can break that
 * the schema's own invariant cannot catch.
 *
 * Like `palette.test.ts`, the cross-check against the schema's fallback lives
 * in `crdt/ops/strings.test.ts` — the side of the seam allowed to see both.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_STRING_MATERIAL,
  STRING_MATERIALS,
  fibre,
  sagFor,
} from "@/lib/material";
import { DEFAULT_SLACK, MIN_SLACK } from "@/lib/slack";

describe("the string materials", () => {
  /** > material (string / yarn / wire) — DESIGN section 3.4 */
  it("is DESIGN 3.4's three, plain string first", () => {
    expect(STRING_MATERIALS.map((m) => m.id)).toEqual(["string", "yarn", "wire"]);
    expect(DEFAULT_STRING_MATERIAL).toBe("string");
  });

  /**
   * The one that protects every board built before this file existed. All five
   * numbers, not just the sag: a weight of 1.01 would redraw the whole board a
   * hair wider, which is the kind of change that gets noticed as "something
   * feels different" and never gets traced.
   */
  it("makes plain string the exact identity, so no existing board moves", () => {
    const plain = fibre("string");
    expect([plain.sag, plain.weight, plain.sheen, plain.gloss]).toEqual([1, 1, 1, 1]);
    expect(plain.halo).toBe(0);
    expect(sagFor(DEFAULT_SLACK, "string")).toBe(DEFAULT_SLACK);
  });

  /** AC-268, as arithmetic: at one slack, wire hangs less string than plain and
   *  yarn hangs more. The pixels are `sim/ropes.test.ts`'s job. */
  it("gives wire less sag than string and yarn more, at the same slack", () => {
    expect(sagFor(DEFAULT_SLACK, "wire")).toBeLessThan(sagFor(DEFAULT_SLACK, "string"));
    expect(sagFor(DEFAULT_SLACK, "yarn")).toBeGreaterThan(sagFor(DEFAULT_SLACK, "string"));
  });

  /**
   * The floor, and why it is not the schema's job.
   *
   * `MIN_SLACK` is enforced on the *authored* number, so a legal 0.01 arrives
   * and the stiffest material multiplies it to a third of that — a rest length
   * within a rounding error of the chord, which is precisely the "solver has no
   * slack to absorb error and the rope jitters visibly" case that constant
   * exists to prevent. Without the clamp the stiffest fibre would be the one
   * that shakes.
   */
  it("never lets a stiff material push the effective slack under MIN_SLACK", () => {
    expect(fibre("wire").sag).toBeLessThan(1);
    expect(MIN_SLACK * fibre("wire").sag).toBeLessThan(MIN_SLACK);
    for (const m of STRING_MATERIALS) {
      expect(sagFor(MIN_SLACK, m.id)).toBeGreaterThanOrEqual(MIN_SLACK);
      expect(sagFor(0, m.id)).toBeGreaterThanOrEqual(MIN_SLACK);
    }
  });

  /**
   * A peer on a later version, or a hand-edited document. DATA-MODEL section
   * 8.1's rule for a field that makes no sense is to render something rather
   * than nothing, and this is called from inside the frame loop where throwing
   * would take the board down.
   */
  it("falls back to plain string for a name it does not know", () => {
    expect(fibre("hemp")).toBe(STRING_MATERIALS[0]);
    expect(fibre("")).toBe(STRING_MATERIALS[0]);
    expect(sagFor(DEFAULT_SLACK, "hemp")).toBe(sagFor(DEFAULT_SLACK, "string"));
  });

  /**
   * Yarn is the fuzzy one and it is the only fuzzy one — the painter's fourth
   * stroke is skipped entirely on a zero, so this is also the assertion that a
   * board with no yarn on it pays nothing for the feature.
   */
  it("gives fuzz to yarn alone", () => {
    expect(fibre("yarn").halo).toBeGreaterThan(0);
    expect(fibre("string").halo).toBe(0);
    expect(fibre("wire").halo).toBe(0);
  });

  /**
   * Bright-and-narrow reads as metal, dim-and-wide reads as wool. The two knobs
   * have to move in opposite directions or the pair just look like two weights
   * of the same cotton.
   */
  it("makes wire's highlight harder than string's and yarn's softer", () => {
    const plain = fibre("string");
    const yarn = fibre("yarn");
    const wire = fibre("wire");
    expect(wire.sheen).toBeGreaterThan(plain.sheen);
    expect(wire.gloss).toBeLessThan(plain.gloss);
    expect(yarn.sheen).toBeLessThan(plain.sheen);
    expect(yarn.gloss).toBeGreaterThan(plain.gloss);
    // And the widths that go with them — wire is the thinnest thing on the
    // board and yarn the fattest, which is most of what tells them apart at
    // the zoom the board is normally at.
    expect(wire.weight).toBeLessThan(plain.weight);
    expect(yarn.weight).toBeGreaterThan(plain.weight);
  });
});
