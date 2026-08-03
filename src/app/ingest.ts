/**
 * What a pasted thing becomes, and where a handful of them land.
 *
 * > **Paste is the primary verb.** `Ctrl+V` and the board figures it out.
 * > — DESIGN section 3.1
 *
 * "Figures it out" is a policy, and ARCHITECTURE section 4.2 puts policy on
 * this side of the boundary: Rust owns bytes, the frontend owns meaning. So
 * everything here is a pure function of a payload whose bytes have already been
 * resolved — no platform, no network, no document. It decides types, sizes and
 * positions, and hands back the same `CreateItemInput`s any other caller would
 * build.
 *
 * ## What is deliberately absent
 *
 * Rotation and pins. "Everything created this way gets one pin, placed at the
 * top centre, and a small random rotation... Nothing arrives straight." Both
 * fall out of `createItems` already — the pin because it defaults on, the angle
 * because `rot` defaults to the item's seeded scatter. A caller that has to
 * remember to jitter is a caller that will forget, which is why that default is
 * where it is and why nothing here overrides it.
 */

import type { AssetInput, CreateItemInput } from "@/crdt/ops";
import { assetKind, CARD_UNITS, objectSizeFor, type SourceAbout } from "@/lib/objects";
import { polaroidFor } from "@/lib/polaroid";
import { newSeed, valueAt } from "@/lib/seed";

/**
 * A clipboard payload whose bytes, if it had any, are already in the store.
 *
 * `asset` rather than `image` since T-260: what comes through here is a file the
 * board can hold, and a photograph is one of four things that can be (D-46
 * section 1). The variant is named for what it *is* — bytes in the store and a
 * record describing them — rather than for the one kind it used to be.
 */
export type Ingested =
  | {
      kind: "asset";
      sha256: string;
      asset: AssetInput;
      /**
       * The transcript found beside a recording — T-287.
       *
       * On the payload rather than folded into `asset.transcript` because the
       * sidecar is a *second asset* and needs a record of its own: a hash on the
       * recording with nothing behind it names a file no peer can be asked for.
       * So the pairing travels here and `attachTranscript` makes both writes.
       *
       * Deliberately not a payload of its own in this list. Everything in it
       * becomes an item, and a transcript is not a thing on the wall — it is a
       * property of the tape somebody dropped. One entry per file the person
       * meant to put down is what keeps `layout`'s fan counting what they see.
       */
      sidecar?: { sha256: string; asset: AssetInput };
      /**
       * What to write under it — T-290.
       *
       * Only a *printed still* has one: a picture lifted off a page because the
       * page was the thing somebody pasted, which needs to say what page it
       * came from or it is an unattributed photograph of a stranger's website.
       * Every other asset arrives with an empty caption, which is what a
       * photograph you pasted yourself should have — D-46 gives a polaroid a
       * caption in the person's own hand, and filling it in for them is not
       * that.
       */
      caption?: string;
      /**
       * The page this object stands in for — T-290, Q-305.
       *
       * Travels with the caption and for the same reason, but it is the durable
       * half: the caption is text somebody can rewrite, and this is what the
       * board opens.
       */
      source?: string;
      /**
       * What the page at `source` was about — T-342, `lib/objects.ts`.
       *
       * Absent is `page`, which is every card. `media` is the one that changes
       * the object: a page that named a film and handed over a player instead,
       * whose picture is a *still of the thing* rather than a banner, so the
       * picture stays the subject and the object is a photograph.
       */
      sourceAbout?: SourceAbout;
    }
  | {
      /**
       * A page that told us what it is and had no picture to give — T-340.
       *
       * **Its own arm rather than a text payload carrying a source**, because
       * the three arms of this union are named for *what a thing is* and this is
       * a third thing: `asset` is bytes in the store, `text` is words somebody
       * copied, and this is what a page says about itself. A text payload that
       * quietly became a business card would be the one arm whose name did not
       * describe its contents, and `layout` would have to ask a second question
       * to tell two of them apart.
       *
       * It is the same distinction `render/items/dom.ts` draws one seam down and
       * for the same reason (D-63): what makes this a card is not the file
       * behind it — there is no file — it is that the item is *about* somewhere.
       * The renderer already reads a card off `source` alone and draws one with
       * no banner as blank stock, so nothing here has to be invented for it.
       *
       * A page with nothing to say still makes a note. `title` is what earns the
       * card: an address on its own is a link somebody copied, and a note with
       * the link in it is the honest object for that.
       */
      kind: "page";
      title: string;
      source: string;
    }
  | { kind: "text"; text: string };

export interface BoardPoint {
  x: number;
  y: number;
}

// --- notes ------------------------------------------------------------------

/** Matches `.paper-text` in `render/items/items.css`. */
const NOTE_PAD_X = 16;
const NOTE_PAD_Y = 14;
const NOTE_LINE_HEIGHT = 22;
/** Rough advance width of the handwriting face at its 17px body size. An
 *  estimate on purpose: measuring would mean a layout read, and a note is a
 *  physical object rather than a text box — near enough is the right answer. */
const NOTE_CHAR_WIDTH = 8.2;

const NOTE_MIN_W = 180;
const NOTE_MAX_W = 380;
const NOTE_MIN_H = 110;
/**
 * A ceiling, not a target.
 *
 * `.paper-text` is `overflow: hidden`, so anything past the note's height is
 * not merely off the bottom — it is unreachable, in a document that holds it
 * and a view that will never show it. High enough that no ordinary paste of
 * notes hits it, and present only so that a stray megabyte on the clipboard
 * cannot make an item taller than the board is usable at.
 */
const NOTE_MAX_H = 2000;
/**
 * CSS wraps prose at word boundaries; this counts characters. Words do not
 * divide evenly into lines, so a character count always fits more per line
 * than the browser will — and being a line short is invisible clipping, while
 * being a line long is a bit of blank paper at the bottom of a note.
 */
const NOTE_WRAP_SLACK = 0.9;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** "Note, sized to the text, up to a max width then wrapping" — DESIGN 3.1. */
export function noteSizeFor(text: string): { w: number; h: number } {
  const lines = text.split("\n");
  let longest = 1;
  for (const line of lines) longest = Math.max(longest, line.length);

  const w = clamp(longest * NOTE_CHAR_WIDTH + NOTE_PAD_X * 2, NOTE_MIN_W, NOTE_MAX_W);
  const perLine = Math.max(1, Math.floor(((w - NOTE_PAD_X * 2) / NOTE_CHAR_WIDTH) * NOTE_WRAP_SLACK));
  let rows = 0;
  for (const line of lines) rows += Math.max(1, Math.ceil(line.length / perLine));

  return { w, h: clamp(rows * NOTE_LINE_HEIGHT + NOTE_PAD_Y * 2, NOTE_MIN_H, NOTE_MAX_H) };
}

// --- reading a clipboard's mind ---------------------------------------------

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|avif|heic|tiff?)($|\?|#)/i;

/**
 * The rest of what this board can hold, by the object each one becomes — T-289.
 *
 * A film, a recording and a document, beside the photograph that was here
 * first. Nothing here decides what the file *is*: `Paste.accept` does that from
 * the sniffed bytes, and this only decides whether the URL is worth one fetch.
 *
 * **`.html` and `.htm` are deliberately absent, and so is every page-shaped
 * extension.** The shell has no signature for markup, so it falls back to
 * `text/plain`, which `assetKind` calls a document — so a URL tried here would
 * come back a *case file holding its own angle brackets*, which is the object
 * Q-265 refused when it cut `rtf` and `html` from the extractors. A web page is
 * a note with its address on it until somebody builds the thing that reads one.
 */
const FILE_EXTENSIONS =
  /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|mp4|m4v|mov|webm|mkv|avi|pdf|txt|md|csv|log|srt|vtt)($|\?|#)/i;

export function isHttpUrl(text: string): boolean {
  const trimmed = text.trim();
  return /^https?:\/\/\S+$/i.test(trimmed) && !/\s/.test(trimmed);
}

/**
 * Is this URL worth *trying* as a photograph?
 *
 * Only ever a guess — plenty of image URLs carry no extension at all. It
 * decides which way to lean, and being wrong costs one failed fetch and a note
 * instead of a polaroid, so it leans towards the extension it can see.
 */
export function looksLikeImageUrl(url: string): boolean {
  return isHttpUrl(url) && IMAGE_EXTENSIONS.test(url);
}

/**
 * Is this URL worth *trying* as a file at all — T-289.
 *
 * The same guess one kind wider, and it is the whole of what stood between a
 * pasted `interview.mp3` and a cassette on the wall: the ingest gate has taken
 * every kind since T-260 and the store has sniffed and measured them since
 * T-262, so a direct media URL already had a cassette waiting for it and was
 * never offered. It arrived as a note with its own address written on it.
 *
 * **Conservative on purpose, and the asymmetry with a local file is deliberate.**
 * A file dragged in from the OS is something somebody chose; a URL is text that
 * happened to be on a clipboard, and every guess that comes back wrong here
 * costs a network fetch and can put an object on the wall that lies about what
 * it is. So this asks for an extension it recognises rather than fetching to
 * find out — which is also what keeps a YouTube link out of it (T-290), since a
 * watch page names no file.
 */
export function looksLikeFileUrl(url: string): boolean {
  return looksLikeImageUrl(url) || (isHttpUrl(url) && FILE_EXTENSIONS.test(url));
}

export interface PastedHtml {
  /** Absolute image sources, in document order. */
  images: string[];
  /**
   * Sources that named a path rather than a location, in document order.
   *
   * Kept apart rather than resolved here, because resolving needs the page the
   * fragment was copied from and this module has no way to ask. The caller can
   * get that from the shell (`clipboardSourceUrl`) and come back with
   * [`resolveAgainst`] — but only when it is worth an IPC round trip, which is
   * only when there was nothing absolute to use.
   */
  relative: string[];
  /** The fragment's own text. Empty is the signature of an image copy. */
  text: string;
}

/**
 * What a fragment of pasted HTML holds.
 *
 * > HTML with an `<img>`: the image is fetched and made a polaroid; this is
 * > what "copy image from a web page" actually puts on the clipboard, and
 * > handling it is not optional. — DESIGN section 3.1
 *
 * The text comes back alongside the images because the two together are what
 * distinguishes the case that row is about. "Copy image" puts a fragment on the
 * clipboard that is *only* an image; copying a paragraph that happens to
 * contain an inline formula or a logo puts one that is mostly prose. Treating
 * the second like the first turns an article into a polaroid of a 30-pixel
 * icon and throws the words away.
 *
 * Parsed into an inert document rather than pattern-matched, because a regex
 * over HTML is wrong in ways that matter here (`<img>` inside a comment, an
 * attribute order nobody expected). `DOMParser` runs no scripts and loads no
 * subresources, and nothing from that document is ever put into the live one —
 * only the string value of an attribute is read.
 *
 * `getAttribute`, not `.src`: the parsed document has no base URL, so `.src`
 * would helpfully resolve a relative path against *our* page and produce a
 * plausible-looking URL pointing at the application. Relative sources come back
 * separately instead, for a caller that can find out what to resolve them
 * against — see [`resolveAgainst`].
 */
export function readHtml(html: string): PastedHtml {
  if (!html.trim()) return { images: [], relative: [], text: "" };
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const images: string[] = [];
  const relative: string[] = [];
  for (const img of parsed.querySelectorAll("img")) {
    const src = img.getAttribute("src")?.trim();
    if (!src) continue;
    // Only schemes that name bytes somewhere else. `javascript:`, `blob:` and
    // `filesystem:` are not sources of a photograph and never reach a fetch.
    if (isHttpUrl(src) || src.startsWith("data:image/")) images.push(src);
    // Anything else *with a scheme* is one of those, and stays refused. What is
    // left is a path — the ordinary case for an image copied out of a page.
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(src)) relative.push(src);
  }
  return { images, relative, text: (parsed.body?.textContent ?? "").trim() };
}

/**
 * Resolve the paths [`readHtml`] could not, against the page they came from.
 *
 * `base` comes from the shell reading `CF_HTML`'s `SourceURL:` — never from our
 * own origin, which is the mistake this function exists to not make. It is
 * checked here as well as at the source, because a base that is not a page turns
 * every relative path into a plausible URL to nothing, and one bad answer is
 * harder to notice than none.
 *
 * A source that will not parse is dropped rather than guessed at.
 */
export function resolveAgainst(sources: readonly string[], base: string): string[] {
  if (!isHttpUrl(base)) return [];
  const out: string[] = [];
  for (const source of sources) {
    try {
      const resolved = new URL(source, base).href;
      // The base is http(s), so a relative path can only resolve to http(s) —
      // but `new URL` also accepts a source that turned out to be absolute
      // after all, and the scheme rule has to hold either way.
      if (isHttpUrl(resolved)) out.push(resolved);
    } catch {
      // Not a path this board can make a URL out of. There is nothing to fetch.
    }
  }
  return out;
}

/** The bytes behind a `data:` URL, or null if it is not one we can read. */
export function decodeDataUrl(url: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([\w/+.-]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  try {
    const binary = atob(match[2]!);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mime: match[1]! };
  } catch {
    return null;
  }
}

// --- laying them down -------------------------------------------------------

/** Step between neighbours in a fan, as a fraction of an item's width. */
const FAN_STEP = 0.42;
/**
 * How wide a fan is allowed to get, in item widths, however many things are in
 * it.
 *
 * Without a bound the spread is linear in the count and the sag is quadratic,
 * so a paste of twenty photographs puts the outer ones thousands of units off —
 * several screens away, selected, and invisible. A handful of photographs put
 * down at once does not spread further the more of them there are; it piles.
 */
const FAN_MAX_WIDTH = 3.2;
/** How far the outer items of a fan sit below the middle one, as a fraction of
 *  an item's height. Normalised by the fan's half-width, so it is this at the
 *  ends whether there are three or fifty. */
const FAN_SAG = 0.07;
/** Board units of slop per item, so a fan is never two of anything aligned. */
const FAN_JITTER = 14;

/**
 * Turn resolved payloads into items at a point.
 *
 * > Multiple images: a loose fan at the paste point, slightly overlapping, each
 * > at its own angle — not a grid. — DESIGN section 3.1
 *
 * The overlap is the point. A grid is a filing system and this is a corkboard;
 * the arrangement has to look like a handful of photographs put down at once,
 * which means they touch. The angles are not computed here — each item's seeded
 * scatter already gives it one, and using the same seed for the position keeps
 * the two consistent for the life of the item.
 */
export function layout(payloads: readonly Ingested[], at: BoardPoint): CreateItemInput[] {
  const centre = (payloads.length - 1) / 2;

  return payloads.map((payload, i) => {
    const seed = newSeed();
    // A photograph is the one thing on this board whose *shape* is a fact about
    // its bytes, so it is the one that has to be asked. The other three are
    // objects with sizes of their own — a VHS is 187 by 103 millimetres whatever
    // is recorded on it — which is why this is a lookup by kind and not a
    // measurement, and why it is right before a single byte has arrived.
    // And a link card is the exception to the exception (T-339). Its bytes are
    // a jpeg, so `objectSizeFor` says nothing and `polaroidFor` would cut a
    // 1200 by 630 banner into a wide print — but the object is not a print of
    // the banner, it is a business card with the banner washed into its stock,
    // and a business card is 85 by 55 mm whatever picture is on it. What says so
    // is `source`: the item is *about* somewhere. Same test as the renderer's
    // `archetypeOf`, and it has to be, or the card would arrive the wrong shape
    // and stay that way — a size is written into the document once.
    // A card with no picture at all is the same object at the same size (T-340),
    // which is the point of a card being 85 by 55 mm whatever is on it: a page
    // that had a banner and a page that had none are the same thing on the wall
    // and must not be two sizes.
    //
    // And a printed still is **not** a card and is not cut to one (T-342). Its
    // picture is a still of a film rather than the card's paper, so it is a
    // photograph and takes a photograph's shape — which is a fact about the
    // bytes, the one thing on this board that is.
    const size =
      payload.kind === "text"
        ? noteSizeFor(payload.text)
        : payload.kind === "page"
          ? CARD_UNITS
          : (objectSizeFor(assetKind(payload.asset.mime)) ??
            (payload.source !== undefined && payload.sourceAbout !== "media"
              ? CARD_UNITS
              : polaroidFor(payload.asset.w, payload.asset.h)));

    // Position along the fan, in [-1, 1] rather than in item indices: the
    // arrangement is then the same shape whatever the count, and only gets
    // denser as more things are put down at the same spot.
    const t = centre === 0 ? 0 : (i - centre) / centre;
    const step = Math.min(FAN_STEP * centre, FAN_MAX_WIDTH / 2) * size.w;
    const jitterX = (valueAt(seed, "fan", 0) * 2 - 1) * FAN_JITTER;
    const jitterY = (valueAt(seed, "fan", 1) * 2 - 1) * FAN_JITTER;

    return {
      // No new item types, and this is the line that would grow one. The face
      // is chosen from the asset's mime at render time (D-46 section 2), and
      // the reason is a data-loss argument rather than a taste one: `readItem`
      // returns null for a type an older build has never heard of, so such an
      // item is both invisible *and* absent from the keep set — an older build
      // would collect the bytes of a document it cannot see.
      //
      // A page payload is a `polaroid` too, and that reads oddly until you read
      // the line above again: the type separates *a sheet of paper* from *a
      // thing with an object on it*, and it has never named the object. A card
      // with no picture is the second of those — it just happens to have nothing
      // behind it yet, which is a state a photograph waiting for its bytes has
      // been in since the beginning.
      type: payload.kind === "text" ? "note" : "polaroid",
      x: at.x + t * step + jitterX,
      // A shallow sag, so a row of photographs reads as dropped rather than
      // set out. Zero for a single item, which is the common case.
      y: at.y + t * t * size.h * FAN_SAG + jitterY,
      w: size.w,
      h: size.h,
      seed,
      assetId: payload.kind === "asset" ? payload.sha256 : null,
      ...(payload.kind === "asset" ? { asset: payload.asset } : {}),
      text:
        payload.kind === "text"
          ? payload.text
          : payload.kind === "page"
            ? payload.title
            : (payload.caption ?? ""),
      ...(payload.kind === "page"
        ? { source: payload.source }
        : payload.kind === "asset" && payload.source !== undefined
          ? { source: payload.source }
          : {}),
      // What the page was about, carried through to the document because the
      // face is chosen from it and nothing downstream could work it out again
      // (T-342). A `page` payload is never `media` — there was no picture to
      // make a still out of, so it is a card whatever the page named.
      ...(payload.kind === "asset" && payload.sourceAbout !== undefined
        ? { sourceAbout: payload.sourceAbout }
        : {}),
    };
  });
}
