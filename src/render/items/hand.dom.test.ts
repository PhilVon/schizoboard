/**
 * @vitest-environment happy-dom
 */

/**
 * T-81. Per-character jitter, and the four things that turn "make each letter a
 * box" from a texture into a bug: text that reflows differently, text that
 * shimmers, text that costs a rebuild it did not need, and text that never
 * arrives at all on a recycled node.
 */

import { describe, expect, it } from "vitest";

import { charJitter } from "@/lib/seed";
import { clearHand, writeHand } from "@/render/items/hand";

const SEED = 0x51ed0081;

function host(): HTMLDivElement {
  return document.createElement("div");
}

/** Every glyph box, in document order. */
function glyphs(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll(".hand-word > span"));
}

function words(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll(".hand-word"));
}

function transforms(el: HTMLElement): string[] {
  return glyphs(el).map((g) => g.style.transform);
}

describe("handwriting", () => {
  it("reads back as the text that went in", () => {
    // The whole of the contract with everything downstream. A find, a copy, an
    // export and a screen reader all see this node, and none of them may see
    // the scaffolding.
    const el = host();
    writeHand(el, "two words", SEED);
    expect(el.textContent).toBe("two words");
  });

  it("keeps whitespace exactly, so a blank line stays a blank line", () => {
    const el = host();
    const text = "first\n\nthird  spaced\ttab";
    writeHand(el, text, SEED);
    expect(el.textContent).toBe(text);
    // The whitespace is *outside* the boxes: `pre-wrap` on the container has to
    // go on seeing it as text, or the newline stops breaking the line.
    for (const g of glyphs(el)) expect(g.textContent).not.toMatch(/\s/);
  });

  it("groups by word, so a line breaks between words and not inside one", () => {
    const el = host();
    writeHand(el, "alpha beta gamma", SEED);
    expect(words(el)).toHaveLength(3);
    expect(words(el).map((w) => w.textContent)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("gives each glyph the jitter its index asks for", () => {
    const el = host();
    writeHand(el, "abc", SEED);
    const wanted = [0, 1, 2].map((i) => charJitter(SEED, i));
    const got = transforms(el);
    for (let i = 0; i < 3; i++) {
      expect(got[i]).toContain(`${wanted[i]!.dx.toFixed(4)}em`);
      expect(got[i]).toContain(`${wanted[i]!.rot.toFixed(5)}rad`);
    }
  });

  it("counts whitespace toward the index, so jitter is addressable by position", () => {
    // "ab cd" — the `c` is character 3 of the string, and must lean like
    // character 3, not like the third glyph.
    const el = host();
    writeHand(el, "ab cd", SEED);
    const c = glyphs(el)[2]!;
    expect(c.textContent).toBe("c");
    expect(c.style.transform).toContain(`${charJitter(SEED, 3).dx.toFixed(4)}em`);
  });

  it("does not shimmer — the same text on the same seed lands identically", () => {
    // DESIGN 3.6: text that shimmers when you scroll past is worse than no
    // jitter at all. Two independent nodes, so this cannot pass by the guard.
    const a = host();
    const b = host();
    writeHand(a, "the same words", SEED);
    writeHand(b, "the same words", SEED);
    expect(transforms(a)).toEqual(transforms(b));
  });

  it("writes a different hand for a different item", () => {
    const a = host();
    const b = host();
    writeHand(a, "the same words", SEED);
    writeHand(b, "the same words", SEED ^ 0x5bf03);
    expect(transforms(a)).not.toEqual(transforms(b));
  });

  it("costs nothing when asked for what it has already written", () => {
    // A photograph re-binds on every frame of its develop (T-174) and its
    // caption has not changed on any of them. Node identity is the assertion:
    // a rebuild replaces these.
    const el = host();
    writeHand(el, "a caption", SEED);
    const before = glyphs(el);
    writeHand(el, "a caption", SEED);
    expect(glyphs(el)[0]).toBe(before[0]);
  });

  it("rewrites when the text changes under it", () => {
    const el = host();
    writeHand(el, "before", SEED);
    writeHand(el, "after", SEED);
    expect(el.textContent).toBe("after");
  });

  it("rewrites when the same text arrives for a different item", () => {
    const el = host();
    writeHand(el, "note", SEED);
    writeHand(el, "note", SEED + 1);
    expect(transforms(el)).toEqual(transforms(withHand("note", SEED + 1)));
  });

  it("forgets what it wrote when it is cleared, because these nodes are pooled", () => {
    // The failure this exists for: a view released and recycled onto an item
    // with the identical text and seed — the same item, panned out of the
    // viewport and back — recognises its own record and stays blank.
    const el = host();
    writeHand(el, "note", SEED);
    clearHand(el);
    expect(el.textContent).toBe("");
    writeHand(el, "note", SEED);
    expect(el.textContent).toBe("note");
  });

  it("empties cleanly on empty text", () => {
    const el = host();
    writeHand(el, "something", SEED);
    writeHand(el, "", SEED);
    expect(el.childNodes).toHaveLength(0);
  });

  it("breaks a pasted URL up, because an atomic word wider than the paper is clipped", () => {
    const el = host();
    const url = "https://example.com/a/very/long/path/that/nobody/would/type";
    writeHand(el, url, SEED);
    expect(el.textContent).toBe(url);
    expect(words(el).length).toBeGreaterThan(1);
    for (const w of words(el)) expect(w.textContent!.length).toBeLessThanOrEqual(24);
  });

  it("leaves ordinary prose in one box per word", () => {
    const el = host();
    writeHand(el, "extraordinarily", SEED);
    expect(words(el)).toHaveLength(1);
  });

  it("stops building boxes past what the paper can show, and keeps the text", () => {
    const el = host();
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    writeHand(el, long, SEED);
    expect(el.textContent).toBe(long);
    expect(glyphs(el).length).toBeLessThanOrEqual(512);
    expect(glyphs(el).length).toBeGreaterThan(400);
  });

  it("does not split an emoji down the middle of its surrogate pair", () => {
    const el = host();
    writeHand(el, "hi\u{1F44B}", SEED);
    expect(glyphs(el).map((g) => g.textContent)).toEqual(["h", "i", "\u{1F44B}"]);
  });

  it("keeps a combining accent on the letter it belongs to", () => {
    // The half `Intl.Segmenter` buys over code points. Decomposed on purpose —
    // "cafe" then U+0301 — because the precomposed form passes on code points
    // alone and proves nothing. An accent in a box of its own is rotated away
    // from the letter it is meant to sit above.
    const el = host();
    const acute = String.fromCharCode(0x0301);
    writeHand(el, `cafe${acute}`, SEED);
    expect(glyphs(el).map((g) => g.textContent)).toEqual(["c", "a", "f", `e${acute}`]);
  });
});

function withHand(text: string, seed: number): HTMLDivElement {
  const el = host();
  writeHand(el, text, seed);
  return el;
}
