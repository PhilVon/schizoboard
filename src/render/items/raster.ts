/**
 * Turning the items into pixels — the one part of an image export that has to be
 * invented (D-34).
 *
 * Everything else on this board already draws itself into a canvas at an
 * arbitrary camera: cork, the board-ink tiles, both rope layers and the overlay
 * are all painters that take a camera and draw per-point, which is what keeps a
 * line crisp at every zoom and what means an *export* camera costs them nothing
 * new. Only the items are DOM, so "how does a board become an image" is one
 * question rather than five, and this file is that question.
 *
 * The route, measured before it was chosen: clone the item subtree into an
 * `<svg><foreignObject>`, serialise it, load it as a `data:` URL and draw it to
 * the export canvas. It works — but a foreignObject subtree is styled by what is
 * *inside* the SVG and by nothing else, and it can reach nothing outside the
 * data URL it arrived in. So two things have to be carried in with it, and
 * neither of them announces itself when it is missing:
 *
 * 1. **The stylesheet.** Without it the clone comes back as unstyled text.
 * 2. **The font, as bytes.** `items.css` names the woff2 by a *relative* URL,
 *    which inside a `data:` SVG resolves against the data URI and is not found.
 *    Nothing throws; the writing silently comes out in whatever cursive the
 *    machine has. Measured ink extent for the same words at 19px: Patrick Hand
 *    138.1px, Segoe Script 214.7px — so it is not a subtle difference, it is
 *    every note in the wrong hand *wrapping differently* (D-34 §4).
 *
 * Photographs are the same hazard one step further out and are handled the same
 * way; see [`inlineAssets`].
 *
 * ## Why this is in `render/items/` and not in `app/`
 *
 * Because the alternative is a second module with an opinion about how an item
 * is represented, and the seam next door forbids exactly that:
 *
 * > If it ever leaks an `HTMLElement`, the escalation stops being one directory.
 * > — `view.ts`
 *
 * An export that reached into the layer for nodes would have to know that items
 * are `<div>`s, that they stack with `z-index` rather than in document order,
 * and that their shadows hang outside their own boxes. All three are true, all
 * three were measured, and all three are this directory's business (D-37). So
 * the layer gets a *painter* — the fifth of five, and the only one that had to
 * be invented — and `app/` composes painters without ever seeing an element.
 */

import type { AssetVariant } from "@/platform/types";
import { SHADOW_BLEED } from "@/render/items/shadow";
import { TAPE_LENGTH } from "@/render/items/tape";

/** The face the board writes in, and the one thing an export must not lose. */
export const BOARD_FONT_URL = "/fonts/patrick-hand.woff2";

/**
 * An SVG carrying a piece of the board, ready to be drawn into a canvas.
 *
 * ## Three things about this that are XML and not HTML
 *
 * A `data:` SVG is parsed by the **XML** parser, which does not forgive what the
 * HTML one does — and it fails by refusing the whole image rather than by
 * dropping the bad part. `drawImage` of an SVG that would not parse draws
 * nothing and throws nothing, so all three of these are silent:
 *
 * 1. **The markup has to be well-formed**, which is what `XMLSerializer` on a
 *    cloned node gives and what `innerHTML` does not (`<br>`, `<img>` and
 *    unquoted attributes all come back unclosed).
 * 2. **The stylesheet has to be escaped.** CSS is allowed `<` and `&` — in a
 *    `content:` string, in a `url()` with a query — and either one ends the
 *    document as far as an XML parser is concerned. A `CDATA` section is the
 *    obvious way and is the worse one: it cannot contain its own terminator, so
 *    a stylesheet with `]]>` anywhere in it closes the section early and takes
 *    the export with it. Escaping has no such hole.
 * 3. **The XHTML namespace has to be declared on the wrapper**, not inherited.
 *    Inside `<foreignObject>` the default namespace is still SVG, so an
 *    undeclared `<div>` is an *SVG* div, which is nothing, and the subtree
 *    silently does not render.
 *
 * `width`/`height` are CSS pixels and the `viewBox` matches them one to one, so
 * the caller scales by drawing the image at whatever size it wants rather than
 * by baking a scale in here.
 */
export function svgFor(markup: string, css: string, width: number, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml">` +
    `<style>${escapeText(css)}</style>` +
    markup +
    `</div>` +
    `</foreignObject>` +
    `</svg>`
  );
}

/**
 * The three characters that end something they were not meant to end.
 *
 * `&` first, or the ampersands this introduces are escaped again on the next
 * pass and `&lt;` reaches the parser as the literal text.
 */
function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The SVG as something `<img src>` will take.
 *
 * `encodeURIComponent` rather than base64: it is a third smaller for markup,
 * needs no unicode dance to get a note written in Japanese through
 * `btoa`, and — the reason that actually decided it — a URI-encoded payload can
 * be read in a debugger, where a base64 one is a wall. An export that comes back
 * blank is going to need reading.
 */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * A node as XML, which is the only form a `data:` SVG will accept.
 *
 * Deliberately not `outerHTML`. The HTML serialiser emits `<br>`, `<img src=x>`
 * and boolean attributes in forms the XML parser rejects outright, and the board
 * has `<img>` on every photograph — so this is the difference between an export
 * and a blank canvas, on the most common item there is.
 */
export function serialise(node: Element, serialiser = new XMLSerializer()): string {
  return serialiser.serializeToString(node);
}

/**
 * Every stylesheet this document has, as one string.
 *
 * Same-origin only, and quietly skipping the rest: a sheet from another origin
 * throws `SecurityError` on `cssRules`, and there is nothing to be done about it
 * from here. A board's own CSS is always same-origin — it is bundled — so what
 * this can lose is a stylesheet somebody else injected, which is not part of the
 * board.
 */
export function collectStyles(sheets: Iterable<CSSStyleSheet>): string {
  const out: string[] = [];
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) out.push(rule.cssText);
  }
  return out.join("\n");
}

/**
 * Put the font's bytes where the SVG can reach them.
 *
 * A string replacement rather than a second `@font-face`, so the rule that is
 * already there — with its `font-display: block` and its weight — is the one
 * that ends up in the export. Both quoting styles and the bare form, because
 * this reads back CSS that has been through the browser's own serialiser and
 * that is not necessarily the text that was written.
 *
 * Returns the CSS unchanged when the URL is not in it, which is the honest
 * outcome for a stylesheet that has already been inlined once — and is why
 * [`fontWasInlined`] exists rather than a boolean return: a caller that wants to
 * know should *ask*, because "unchanged" happens for two opposite reasons.
 */
export function inlineFont(css: string, dataUri: string, url = BOARD_FONT_URL): string {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.replace(new RegExp(`url\\((['"]?)${escaped}\\1\\)`, "g"), `url("${dataUri}")`);
}

/** Whether a stylesheet still names the font by a URL an export cannot reach. */
export function fontWasInlined(css: string, url = BOARD_FONT_URL): boolean {
  return !css.includes(url);
}

/**
 * The bytes of a fetched font, as a `data:` URI.
 *
 * `font/woff2` rather than `application/octet-stream`: Chromium will load either,
 * and the honest type is what makes the export readable by anything else that
 * ever opens it.
 */
export function fontDataUri(bytes: ArrayBuffer | Uint8Array): string {
  return dataUri(bytes, "font/woff2");
}

/**
 * Any bytes, as something a `data:` SVG can reach.
 *
 * Base64 and not `encodeURIComponent` — the opposite of the choice
 * [`svgDataUri`] makes, and for the opposite reason. That one carries markup,
 * which is mostly characters URI-encoding leaves alone and which somebody is
 * going to have to read when an export comes back blank. This carries a JPEG,
 * where every third byte would become `%xx` and there is nothing to read.
 */
export function dataUri(bytes: ArrayBuffer | Uint8Array, mime: string): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  // In chunks, because `String.fromCharCode(...bytes)` on a 24 kB font is a
  // 24,000-argument call and browsers have a limit on that which is nowhere near
  // as large as people assume — and a photograph is not 24 kB, it is 400.
  const CHUNK = 8192;
  for (let at = 0; at < view.length; at += CHUNK) {
    binary += String.fromCharCode(...view.subarray(at, at + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Which stored variant an export asks for, whatever the screen is showing.
 *
 * `display` is capped at 2560 px on its longest edge, which at the default 2×
 * export scale covers any item up to 1280 board units — every photograph anyone
 * has put on this board, with room over. `original` is the untouched paste and
 * is deliberately not used: a 12 MB JPEG base64'd into an SVG *per item* is
 * precisely the export cost D-34 warned about, bought for resolution the page
 * has nowhere to put.
 */
export const EXPORT_VARIANT: AssetVariant = "display";

/**
 * The same asset, asked for at the size an export needs.
 *
 * The item's `<img>` points at whatever variant its size *on screen* called for
 * (`variantFor`, `platform/types.ts`) — and during an export the screen is the
 * whole board at a few per cent, so a polaroid is 53 px across and pointing at
 * the 256 px thumbnail. Inlining that would put a thumbnail in the file, at
 * 660 px, and it would look exactly like a photograph nobody had focused.
 *
 * Here rather than in `app/main.ts`, on the standing argument beside
 * `variantFor` itself: the wiring module has no tests, so a decision left there
 * is a decision nothing checks.
 *
 * Only rewrites a URL that already names a variant, so anything that is not an
 * asset — and there is nothing else on an item today — goes through untouched.
 */
export function atVariant(url: string, variant: AssetVariant = EXPORT_VARIANT): string {
  return url.replace(/([?&]v=)[^&]*/, `$1${variant}`);
}

/**
 * The one thing [`inlineAssets`] needs from the world: a URL in, bytes and the
 * type they are out.
 *
 * An injected function rather than `fetch` itself so the failing case is
 * reachable from a test — a photograph that cannot be read is the case that has
 * to not take the export with it, and it is not one a real store will produce on
 * demand.
 */
export type ReadBytes = (url: string) => Promise<{ bytes: ArrayBuffer | Uint8Array; mime: string }>;

/** Bytes over the `asset://` scheme, which is CORS-open (`src-tauri/src/protocol.rs`). */
export const fetchBytes: ReadBytes = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} — ${response.status}`);
  return {
    bytes: await response.arrayBuffer(),
    mime: response.headers.get("content-type") ?? "application/octet-stream",
  };
};

/** What the photographs cost, and whether any of them went missing. */
export interface AssetInlining {
  /** `<img>` given their bytes. */
  readonly inlined: number;
  /**
   * `<img>` that named a photograph this machine could not read, and had their
   * `src` taken off instead of keeping a URL the export cannot resolve.
   *
   * Normally zero, and never a reason to fail: `state/assets.ts` only points an
   * `<img>` at bytes it has said are on the disk, so this is a file that has
   * gone between the item binding and the export.
   */
  readonly unreadable: number;
  /**
   * Data-URI characters carried into this subtree, repeats included.
   *
   * Repeats included because that is what the export actually has to *hold* —
   * two items showing one photograph carry it twice, since each item is its own
   * SVG. The cache below saves the read and the base64, not the payload.
   */
  readonly bytes: number;
}

/**
 * Put every photograph's bytes inside the clone, because a `data:` SVG can reach
 * nothing outside itself.
 *
 * The same trap as the font, one step further out and louder about it: an
 * `asset://` URL is simply not resolvable from inside a `data:` document, so the
 * first export this project produced had a broken-image box where every
 * photograph should have been (D-34 §4). On a board of three hundred
 * photographs this is the expensive part of an export — not the drawing — which
 * is why the cost comes back in [`AssetInlining`] rather than being something to
 * find out about later.
 *
 * `setAttribute`, not `img.src`: the clone is meant to be inert (see
 * [`cloneForExport`]) and the property setter is what starts a load. Writing a
 * 400 kB data URI and having the browser decode it again, per item, for a
 * picture nothing will ever show, is the whole cost of the export paid twice.
 *
 * `cache` is keyed by URL and holds the *promise*, so two items showing one
 * photograph read it once even when they ask at the same moment. Pass one across
 * the whole export; the default is there so a single subtree can be inlined on
 * its own.
 */
export async function inlineAssets(
  root: Element,
  read: ReadBytes,
  cache: Map<string, Promise<string | null>> = new Map(),
): Promise<AssetInlining> {
  let inlined = 0;
  let unreadable = 0;
  let bytes = 0;

  await Promise.all(
    [...root.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      // Already carried in — the grain tiles and the shadow sprite are canvases
      // the item renders to a data URI, and they cost the export their length.
      if (src.startsWith("data:")) {
        bytes += src.length;
        return;
      }
      // An item whose bytes have not arrived is drawn as undeveloped film and
      // its `<img>` has nothing in it. Leaving `src=""` in the SVG would make
      // the document ask *itself* for an image; taking it off says the same
      // thing and asks nothing. Not counted as unreadable — this is an ordinary
      // board, not a broken one.
      if (src === "") {
        img.removeAttribute("src");
        return;
      }

      const url = atVariant(src);
      let pending = cache.get(url);
      if (pending === undefined) {
        pending = readDataUri(url, read);
        cache.set(url, pending);
      }
      const uri = await pending;
      if (uri === null) {
        img.removeAttribute("src");
        unreadable += 1;
        return;
      }
      img.setAttribute("src", uri);
      inlined += 1;
      bytes += uri.length;
    }),
  );

  return { inlined, unreadable, bytes };
}

/** `null` rather than a throw: one unreadable photograph is a hole in the
 *  picture, not a failed export. */
async function readDataUri(url: string, read: ReadBytes): Promise<string | null> {
  try {
    const { bytes, mime } = await read(url);
    return dataUri(bytes, mime);
  } catch {
    return null;
  }
}

/**
 * A copy of an item that will not load anything.
 *
 * `cloneNode` produces a node in the live document, and a node in the live
 * document with an `<img src>` starts fetching and decoding it — so cloning
 * three hundred photographs to export them decodes three hundred photographs
 * that nothing will ever paint, and then [`inlineAssets`] overwrites every one
 * of those `src` values anyway. So the copy is made into a document with no
 * browsing context, which is the platform's own reason `DOMParser` output never
 * fetches anything, and `importNode` into it is a clone that costs only nodes.
 *
 * The pose is stripped here too, and that is the other half of the design D-34
 * left open: an item is absolutely positioned at the world origin and carries
 * `transform: translate(x, y) rotate(r)` to reach its place on the board, so a
 * clone dropped into a box its own size is entirely outside it and draws
 * *nothing*. The first probe came back with zero opaque pixels for exactly this.
 * So the SVG is the item's paper, square on, at its own size, and where it goes
 * and which way up is the export canvas's arithmetic — which is also what keeps
 * a rotated item from needing an SVG padded out to hold its corners.
 */
export function cloneForExport(el: Element, inert = inertDocument()): HTMLElement {
  const clone = inert.importNode(el, true) as HTMLElement;
  clone.style.position = "static";
  clone.style.left = "0px";
  clone.style.top = "0px";
  clone.style.margin = "0";
  clone.style.transform = "none";
  return clone;
}

/**
 * A document with no browsing context: it parses, and it fetches nothing.
 *
 * `createHTMLDocument` rather than a `<template>`'s contents, which is the other
 * way to say this. Both are inert in Chromium; only one of them is inert
 * *legibly*, and happy-dom hands back the live document for the template form —
 * so the template trick is a thing the test suite cannot tell apart from having
 * done nothing at all.
 */
export function inertDocument(): Document {
  return document.implementation.createHTMLDocument("");
}

/**
 * How much room to leave round an item's raster, board units.
 *
 * An item paints outside its own box in two ways, and both were measured rather
 * than assumed. The shadow is a sibling element hanging past every edge
 * (`SHADOW_BLEED`), and tape crosses a corner at forty-five degrees and sticks
 * out by about half its length. On a 330×296 polaroid at rest the subtree
 * reaches 13.7 / 12.4 / 17.2 / 18.5 units past the sheet — asymmetric, because
 * the light is off the top left — and a tenth of a 48-unit ring around it comes
 * back painted.
 *
 * A `foreignObject` clips to its rect, so a raster cut to the item's own width
 * and height loses all of that. The picture still looks like a board; it just
 * looks like a board with no shadows on it, which is not a thing anybody can
 * see without the real one beside it.
 */
export const ITEM_BLEED = Math.ceil(Math.max(SHADOW_BLEED, TAPE_LENGTH / 2));

/**
 * The camera an export draws at: the board coordinate at the canvas's top-left
 * corner, and how many pixels a board unit is worth.
 *
 * Structural and tiny on purpose. `app/export.ts`'s `ExportView` satisfies it,
 * and `render/` must not import from `app/` to say so.
 */
export interface RasterCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** One item to draw: its node, and where the scene says it is. */
export interface RasterItem {
  readonly id: string;
  readonly el: Element;
  /** Paint order, low first — `z-index`, never document order (D-37). */
  readonly rank: number;
  /** Drawn centre, drawn angle, and the sheet's own size, in board units. */
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly w: number;
  readonly h: number;
}

/** What an item raster cost, and whether any of it went missing. */
export interface RasterReport {
  readonly items: number;
  /** Items that reached the canvas. Short of `items` means an SVG would not
   *  parse, which is the failure that draws nothing and throws nothing. */
  readonly drawn: number;
  readonly inlined: number;
  readonly unreadable: number;
  readonly bytes: number;
}

/**
 * The board's own stylesheet, with the font's bytes carried in — everything a
 * cloned item needs to be styled from inside a `data:` SVG.
 *
 * Once per export rather than once per item: it is 52 kB, and it is the same 52
 * kB for every sheet on the board.
 */
export async function exportStylesheet(
  sheets: Iterable<CSSStyleSheet> = document.styleSheets,
  url = BOARD_FONT_URL,
): Promise<string> {
  const css = collectStyles(sheets);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} — ${response.status}`);
  return inlineFont(css, fontDataUri(await response.arrayBuffer()), url);
}

/**
 * The part of a canvas context an item raster touches.
 *
 * Narrow because it is the whole testable surface: ordering, the shadow's room
 * and the placement arithmetic are all readable from the calls made against
 * this, and none of them needs a real canvas to be checked.
 */
export type RasterTarget = Pick<
  CanvasRenderingContext2D,
  "save" | "restore" | "translate" | "rotate" | "scale" | "drawImage"
>;

/**
 * The three things [`rasteriseItems`] reaches the world through.
 *
 * `decode` is here for one reason and it is not elegance: an SVG becomes pixels
 * by being loaded into an `<img>`, and happy-dom neither loads nor fails one —
 * it simply never fires, so a test would hang rather than pass or fail. Real
 * decoding is proved in the real webview instead; what a test can check is
 * everything either side of it.
 */
export interface RasterDeps {
  read?: ReadBytes;
  bleed?: number;
  decode?: (uri: string) => Promise<CanvasImageSource | null>;
}

/**
 * Draw items into a canvas at an export camera.
 *
 * Sequential, and deliberately so: each item holds a stylesheet, a font and a
 * photograph as one string — measured at 12 MB across 24 sheets — and doing
 * them at once is that figure times the board. One at a time, the peak is one
 * item and the total is the same.
 *
 * Sorted by `rank` here rather than trusted from the caller, because getting it
 * wrong is invisible: on a board built in order document order *is* paint order,
 * and it stops being so the first time anybody brings something to the front
 * (D-37).
 */
export async function rasteriseItems(
  items: Iterable<RasterItem>,
  ctx: RasterTarget,
  camera: RasterCamera,
  css: string,
  deps: RasterDeps = {},
): Promise<RasterReport> {
  const { read = fetchBytes, bleed = ITEM_BLEED, decode: toImage = decode } = deps;
  const ordered = [...items].sort((a, b) => a.rank - b.rank);
  const inert = inertDocument();
  const cache = new Map<string, Promise<string | null>>();
  let drawn = 0;
  let inlined = 0;
  let unreadable = 0;
  let bytes = 0;

  for (const item of ordered) {
    const width = Math.ceil(item.w + 2 * bleed);
    const height = Math.ceil(item.h + 2 * bleed);
    if (!(width > 0) || !(height > 0)) continue;

    // The item, square on at the origin, inside the room its shadow needs.
    const clone = cloneForExport(item.el, inert);
    clone.style.position = "absolute";
    clone.style.left = `${bleed}px`;
    clone.style.top = `${bleed}px`;
    const framed = inert.createElement("div");
    framed.setAttribute("style", `position:relative;width:${width}px;height:${height}px`);
    framed.append(clone);

    const cost = await inlineAssets(framed, read, cache);
    inlined += cost.inlined;
    unreadable += cost.unreadable;
    bytes += cost.bytes;

    const image = await toImage(svgDataUri(svgFor(serialise(framed), css, width, height)));
    // An SVG that would not parse draws nothing and throws nothing, so this is
    // the one place the failure is visible at all. Counted, not thrown: one
    // sheet missing is a hole in the picture, and refusing the whole export
    // would be a worse answer to it than handing over the rest.
    if (image === null) continue;

    ctx.save();
    // Placement is the canvas's arithmetic, not the clone's — see
    // [`cloneForExport`]. Board units all the way down: translate to the item's
    // drawn centre, turn to its drawn angle, then scale, so the bleed and the
    // half-sizes below are the numbers the scene actually holds.
    ctx.translate((item.x - camera.x) * camera.zoom, (item.y - camera.y) * camera.zoom);
    ctx.rotate(item.rot);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.drawImage(image, -item.w / 2 - bleed, -item.h / 2 - bleed, width, height);
    ctx.restore();
    drawn += 1;
  }

  return { items: ordered.length, drawn, inlined, unreadable, bytes };
}

/** An `<img>` that has loaded, or `null`. Never rejects: a sheet that will not
 *  parse is counted by the caller, not thrown at the user. */
async function decode(uri: string): Promise<HTMLImageElement | null> {
  const image = new Image();
  return new Promise((resolve) => {
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = uri;
  });
}
