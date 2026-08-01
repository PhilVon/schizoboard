/**
 * The folder, the VHS and the cassette against the one light — T-313.
 *
 * These three objects are drawn almost entirely in CSS gradients, and a gradient
 * is declared in its element's frame, so every one of them turned with the
 * object. Phil turned a folder upside down and its creases were lit from below:
 * DESIGN 4.1's "one element lit from the wrong side", which it says breaks the
 * sense of a real surface faster than anything else on the board.
 *
 * `dom.ts`'s `writeLight` now publishes the light in each object's own frame as
 * `--lx` / `--ly` and the counter-turn as `--turn`, and the stylesheet takes its
 * own dot product per feature. Which means the numbers beside each gradient have
 * to agree with the angle written two characters away, and with `LIGHT_ANGLE` in
 * a different language in a different file. Nothing at runtime checks that, and
 * getting it wrong has no symptom in any number — only in the pixels, and only
 * on an object somebody has turned.
 *
 * So this is arithmetic on the source, like `case-label-css.test.ts`, and every
 * assertion is a decision rather than a restatement.
 */

import { describe, expect, it } from "vitest";

import { LIGHT_DX, LIGHT_DY } from "../src/render/items/shadow";

import { declarations, layers } from "./css-declarations";

/** Every rule that draws one of the three case objects. */
const RULES = [
  ".folder-back",
  ".folder-sheets",
  ".folder-sheets::after",
  ".folder-front",
  ".folder-label",
  ".case-shell",
  ".case-tape",
  ".case-label",
] as const;

/**
 * The gradients deliberately left in the object's own frame, and why.
 *
 * An allow-list rather than silence, because "we did not get to it" and "this one
 * is a fact about the object" look identical in a stylesheet, and the difference
 * is the whole of this task. Anything angled or axis-locked that is not here has
 * to carry the light.
 */
const IN_THE_OBJECT_S_FRAME: Record<string, string> = {
  ".folder-sheets::after":
    "the pitch of the sheet edges and the fade at the left, where the pile is squarest to us — both facts about the pile, not about the light",
  ".folder-label": "a gummed label's own printed tint",
  ".case-tape": "the tape's own web, which is a property of the tape",
  ".case-label": "as .folder-label",
  ".folder-sheets": "the depth ramp into the folder, which is how far in the paper is",
  ".case-shell": "the moulding ribs, which are on the shell",
};

interface Angled {
  rule: string;
  /** The CSS angle, clockwise from `to top`. */
  deg: number;
  layer: string;
}

function angledLayers(rule: string): Angled[] {
  const decls = declarations(rule);
  const bg = decls.get("background") ?? decls.get("background-image");
  if (bg === undefined) return [];
  const out: Angled[] = [];
  for (const layer of layers(bg)) {
    const at = /^(?:repeating-)?linear-gradient\(\s*(-?[\d.]+)deg/.exec(layer);
    if (at) out.push({ rule, deg: Number.parseFloat(at[1]!), layer });
  }
  return out;
}

/** `calc(158deg + var(--turn, 0deg))` — a wash put back into board space. */
function counterTurned(rule: string): number {
  const decls = declarations(rule);
  const bg = decls.get("background") ?? decls.get("background-image") ?? "";
  return layers(bg).filter((l) => /calc\(\s*-?[\d.]+deg \+ var\(--turn/.test(l)).length;
}

describe("a case object against the one light", () => {
  /**
   * **The trap `wear.ts` records, in the stylesheet this time.** CSS measures a
   * gradient clockwise from *to top*, so a line at `a` degrees has normal
   * `(sin a, -cos a)`. Reading it as a maths angle gets a vector at right angles
   * to the truth and negated — a highlight on the wrong flank of every crease on
   * the board, with no symptom in any number.
   *
   * Every crease declares its own normal beside itself, so every one of them can
   * be checked against the angle it is used at.
   */
  it.each([
    [".folder-front", "--crease-a", 101],
    [".folder-front", "--crease-b", 152],
    [".folder-sheets", "--crease-c", 99],
    [".folder-sheets", "--crease-d", 84],
  ])("%s %s carries the normal of its own %s° line", (rule, prop, deg) => {
    const def = declarations(rule).get(prop);
    expect(def, `${prop} is declared on ${rule}`).toBeDefined();
    // ` - 0.105 * var(--ly)` carries its sign in the operator, not on the
    // number — which is how CSS wants it written and how the first version of
    // this test read a negative coefficient as positive.
    const nums = [...def!.replace(/ - /g, " + -").matchAll(/(-?[\d.]+) \* var\(--l([xy])/g)];
    expect(nums, `${prop} dots the light with two coefficients`).toHaveLength(2);
    const by = Object.fromEntries(nums.map((m) => [m[2]!, Number.parseFloat(m[1]!)]));
    const a = ((deg as number) * Math.PI) / 180;
    expect(by["x"], `${prop} x is sin ${deg}°`).toBeCloseTo(Math.sin(a), 2);
    expect(by["y"], `${prop} y is -cos ${deg}°`).toBeCloseTo(-Math.cos(a), 2);
  });

  /**
   * **The promise that made this change safe to make.** Every one of these
   * features keeps exactly the alpha it was tuned at while the object lies
   * square, because its clamp multiplier is the reciprocal of its own dot
   * product at rest. Measured: a resting folder before and after came back with
   * a maximum difference of three levels in eight bits.
   *
   * A shared multiplier cannot do that — a fold at 84° is at 66° to the light
   * where one at 152° is square to it — and the failure is silent, a ninth of the
   * contrast off one crease on a board nobody has touched. The light itself is
   * imported rather than written here, so moving `LIGHT_ANGLE` reports every
   * multiplier it has stranded instead of quietly dimming them.
   */
  it.each([
    [".folder-front", "--crease-a", 101],
    [".folder-front", "--crease-b", 152],
    [".folder-sheets", "--crease-c", 99],
    [".folder-sheets", "--crease-d", 84],
  ])("%s %s reaches full strength at rest", (rule, prop, deg) => {
    const decls = declarations(rule);
    const bg = decls.get("background")!;
    const used = [...bg.matchAll(new RegExp(`calc\\((-?[\\d.]+) \\* var\\(${prop}\\)\\)`, "g"))];
    expect(used.length, `${prop} is used in a clamped pair`).toBeGreaterThanOrEqual(2);
    const a = ((deg as number) * Math.PI) / 180;
    const atRest = Math.sin(a) * LIGHT_DX + -Math.cos(a) * LIGHT_DY;
    for (const m of used) {
      const mult = Math.abs(Number.parseFloat(m[1]!));
      expect(
        mult * Math.abs(atRest),
        `${prop} multiplier ${mult} against a resting dot of ${atRest.toFixed(3)}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  /**
   * And both halves of the pair are there. One layer alone is the old drawing
   * with a fade on it: the crease would simply disappear as the object turned
   * past square rather than changing sides, which is a fault that looks like a
   * rendering glitch instead of like the wrong light.
   */
  it.each(["--crease-a", "--crease-b", "--crease-c", "--crease-d"])(
    "%s is drawn both ways up",
    (prop) => {
      const rule = prop === "--crease-c" || prop === "--crease-d" ? ".folder-sheets" : ".folder-front";
      const bg = declarations(rule).get("background")!;
      const signs = [...bg.matchAll(new RegExp(`calc\\((-?[\\d.]+) \\* var\\(${prop}\\)\\)`, "g"))].map(
        (m) => Math.sign(Number.parseFloat(m[1]!)),
      );
      expect(signs).toContain(1);
      expect(signs).toContain(-1);
    },
  );

  /**
   * A profile is a cross-section and DESIGN 4.3 says the light decides only which
   * way up it is drawn — so each of the three has a turned-over twin, gated on
   * the opposite sign of `--ly`.
   */
  it.each([
    [".folder-front", "--edge-lit", "--edge-off"],
    [".folder-sheets", "--head-lit", "--head-off"],
  ])("%s draws its cut edge both ways up", (rule, lit, off) => {
    const decls = declarations(rule);
    for (const prop of [lit, off]) {
      const def = decls.get(prop);
      expect(def, `${prop} is declared`).toBeDefined();
      expect(def, `${prop} is clamped`).toMatch(/^clamp\(0, calc\(-?[\d.]+ \* var\(--ly/);
    }
    expect(decls.get(lit)!.includes("calc(-")).toBe(false);
    expect(decls.get(off)!.includes("calc(-")).toBe(true);
    // And the same resting promise the creases make: a square object's cut edge
    // keeps exactly the shine it was drawn with. The top edge's normal is
    // straight up, so its dot with the light is `--ly` alone.
    for (const prop of [lit, off]) {
      const mult = Math.abs(Number.parseFloat(/calc\((-?[\d.]+) \*/.exec(decls.get(prop)!)![1]!));
      expect(mult * LIGHT_DY, `${prop} multiplier ${mult}`).toBeGreaterThanOrEqual(1);
    }
    const bg = decls.get("background")!;
    expect(bg).toContain(`var(${lit})`);
    expect(bg).toContain(`var(${off})`);
  });

  /**
   * **The sweep.** Every angled gradient on any of these objects is either put
   * back into board space with `--turn` or signed against `--lx` / `--ly` — or it
   * is on the list above with a reason. That list is what stops "not got to yet"
   * looking exactly like "this one belongs to the object".
   */
  it.each(RULES)("%s leaves nothing lit from its own side", (rule) => {
    const excused = IN_THE_OBJECT_S_FRAME[rule];
    for (const { deg, layer } of angledLayers(rule)) {
      const signed = /var\(--(?:lx|ly|crease-|edge-|head-)/.test(layer);
      expect(
        signed || excused !== undefined,
        `${rule} has a ${deg}° gradient that neither carries the light nor is excused`,
      ).toBe(true);
    }
  });

  /** And the three broad washes really are counter-turned, not merely excused. */
  it.each([".folder-back", ".folder-front", ".case-shell"])("%s counter-turns its wash", (rule) => {
    expect(counterTurned(rule)).toBeGreaterThanOrEqual(1);
  });
});
