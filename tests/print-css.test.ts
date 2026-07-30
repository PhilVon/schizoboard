/**
 * What must not be in an export — T-208, D-36, and now the search field (T-85).
 *
 * There is no test between this stylesheet and a file handed to another person.
 * The PDF route is Chromium's own print pipeline, so it renders the document
 * exactly as it stands: anything on screen that is not the board goes in the
 * file. That is not a hypothesis — the first PDF this project produced had the
 * dev HUD in it, fps counter and all, and the whole hint line across the bottom.
 *
 * The block is one `@media print` rule and a deletion from it is silent. It
 * would not fail a build, would not fail a test, and would not be visible on
 * screen; the first anybody would know is a PDF with somebody's search query
 * printed across the top of their board. So the block is asserted as *data*,
 * read out of the stylesheet, rather than left to a run that only happens when
 * somebody thinks to look.
 *
 * The negative half matters as much: `@media print` cannot be left half-applied,
 * which is the reason it is a stylesheet rather than a toggle — and a rule that
 * over-reached would take the board out of the board's own picture.
 *
 * In `tests/` rather than beside the stylesheet because it reads a file, and
 * `tsconfig.json` deliberately withholds Node's types from `src/` — a guard
 * against `process.env` typechecking inside a renderer.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("../src/styles/base.css", import.meta.url)),
  "utf8",
);

/** The selectors inside the first `display: none !important` rule of the print
 *  block, as a set — parsed rather than string-matched, so a selector merely
 *  *mentioned* in a comment nearby cannot pass for one that is in the rule. */
function hiddenInPrint(): Set<string> {
  const at = css.indexOf("@media print");
  expect(at, "the print block itself").toBeGreaterThan(-1);
  const block = css.slice(at);
  const rule = block.slice(0, block.indexOf("display: none !important"));
  const open = rule.lastIndexOf("{", rule.lastIndexOf("{") - 1);
  const selectors = rule
    .slice(rule.indexOf("{", open + 1) === -1 ? open : open + 1)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{/g, "")
    .split(",")
    .map((s: string) => s.trim())
    .filter((s: string) => s.startsWith("."));
  return new Set(selectors);
}

describe("the print block", () => {
  it.each([
    [".hud", "the dev HUD — the first thing that ever leaked into a PDF"],
    [".hint", "the keyboard hint line"],
    [".notice", "whose laptop the missing photographs are on"],
    [".flash", "a confirmation that something just happened"],
    [".search", "the query you were looking for, across the top of the board"],
    [".menu", "a context menu left open"],
  ])("hides %s — %s", (selector) => {
    expect(hiddenInPrint().has(selector)).toBe(true);
  });

  it("takes the session's chrome out, since a file handed on is not your window", () => {
    // Cursors, drag ghosts, selection outlines and wet ink all live here.
    expect(css.slice(css.indexOf("@media print"))).toContain(".layer-overlay");
  });

  it("does not take the board out of the board's own picture", () => {
    const hidden = hiddenInPrint();
    for (const layer of [".layer-world", ".layer-cork", ".layer-board-ink", ".layer-pins"]) {
      expect(hidden.has(layer), `${layer} must survive a print`).toBe(false);
    }
  });
});
