/**
 * @vitest-environment happy-dom
 *
 * Whether the SVG an export builds will actually parse.
 *
 * This is the half of `exportImage.ts` that cannot be checked by reading the
 * string, and it is the half where being wrong is invisible: a `data:` SVG is
 * handled by the **XML** parser, which refuses the whole document over one
 * unclosed `<img>` or one `&` in a stylesheet — and `drawImage` of an image that
 * would not parse draws nothing and throws nothing. The export succeeds and the
 * canvas is empty.
 *
 * So every case here ends at `DOMParser`, and asserts on `parsererror` rather
 * than on the text.
 */

import { describe, expect, it } from "vitest";

import { serialise, svgDataUri, svgFor } from "@/app/exportImage";

/** What the browser will do with the string, and the only assertion worth making. */
function parse(svg: string): Document {
  return new DOMParser().parseFromString(svg, "image/svg+xml");
}

const brokeOn = (svg: string): string | null =>
  parse(svg).querySelector("parsererror")?.textContent?.slice(0, 200) ?? null;

/** A node built the way the layer builds one, rather than from a string. */
function item(): HTMLElement {
  const el = document.createElement("div");
  el.className = "item item-polaroid";
  const img = document.createElement("img");
  img.src = "http://asset.localhost/abcdef?v=display";
  img.alt = "";
  el.append(img, document.createElement("br"));
  const caption = document.createElement("div");
  caption.className = "pol-caption";
  caption.textContent = "Bearded Viking Man";
  el.append(caption);
  return el;
}

describe("the SVG an export draws from", () => {
  it("parses, with a stylesheet and markup in it", () => {
    const svg = svgFor('<div class="item">hello</div>', ".item { color: red }", 800, 600);
    expect(brokeOn(svg)).toBeNull();
    const doc = parse(svg);
    expect(doc.documentElement.getAttribute("viewBox")).toBe("0 0 800 600");
    expect(doc.querySelector("foreignObject")?.getAttribute("width")).toBe("800");
  });

  /**
   * Inside `<foreignObject>` the default namespace is still SVG, so a `<div>`
   * with no declaration of its own is an *SVG* div — which is nothing, and the
   * whole subtree silently does not render. It parses either way, which is what
   * makes this worth asserting rather than assuming.
   */
  it("puts the wrapper in the XHTML namespace, where a foreignObject's default is SVG", () => {
    const doc = parse(svgFor("<p>hi</p>", "", 10, 10));
    const wrapper = doc.querySelector("foreignObject")?.firstElementChild;
    expect(wrapper?.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
  });

  /**
   * CSS is allowed `<` and `&` — in a `content:` string, in a `url()` with a
   * query — and either ends the document as far as an XML parser is concerned.
   * The board's own stylesheet has `content: ""` rules and asset URLs with
   * `?v=display` on them, so this is not hypothetical.
   */
  it("survives a stylesheet with characters XML would choke on", () => {
    const nasty = `.a::after { content: "a < b & c" } .b { background: url("x.png?v=1&w=2") }`;
    const svg = svgFor("<p>hi</p>", nasty, 10, 10);
    expect(brokeOn(svg)).toBeNull();
    // Escaped rather than wrapped in CDATA, and it comes back out as written.
    expect(parse(svg).querySelector("style")?.textContent).toBe(nasty);
  });

  /**
   * The reason this escapes rather than using a `CDATA` section, which is the
   * obvious way to carry CSS through XML: a CDATA section cannot contain its own
   * terminator, so one `]]>` anywhere in the stylesheet closes it early and
   * takes the whole export with it. Nothing in the board's CSS has one today,
   * which is exactly the sort of thing that is true until somebody writes a
   * `content:` rule.
   */
  it("survives a stylesheet holding the thing a CDATA section could not", () => {
    const css = `.a::after { content: "]]>" }`;
    const svg = svgFor("<p>hi</p>", css, 10, 10);
    expect(brokeOn(svg)).toBeNull();
    expect(parse(svg).querySelector("style")?.textContent).toBe(css);
  });

  it("survives a board that is one pixel of nothing", () => {
    expect(brokeOn(svgFor("", "", 1, 1))).toBeNull();
  });
});

describe("getting a node into it", () => {
  /**
   * The reason `serialise` exists rather than `el.outerHTML`. The HTML
   * serialiser emits `<img src=…>` and `<br>` unclosed, which the XML parser
   * rejects outright — and there is an `<img>` on every photograph, so the HTML
   * route fails on the most common item there is.
   */
  it("is XML, where outerHTML would have left the img and the br unclosed", () => {
    const xml = serialise(item());
    expect(brokeOn(svgFor(xml, "", 400, 400))).toBeNull();
    expect(xml).toMatch(/<img[^>]*\/>/);
    expect(xml).toMatch(/<br\s*\/>/);
  });

  it("keeps the classes and the writing the stylesheet will be matched against", () => {
    const xml = serialise(item());
    expect(xml).toContain('class="item item-polaroid"');
    expect(xml).toContain("Bearded Viking Man");
  });

  it("carries text that would otherwise close a tag", () => {
    const el = document.createElement("div");
    el.textContent = 'a < b & c > d "quoted"';
    expect(brokeOn(svgFor(serialise(el), "", 10, 10))).toBeNull();
    expect(parse(svgFor(serialise(el), "", 10, 10)).documentElement.textContent).toContain(
      "a < b & c > d",
    );
  });
});

describe("the data URI", () => {
  it("is an svg+xml URL an <img> will take", () => {
    const uri = svgDataUri(svgFor("<p>hi</p>", "", 10, 10));
    expect(uri.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  });

  /**
   * `#` ends a URL at the fragment, and the board's stylesheet is full of hex
   * colours. Un-encoded, everything after the first one is thrown away and the
   * image is a truncated document that will not parse.
   */
  it("encodes the characters that would truncate it", () => {
    const uri = svgDataUri(svgFor("<p>hi</p>", ".a { color: #ff8b6b }", 10, 10));
    expect(uri).not.toContain("#");
    expect(decodeURIComponent(uri.slice("data:image/svg+xml;charset=utf-8,".length))).toContain(
      "#ff8b6b",
    );
  });

  it("carries a note written in a script btoa could not have taken", () => {
    const svg = svgFor("<p>日本語のメモ</p>", "", 10, 10);
    const round = decodeURIComponent(svgDataUri(svg).slice("data:image/svg+xml;charset=utf-8,".length));
    expect(round).toBe(svg);
    expect(brokeOn(round)).toBeNull();
  });
});
