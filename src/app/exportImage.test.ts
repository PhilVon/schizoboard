/**
 * The two things a `foreignObject` export has to carry in with it.
 *
 * Both fail *silently*, which is the whole reason they are worth a test file of
 * their own. A stylesheet that did not make it gives unstyled text; a font that
 * did not gives the machine's cursive at a different width, so every note wraps
 * somewhere else — and nothing throws in either case. The export succeeds and
 * the file is wrong, which is the failure mode there is no way to notice from
 * inside the application (D-34 §4).
 */

import { describe, expect, it } from "vitest";

import {
  atVariant,
  BOARD_FONT_URL,
  collectStyles,
  dataUri,
  fontDataUri,
  fontWasInlined,
  inlineFont,
} from "@/app/exportImage";

/** A stylesheet stub with only the surface `collectStyles` reads. */
const sheet = (...cssText: string[]): CSSStyleSheet =>
  ({ cssRules: cssText.map((t) => ({ cssText: t })) }) as unknown as CSSStyleSheet;

/** One that throws on `cssRules`, which is what a cross-origin sheet does. */
const foreign = (): CSSStyleSheet =>
  ({
    get cssRules(): CSSRuleList {
      throw new DOMException("cross-origin", "SecurityError");
    },
  }) as unknown as CSSStyleSheet;

describe("gathering the stylesheet", () => {
  it("is every rule of every sheet, in order", () => {
    const css = collectStyles([sheet(".a { color: red }", ".b { color: blue }"), sheet(".c {}")]);
    expect(css).toBe(".a { color: red }\n.b { color: blue }\n.c {}");
  });

  it("skips a sheet it is not allowed to read rather than failing the export", () => {
    // A board's own CSS is bundled and therefore same-origin. What this can lose
    // is a stylesheet somebody else injected, which is not part of the board —
    // and losing it is a great deal better than losing the export.
    const css = collectStyles([foreign(), sheet(".a { color: red }")]);
    expect(css).toBe(".a { color: red }");
  });

  it("is empty rather than undefined for a document with no styles", () => {
    expect(collectStyles([])).toBe("");
  });
});

describe("carrying the font in", () => {
  const face = (url: string): string =>
    `@font-face { font-family: "Patrick Hand"; src: url(${url}) format("woff2"); font-display: block; }`;

  it("replaces the relative URL a data: SVG cannot resolve", () => {
    const out = inlineFont(face(`"${BOARD_FONT_URL}"`), "data:font/woff2;base64,AAAA");
    expect(out).toContain('url("data:font/woff2;base64,AAAA")');
    expect(out).not.toContain(BOARD_FONT_URL);
    // The rule it was in survives — `font-display: block` and the family are
    // what make the export write the same way the board does.
    expect(out).toContain("font-display: block");
    expect(out).toContain('font-family: "Patrick Hand"');
  });

  /**
   * The CSS this reads back has been through the browser's own serialiser, and
   * that is not necessarily the text anybody wrote — Chromium quotes some URLs
   * and leaves others bare.
   */
  it("finds the URL however the browser chose to quote it", () => {
    for (const quoted of [`"${BOARD_FONT_URL}"`, `'${BOARD_FONT_URL}'`, BOARD_FONT_URL]) {
      const out = inlineFont(face(quoted), "data:font/woff2;base64,AAAA");
      expect(fontWasInlined(out), `quoted as ${quoted}`).toBe(true);
    }
  });

  it("replaces every mention, not just the first", () => {
    const twice = `${face(`"${BOARD_FONT_URL}"`)}\n${face(`"${BOARD_FONT_URL}"`)}`;
    expect(fontWasInlined(inlineFont(twice, "data:font/woff2;base64,AAAA"))).toBe(true);
  });

  it("leaves a stylesheet that never mentioned it alone", () => {
    const css = ".a { color: red }";
    expect(inlineFont(css, "data:font/woff2;base64,AAAA")).toBe(css);
  });

  /**
   * `inlineFont` returning the CSS unchanged means two opposite things — already
   * inlined, or the rule was never found — so the check is a separate question
   * rather than a boolean from the replace. An export whose font quietly did not
   * make it is the exact failure this file exists for.
   */
  it("can be asked whether the URL is really gone", () => {
    expect(fontWasInlined(face(`"${BOARD_FONT_URL}"`))).toBe(false);
    expect(fontWasInlined(".a { color: red }")).toBe(true);
  });
});

describe("the font's bytes", () => {
  it("come back as a woff2 data URI", () => {
    const uri = fontDataUri(new Uint8Array([0x77, 0x4f, 0x46, 0x32]));
    expect(uri).toBe(`data:font/woff2;base64,${btoa("wOF2")}`);
  });

  it("takes an ArrayBuffer as readily as a view, because `fetch` hands back one", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(fontDataUri(bytes.buffer)).toBe(fontDataUri(bytes));
  });

  /**
   * The real font is 24 kB. `String.fromCharCode(...bytes)` on that is a
   * 24,000-argument call, and the argument limit is a great deal lower than
   * people assume — it throws `RangeError` rather than truncating, so this is
   * the difference between an export and a stack overflow.
   */
  it("survives a font the size of the real one", () => {
    const big = new Uint8Array(24_000).fill(0x41);
    const uri = fontDataUri(big);
    expect(uri.startsWith("data:font/woff2;base64,")).toBe(true);
    expect(atob(uri.slice("data:font/woff2;base64,".length)).length).toBe(24_000);
  });

  /**
   * The same chunking carries a photograph, which is where the argument limit
   * stops being theoretical: the font is 24 kB and a display-variant JPEG is
   * closer to 400.
   */
  it("carries a photograph's worth of bytes under whatever type they are", () => {
    const photo = new Uint8Array(400_000).fill(0xff);
    const uri = dataUri(photo, "image/jpeg");
    expect(uri.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(atob(uri.slice("data:image/jpeg;base64,".length)).length).toBe(400_000);
  });
});

/**
 * The variant an export asks for, which is not the one the screen is showing.
 *
 * During an export the camera frames the whole board, so a polaroid is a few
 * dozen pixels across and its `<img>` is pointing at the 256 px thumbnail —
 * while the file it is going into draws that same item at 660. Inlining what the
 * screen chose puts a thumbnail in the export, and it looks like a photograph
 * nobody focused.
 */
describe("asking for the size an export needs", () => {
  it("raises the thumbnail the screen settled on to the display variant", () => {
    expect(atVariant("asset://sha256/abc123?v=thumb")).toBe("asset://sha256/abc123?v=display");
  });

  it("leaves one that is already right alone", () => {
    const url = "asset://sha256/abc123?v=display";
    expect(atVariant(url)).toBe(url);
  });

  it("rewrites only the variant, whatever else is in the query", () => {
    expect(atVariant("http://asset.localhost/sha256/abc?v=thumb&t=7")).toBe(
      "http://asset.localhost/sha256/abc?v=display&t=7",
    );
    expect(atVariant("http://asset.localhost/sha256/abc?t=7&v=thumb")).toBe(
      "http://asset.localhost/sha256/abc?t=7&v=display",
    );
  });

  /**
   * Nothing on an item is served from anywhere but the asset store today. This
   * is what keeps that from being an assumption baked into a string replace.
   */
  it("goes through a URL that never named a variant untouched", () => {
    expect(atVariant("http://example.test/logo.png")).toBe("http://example.test/logo.png");
    expect(atVariant("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });
});
