/**
 * What stops the set touching the board it covers — T-276, AC-676.
 *
 * > The board behind it is not re-laid-out, re-fitted or re-tiered on the way in
 * > or out.
 *
 * That is a promise about something *not* happening, which is the kind nothing
 * catches. There is no frame this could be asserted on: the board looks
 * identical whether it was left alone or taken apart and put back, and the
 * failure only shows as a tier that dropped, a camera that moved a few pixels,
 * or four hundred items remounting the moment somebody presses `Escape`.
 *
 * So it is asserted on the two mechanisms that make it true instead.
 *
 * **The element cannot change the size of the window.** Every re-fit on this
 * board is downstream of one signal — `camera.version` — and the only thing that
 * moves it without a person doing something is the `resize` listener in
 * `app/main.ts`, which goes on to `world.gestureTick`, the settle debounce,
 * `lod.settle` and, if the tier moved, `dirty.everything()`. An absolutely
 * positioned child of a layer inside `contain: strict` cannot start that chain.
 * Give it `position: fixed` and a `min-width`, or let a scrollbar appear, and it
 * can.
 *
 * **The module cannot reach the board.** `ui/crt.ts` imports nothing from
 * `state/`, `render/` or `crdt/`, so there is no camera to fly, no LOD to hold,
 * no dirty set to fill and no document to write to. An import appearing in that
 * list is the first move anybody makes towards breaking this, and it is visible
 * here before the behaviour is.
 *
 * In `tests/` rather than beside the module because both halves read files, and
 * `tsconfig.json` deliberately withholds Node's types from `src/`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const base = readFileSync(
  fileURLToPath(new URL("../src/styles/base.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const source = readFileSync(fileURLToPath(new URL("../src/ui/crt.ts", import.meta.url)), "utf8");

/** Every declaration under one top-level selector of `base.css`, in source order. */
function declarations(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < base.length) {
    const open = base.indexOf("{", i);
    if (open === -1) break;
    const head = base.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < base.length && depth > 0) {
      if (base[j] === "{") depth++;
      else if (base[j] === "}") depth--;
      j++;
    }
    if (head.split(",").some((s) => s.trim() === selector)) {
      for (const decl of base.slice(open + 1, j - 1).split(";")) {
        const at = decl.indexOf(":");
        if (at === -1) continue;
        out.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim().replace(/\s+/g, " "));
      }
    }
    i = j;
  }
  return out;
}

describe("the set cannot resize the window, which is what would re-fit the board", () => {
  const crt = declarations(".crt");

  it("is laid out by the layer it is in, not by the viewport", () => {
    // `fixed` would take it out of `#board-root`'s containment, and out from
    // under the one thing guaranteeing it cannot affect the page's own box.
    expect(crt.get("position")).toBe("absolute");
    expect(crt.get("inset")).toBe("0");
  });

  it("is not there at all while nothing is on", () => {
    // The same argument the search field makes: on every frame nobody is
    // watching anything there is no rectangle over the board.
    expect(crt.get("display")).toBe("none");
  });

  it("sits inside a root that clips it, so nothing it holds can scroll the page", () => {
    expect(declarations("#board-root").get("contain")).toBe("strict");
    expect(declarations("html").get("overflow")).toBe("hidden");
  });

  it("gives nothing inside it a width that could exceed the viewport", () => {
    for (const selector of [".crt-set", ".crt-rail", ".crt-plate"]) {
      const width = declarations(selector).get("width") ?? declarations(selector).get("max-width");
      if (width === undefined) continue;
      const vw = /^(\d+(?:\.\d+)?)vw$/.exec(width);
      if (vw === null) continue;
      expect(Number(vw[1]), `${selector} is ${width}`).toBeLessThanOrEqual(100);
    }
  });
});

describe("the set cannot reach the board", () => {
  it("imports nothing from the board — no camera, no LOD, no scene, no document", () => {
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((s) => /^@\/(state|render|crdt|sim|app)\//.test(s))).toEqual([]);
  });

  it("never names the machinery a re-fit or a re-tier would have to go through", () => {
    for (const forbidden of ["camera", "lod", "dirty", "scene", "flight", "culler"]) {
      expect(
        new RegExp(`\\b${forbidden}\\.`).test(source),
        `${forbidden} is reachable from the set`,
      ).toBe(false);
    }
  });
});
