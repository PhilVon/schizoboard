/**
 * What a folder, a tape and a cassette show of themselves when the file is not
 * here — asserted as arithmetic on the stylesheet, T-271.
 *
 * Two different things are being defended, and only one of them is the new
 * drawing.
 *
 * The first is the **resting pose**. Every declaration this task touched already
 * existed and already drew a signed-off object; all that was added was a factor
 * that is `1` whenever the file is present. So the whole of it has to vanish
 * into a fallback, exactly, at every one of these declarations — and "exactly"
 * is the word doing the work. A pack that wound to 99.97% instead of 100% would
 * pass every screenshot anybody would think to take.
 *
 * The second is the **tier**. The pack, the tape web and the folder's paper are
 * detail, and detail goes away below 35% zoom. A file that is never coming is
 * not detail — it is the thing a person scans a whole wall for — so it is drawn
 * where no tier can reach it, and that is a fact about which selector the rule
 * is on, which is a thing this file can check and a browser test could not.
 *
 * Nothing here re-tests Chromium's gradient parser. `npm run check` does not
 * render, and a run does; what this stops is arithmetic drifting between two
 * rules in two different parts of a 2,700-line stylesheet.
 */

import { describe, expect, it } from "vitest";

import { bare, declarations, layers } from "./css-declarations";

const reel = declarations(".case-reel");
const web = declarations(".case-tape");
const window_ = declarations(".case-window");
const waiting = declarations(".item-case.is-waiting");
const sheets = declarations(".folder-sheets");
const front = declarations(".folder-front");
const slip = declarations('.item-case[data-kind="folder"] .case-body::after');

/**
 * How much of the file is here, and how far playback has got — the two numbers
 * every declaration below is a function of.
 *
 * `reeled` is `0` on every object on the board today, because nothing produces a
 * playback position yet: T-257 is where that lands and Q-250 parked the wiring
 * there. It is a parameter here anyway, because the *drawing* is finished and
 * the whole claim of T-268 is about what it does between 0 and 1.
 */
interface Transport {
  arrived: number;
  reeled: number;
}

const REST: Transport = { arrived: 1, reeled: 0 };

/**
 * Resolve a `calc()` written in the one shape this file uses — percentages,
 * `var(--pack)`, `var(--wound, F)`, `var(--arrived, F)`, `var(--reeled, F)`,
 * `sqrt()`, `+ - * /` and parentheses — at a given transport state.
 *
 * A short evaluator rather than a regex per declaration, because the whole point
 * below is to compare a parameterised stop against the plain number it used to
 * be, and there are eight of them. `Function` over the substituted string is
 * safe here in the way it never is elsewhere: the input is a file in this
 * repository, read at test time.
 *
 * `wound` is the supply reel's, since that is the one every stop below is drawn
 * for — the take-up reel is the same declarations at the complement, which is
 * asserted where the two rules are read rather than assumed here.
 */
function at(expr: string, t: Transport = REST): number {
  const wound = t.arrived * (1 - t.reeled);
  const pack = 100 * Math.sqrt(0.2809 + 0.7191 * wound);
  const substituted = expr
    .replace(/var\(--pack\)/g, `(${pack})`)
    .replace(/var\(--wound,\s*[\d.]+\)/g, `(${wound})`)
    .replace(/var\(--arrived,\s*[\d.]+\)/g, `(${t.arrived})`)
    .replace(/var\(--reeled,\s*[\d.]+\)/g, `(${t.reeled})`)
    .replace(/(\d(?:\.\d+)?)%/g, "$1")
    .replace(/sqrt\(/g, "Math.sqrt(")
    .replace(/calc/g, "");
  expect(
    /^[\d\s.+\-*/()]+$/.test(substituted.replace(/Math\.sqrt/g, "")),
    `"${expr}" is arithmetic over the transport`,
  ).toBe(true);
  return Number(new Function(`return (${substituted})`)());
}

/**
 * The colour stops of the reel's pack, as `[colour, from, to]`, at one fraction.
 *
 * A stop's two ends are separated by a space and either of them may be a
 * `calc()` with spaces inside it, so they are pulled out by shape — a
 * percentage, or a balanced `calc(…)` one level deep — rather than by splitting.
 */
function words(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= value.length; i++) {
    const c = value[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if ((c === " " || c === undefined) && depth === 0) {
      const word = value.slice(start, i).trim();
      if (word.length > 0) out.push(word);
      start = i + 1;
    }
  }
  return out;
}

function pack(t: Transport = REST): Array<[string, number, number]> {
  const radial = layers(reel.get("background")!)[0]!;
  // The stop list, minus the `radial-gradient(circle at 50% 50%` head.
  const stops = layers(radial.slice(radial.indexOf("(") + 1, radial.lastIndexOf(")"))).slice(1);
  return stops.map((s) => {
    const parts = words(s);
    expect(parts, `"${s}" is a colour and two stops`).toHaveLength(3);
    return [parts[0]!, at(parts[1]!, t), at(parts[2]!, t)] as [string, number, number];
  });
}

describe("a tape with nothing wound on it", () => {
  /**
   * **The one that would move a signed-off object.** `--pack` is the whole of
   * this task inside `.case-reel`, and at rest it has to be the 100% that was
   * written there before — so that a tape whose file is present is not merely
   * close to the tape T-267 shipped, it is that tape.
   */
  it("winds to exactly the pack it always drew", () => {
    expect(at(reel.get("--pack")!)).toBe(100);
    const rest = pack();
    expect(rest.map(([, from, to]) => [from, to])).toEqual([
      [0, 20],
      [20, 44],
      [44, 49],
      [49, 53],
      [53, 72],
      [72, 90],
      [90, 100],
      // The band past the pack, which at rest is nothing at all.
      [100, 100],
    ]);
  });

  /**
   * And with nothing wound on, all three tape bands collapse onto the hub: what
   * is left is the spool and its teeth, which is what an empty cassette shows
   * through its window.
   */
  it("collapses onto the bare hub when nothing has arrived", () => {
    const nothing = { arrived: 0, reeled: 0 };
    expect(at(reel.get("--pack")!, nothing)).toBeCloseTo(53, 10);
    for (const [, from, to] of pack(nothing).slice(4, 7)) expect(to - from).toBeCloseTo(0, 10);
  });

  /**
   * **What must not be transparent.** The spool teeth are a `repeating-conic`
   * *under* the radial, and what masks them is the radial being opaque. Punch a
   * hole where the tape used to be and an empty reel wears a ring of teeth out
   * at the flange — which looks like a drawing mistake rather than like an empty
   * spool. The window's own black is the inside of the shell, so it is the right
   * colour as well as an opaque one.
   */
  it("shows the inside of the shell past the pack, not a hole", () => {
    const outer = pack({ arrived: 0, reeled: 0 }).at(-1)!;
    expect(outer[1], "the empty band starts at the hub").toBeCloseTo(53, 10);
    expect(outer[2]).toBe(100);
    expect(outer[0]).toBe(window_.get("background"));
  });

  /**
   * **The one the first pass of this task got wrong, and the reason it is a
   * number rather than a screenshot.** Collapsing the pack was declared and
   * invisible: the tape's three browns run `#2b241d` to `#120e0a` against a
   * `#0a0908` window, so an empty reel and a full one were the same black and a
   * four-state ladder came back with the two tape rows identical.
   *
   * So the empty window is not the packed one. It is the far wall of the shell,
   * and it has to be *legibly* lighter — 30 levels of luma is about where a
   * difference stops being a shade of the same thing and starts being another
   * material, and the shadow this board mistook for a pale square once was 11.
   */
  it("makes an empty window a different colour from a packed one, not a darker one", () => {
    const luma = (hex: string) => {
      const [, r, g, b] = /#(..)(..)(..)/.exec(hex)!.map((h) => Number.parseInt(h, 16));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const packed = /var\(--shell-in,\s*(#[0-9a-f]{6})\)/.exec(window_.get("background")!)![1]!;
    const empty = waiting.get("--shell-in")!;
    expect(luma(empty) - luma(packed)).toBeGreaterThan(30);
  });

  /**
   * There is no span of tape between two bare spools. It fades rather than
   * narrows because a threaded cassette carries the same width of ribbon across
   * it however much is on either reel — and it is `var(--arrived, 1)` rather
   * than a number, so a cassette whose file is here is at the full opacity it
   * has always drawn at.
   */
  it("has no web between the spools until there is tape", () => {
    expect(web.get("opacity")).toBe("var(--arrived, 1)");
    expect(at(web.get("opacity")!, { arrived: 0, reeled: 0 })).toBe(0);
    expect(at(web.get("opacity")!)).toBe(1);
  });

  /**
   * And the state that drives all of it is one declaration. `is-developing`
   * carries `is-waiting` too, so the inline fraction `paintContents` writes has
   * to beat this — which it does, being inline; what this rule is for is the
   * three phases that write nothing at all.
   */
  it("is one rule for every way of not having the file", () => {
    expect(waiting.get("--arrived")).toBe("0");
  });
});

describe("the state that has to survive a fitted board", () => {
  /** The elements the LOD block switches off — read out of the stylesheet
   *  rather than restated, so this cannot drift from the block it is about. */
  const hidden = (() => {
    const at_ = bare.indexOf(":is(.layer-world[data-lod], .item.is-coarse)");
    expect(at_, "the LOD block is still written this way").toBeGreaterThan(0);
    return bare.slice(at_, bare.indexOf("}", at_));
  })();

  /**
   * The transfer is detail and goes with the rest of the detail. Stated as a
   * test because it is the half of the bargain that is easy to regret and undo:
   * a wall of folders at 20% is a wall of cards, and a tape winding on inside
   * one of them is not something anybody can see anyway.
   */
  it("lets the transfer go with the rest of the detail", () => {
    for (const sel of [".case-reel", ".case-tape", ".folder-sheets"]) {
      expect(hidden, `${sel} is still switched off below 35%`).toContain(sel);
    }
  });

  /**
   * **And the torn state does not.** A file nobody has is a fact about the
   * board, and the tier it most needs to read at is the one where the whole
   * board is on the screen. So it is drawn on `.case-body::after` — a
   * pseudo-element of a node the block above does not name, and cannot name,
   * because `.case-body` is the object.
   */
  it("keeps the torn state at every tier", () => {
    expect(/\.item-case\.is-torn \.case-body::after/.test(bare)).toBe(true);
    expect(hidden).not.toContain(".case-body");
  });
});

describe("a folder that opens on nothing", () => {
  /** The head, foot and panel of a full folder, for the slip to be measured
   *  against — a slip only reads as one beside what it replaces. */
  const foot = 100 - Number.parseFloat(sheets.get("bottom")!);
  const panel = Number.parseFloat(front.get("inset")!.split(" ")[0]!);
  const fullHead = 4.5 - 0.48 * 4.5;

  /**
   * Shorter and narrower than a document, which is the whole reading: the label
   * above it still says how many pages the folder held, and what is in it is one
   * piece of paper. A slip that spanned the object would say "a thin document".
   */
  it("is a fraction of the paper it stands in for", () => {
    const visible = panel - Number.parseFloat(slip.get("top")!);
    expect(visible, "shallower than an almost-empty folder").toBeLessThan(
      (panel - fullHead) * 0.45,
    );
    expect(visible, "and still visible above the panel").toBeGreaterThan(1);
    expect(Number.parseFloat(slip.get("width")!)).toBeLessThan(70);
  });

  /** Its foot tucks behind the front panel like the paper's does, so it is a
   *  slip lying in a folder rather than one stuck on the front of it. */
  it("tucks behind the front panel", () => {
    expect(100 - Number.parseFloat(slip.get("bottom")!)).toBe(foot);
    expect(foot).toBeGreaterThan(panel + 1);
  });

  /** And it is paler than the sheets, because a compliments slip is not
   *  manilla and the difference is what makes it a different object. */
  it("is whiter than the stack it replaces", () => {
    const brightest = (decl: string) =>
      Math.max(...[...decl.matchAll(/#([0-9a-f]{6})/g)].map((m) => Number.parseInt(m[1]!, 16)));
    expect(brightest(slip.get("background")!)).toBeGreaterThan(
      brightest(declarations(".folder-sheets").get("background")!),
    );
  });
});

/**
 * The transport — T-268, and the reason the pack stopped being linear.
 *
 * A tape has a fixed quantity of ribbon, so the two spools are one reading and
 * its complement rather than two independent ones. Both used to take `--arrived`
 * directly, which is why a rewound tape had two full reels where Phil's
 * reference has a dark spool on the left and a bare one on the right.
 *
 * `--reeled` has no producer yet: T-257 is where playback lands and Q-250 parked
 * the wiring there. So this is the whole of what can be asserted about a control
 * nothing drives — that the drawing is a correct function of the position, and
 * that at the position every tape on this board is at, it draws what it drew
 * before.
 */
describe("where in the tape you are", () => {
  const supply = declarations(".case-reel.is-supply");
  const takeup = declarations(".case-reel.is-takeup");

  /** How much ribbon a rule puts on its own hub, at one transport state. */
  function wound(rule: Map<string, string>, t: Transport): number {
    return at(rule.get("--wound")!, t);
  }

  it("splits one tape between two spools rather than filling both", () => {
    for (const reeled of [0, 0.25, 0.5, 0.75, 1]) {
      const t = { arrived: 1, reeled };
      expect(wound(supply, t) + wound(takeup, t), `at ${reeled}`).toBeCloseTo(1, 10);
      expect(wound(takeup, t)).toBeCloseTo(reeled, 10);
    }
  });

  /**
   * And a transfer is still a transfer: half a file that has not been played is
   * half a tape on the supply reel and nothing on the take-up, not half on each.
   */
  it("winds what has arrived onto the spool that has not been played off", () => {
    const half = { arrived: 0.5, reeled: 0 };
    expect(wound(supply, half)).toBeCloseTo(0.5, 10);
    expect(wound(takeup, half)).toBe(0);
  });

  /**
   * **Area, not radius.** Tape is wound in a flat spiral, so the length on a hub
   * is the area of the annulus. A tape half played sits at 0.80 of the full
   * radius; drawn linearly it would sit at 0.765, and the error is worst exactly
   * where the eye is reading the balance between the two spools.
   */
  it("grows the pack by area, so a half-played tape is not a half spool", () => {
    const half = at(reel.get("--pack")!, { arrived: 1, reeled: 0.5 });
    expect(half).toBeCloseTo(100 * Math.sqrt(0.2809 + 0.7191 * 0.5), 6);
    expect(half).toBeGreaterThan(53 + 47 * 0.5);
    // The two ends, which are the ones a reader will check against the old
    // linear declaration: they agree there and nowhere else.
    expect(at(reel.get("--pack")!, { arrived: 1, reeled: 0 })).toBe(100);
    expect(at(reel.get("--pack")!, { arrived: 1, reeled: 1 })).toBeCloseTo(53, 10);
  });
});
