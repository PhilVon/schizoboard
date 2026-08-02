/**
 * The one thing the reading surface and the text index have to agree about —
 * T-280.
 *
 * Two functions turn a PDF's text runs into characters, on two sides of a
 * boundary, and neither of them may move to the other side: `linesOfRuns`
 * (`render/items/dom.ts`) reads the run boxes to find where the *lines* were,
 * because Q-198 re-sets the text on our own paper and a line break is part of
 * setting it; `document::joined` (`src-tauri/src/document.rs`) decides only
 * where the *gaps* were, because that is all a needle can tell apart and the
 * index is a few hundred kilobytes rather than a few megabytes because of it.
 *
 * Making them one function would mean putting layout in Rust or a PDF parser in
 * the browser, and D-46 refuses both. So they stay two, and are held to the
 * promise two implementations can keep: **the same non-space characters in the
 * same order**. Which whitespace lands between them is exactly what they are
 * allowed to disagree about, because `TextIndex` normalises it away and the
 * reading surface is the only thing that ever looks at it.
 *
 * The cases are in `tests/fixtures/run-joining.json` and this file is half of
 * what reads them. The other half is `the_gap_rule_agrees_with_the_reading_
 * surfaces_line_rule` in `document.rs`, asserting the same tokens against the
 * same file — which is what makes this a shared fixture rather than two tables
 * somebody has to remember to update together.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { linesOfRuns } from "@/render/items/dom";
import type { TextRun } from "@/platform/types";

interface Case {
  readonly name: string;
  readonly why?: string;
  readonly runs: ReadonlyArray<Partial<TextRun> & { readonly text: string }>;
  readonly tokens: readonly string[];
}

const cases: Case[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/run-joining.json", import.meta.url)), "utf8"),
) as Case[];

/** The same defaults `document.rs` fills the fixture's absent fields with. */
function run(from: Partial<TextRun> & { text: string }): TextRun {
  return {
    text: from.text,
    x: from.x ?? 0,
    y: from.y ?? 0,
    width: from.width ?? 0,
    height: from.height ?? 12,
    size: 12,
  };
}

describe("the reading surface and the text index read the same characters", () => {
  it("has cases to run", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const shared of cases) {
    it(shared.name, () => {
      const got = linesOfRuns(shared.runs.map(run)).split(/\s+/).filter(Boolean);
      expect(got).toEqual(shared.tokens);
    });
  }
});
