/**
 * Where a sheet's rules are printed (T-182).
 *
 * The rest of `paper.ts` is a texture and two colours, and a test would only
 * restate them. This part is arithmetic against numbers that live in a *second*
 * file — `.paper-text`'s padding and line height in `items.css` — and the
 * failure mode is not a crash: it is writing that sits between the lines for the
 * whole sheet, which is what shipped for months.
 */

import { describe, expect, it } from "vitest";

import { rulePhase, stockRuling, type PaperStock } from "@/render/items/paper";

/** `.paper-text`: 14px of padding, and Patrick Hand's baseline 18px into a 22px line box. */
const FIRST_BASELINE = 32;
const LINE_HEIGHT = 22;

/** Every y a rule is drawn at, down as far as a tall note. */
function rulesDownTheSheet(spacing: number, depth = 400): number[] {
  const ys: number[] = [];
  for (let y = rulePhase(spacing); y < depth; y += spacing) ys.push(y);
  return ys;
}

/** Every y the writing's baselines land on. */
function baselines(depth = 400): number[] {
  const ys: number[] = [];
  for (let y = FIRST_BASELINE; y < depth; y += LINE_HEIGHT) ys.push(y);
  return ys;
}

describe("ruling a sheet", () => {
  it("puts a rule under the first line of writing on every ruled stock", () => {
    // DESIGN 4.4 asks for exactly this of the index card, and it is the same
    // thing the legal pad and the graph paper were getting wrong.
    for (const stock of ["legal", "graph", "index"] as PaperStock[]) {
      const spacing = spacingOf(stock);
      expect(rulesDownTheSheet(spacing), stock).toContain(FIRST_BASELINE);
    }
  });

  it("puts one under every line on the legal pad, whose spacing is the line", () => {
    // The stock this was noticed on. Its 22px ruling and the 22px line box are
    // the same rhythm, so getting the phase right lands all of them at once.
    for (const baseline of baselines()) {
      expect(rulesDownTheSheet(22)).toContain(baseline);
    }
  });

  it("draws the rule one unit tall, starting at the baseline", () => {
    // Starting *at* it rather than above: letters rest on a line and descenders
    // cross it, which is what writing on ruled paper does.
    const css = stockRuling("legal");
    expect(css).toContain("transparent 0 10px");
    expect(css).toContain("10px 11px");
    expect(css).toContain("11px 22px");
  });

  it("leaves an unruled stock unruled, and the graph's columns square", () => {
    expect(stockRuling("white")).toBe("none");
    expect(stockRuling("cream")).toBe("none");
    // 14px squares, phased 4px down the sheet so a line of writing lands on one
    // — a column has no baseline to meet, so its own phase is left alone.
    const graph = stockRuling("graph");
    expect(graph).toContain("transparent 0 4px");
    expect(graph).toContain("to right, transparent 0 13px");
  });

  it("keeps the index card's red margin, which is not a rule", () => {
    const index = stockRuling("index");
    expect(index).toContain("linear-gradient(to right, transparent 0 30px");
    expect(index).toContain("transparent 0 12px");
  });
});

/** The spacings in `paper.ts`'s table, named here so the test says what it means. */
function spacingOf(stock: PaperStock): number {
  return { legal: 22, graph: 14, index: 20 }[stock as "legal" | "graph" | "index"];
}
