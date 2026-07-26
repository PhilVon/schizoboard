/**
 * @vitest-environment happy-dom
 *
 * happy-dom only for `DOMParser`, which is the one browser API the ingestion
 * policy touches. Everything else here is arithmetic.
 */

import { describe, expect, it } from "vitest";

import {
  decodeDataUrl,
  readHtml,
  resolveAgainst,
  isHttpUrl,
  layout,
  looksLikeImageUrl,
  noteSizeFor,
  type Ingested,
} from "@/app/ingest";
import { FRAME_BOTTOM, FRAME_SIDE, PHOTO_MAX_EDGE, polaroidFor } from "@/lib/polaroid";

/** The photograph's own box, undoing the frame the view will draw around it. */
function photoWindow(item: { w: number; h: number }): { w: number; h: number } {
  return {
    w: item.w * (1 - 2 * FRAME_SIDE),
    h: item.h - item.w * (FRAME_SIDE + FRAME_BOTTOM),
  };
}

describe("polaroidFor", () => {
  it("frames a photograph at its own shape, not the frame's", () => {
    for (const [w, h] of [
      [3000, 2000],
      [2000, 3000],
      [1000, 1000],
      [4000, 900],
    ]) {
      const window_ = photoWindow(polaroidFor(w!, h!));
      // The window has to match the picture, or `object-fit: cover` crops it
      // and the loss never looks like a bug — just like bad framing.
      expect(window_.w / window_.h).toBeCloseTo(w! / h!, 4);
    }
  });

  it("is taller than it is wide for a square photograph, as a polaroid is", () => {
    const item = polaroidFor(1000, 1000);
    expect(item.h).toBeGreaterThan(item.w);
  });

  it("caps a huge photograph and lifts a tiny one", () => {
    const huge = photoWindow(polaroidFor(9000, 6000));
    expect(huge.w).toBeCloseTo(PHOTO_MAX_EDGE, 3);

    // A favicon must still be big enough to pin, string and annotate.
    const tiny = photoWindow(polaroidFor(32, 32));
    expect(tiny.w).toBeGreaterThan(100);
  });

  it("gives a square frame to a photograph whose size is not known yet", () => {
    const unknown = photoWindow(polaroidFor(0, 0));
    expect(unknown.w).toBeCloseTo(unknown.h, 3);
  });
});

describe("noteSizeFor", () => {
  it("grows with the text and stops at a sheet's width", () => {
    const short = noteSizeFor("hello");
    const long = noteSizeFor("x".repeat(400));
    expect(long.w).toBeGreaterThan(short.w);
    expect(long.w).toBeLessThanOrEqual(380);
    // Wrapped, so what the width stopped doing the height starts.
    expect(long.h).toBeGreaterThan(short.h);
  });

  it("counts the lines it was actually given", () => {
    const one = noteSizeFor("a");
    const five = noteSizeFor("a\nb\nc\nd\ne");
    expect(five.h).toBeGreaterThan(one.h);
  });

  it("gives a long paste room, because .paper-text clips what will not fit", () => {
    // Forty lines is an ordinary paste of notes. Anything past the note's
    // height is not merely off the bottom — it is in the document and
    // unreachable, with no scrolling and no in-place editing to get at it.
    const forty = noteSizeFor("a line of notes\n".repeat(40));
    expect(forty.h).toBeGreaterThan(40 * 22);
  });

  it("allows for the browser wrapping on words rather than on characters", () => {
    // Counting characters always fits more per line than word-boundary wrapping
    // does, and being one line short is invisible clipping.
    const width = noteSizeFor("x".repeat(60)).w;
    const perLine = (width - 32) / 8.2;
    const prose = ("lorem ipsum dolor sit amet ".repeat(20)).trim();
    const rows = Math.ceil(prose.length / perLine);
    expect(noteSizeFor(prose).h).toBeGreaterThan(rows * 22);
  });

  it("still stops somewhere, so a stray megabyte is not an item", () => {
    expect(noteSizeFor("line\n".repeat(50000)).h).toBeLessThanOrEqual(2000);
  });

  it("has a size for nothing at all, because a blank scrap is a thing", () => {
    const blank = noteSizeFor("");
    expect(blank.w).toBeGreaterThan(0);
    expect(blank.h).toBeGreaterThan(0);
  });
});

describe("reading a clipboard's mind", () => {
  it("finds the image in what a web page copy actually puts on the clipboard", () => {
    const html =
      '<meta charset="utf-8"><img src="https://example.com/photo.jpg?w=800" alt="a thing">';
    const read = readHtml(html);
    expect(read.images).toEqual(["https://example.com/photo.jpg?w=800"]);
    // No text of its own — that is what marks it out as an image copy rather
    // than a piece of prose that happens to contain a picture.
    expect(read.text).toBe("");
  });

  it("reports the words when the fragment is really a piece of writing", () => {
    const read = readHtml(
      '<p>A paragraph about deserts <img src="https://e.com/formula.png"> and dunes.</p>',
    );
    expect(read.images).toHaveLength(1);
    expect(read.text).toContain("A paragraph about deserts");
  });

  it("takes a data URL, which is the other thing that shows up there", () => {
    expect(readHtml('<img src="data:image/png;base64,iVBORw0KGgo=">').images).toEqual([
      "data:image/png;base64,iVBORw0KGgo=",
    ]);
  });

  it("drops a source that is not a place bytes live", () => {
    // Not sources of a photograph at all, whatever anyone knows about the page.
    expect(readHtml('<img src="javascript:alert(1)">').images).toEqual([]);
    expect(readHtml('<img src="blob:http://localhost/abc">').images).toEqual([]);
    expect(readHtml('<img src="file:///C:/Windows/win.ini">').images).toEqual([]);
    expect(readHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">').images).toEqual([]);
    // And none of them is a path, so none is offered up for resolving either.
    expect(readHtml('<img src="javascript:alert(1)">').relative).toEqual([]);
    expect(readHtml('<img src="file:///C:/Windows/win.ini">').relative).toEqual([]);
  });

  it("sets a path aside rather than resolving it against the application", () => {
    // The parsed document has no base URL, so `.src` would resolve against our
    // own origin and produce a plausible, wrong URL. These are not images yet —
    // they are images once somebody says what page they came from.
    const read = readHtml('<img src="/photo.jpg"><img src="../up.png">');
    expect(read.images).toEqual([]);
    expect(read.relative).toEqual(["/photo.jpg", "../up.png"]);
  });

  it("resolves those paths once the page they came from is known", () => {
    const base = "https://example.com/gallery/index.html";
    expect(resolveAgainst(["/photo.jpg", "../up.png", "next.gif"], base)).toEqual([
      "https://example.com/photo.jpg",
      "https://example.com/up.png",
      "https://example.com/gallery/next.gif",
    ]);
  });

  it("refuses a base that is not a page, however plausible the result looks", () => {
    // The whole failure this exists to avoid is a confident URL to nothing.
    expect(resolveAgainst(["/a.png"], "about:blank")).toEqual([]);
    expect(resolveAgainst(["/a.png"], "file:///C:/notes.docx")).toEqual([]);
    expect(resolveAgainst(["/a.png"], "")).toEqual([]);
    // Including our own origin, which is the mistake `.src` would have made.
    expect(resolveAgainst(["/a.png"], "tauri://localhost/")).toEqual([]);
  });

  it("cannot be talked into a scheme it would not have fetched anyway", () => {
    const base = "https://example.com/a/";
    expect(resolveAgainst(["javascript:alert(1)", "file:///C:/win.ini"], base)).toEqual([]);
    expect(resolveAgainst(["\\\\?\\bad", "http://ok.example/x.png"], base)).toContain(
      "http://ok.example/x.png",
    );
  });

  it("is not fooled by an img inside a comment", () => {
    expect(readHtml('<!-- <img src="https://example.com/a.png"> -->').images).toEqual([]);
  });

  it("does not execute anything it was handed", () => {
    const before = document.body.innerHTML;
    readHtml('<img src="https://e.com/x.png" onerror="window.__pwned = 1">');
    readHtml(`<script>window.__pwned = 1</${""}script><img src="https://e.com/y.png">`);
    expect((window as unknown as Record<string, unknown>)["__pwned"]).toBeUndefined();
    expect(document.body.innerHTML).toBe(before);
  });

  it("takes every image in a multi-image fragment", () => {
    const html = '<div><img src="https://e.com/1.png"><img src="https://e.com/2.png"></div>';
    expect(readHtml(html).images).toHaveLength(2);
  });

  it("knows a URL from a sentence containing one", () => {
    expect(isHttpUrl("https://example.com/a")).toBe(true);
    expect(isHttpUrl("  http://example.com  ")).toBe(true);
    expect(isHttpUrl("see https://example.com for details")).toBe(false);
    expect(isHttpUrl("just some text")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
  });

  it("guesses at an image URL by what it can see", () => {
    expect(looksLikeImageUrl("https://e.com/a.JPG")).toBe(true);
    expect(looksLikeImageUrl("https://e.com/a.png?size=2")).toBe(true);
    expect(looksLikeImageUrl("https://e.com/article")).toBe(false);
    expect(looksLikeImageUrl("a.png")).toBe(false);
  });

  it("decodes a data URL and refuses one it cannot", () => {
    const decoded = decodeDataUrl("data:image/png;base64,aGVsbG8=");
    expect(decoded?.mime).toBe("image/png");
    expect(new TextDecoder().decode(decoded!.bytes)).toBe("hello");

    expect(decodeDataUrl("https://example.com/a.png")).toBeNull();
    expect(decodeDataUrl("data:image/png,notbase64")).toBeNull();
    expect(decodeDataUrl("data:image/png;base64,!!!not base64!!!")).toBeNull();
  });
});

describe("layout", () => {
  const image = (w = 1200, h = 800): Ingested => ({
    kind: "image",
    sha256: "a".repeat(64),
    asset: { w, h, mime: "image/png", size: 1 },
  });

  it("puts one thing where it was put", () => {
    const [item] = layout([image()], { x: 120, y: -40 });
    // Jittered, because nothing arrives straight — but on the spot.
    expect(Math.abs(item!.x - 120)).toBeLessThan(20);
    expect(Math.abs(item!.y + 40)).toBeLessThan(20);
  });

  it("makes a polaroid of a picture and a note of some words", () => {
    const items = layout([image(), { kind: "text", text: "a thought" }], { x: 0, y: 0 });
    expect(items[0]).toMatchObject({ type: "polaroid", assetId: "a".repeat(64), text: "" });
    expect(items[1]).toMatchObject({ type: "note", assetId: null, text: "a thought" });
  });

  it("fans several photographs out so they overlap, and never in a grid", () => {
    const items = layout([image(), image(), image(), image()], { x: 0, y: 0 });
    const xs = items.map((i) => i.x).sort((a, b) => a - b);

    // Spread about the point rather than piled on it...
    expect(xs[0]).toBeLessThan(-50);
    expect(xs[3]).toBeGreaterThan(50);
    // ...and touching, which is what makes it a handful rather than a layout.
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!).toBeLessThan(items[0]!.w);
    }
    // No two share a row or a column.
    expect(new Set(items.map((i) => i.y)).size).toBe(4);
  });

  it("piles rather than spreads when a great many arrive at once", () => {
    // The spread used to be linear in the count and the sag quadratic, so
    // twenty photographs put the outer ones several screens away — selected,
    // and invisible. A handful put down at once does not get wider the more of
    // them there are.
    const many = layout(Array.from({ length: 40 }, () => image()), { x: 0, y: 0 });
    const width = many[0]!.w;
    for (const item of many) {
      expect(Math.abs(item.x)).toBeLessThan(width * 2);
      expect(Math.abs(item.y)).toBeLessThan(many[0]!.h);
    }
    // Still a fan: the ends are further out than the middle.
    expect(Math.abs(many[0]!.x)).toBeGreaterThan(width);
    expect(Math.abs(many[39]!.x)).toBeGreaterThan(width);
  });

  it("carries the asset's metadata into the document with it", () => {
    // DATA-MODEL section 10: the document holds {w,h,mime,size,origName}, and
    // ingestion is the only moment that information exists.
    const [item] = layout(
      [
        {
          kind: "image",
          sha256: "c".repeat(64),
          asset: { w: 900, h: 600, mime: "image/jpeg", size: 4096, origName: "dune.jpg" },
        },
      ],
      { x: 0, y: 0 },
    );
    expect(item!.asset).toEqual({
      w: 900,
      h: 600,
      mime: "image/jpeg",
      size: 4096,
      origName: "dune.jpg",
    });
  });

  it("leaves the angle and the pin to createItems, which already do them", () => {
    // "Nothing arrives straight" is the seeded scatter's job, and a caller that
    // has to remember to jitter is a caller that will forget.
    for (const item of layout([image(), image()], { x: 0, y: 0 })) {
      expect(item.rot).toBeUndefined();
      expect(item.withPin).toBeUndefined();
      expect(item.seed).toEqual(expect.any(Number));
    }
  });

  it("makes nothing out of nothing", () => {
    expect(layout([], { x: 0, y: 0 })).toEqual([]);
  });
});
