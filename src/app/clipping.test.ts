import { beforeEach, describe, expect, it } from "vitest";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { checkInvariants } from "@/crdt/invariants";
import { createItems, itemText, registerAsset } from "@/crdt/ops/items";
import { readItem } from "@/crdt/schema";
import {
  CLIP_MAX_EDGE,
  CLIP_SCALE,
  Clipper,
  clipScale,
  crosses,
  figureCrossed,
  type FigureUnder,
  landing,
  readingCorners,
  screenQuad,
  toWordBounds,
  type ShownPage,
} from "@/app/clipping";
import type { PageContent } from "@/platform/types";
import type { RasterCamera, RasterReport } from "@/render/items/raster";
import type { Bounds } from "@/state/camera";
import { noteSizeFor } from "@/app/ingest";
import { OPEN_PAGE_TURN } from "@/lib/objects";
import { Camera } from "@/state/camera";
import { Scene } from "@/state/scene";

const SHA = "d0c5".padEnd(64, "0");
/** The recording a transcript is a transcript of — T-287. */
const OTHER_SHA = "7a9e".padEnd(64, "1");
const CLIP_SHA = "c11b".padEnd(64, "0");

const SCAN: PageContent = {
  kind: "image",
  image: { mime: "image/jpeg", width: 1700, height: 2200, bytes: 402_118 },
};
const TYPED: PageContent = { kind: "text", runs: [], figures: [] };

let board: BoardDoc;
let scene: Scene;
let said: string[];
let ingested: Array<{ bytes: Uint8Array; mime: string }>;
let held: string[];
let rasterCalls: Array<{ itemId: string; camera: RasterCamera }>;
let canvases: Array<{ w: number; h: number }>;

/** What the reader would answer for the page on show. */
let page: ShownPage | null;
/** What the raster painter reports. Zero drawn is a real answer, not an error. */
let drawn: number;
/** What the encoder answers. Null is an encoder that refused. */
let encoded: { bytes: Uint8Array; mime: string } | null;
/** What the caret hit test finds under the rectangle on a typed page. */
let passage: string;
/** Where the injected passage started in the page, for a transcript's cue. */
let startedAt: number;
/** What the rectangle crossed on a typed page — T-331, Q-290. */
let overFigure: FigureUnder | null;

/**
 * A case file lying open, in the scene *and* in the document.
 *
 * Both, because the two halves are read by different people: `landing` asks the
 * scene where the paper is, and `createQuoteCard` reads the source out of the
 * document inside its own transaction and refuses one that is not there.
 */
function folder(x = 0, y = 0, rot = 0, w = 480, h = 344): string {
  // No pin of its own: a folder lying on the board is the ordinary case, and
  // it keeps the pin assertions below about the pin this gesture made.
  const [made] = createItems(board, [
    { type: "polaroid", x, y, w, h, assetId: SHA, withPin: false },
  ]);
  const id = made!.itemId;
  scene.putItem(
    { id, type: "polaroid", z: "a0", seed: 3, assetId: SHA, createdBy: 1, createdAt: 0, text: "" },
    { x, y, rot, w, h },
  );
  return id;
}

function clipper(): Clipper {
  return new Clipper({
    board,
    scene,
    shownPage: () => page,
    figureUnder: () => overFigure,
    rasterise: (itemId, _ctx, camera) => {
      rasterCalls.push({ itemId, camera: { ...camera } });
      return Promise.resolve({
        items: 1,
        drawn,
        inlined: 0,
        unreadable: 0,
        bytes: 0,
        inked: 0,
      } satisfies RasterReport);
    },
    canvas: (w, h) => {
      canvases.push({ w, h });
      // happy-dom has no 2D context, and what is worth checking here is the
      // arithmetic either side of the drawing rather than the drawing.
      return {
        width: w,
        height: h,
        // Enough of a context for the turn: what is worth checking here is
        // which way the axes came out, not the drawing.
        getContext: () => ({ translate: () => {}, rotate: () => {}, drawImage: () => {} }),
      } as unknown as HTMLCanvasElement;
    },
    encode: () => Promise.resolve(encoded),
    ingest: (bytes, mime) => {
      ingested.push({ bytes, mime });
      return Promise.resolve({ sha256: CLIP_SHA, w: 480, h: 300, size: bytes.length });
    },
    stored: (sha256) => held.push(sha256),
    passage: () => ({ text: passage, at: startedAt }),
    say: (message) => said.push(message),
  });
}

function rect(minX: number, minY: number, maxX: number, maxY: number): Bounds {
  return { minX, minY, maxX, maxY };
}

/** The card a cut made, or null — anything in the document that is not the
 *  folder the cut came out of. */
function card(source: string): string | null {
  for (const id of board.items.keys()) if (id !== source) return id;
  return null;
}

/** Let the cut's promise chain drain. It is fire-and-forget by design: the
 *  pointer went up before any of it started. */
async function settled(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  board = openBoardDoc();
  initialiseBoard(board);
  scene = new Scene();
  said = [];
  ingested = [];
  held = [];
  rasterCalls = [];
  canvases = [];
  drawn = 1;
  encoded = { bytes: new Uint8Array([1, 2, 3, 4]), mime: "image/webp" };
  passage = "the third invoice has no counter-signature";
  startedAt = 0;
  overFigure = null;
  page = { sha256: SHA, index: 4, content: SCAN, origName: "scan.pdf", cues: [], of: null };
  registerAsset(
    board,
    SHA,
    { w: 0, h: 0, mime: "application/pdf", size: 9, origName: "scan.pdf" },
    0,
  );
});

describe("what a rectangle yields, by what is on the page", () => {
  it("lifts the pixels off a scanned page", async () => {
    // Q-284's first half, and D-46's "a scanned page is only quotable by
    // rectangle" — a scan has no text to select.
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.mime).toBe("image/webp");
    const made = card(id)!;
    expect(readItem(made, board.items.get(made)!)!.type).toBe("polaroid");
    expect(readItem(made, board.items.get(made)!)!.assetId).toBe(CLIP_SHA);
  });

  it("takes the words off a typed page rather than a picture of our own hand", async () => {
    // Q-284. Q-198 chose re-typesetting over facsimile, so the pixels of a
    // typed page are our hand on our paper — lifting them would photograph the
    // reading surface and call it the document.
    const id = folder();
    page = { sha256: SHA, index: 4, content: TYPED, origName: "scan.pdf", cues: [], of: null };
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    const made = card(id)!;
    expect(readItem(made, board.items.get(made)!)!.type).toBe("note");
    expect(readItem(made, board.items.get(made)!)!.assetId).toBeNull();
  });

  it("reads a page of plain text, which is what a text file gives", async () => {
    // `plain` and `text` are different arms of PageContent and a .txt file
    // produces the first — D-60's 66-by-46 grid, with no runs at all. Testing
    // only `text` left the commonest typed page falling through to the picture
    // arm, which a mutation caught and this stops.
    const id = folder();
    page = { sha256: SHA, index: 2, content: { kind: "plain", text: "..." }, origName: "notes.txt", cues: [], of: null };
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    const made = card(id)!;
    expect(readItem(made, board.items.get(made)!)!.type).toBe("note");
    expect(itemText(board, made)?.toString()).toContain("notes.txt p. 2");
  });

  it("writes the passage with its citation under it, on index stock", async () => {
    const id = folder();
    page = { sha256: SHA, index: 4, content: TYPED, origName: "scan.pdf", cues: [], of: null };
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    const made = card(id)!;
    expect(itemText(board, made)?.toString()).toBe(
      `the third invoice has no counter-signature

— scan.pdf p. 4`,
    );
    expect(readItem(made, board.items.get(made)!)!.style.paperStock).toBe("index");
  });

  /**
   * T-333, off a driven run rather than off a test: a four-line quote from
   * `filing.pdf` came out on a card whose paper ended at the last word, with
   * `— filing.pdf p. 1` past the bottom edge. `.paper-text` is
   * `overflow: hidden`, so that citation is not at the bottom of the card — it
   * is nowhere, at every zoom, and it is the one thing quoting exists to carry.
   *
   * The card was sized from the quote and then written with the quote, a blank
   * line and the citation. `NOTE_MIN_H` absorbs those two rows on anything
   * short, which is why every test and every earlier run agreed it was fine.
   */
  describe("and the card is as big as what is written on it", () => {
    /** The size a note holding this exact string would be given — the question
     *  asked of the text read back out of the document, so nothing here can
     *  agree with the code by sharing its input. */
    const needs = (made: string) => noteSizeFor(itemText(board, made)!.toString());
    const box = (made: string) => {
      const fields = readItem(made, board.items.get(made)!)!;
      return { w: fields.w, h: fields.h };
    };

    it("fits the citation on the paper, not past the bottom of it", async () => {
      const id = folder();
      page = { sha256: SHA, index: 1, content: TYPED, origName: "filing.pdf", cues: [], of: null };
      passage = [
        "MATTER OF HARTLEY",
        "and in the matter of an application under section 12",
        "The witness states that on the evening in question he",
        "observed the vehicle parked outside the premises.",
      ].join("\n");
      clipper().cut(id, rect(-100, -80, 60, 70));
      await settled();

      const made = card(id)!;
      expect(box(made).h).toBeGreaterThanOrEqual(needs(made).h);
      expect(box(made).w).toBeGreaterThanOrEqual(needs(made).w);
      // And the citation genuinely costs something: sized off the quote alone
      // this card was two rows short, which is the whole defect in one number.
      expect(box(made).h).toBeGreaterThan(noteSizeFor(passage).h);
    });

    it("widens for a citation longer than anything in the quote", async () => {
      // The other half of the same call, and the half a height-only repair
      // leaves behind: the reference is a line of the card's text like any
      // other, so a long filename wraps and costs a row it was not given.
      const id = folder();
      page = {
        sha256: SHA,
        index: 12,
        content: TYPED,
        origName: "witness-statement-second-supplemental-exhibit-B.pdf", cues: [], of: null
      };
      passage = "he did not";
      clipper().cut(id, rect(-100, -80, 60, 70));
      await settled();

      const made = card(id)!;
      expect(box(made).w).toBeGreaterThan(noteSizeFor(passage).w);
      expect(box(made).h).toBeGreaterThanOrEqual(needs(made).h);
    });

    it("grows the ordinary card downwards and not sideways", async () => {
      // The common cut, and the shape of what the repair costs. The citation is
      // shorter than the sentence above it, so the card is exactly as wide as
      // it always was; it is *taller* by the blank line and the citation, which
      // is the room they need and were not being given. Written as three
      // separate facts because "unchanged" was the guess and it was wrong by
      // six units — `NOTE_MIN_H` hid the two rows on this card but not quite.
      const id = folder();
      page = { sha256: SHA, index: 4, content: TYPED, origName: "scan.pdf", cues: [], of: null };
      passage = "the third invoice has no counter-signature";
      clipper().cut(id, rect(-100, -80, 60, 70));
      await settled();

      const made = card(id)!;
      expect(itemText(board, made)!.toString()).toContain("— scan.pdf p. 4");
      expect(box(made).w).toBe(noteSizeFor(passage).w);
      expect(box(made).h).toBeGreaterThan(noteSizeFor(passage).h);
      expect(box(made).h).toBeGreaterThanOrEqual(needs(made).h);
    });
  });

  it("threads a written card exactly as it threads a picture", async () => {
    const id = folder();
    page = { sha256: SHA, index: 4, content: TYPED, origName: "scan.pdf", cues: [], of: null };
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(board.strings.size).toBe(1);
    expect(board.pins.size).toBe(2);
    expect(checkInvariants(board)).toEqual([]);
  });

  it("lifts the picture when the rectangle crossed a figure on a typed page", async () => {
    // T-331, and the arm that did not exist while a typed page could not carry
    // a picture. Q-284's "our own hand" reasoning is about the re-set *words*;
    // a figure is the original image laid on our paper, which is exactly the
    // standing Q-199 gives a scan.
    const id = folder();
    page = { sha256: SHA, index: 5, content: TYPED, origName: "filing.pdf", cues: [], of: null };
    overFigure = "drawn";
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toHaveLength(1);
    const made = card(id)!;
    expect(readItem(made, board.items.get(made)!)!.type).toBe("polaroid");
    expect(readItem(made, board.items.get(made)!)!.assetId).toBe(CLIP_SHA);
  });

  it("takes the picture over the words when the rectangle caught both", async () => {
    // Q-290. Selecting a passage already has its own way in; a rectangle
    // dragged across a chart as well as the sentence under it has caught the
    // one thing no other gesture on this board reaches. So the picture wins
    // outright rather than by a ratio nobody can see while they are dragging.
    const id = folder();
    page = { sha256: SHA, index: 5, content: TYPED, origName: "filing.pdf", cues: [], of: null };
    overFigure = "drawn";
    passage = "The premises as they stood on the evening in question:";
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    const made = card(id)!;
    expect(readItem(made, board.items.get(made)!)!.type).toBe("polaroid");
    expect(itemText(board, made)?.toString()).not.toContain("the premises");
  });

  it("is still the words on a page whose figure the rectangle missed", async () => {
    const id = folder();
    page = { sha256: SHA, index: 5, content: TYPED, origName: "filing.pdf", cues: [], of: null };
    overFigure = null;
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    expect(readItem(card(id)!, board.items.get(card(id)!)!)!.type).toBe("note");
  });

  it("names the figure rather than calling the page blank", async () => {
    // A rectangle inside the box `document.rs` reports for a figure it could
    // not lift. "There is nothing written there" is true and useless: the box
    // under the cursor is at that moment explaining itself, and a board that
    // argues with its own page is worse than one that says nothing.
    const id = folder();
    page = { sha256: SHA, index: 5, content: TYPED, origName: "filing.pdf", cues: [], of: null };
    overFigure = "unliftable";
    passage = "";
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(card(id)).toBeNull();
    expect(ingested).toEqual([]);
    expect(said).toEqual(["That picture could not be lifted off the page."]);
  });

  it("still takes the words beside a figure it could not lift", async () => {
    // Q-290 gives the picture the rectangle, and here there is no picture to
    // give — so the words are the only thing that was ever there.
    const id = folder();
    page = { sha256: SHA, index: 5, content: TYPED, origName: "filing.pdf", cues: [], of: null };
    overFigure = "unliftable";
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    expect(readItem(card(id)!, board.items.get(card(id)!)!)!.type).toBe("note");
  });

  it("never lifts a picture off a page of plain text", async () => {
    // A .txt file has no figures to cross, so `overFigure` cannot be true for
    // one in the running app. Asserted anyway because the guard is a `kind`
    // check a refactor could widen without anything noticing.
    const id = folder();
    page = { sha256: SHA, index: 2, content: { kind: "plain", text: "..." }, origName: "notes.txt", cues: [], of: null };
    overFigure = "drawn";
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    expect(readItem(card(id)!, board.items.get(card(id)!)!)!.type).toBe("note");
  });

  it("cuts nothing from a rectangle over the blank half of a page", async () => {
    // AC-855, and the same answer the picture arm gives when nothing could be
    // drawn: no card, no pin, no string.
    const id = folder();
    page = { sha256: SHA, index: 4, content: TYPED, origName: "scan.pdf", cues: [], of: null };
    passage = "   ";
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(card(id)).toBeNull();
    expect(board.pins.size).toBe(0);
    expect(said).toHaveLength(1);
  });

  it("says so on a page that is blank or unreadable", async () => {
    const id = folder();
    page = { sha256: SHA, index: 4, content: { kind: "empty" }, origName: "scan.pdf", cues: [], of: null };
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(card(id)).toBeNull();
    expect(ingested).toEqual([]);
    expect(said).toHaveLength(1);
  });

  it("does nothing at all on something that is not an open case file", async () => {
    // Silent, deliberately: this is the gesture asking a question rather than
    // a person being refused.
    const id = folder();
    page = null;
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    expect(said).toEqual([]);
  });

  it("writes the citation under the picture", async () => {
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();
    expect(itemText(board, card(id)!)?.toString()).toBe("scan.pdf p. 4");
  });

  it("comes out threaded, and leaves the document sound", async () => {
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(board.strings.size).toBe(1);
    // Two: one in the page where the rectangle was, one in the card.
    expect(board.pins.size).toBe(2);
    expect(checkInvariants(board)).toEqual([]);
  });

  it("puts the pin at the middle of the rectangle, in the page's own frame", async () => {
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    const parented = [...board.pins.values()]
      .map((map) => ({ parent: map.get("parent"), lx: map.get("lx"), ly: map.get("ly") }))
      .find((pin) => pin.parent === id)!;
    expect(parented.lx).toBeCloseTo(-20, 6);
    expect(parented.ly).toBeCloseTo(-5, 6);
  });

  /**
   * And it tapes it to the *page*, not to the folder — T-330.
   *
   * `page.index` rather than the reader asked a second time: the bytes go to
   * disk and back while a cut is in flight, and the arrow keys work throughout,
   * so a page reference is quoted out of the page it was read on and not out of
   * whichever page you happen to be on when the card arrives.
   */
  it("tapes it to the page the rectangle was drawn on", async () => {
    const id = folder();
    page = { sha256: SHA, index: 7, content: SCAN, origName: "scan.pdf", cues: [], of: null };
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    const taped = [...board.pins.values()].find((map) => map.get("parent") === id)!;
    expect(taped.get("kind")).toBe("tape");
    expect(taped.get("page")).toBe(7);
    // And the card's own pin is in a polaroid, which has one face — no key.
    const onCard = [...board.pins.values()].find((map) => map.get("parent") !== id)!;
    expect(onCard.has("page")).toBe(false);
  });

  /**
   * Both arms, because they are two `createQuoteCard` calls and a page passed
   * by one of them is not a page passed by the other. The written arm lands in
   * the same frame as the release rather than after a round trip to disk, which
   * is exactly why it is easy to leave out of a fix aimed at the slow one.
   */
  it("tapes a quotation to its page too, on the written arm", async () => {
    const id = folder();
    page = { sha256: SHA, index: 3, content: { kind: "plain", text: "..." }, origName: "notes.txt", cues: [], of: null };
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    const taped = [...board.pins.values()].find((map) => map.get("parent") === id)!;
    expect(taped.get("kind")).toBe("tape");
    expect(taped.get("page")).toBe(3);
  });

  /**
   * T-287, Q-301. A transcript is a page like any other and is quoted by the
   * same gesture — but what the card *says it came from* is the one thing
   * about it that is not like any other page. The sidecar is a file nobody put
   * on the wall and nobody thinks of as having pages, so `interview.srt p. 1`
   * names the wrong file and gives a number that cannot be followed back.
   */
  it("cites a recording and the moment, not the sidecar and a page", async () => {
    const id = folder();
    passage = "I asked him twice and he gave me the same answer";
    page = {
      sha256: SHA,
      index: 1,
      content: { kind: "plain", text: "..." },
      origName: "interview.srt",
      cues: [
        { offset: 0, at: 0 },
        { offset: 46, at: 724 },
      ],
      of: { sha256: OTHER_SHA, origName: "interview.mp3" },
    };
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    const made = card(id)!;
    const written = itemText(board, made)?.toString() ?? "";
    expect(written).toContain("interview.mp3");
    expect(written).not.toContain("interview.srt");
    expect(written).not.toContain("p. 1");
  });

  /**
   * The offset is what picks the cue, and picking the wrong one is a citation
   * that is plausible, precise and wrong — the worst kind on a board of
   * evidence. Two cues and a passage that starts inside the second.
   */
  it("cites the cue the passage started in and not the first on the page", async () => {
    const id = folder();
    page = {
      sha256: SHA,
      index: 1,
      content: { kind: "plain", text: "..." },
      origName: "interview.srt",
      cues: [
        { offset: 0, at: 0 },
        { offset: 46, at: 724 },
      ],
      of: { sha256: OTHER_SHA, origName: "interview.mp3" },
    };
    startedAt = 60;
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();
    expect(itemText(board, card(id)!)?.toString()).toContain("interview.mp3 12:04");
  });

  it("cites the recording alone when the quote starts before any cue", async () => {
    // A weaker reference rather than a broken one, which is the form
    // `pageReference` already takes for a document with no pages of its own.
    const id = folder();
    page = {
      sha256: SHA,
      index: 1,
      content: { kind: "plain", text: "..." },
      origName: "interview.srt",
      cues: [{ offset: 40, at: 724 }],
      of: { sha256: OTHER_SHA, origName: "interview.mp3" },
    };
    startedAt = 0;
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    const written = itemText(board, card(id)!)?.toString() ?? "";
    expect(written).toContain("interview.mp3");
    expect(written).not.toContain("12:04");
    expect(written).not.toContain("0:00");
  });

  it("holds the bytes it just wrote, rather than waiting to be told", async () => {
    // Without this the card draws as undeveloped film until the next idle
    // reconcile — what `PosterGrabber` says, for its reason.
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();
    expect(held).toEqual([CLIP_SHA]);
  });

  it("stores nothing when nothing could be drawn", async () => {
    // The item is not mounted, or its SVG would not parse — the failure
    // `rasteriseItems` counts rather than throws. A card carrying a blank
    // rectangle is worse than no card at all (AC-855).
    const id = folder();
    drawn = 0;
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    expect(card(id)).toBeNull();
    expect(said).toHaveLength(1);
  });

  it("stores nothing when the encoder refuses", async () => {
    const id = folder();
    encoded = null;
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(ingested).toEqual([]);
    expect(card(id)).toBeNull();
    expect(said).toHaveLength(1);
  });

  it("cuts a second rectangle while the first is still in flight", async () => {
    // The refusal this used to assert was found by driving: a cut is about two
    // hundred milliseconds, which is well inside the time it takes to drag
    // another rectangle, so the second and third cuts off one page produced
    // nothing at all and looked exactly like a board that had ignored them.
    // A deliberate gesture that lands nowhere and says nothing is the failure
    // DESIGN section 1.3 is about.
    const id = folder();
    const cut = clipper();
    cut.cut(id, rect(-100, -80, 60, 70));
    expect(cut.cutting).toBe(true);
    cut.cut(id, rect(0, 0, 40, 40));
    expect(cut.inFlightCount).toBe(2);
    await settled();

    expect(ingested).toHaveLength(2);
    expect(cut.cutting).toBe(false);
  });

  it("gives each overlapping cut its own card", async () => {
    const id = folder();
    const cut = clipper();
    cut.cut(id, rect(-100, -80, 60, 70));
    cut.cut(id, rect(0, 0, 40, 40));
    await settled();
    // Two cards, two source pins, two strings — nothing shared and nothing lost.
    expect(board.items.size).toBe(3);
    expect(board.strings.size).toBe(2);
    expect(checkInvariants(board)).toEqual([]);
  });

  it("sizes the canvas to the rectangle and aims the camera at its corner", async () => {
    // What makes the rectangle fill the canvas exactly: the item is drawn
    // square-on at the origin, so a local point lands at (local - camera) *
    // zoom.
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    // 160 by 150 board units, at three device pixels to the unit.
    expect(canvases[0]).toEqual({ w: 480, h: 450 });
    expect(rasterCalls[0]!.camera).toEqual({ x: -100, y: -80, zoom: CLIP_SCALE });
  });

  it("turns the clipping back the quarter the page is turned in the folder", async () => {
    // Found by driving, not by reading. The rectangle is square in the item's
    // own frame and must be lifted there, but the page lies on its side in that
    // frame — so a landscape rectangle came back 289 by 578 until this.
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    expect(canvases).toHaveLength(2);
    // The second canvas is the first with its axes swapped.
    expect(canvases[1]).toEqual({ w: canvases[0]!.h, h: canvases[0]!.w });
  });

  it("does not touch the page's own pose", async () => {
    // A tape changes nothing about how the page hangs, so there is nothing to
    // settle — and settling anyway writes the momentary SWING into the stored
    // rotation. Driven before this was fixed: three clippings off one folder
    // walked its settledRot 0 -> 0.028 -> -0.022 -> 0.008, on every peer.
    const id = folder(0, 0, 0.2);
    // Mid-swing, which is the only state in which this can go wrong: a settle
    // writes the DRAWN pose, and drawn differs from stored by exactly the
    // transients. A page sitting perfectly still would be written back
    // identical and the bug would be invisible.
    // And hanging from exactly one pin, because that is the state a settle
    // acts on at all — `settleOnPin` skips an item held by none or by two.
    scene.putPin({
      id: "hangs",
      parent: id,
      lx: 0,
      ly: -140,
      kind: "pushpin",
      color: "#c8352f",
      page: null,
      wx: 0,
      wy: -140,
    });
    const slot = scene.slotOf(id)!;
    scene.swing[slot] = 0.028;
    scene.driftX[slot] = 7;
    scene.driftY[slot] = -4;
    const before = { ...readItem(id, board.items.get(id)!)! };
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    const after = readItem(id, board.items.get(id)!)!;
    expect(after.rot).toBe(before.rot);
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
  });

  it("does not touch the page's own pose on the written arm either", async () => {
    // The same guarantee, and a separate test because it is a separate call:
    // patching one arm's settle back in left the other's test entirely green.
    const id = folder(0, 0, 0.2);
    scene.putPin({
      id: "hangs",
      parent: id,
      lx: 0,
      ly: -140,
      kind: "pushpin",
      color: "#c8352f",
      page: null,
      wx: 0,
      wy: -140,
    });
    const slot = scene.slotOf(id)!;
    scene.swing[slot] = 0.028;
    scene.driftX[slot] = 7;
    page = { sha256: SHA, index: 4, content: TYPED, origName: "scan.pdf", cues: [], of: null };
    const before = { ...readItem(id, board.items.get(id)!)! };
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();

    const after = readItem(id, board.items.get(id)!)!;
    expect(after.rot).toBe(before.rot);
    expect(after.x).toBe(before.x);
  });

  it("names the clipping after the document it came out of", async () => {
    const id = folder();
    clipper().cut(id, rect(-100, -80, 60, 70));
    await settled();
    const made = card(id)!;
    const asset = board.assets.get(readItem(made, board.items.get(made)!)!.assetId!)!;
    expect(asset.get("origName")).toBe("scan.pdf");
  });
});

describe("how big a lifted clipping is", () => {
  it("is three device pixels to the board unit", () => {
    expect(clipScale(160, 150)).toBe(CLIP_SCALE);
  });

  it("comes down rather than running away on a rectangle dragged off the page", () => {
    // The gesture does not clamp to the paper, deliberately — clamping is a
    // thing you notice fighting. So the cap is reachable by a gesture rather
    // than only by a mistake.
    expect(clipScale(CLIP_MAX_EDGE, 10)).toBeCloseTo(1, 6);
    expect(clipScale(CLIP_MAX_EDGE * 3, 10) * CLIP_MAX_EDGE * 3).toBeCloseTo(CLIP_MAX_EDGE, 6);
  });

  it("caps on the longer edge, whichever one that is", () => {
    expect(clipScale(10, CLIP_MAX_EDGE)).toBeCloseTo(1, 6);
  });

  it("never returns a scale of zero for a rectangle with no size", () => {
    expect(clipScale(0, 0)).toBe(CLIP_SCALE);
  });
});

describe("where the card lands", () => {
  it("lands clear of the folder rather than over the page it came from", () => {
    // A card on top of the page would cover the thing it was cut from and put
    // its own string underneath itself.
    const id = folder();
    const box = scene.openBoundsOf(id)!;
    const at = landing(scene, id, rect(40, -20, 120, 40), 200)!;
    expect(at.x).toBeGreaterThan(box.maxX);
  });

  it("goes out the side the rectangle was nearer", () => {
    // So that cutting from the left column does not run a string across the
    // whole page to get out.
    const id = folder();
    const box = scene.openBoundsOf(id)!;
    const at = landing(scene, id, rect(-200, -20, -120, 40), 200)!;
    expect(at.x).toBeLessThan(box.minX);
  });

  it("sits level with the rectangle, so the string is short", () => {
    const id = folder();
    const at = landing(scene, id, rect(40, 60, 120, 100), 200)!;
    expect(at.y).toBeCloseTo(80, 6);
  });

  it("follows the page round when the folder is turned", () => {
    // The rectangle is the same rectangle in the page's frame either way, so a
    // turned folder has to put the card somewhere else on the board.
    const turned = folder(0, 0, 0.5);
    const flat = landing(scene, turned, rect(40, 60, 120, 100), 200)!;
    const square = folder(0, 0, 0);
    const level = landing(scene, square, rect(40, 60, 120, 100), 200)!;
    expect(flat.y).not.toBeCloseTo(level.y, 1);
  });

  it("has nowhere to put a card for an item that has gone", () => {
    expect(landing(scene, "nobody", rect(0, 0, 10, 10), 200)).toBeNull();
  });
});

describe("which two points a passage runs between", () => {
  it("reads from the highest corner to the lowest", () => {
    const ends = readingCorners([
      { x: 10, y: 100 },
      { x: 90, y: 100 },
      { x: 90, y: 20 },
      { x: 10, y: 20 },
    ])!;
    expect(ends[0]).toEqual({ x: 10, y: 20 });
    expect(ends[1]).toEqual({ x: 90, y: 100 });
  });

  it("breaks a level tie leftmost first and rightmost last", () => {
    const ends = readingCorners([
      { x: 10, y: 0 },
      { x: 90, y: 0 },
      { x: 90, y: 50 },
      { x: 10, y: 50 },
    ])!;
    expect(ends[0]!.x).toBe(10);
    expect(ends[1]!.x).toBe(90);
  });

  it("is not the rectangle's own first corner once the page is turned", () => {
    // The whole reason this function exists. The page lies a quarter turn
    // inside the folder, so the corner with the smallest local coordinates is
    // the BOTTOM LEFT of what somebody is looking at — start a range there and
    // the passage runs backwards from the end of the page.
    const camera = new Camera();
    camera.resize(1000, 800);
    // An open folder is drawn turned by exactly this — `Scene.setOpen`'s +90°
    // against the stylesheet's -90°.
    const id = folder(0, 0, -OPEN_PAGE_TURN);
    const quad = screenQuad(scene, camera, id, rect(-100, -80, 60, 70))!;

    // The rectangle's own first corner is (minX, minY), the first of the four.
    // On a turned page that is not where the text starts.
    const ends = readingCorners(quad)!;
    expect(ends[0]).not.toEqual(quad[0]);
    // It is the corner the rectangle calls (minX, maxY) — its bottom left.
    expect(ends[0]).toEqual(quad[3]);
  });

  it("has no answer for anything but four corners", () => {
    expect(readingCorners([])).toBeNull();
    expect(readingCorners([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
  });
});

describe("the rectangle in screen space", () => {
  it("comes back out through the pose the item is drawn at", () => {
    const camera = new Camera();
    camera.resize(1000, 800);
    const id = folder(0, 0, 0);
    const quad = screenQuad(scene, camera, id, rect(-100, -80, 60, 70))!;
    expect(quad).toHaveLength(4);
    // Un-rotated: the four corners are the four corners, in board order.
    const a = camera.boardToScreen(-100, -80);
    expect(quad[0]!.x).toBeCloseTo(a.x, 6);
    expect(quad[0]!.y).toBeCloseTo(a.y, 6);
  });

  it("has nothing to convert for an item that has gone", () => {
    const camera = new Camera();
    camera.resize(1000, 800);
    expect(screenQuad(scene, camera, "nobody", rect(0, 0, 10, 10))).toBeNull();
  });
});

describe("a quotation rather than a substring", () => {
  it("widens to whole words at both ends", () => {
    // Driven, and this is the string the card actually carried: a caret hit
    // test lands between two characters, so a rectangle over a line of a
    // filing came back as "ed the vehicle parked outside the premises."
    const line = "and he had watched the vehicle parked outside the premises.";
    const [a, b] = toWordBounds(line, line.indexOf("ed the"), line.length - 4);
    expect(line.slice(a, b)).toBe("watched the vehicle parked outside the premises.");
  });

  it("pushes out rather than in, so a tight rectangle still catches its word", () => {
    // The other obvious rule is to pull the ends inward, and it is worse in
    // the one case that matters: a rectangle drawn tightly around one word
    // would come back empty.
    const line = "the third invoice";
    const [a, b] = toWordBounds(line, 5, 8);
    expect(line.slice(a, b)).toBe("third");
  });

  it("keeps the punctuation attached to the word it is attached to", () => {
    const line = "no counter-signature. The invoice";
    const [a, b] = toWordBounds(line, 3, 20);
    expect(line.slice(a, b)).toBe("counter-signature.");
  });

  it("treats a line break as a word gap", () => {
    const line = "IN THE MATTER OF HARTLEY\nand in the matter of";
    const [a, b] = toWordBounds(line, 22, 28);
    expect(line.slice(a, b)).toBe("HARTLEY\nand");
  });

  it("survives offsets that arrive backwards or off the end", () => {
    // The two carets come from two corners and nothing upstream promises an
    // order, so this must not depend on one.
    const line = "the third invoice";
    expect(toWordBounds(line, 8, 5)).toEqual(toWordBounds(line, 5, 8));
    expect(toWordBounds(line, 0, 500)).toEqual([0, line.length]);
  });

  it("has nothing to widen in an empty page", () => {
    expect(toWordBounds("", 0, 0)).toEqual([0, 0]);
  });
});

/**
 * What "crossed a picture" means — T-331, Q-290.
 *
 * The answer Phil gave is a sentence rather than a rule with a number in it:
 * "a rectangle that crossed a picture wanted the picture". Intersection is what
 * that sentence means, and anything stricter would need a threshold nobody can
 * see while they are dragging.
 */
describe("whether a rectangle crossed a picture", () => {
  const BOX = { left: 100, top: 100, right: 200, bottom: 200 };
  const quad = (minX: number, minY: number, maxX: number, maxY: number) => [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];

  it("crosses one it overlaps a corner of", () => {
    expect(crosses(quad(150, 150, 300, 300), BOX)).toBe(true);
  });

  it("crosses one it encloses entirely", () => {
    // The case a corner hit test would miss, and the ordinary way somebody
    // takes a whole chart: a rectangle drawn round it touches none of it.
    expect(crosses(quad(50, 50, 300, 300), BOX)).toBe(true);
  });

  it("crosses one that encloses it", () => {
    expect(crosses(quad(120, 120, 140, 140), BOX)).toBe(true);
  });

  it("does not cross one it only sits beside", () => {
    expect(crosses(quad(210, 100, 300, 200), BOX)).toBe(false);
    expect(crosses(quad(100, 210, 200, 300), BOX)).toBe(false);
  });

  it("does not cross one its edge merely lands on", () => {
    // Strict, so a rectangle dragged up to the top of a figure takes the words
    // above it rather than the picture it stopped at.
    expect(crosses(quad(200, 100, 300, 200), BOX)).toBe(false);
  });

  it("answers no for a rectangle that is not on the page at all", () => {
    // `screenQuad` returns null for an item with no slot and the caller stops
    // there; an empty quad is the belt to that brace.
    expect(crosses([], BOX)).toBe(false);
  });

  it("uses the whole quad, because the page it was dragged on is turned", () => {
    // A quarter turn inside the folder plus the folder's own scatter, so the
    // four points are not axis-aligned. A test against only the first two would
    // miss a rectangle whose reach is in the other two.
    const turned = [
      { x: 90, y: 90 },
      { x: 95, y: 95 },
      { x: 250, y: 250 },
      { x: 95, y: 250 },
    ];
    expect(crosses(turned, BOX)).toBe(true);
  });
});

/** Which of the figures on a page a rectangle found — T-331. */
describe("which figure a rectangle crossed", () => {
  const at = (left: number): { left: number; top: number; right: number; bottom: number } => ({
    left,
    top: 100,
    right: left + 100,
    bottom: 200,
  });
  const over = (minX: number, maxX: number) => [
    { x: minX, y: 100 },
    { x: maxX, y: 100 },
    { x: maxX, y: 200 },
    { x: minX, y: 200 },
  ];

  it("answers nothing for a rectangle that crossed none of them", () => {
    expect(figureCrossed(over(500, 600), [{ drawn: true, box: at(100) }])).toBeNull();
  });

  it("names a drawn one", () => {
    expect(figureCrossed(over(120, 160), [{ drawn: true, box: at(100) }])).toBe("drawn");
  });

  it("names an unliftable one, which is a different sentence and not the same as none", () => {
    expect(figureCrossed(over(120, 160), [{ drawn: false, box: at(100) }])).toBe("unliftable");
  });

  it("prefers the drawn one wherever the two sit on the page", () => {
    // Both orders, because "whichever came first" would pass one of them and is
    // a coin toss nobody dragging a rectangle can see.
    const both = [
      { drawn: false, box: at(100) },
      { drawn: true, box: at(200) },
    ];
    expect(figureCrossed(over(120, 260), both)).toBe("drawn");
    expect(figureCrossed(over(120, 260), [...both].reverse())).toBe("drawn");
  });

  it("answers nothing for a page with no figures at all", () => {
    expect(figureCrossed(over(120, 160), [])).toBeNull();
  });
});
