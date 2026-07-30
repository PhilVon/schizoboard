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

import {
  cloneForExport,
  inertDocument,
  inlineAssets,
  ITEM_BLEED,
  rasteriseItems,
  type RasterItem,
  type RasterTarget,
  type ReadBytes,
  serialise,
  svgDataUri,
  svgFor,
} from "@/render/items/raster";
import { SHADOW_BLEED } from "@/render/items/shadow";

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

/**
 * A reader that records what it was asked for, because "how many times" is half
 * of what these tests are about.
 */
function reader(
  bytes: Record<string, number[]> = {},
): ReadBytes & { readonly asked: string[] } {
  const asked: string[] = [];
  const read = async (url: string): Promise<{ bytes: Uint8Array; mime: string }> => {
    asked.push(url);
    // A tick, so two images asking at the same moment really do overlap.
    await Promise.resolve();
    const found = bytes[url];
    if (found === undefined) throw new Error(`no such asset: ${url}`);
    return { bytes: new Uint8Array(found), mime: "image/jpeg" };
  };
  return Object.assign(read, {
    get asked(): string[] {
      return asked;
    },
  });
}

/** An item with a photograph in it, as the polaroid view builds one. */
function polaroid(src: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "item item-polaroid";
  const img = document.createElement("img");
  img.className = "pol-photo";
  img.setAttribute("src", src);
  img.alt = "";
  el.append(img);
  return el;
}

describe("carrying the photographs in", () => {
  const PHOTO = "asset://sha256/abc123?v=display";

  it("puts the bytes in the img, where the asset URL could not be reached", async () => {
    const el = polaroid(PHOTO);
    const read = reader({ [PHOTO]: [0xff, 0xd8, 0xff] });

    const cost = await inlineAssets(el, read);

    const src = el.querySelector("img")?.getAttribute("src") ?? "";
    expect(src).toBe(`data:image/jpeg;base64,${btoa("\xff\xd8\xff")}`);
    expect(cost.inlined).toBe(1);
    expect(cost.unreadable).toBe(0);
    expect(cost.bytes).toBe(src.length);
  });

  /**
   * The export camera frames the whole board, so the item is a few dozen pixels
   * across and its `<img>` is on the thumbnail — while the file draws it at 660.
   */
  it("asks for the display variant even when the screen settled on a thumbnail", async () => {
    const read = reader({ [PHOTO]: [1, 2, 3] });
    await inlineAssets(polaroid("asset://sha256/abc123?v=thumb"), read);
    expect(read.asked).toEqual([PHOTO]);
  });

  /**
   * Two items showing one photograph is an ordinary board — a paste done twice,
   * a bundle merged. The cache holds the *promise*, so overlapping asks collapse
   * as well as sequential ones.
   */
  it("reads a photograph once however many items are showing it", async () => {
    const wall = document.createElement("div");
    wall.append(polaroid(PHOTO), polaroid(PHOTO), polaroid(PHOTO));
    const read = reader({ [PHOTO]: [1, 2, 3] });

    const cost = await inlineAssets(wall, read);

    expect(read.asked).toEqual([PHOTO]);
    expect(cost.inlined).toBe(3);
    // Read once, carried three times: each item is its own SVG, so the bytes are
    // in the export three times whatever the cache did.
    expect(cost.bytes).toBe(3 * (wall.querySelector("img")?.getAttribute("src")?.length ?? 0));
  });

  it("shares the cache across the separate subtrees of one export", async () => {
    const read = reader({ [PHOTO]: [1, 2, 3] });
    const cache = new Map<string, Promise<string | null>>();
    await inlineAssets(polaroid(PHOTO), read, cache);
    await inlineAssets(polaroid(PHOTO), read, cache);
    expect(read.asked).toEqual([PHOTO]);
  });

  /**
   * `state/assets.ts` only ever points an `<img>` at bytes it has said are on
   * this disk, so this is a file that went between the binding and the export.
   * One hole in the picture is not a failed export — and the URL must not be
   * left in, because a `data:` SVG cannot resolve it and Chromium would draw a
   * broken-image box in the file.
   */
  it("takes the src off a photograph it cannot read rather than failing", async () => {
    const el = polaroid(PHOTO);
    const cost = await inlineAssets(el, reader({}));
    expect(el.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(cost).toEqual({ inlined: 0, unreadable: 1, bytes: 0 });
  });

  /**
   * An item whose bytes have not arrived is drawn as undeveloped film with
   * nothing in its `<img>`. That is an ordinary board, not a broken one — and
   * `src=""` inside the SVG would resolve against the SVG's own data URI and
   * make the document ask itself for an image.
   */
  it("takes an empty src off without calling it missing", async () => {
    const el = polaroid("");
    const read = reader({});
    const cost = await inlineAssets(el, read);
    expect(el.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(read.asked).toEqual([]);
    expect(cost).toEqual({ inlined: 0, unreadable: 0, bytes: 0 });
  });

  /**
   * The grain tiles and the shadow sprite are canvases the item renders to a
   * data URI. Nothing to fetch, but they are not free — they are the rest of
   * what the SVG has to hold.
   */
  it("leaves what is already carried alone, and counts what it costs", async () => {
    const already = "data:image/png;base64,AAAA";
    const el = polaroid(already);
    const read = reader({});
    const cost = await inlineAssets(el, read);
    expect(el.querySelector("img")?.getAttribute("src")).toBe(already);
    expect(read.asked).toEqual([]);
    expect(cost).toEqual({ inlined: 0, unreadable: 0, bytes: already.length });
  });

  it("comes back through the XML parser with a photograph in it", async () => {
    const el = polaroid(PHOTO);
    await inlineAssets(el, reader({ [PHOTO]: [0xff, 0xd8, 0xff, 0xe0] }));
    expect(brokeOn(svgFor(serialise(el), "", 330, 330))).toBeNull();
  });
});

describe("the copy an export is made from", () => {
  /**
   * The pose is the whole reason the first probe drew zero pixels: an item is
   * absolutely positioned at the world origin and reaches its place on the board
   * with a transform, so a clone dropped into a box its own size is entirely
   * outside it.
   */
  it("is square on at the origin, because placement is the canvas's arithmetic", () => {
    const el = polaroid("");
    el.style.position = "absolute";
    el.style.transform = "translate(1200px, 400px) rotate(-4deg)";

    const clone = cloneForExport(el);

    expect(clone.style.transform).toBe("none");
    expect(clone.style.position).toBe("static");
    // And the board it was copied from is untouched.
    expect(el.style.transform).toBe("translate(1200px, 400px) rotate(-4deg)");
  });

  it("keeps the classes and the children the stylesheet will be matched against", () => {
    const clone = cloneForExport(polaroid("asset://sha256/abc?v=display"));
    expect(clone.className).toBe("item item-polaroid");
    expect(clone.querySelector("img.pol-photo")?.getAttribute("src")).toBe(
      "asset://sha256/abc?v=display",
    );
  });

  /**
   * The reason for the inert document. A node in the live one with an `<img src>`
   * starts fetching and decoding it — so cloning three hundred photographs
   * decodes three hundred photographs that nothing will ever paint, and
   * `inlineAssets` then overwrites every one of those `src` values anyway.
   */
  it("belongs to a document that loads nothing", () => {
    const el = polaroid("asset://sha256/abc?v=display");
    document.body.append(el);
    try {
      const clone = cloneForExport(el);
      // Crossed documents, which is the whole difference from `cloneNode`: the
      // copy is not in the one that would go and get the picture.
      expect(el.ownerDocument).toBe(document);
      expect(clone.ownerDocument).not.toBe(document);
      expect(clone.ownerDocument.defaultView).toBe(null);
    } finally {
      el.remove();
    }
  });

  it("can be given one inert document for a whole export", () => {
    const inert = inertDocument();
    const a = cloneForExport(polaroid(""), inert);
    const b = cloneForExport(polaroid(""), inert);
    expect(a.ownerDocument).toBe(b.ownerDocument);
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

/**
 * The painter: what order things are drawn in, how much room a sheet is given,
 * and where on the canvas it lands.
 *
 * Every one of these is silent when it is wrong. A board drawn in document
 * order looks like a board — with the wrong thing on top. A sheet cut to its
 * own size looks like a sheet — with no shadow. A placement that ignores the
 * swing looks like a board — hanging at the angle it had before it settled.
 */
describe("drawing the items into a canvas", () => {
  /** A context that records what it was told to do, and nothing else. */
  function target(): RasterTarget & { readonly calls: unknown[][] } {
    const calls: unknown[][] = [];
    const record =
      (name: string) =>
      (...args: unknown[]): void => {
        calls.push([name, ...args]);
      };
    return {
      calls,
      save: record("save"),
      restore: record("restore"),
      translate: record("translate"),
      rotate: record("rotate"),
      scale: record("scale"),
      drawImage: record("drawImage"),
    } as RasterTarget & { readonly calls: unknown[][] };
  }

  const sheet = (over: Partial<RasterItem> = {}): RasterItem => ({
    id: "i1",
    el: polaroid(""),
    rank: 0,
    x: 0,
    y: 0,
    rot: 0,
    w: 100,
    h: 80,
    ...over,
  });

  /** Stands in for the `<img>` happy-dom will never load. */
  const decode = async (): Promise<CanvasImageSource> => ({}) as CanvasImageSource;
  const deps = { decode, bleed: 0 };

  it("draws in rank order, whatever order it was handed them", async () => {
    const ctx = target();
    const report = await rasteriseItems(
      [sheet({ id: "top", rank: 9, x: 90 }), sheet({ id: "bottom", rank: 1, x: 10 })],
      ctx,
      { x: 0, y: 0, zoom: 1 },
      "",
      deps,
    );
    expect(report.drawn).toBe(2);
    const xs = ctx.calls.filter((c) => c[0] === "translate").map((c) => c[1]);
    expect(xs).toEqual([10, 90]);
  });

  /**
   * The measured failure. On a board built in order document order *is* paint
   * order, so this only ever goes wrong on a board somebody has restacked —
   * and then it goes wrong quietly.
   */
  it("puts a brought-to-front sheet last even when it is first in the list", async () => {
    const ctx = target();
    await rasteriseItems(
      [sheet({ id: "raised", rank: 24, x: 1 }), sheet({ id: "a", rank: 2, x: 2 })],
      ctx,
      { x: 0, y: 0, zoom: 1 },
      "",
      deps,
    );
    const xs = ctx.calls.filter((c) => c[0] === "translate").map((c) => c[1]);
    expect(xs).toEqual([2, 1]);
  });

  /**
   * A `foreignObject` clips to its rect and the shadow is a sibling hanging
   * past every edge, so a raster cut to the sheet takes the shadow off it.
   */
  it("gives the sheet room for its shadow, and draws the whole of that room", async () => {
    const ctx = target();
    const seen: string[] = [];
    await rasteriseItems([sheet()], ctx, { x: 0, y: 0, zoom: 1 }, "", {
      bleed: 20,
      decode: async (uri: string) => {
        seen.push(decodeURIComponent(uri));
        return {} as CanvasImageSource;
      },
    });

    // 100×80 with 20 of room on every side.
    expect(seen[0]).toContain('width="140"');
    expect(seen[0]).toContain('height="120"');
    // And the sheet sits inside it, off the corner by the same amount.
    expect(seen[0]).toContain("left: 20px");
    expect(seen[0]).toContain("top: 20px");

    const draw = ctx.calls.find((c) => c[0] === "drawImage");
    // Centred on the item's own middle, which is 20 further out on each side.
    expect(draw?.slice(2)).toEqual([-70, -60, 140, 120]);
  });

  it("has a bleed big enough for the widest shadow the board draws", () => {
    expect(ITEM_BLEED).toBeGreaterThanOrEqual(SHADOW_BLEED);
  });

  /**
   * Board units all the way down: to the drawn centre, turn to the drawn angle,
   * *then* scale. Scaling first would put the rotation in pixel space, which is
   * the same picture only while the zoom is 1.
   */
  it("places a sheet at its drawn centre, angle and zoom", async () => {
    const ctx = target();
    await rasteriseItems(
      [sheet({ x: 300, y: 200, rot: 0.25, w: 100, h: 80 })],
      ctx,
      { x: 100, y: 50, zoom: 2 },
      "",
      deps,
    );
    expect(ctx.calls).toEqual([
      ["save"],
      ["translate", 400, 300],
      ["rotate", 0.25],
      ["scale", 2, 2],
      ["drawImage", expect.anything(), -50, -40, 100, 80],
      ["restore"],
    ]);
  });

  /**
   * An SVG that will not parse draws nothing and throws nothing — this is the
   * only place that failure is visible at all. One hole in the picture is a
   * better answer than refusing to hand over the rest of the board.
   */
  it("counts a sheet that would not draw rather than failing the export", async () => {
    const ctx = target();
    const report = await rasteriseItems([sheet({ id: "a" }), sheet({ id: "b" })], ctx, { x: 0, y: 0, zoom: 1 }, "", {
      bleed: 0,
      decode: async () => null,
    });
    expect(report).toMatchObject({ items: 2, drawn: 0 });
    expect(ctx.calls).toEqual([]);
  });

  it("reads each photograph once across the whole board", async () => {
    const PHOTO = "asset://sha256/shared?v=display";
    const read = reader({ [PHOTO]: [1, 2, 3] });
    const report = await rasteriseItems(
      [sheet({ id: "a", el: polaroid(PHOTO) }), sheet({ id: "b", el: polaroid(PHOTO) })],
      target(),
      { x: 0, y: 0, zoom: 1 },
      "",
      { decode, bleed: 0, read },
    );
    expect(read.asked).toEqual([PHOTO]);
    expect(report.inlined).toBe(2);
  });
});
