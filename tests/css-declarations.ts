/**
 * Reading `items.css` as data, for the tests that assert geometry on it.
 *
 * The suite runs on happy-dom, which has no layout engine, so nothing in `src/`
 * can measure a box. What *can* be checked without a browser is that the
 * stylesheet still describes the shape it is supposed to — every length in these
 * objects is a percentage of a size settled in `lib/objects.ts`, so the geometry
 * is arithmetic on the source.
 *
 * In `tests/` rather than beside the stylesheet because it reads a file, and
 * `tsconfig.json` deliberately withholds Node's types from `src/`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const css = readFileSync(
  fileURLToPath(new URL("../src/render/items/items.css", import.meta.url)),
  "utf8",
);

/** The stylesheet with every comment taken out, which is what to match against. */
export const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every declaration under a selector, merged in source order.
 *
 * A hand-rolled scan rather than a regex because `@keyframes` nests, and rather
 * than a CSS parser because pulling one in to read a dozen numbers is a
 * dependency for the sake of a dependency. Only top-level rules are collected,
 * which is where all of these live.
 */
export function declarations(selector: string): Map<string, string> {
  const src = bare;
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
        out.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim().replace(/\s+/g, " "));
      }
    }
    i = j;
  }
  return out;
}

/** A comma-separated CSS list, split at the top level — commas inside `rgba()`
 *  and `linear-gradient()` are not separators. */
export function layers(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter((s) => s.length > 0);
}
