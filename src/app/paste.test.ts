/**
 * @vitest-environment happy-dom
 *
 * The order in which paste makes up its mind, which is the whole of the
 * feature. `lib/ingest.test.ts` covers what each payload becomes; this covers
 * which payload wins, and that the document sees one transaction rather than
 * one per photograph.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialiseBoard, openBoardDoc, sealBoard, type BoardDoc } from "@/crdt/doc";
import { readAsset, readItem } from "@/crdt/schema";
import { Paste } from "@/app/paste";
import type {
  AssetMeta,
  ClipboardPayload,
  PageCard,
  Platform,
  PlatformEvents,
  Refusal,
} from "@/platform/types";
import { CARD_UNITS } from "@/lib/objects";
import { polaroidFor } from "@/lib/polaroid";
import { Camera } from "@/state/camera";

interface Call {
  method: string;
  arg: unknown;
}

class FakeNative {
  readonly kind = "mock" as const;
  readonly calls: Call[] = [];
  /** Sources this fake refuses, so failure paths can be driven. */
  readonly refuse = new Set<string>();
  /**
   * Sources the *store* refuses, in the shape the store refuses them in.
   *
   * Distinct from `refuse` above, which throws whatever a broken read throws.
   * The whole of T-309 is that these two are not the same thing on this side
   * either: one is a claim about the board and the other is not.
   *
   * Keyed by whatever was handed over, so one map covers a path, a URL and an
   * address read as a page: the three roads are mutually exclusive for any one
   * string — a `.jpg` URL is never asked for as a page, and a page is never
   * ingested — so there is nothing for two maps to disagree about.
   */
  readonly refusal = new Map<string, Refusal>();
  /** What the bytes behind a path turn out to be. */
  readonly mimeFor = new Map<string, string>();
  nativeFiles: string[] = [];
  private handler: ((payload: PlatformEvents["files:dropped"]) => void) | null = null;

  /**
   * Models the store: the mime is sniffed from the bytes and falls back to the
   * caller's hint, and dimensions stay at zero when nothing decoded.
   *
   * Seeded on the path itself and put through {@link digest}, and both halves of
   * that mattered before they were changed. The seed used to be the path's
   * *length*, so **every path of the same length hashed the same** —
   * `C:/interview.mp4` and `C:/interview.srt` are both sixteen — and a fixture
   * modelling two different files silently modelled one file twice. And the
   * result used to be padded with zeroes rather than hex, so anything reaching
   * `readAsset`'s `hash()` guard came back null: a record written and then read
   * as empty, which looks exactly like a write that never happened (T-287).
   */
  private meta(seed: string, mime = "image/png", size = 1): AssetMeta {
    const decoded = mime.startsWith("image/") && this.decodes;
    return {
      sha256: digest(seed),
      w: decoded ? 1200 : 0,
      h: decoded ? 800 : 0,
      mime,
      size,
      duration: mime === "video/mp4" || mime.startsWith("audio/") ? 92 : null,
      pages: mime === "application/pdf" ? 14 : mime.startsWith("text/") ? 3 : null,
    };
  }

  /** Flip off to model bytes that claim to be an image and are not. */
  decodes = true;

  /** A shell that will not take bytes — the paste ceiling, in practice. */
  bytesThrow = false;
  async assetIngestBytes(bytes: Uint8Array, mime?: string): Promise<AssetMeta> {
    this.calls.push({ method: "bytes", arg: { length: bytes.length, mime } });
    if (this.bytesThrow) throw new Error("too big to hand over in one piece");
    return this.meta(`b${bytes.length}`, mime, bytes.length);
  }
  /** What each path was ingested *as* — T-347's flag, recorded separately so
   *  the existing `calls` assertions keep their shape. */
  readonly readAs = new Map<string, boolean>();
  async assetIngestPath(path: string, markdown = false): Promise<AssetMeta> {
    this.calls.push({ method: "path", arg: path });
    this.readAs.set(path, markdown);
    const refusal = this.refusal.get(path);
    if (refusal) throw refusal;
    if (this.refuse.has(path)) throw new Error("no such file");
    return this.meta(`p${path}`, this.mimeFor.get(path));
  }
  /**
   * What each address says about itself, for the pages a test sets up.
   *
   * `aboutMedia` may be left off and is filled in `false` below — the ordinary
   * page, and the one nearly every fixture here is. A test about a watch page
   * has to say so, which is the right way round: the whole of T-342 is that
   * "declared no media" and "declared media we cannot hold" are different pages,
   * so a fixture claiming the second must be explicit about it.
   */
  readonly cardFor = new Map<string, Omit<PageCard, "aboutMedia"> & { aboutMedia?: boolean }>();
  async pageCard(url: string): Promise<PageCard> {
    this.calls.push({ method: "card", arg: url });
    // The shell's own sentence for an address that gave it no page — a 404, a
    // timeout, something that is not a page at all (T-343). Before `refusal`,
    // and it is the difference between the flash saying something and not.
    const refusal = this.refusal.get(url);
    if (refusal) throw refusal;
    const card = this.cardFor.get(url);
    // A page nobody described is one that would not load, which is the
    // ordinary answer for most of the web and the one that makes a note.
    //
    // A plain `Error` on purpose, and it models the *browser* build rather than
    // the shell: `mock.ts` rejects every `pageCard` with "needs the native
    // shell". Nothing is said out loud for one of these, which is why the
    // fixtures above this line have not all had to grow a sentence.
    if (!card) throw new Error("not a page");
    return { aboutMedia: false, ...card };
  }

  async assetIngestUrl(url: string): Promise<AssetMeta> {
    this.calls.push({ method: "url", arg: url });
    const refusal = this.refusal.get(url);
    if (refusal) throw refusal;
    if (this.refuse.has(url)) throw new Error("could not fetch");
    // Through `mimeFor` like the path route, so a test can say what an address
    // actually serves — without it every URL is a PNG and T-289's whole
    // question ("what does a media URL become") cannot be asked.
    return this.meta(`u${url}`, this.mimeFor.get(url));
  }
  async clipboardReadManifest(): Promise<{ kinds: ("files" | "text")[] }> {
    return { kinds: this.nativeFiles.length > 0 ? ["files"] : [] };
  }
  /** Counted, so a test can say the shell was never troubled at all. */
  itemReads = 0;
  async clipboardReadItem(): Promise<ClipboardPayload | null> {
    this.itemReads += 1;
    if (this.clipboardThrows) throw new Error("the clipboard is held by another process");
    return this.nativeFiles.length > 0 ? { kind: "files", paths: this.nativeFiles } : null;
  }
  /** A shell that cannot answer — the browser, or a locked Win32 clipboard. */
  clipboardThrows = false;
  /** The page a fragment was copied from, as the shell would report it. Null is
   *  the answer on a platform that cannot read CF_HTML — which is most of them. */
  sourceUrl: string | null = null;
  async clipboardSourceUrl(): Promise<string | null> {
    this.calls.push({ method: "sourceUrl", arg: null });
    return this.sourceUrl;
  }
  async on(event: string, handler: (payload: never) => void): Promise<() => void> {
    if (event === "files:dropped") {
      this.handler = handler as (p: PlatformEvents["files:dropped"]) => void;
    }
    return () => {};
  }
  /** `found` is what the drop named before the shell's own bound cut it — the
   *  shape T-295 added to the event. Omitted means nothing was cut. */
  drop(paths: string[], x: number, y: number, found?: number): void {
    this.handler?.({ paths, x, y, ...(found === undefined ? {} : { found }) });
  }
  assetUrl(): string {
    return "";
  }
}

/**
 * Sixty-four hex characters, one per distinct seed — what a content hash looks
 * like to everything downstream, without hashing anything.
 *
 * Deterministic, so the same file ingested twice still dedupes to one asset,
 * which is a property several tests here rest on.
 */
function digest(seed: string): string {
  let a = 0x811c9dc5;
  const out: string[] = [];
  for (let round = 0; round < 16; round++) {
    for (const char of `${seed}/${round}`) {
      a = Math.imul(a ^ char.charCodeAt(0), 0x01000193) >>> 0;
    }
    out.push(a.toString(16).padStart(8, "0"));
  }
  return out.join("").slice(0, 64);
}

let board: BoardDoc;
let native: FakeNative;
let camera: Camera;
let paste: Paste;
/** Whether something is over the board, for T-324's gate. False everywhere but
 *  the one describe that is about it. */
let covered = false;
let cursor: { x: number; y: number } | null;
let created: string[];
let transactions: number;
/**
 * What the board's own clipboard says about a paste — null when it holds
 * nothing, which is the case every other test in this file is in
 * (`app/clipboard.ts`).
 */
let claim: ((data: DataTransfer | null, at: { x: number; y: number }) => boolean) | null;
/** Every line the paste said out loud — `ui/flash.ts` in the application. */
let said: string[];

/** A `DataTransfer` is only valid during its event, so the real one is a
 *  one-shot too — this stands in for exactly the surface paste reads. */
function clipboard(clip: { files?: unknown[]; text?: string; html?: string }): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: clip.files ?? [],
      getData: (type: string) => (type === "text/html" ? (clip.html ?? "") : (clip.text ?? "")),
    },
  });
  return event;
}

function imageFile(bytes: number, type = "image/png", name = "photo.png"): unknown {
  return {
    name,
    type,
    size: bytes,
    arrayBuffer: async () => new ArrayBuffer(bytes),
  };
}

/** Everything on the board, oldest first. */
function itemsOnBoard(): {
  type: string;
  assetId: string | null;
  source: string | null;
  sourceAbout: string;
  text: string;
  x: number;
  w: number;
  h: number;
}[] {
  const out = [];
  for (const [id, map] of board.items) {
    const fields = readItem(id, map);
    if (!fields) continue;
    const text = map.get("text");
    out.push({
      type: fields.type,
      assetId: fields.assetId,
      source: fields.source,
      sourceAbout: fields.sourceAbout,
      text: String(text ?? ""),
      x: fields.x,
      // The box, for T-339: a link card is cut to a card and not to its banner,
      // and a size is written into the document once.
      w: fields.w,
      h: fields.h,
    });
  }
  return out;
}

/**
 * Let the promise chain finish.
 *
 * Deterministic turns rather than a timeout: nothing here does real I/O, so
 * everything resolves within a handful of macrotasks, and waiting on a
 * condition would make the "nothing happens" cases pay a full timeout each.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function firePaste(clip: Parameters<typeof clipboard>[0]): Promise<void> {
  // The handler is synchronous — a DataTransfer is only valid during its own
  // event — and hands off to a promise from there.
  window.dispatchEvent(clipboard(clip));
  await settle();
}

beforeEach(async () => {
  document.body.innerHTML = "";
  board = openBoardDoc();
  initialiseBoard(board);
  transactions = 0;
  board.doc.on("afterTransaction", (t) => {
    if (t.origin === "schizo/local-user") transactions++;
  });

  native = new FakeNative();
  camera = new Camera();
  camera.resize(1000, 800);
  cursor = null;
  created = [];
  claim = null;
  said = [];
  covered = false;
  paste = new Paste({
    native: native as unknown as Platform,
    board,
    camera,
    claim: (data, at) => claim?.(data, at) === true,
    cursor: () => cursor,
    covered: () => covered,
    onCreated: (ids) => created.push(...ids),
    say: (message) => said.push(message),
  });
  await paste.attach();
});

// Paste listens on `window`, so an instance left attached goes on answering
// every later test's events — with its own board and its own stale fake behind
// it, which shows up as counts that make no sense.
afterEach(() => paste.destroy());

describe("what wins", () => {
  it("stands aside for the board's own clipboard, before reading anything", async () => {
    // The token said the last copy on this machine was a piece of this board,
    // so the text beside it is a description of that paper and not a note
    // somebody wants (T-227). Nothing may be ingested, and the point it was
    // asked about is the point the paste would have used.
    const asked: { x: number; y: number }[] = [];
    cursor = { x: 300, y: 200 };
    claim = (_data, at) => {
      asked.push(at);
      return true;
    };

    await firePaste({ text: "the words that were on the paper" });

    expect(itemsOnBoard()).toEqual([]);
    expect(native.calls).toEqual([]);
    expect(asked).toEqual([camera.screenToBoard(300, 200)]);
  });


  it("makes a polaroid of image bytes on the clipboard", async () => {
    await firePaste({ files: [imageFile(2048)] });
    const items = itemsOnBoard();
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("polaroid");
    // A content hash and nothing to read into it beyond that — the fake's
    // digest is opaque on purpose, so what is asserted is the shape everything
    // downstream requires (`isHash`).
    expect(items[0]!.assetId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prefers the picture when a web page copy hands over all three", async () => {
    // Copying an image out of a browser puts the bytes, a fragment of markup
    // and the page's text on the clipboard at once. Taking the last of those
    // would turn a photograph into a note.
    await firePaste({
      files: [imageFile(512)],
      html: '<img src="https://example.com/a.png">',
      text: "https://example.com/a.png",
    });
    expect(itemsOnBoard()).toHaveLength(1);
    expect(itemsOnBoard()[0]!.type).toBe("polaroid");
    expect(native.calls.map((c) => c.method)).toEqual(["bytes"]);
  });

  it("fetches the image a web page copy only pointed at", async () => {
    await firePaste({ html: '<img src="https://example.com/photo.jpg">', text: "some caption" });
    expect(native.calls).toEqual([{ method: "url", arg: "https://example.com/photo.jpg" }]);
    expect(itemsOnBoard()[0]!.type).toBe("polaroid");
  });

  it("reads a data URL out of the markup rather than fetching it", async () => {
    await firePaste({ html: '<img src="data:image/png;base64,aGVsbG8=">' });
    expect(native.calls[0]).toMatchObject({ method: "bytes", arg: { mime: "image/png" } });
  });

  it("makes a note of plain text", async () => {
    await firePaste({ text: "the string is the product" });
    const items = itemsOnBoard();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "note", assetId: null });
    expect(items[0]!.text).toBe("the string is the product");
  });

  /**
   * T-294. A note is a thing you take in at a glance, and four thousand words
   * is not one — it is a document that arrived without a file.
   */
  describe("a paste too long to be a note", () => {
    /** Past the note's own paper, which is where `tooMuchForANote` draws it. */
    const manuscript = "a line of the manuscript\n".repeat(200);

    it("makes a document of it, through the store like every other document", async () => {
      await firePaste({ text: manuscript });

      const made = itemsOnBoard()[0]!;
      // An asset, so it is the same manilla folder a `.txt` dragged in from
      // Explorer becomes — paginated, searchable and quotable by the machinery
      // that already exists rather than by a second copy of it.
      expect(made.assetId).not.toBeNull();
      expect(made.text).toBe("");
      // Offered to the shell as text, and the object is chosen from what the
      // *shell* sniffs — nothing on this side decides it is a folder.
      const ingested = native.calls.find((c) => c.method === "bytes");
      expect(ingested?.arg).toMatchObject({ mime: "text/plain" });
    });

    it("leaves a paste the paper can hold as a note", async () => {
      // The guard, and it is the one that would fail silently: a threshold of
      // zero would turn every note on this board into a case file.
      await firePaste({ text: "a line of the manuscript\n".repeat(20) });
      const made = itemsOnBoard()[0]!;
      expect(made.type).toBe("note");
      expect(made.assetId).toBeNull();
    });

    it("falls back to the note when the shell will not hold it", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The one that really happens: a clipboard holding a hundred megabytes of
      // text, past the paste ceiling. A clipped note is a worse object than a
      // folder and a better one than nothing.
      native.bytesThrow = true;
      await firePaste({ text: manuscript });

      const made = itemsOnBoard()[0]!;
      expect(made.type).toBe("note");
      expect(made.text).toBe(manuscript.trim());
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("still reads a long paste for a URL first", async () => {
      // Order matters: a manuscript is what text becomes when it is *not* one of
      // the things above it, and a very long URL is still a URL.
      const long = `https://e.com/${"a".repeat(4000)}.png`;
      await firePaste({ text: long });
      expect(itemsOnBoard()[0]!.type).toBe("polaroid");
      expect(native.calls.some((c) => c.method === "url")).toBe(true);
    });
  });

  it("fetches a bare image URL, and keeps the address when it cannot", async () => {
    await firePaste({ text: "https://example.com/a.png" });
    expect(itemsOnBoard()[0]!.type).toBe("polaroid");

    native.refuse.add("https://example.com/gone.png");
    await firePaste({ text: "https://example.com/gone.png" });
    // A photograph that would not come is a note with its address on it, which
    // is more use than nothing at all.
    const note = itemsOnBoard().find((i) => i.type === "note");
    expect(note?.text).toBe("https://example.com/gone.png");
  });

  /**
   * T-289. The gate has taken every kind since T-260 and the store has sniffed
   * and measured them since T-262, so a cassette was already waiting for a
   * pasted `interview.mp3` — the URL was simply never offered, and arrived as a
   * note with its own address written on it.
   */
  it("fetches a direct media URL and puts the recording on the wall", async () => {
    native.mimeFor.set("https://example.com/interview.mp3", "audio/mpeg");
    await firePaste({ text: "https://example.com/interview.mp3" });

    expect(native.calls).toEqual([{ method: "url", arg: "https://example.com/interview.mp3" }]);
    const made = itemsOnBoard()[0]!;
    const record = board.assets.get(String(made.assetId));
    expect(record?.get("mime")).toBe("audio/mpeg");
    // And the duration the shell measured at ingest, which is what the spine
    // and the J-card are written from and has no second chance to be taken.
    expect(record?.get("duration")).toBe(92);
  });

  it("fetches a direct film URL too, and keeps what it was called", async () => {
    native.mimeFor.set("https://example.com/reel.mp4", "video/mp4");
    await firePaste({ text: "https://example.com/reel.mp4" });

    const made = itemsOnBoard()[0]!;
    const record = board.assets.get(String(made.assetId));
    expect(record?.get("mime")).toBe("video/mp4");
    expect(record?.get("origName")).toBe("reel.mp4");
  });

  /**
   * The refusing half of the same gesture (T-290). A watch page names no file,
   * so the guess never reaches for it — and it must not, because what comes
   * back is markup, which sniffs as text and would arrive as a *case file
   * holding its own angle brackets*.
   */
  it("never fetches a watch page, which names no file", async () => {
    await firePaste({ text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    // It is *read* as a page (T-289) — that is how the still is found — but it
    // is never handed to the ingest as a file, which is what would come back
    // markup and become a case file full of angle brackets.
    expect(native.calls.filter((c) => c.method === "url")).toEqual([]);
    expect(itemsOnBoard()[0]!.type).toBe("note");
  });

  it("never fetches a page, whatever it is called", async () => {
    // Q-265 cut `html` from the extractors for this reason: the shell has no
    // signature for markup, so it falls back to text/plain, which `assetKind`
    // calls a document. A fetched page would open as angle brackets set in the
    // board's own hand.
    await firePaste({ text: "https://example.com/report.html" });
    // Read as a page, never ingested as one. A `.html` address IS a page, so
    // asking it what it says is right; handing it to the store is what Q-265
    // refused.
    expect(native.calls.filter((c) => c.method === "url")).toEqual([]);
    expect(itemsOnBoard()[0]!.type).toBe("note");
  });

  /**
   * T-289, Q-304. The page was only ever the way to find the file: an
   * archive.org item declares its audio and names the mp3, and what lands is
   * the cassette.
   */
  it("takes the media a page declares, and the page is not the object", async () => {
    native.cardFor.set("https://archive.org/details/wexford", {
      title: "The Wexford Tapes",
      siteName: "Internet Archive",
      image: "https://archive.org/services/img/wexford",
      media: { url: "https://archive.org/download/wexford/01.mp3", mime: "audio/mpeg" },
    });
    native.mimeFor.set("https://archive.org/download/wexford/01.mp3", "audio/mpeg");

    await firePaste({ text: "https://archive.org/details/wexford" });

    const made = itemsOnBoard()[0]!;
    const record = board.assets.get(String(made.assetId));
    expect(record?.get("mime")).toBe("audio/mpeg");
    // And the still it also offered was never fetched: the recording is the
    // thing, and a photograph of the page beside it would be clutter.
    expect(native.calls).toEqual([
      { method: "card", arg: "https://archive.org/details/wexford" },
      { method: "url", arg: "https://archive.org/download/wexford/01.mp3" },
    ]);
  });

  /**
   * The other outcome, and T-290's whole object — restored by T-342 after this
   * assertion had been turned round the wrong way.
   *
   * A watch page declares an `og:video` that is a player rather than a film, so
   * Rust hands over no media at all. It *does* report that the page said it was
   * about a video (`aboutMedia`), and that is what keeps this a printed still:
   * the picture is a frame of the film, so it stays the subject and the address
   * is written under it. For a while this test asserted the opposite, because
   * "non-media link" had been read as "a link we could get no file from".
   */
  it("makes a printed still of a page whose video is not a film", async () => {
    native.cardFor.set("https://www.youtube.com/watch?v=abc", {
      title: "The Wexford Interview",
      siteName: "YouTube",
      image: "https://i.ytimg.com/vi/abc/hq.jpg",
      media: null,
      aboutMedia: true,
    });

    await firePaste({ text: "https://www.youtube.com/watch?v=abc" });

    const made = itemsOnBoard()[0]!;
    expect(made.assetId).not.toBeNull();
    // The title and the address, under the picture. The address is the
    // load-bearing half: this object exists because the film could not be
    // brought onto the board, so it has to be legible and not merely stored.
    expect(made.text).toBe("The Wexford Interview\nhttps://www.youtube.com/watch?v=abc");
    // And still on the field, which is what actually gets opened (Q-305).
    expect(made.source).toBe("https://www.youtube.com/watch?v=abc");
    expect(made.sourceAbout).toBe("media");
    // Sized as a print of its still and not as a card: the shape is a fact
    // about the bytes, which is what a photograph is and a card is not.
    expect(made.w).not.toBe(CARD_UNITS.w);
  });

  it("makes a printed still of a track page too, not only a watch page", async () => {
    // The Spotify half of T-290's title. `og:audio` pointing at a player counts
    // exactly as `og:video` does — the rule is about the claim, not the property.
    native.cardFor.set("https://open.spotify.com/track/abc", {
      title: "Never Gonna Give You Up",
      siteName: "Spotify",
      image: "https://i.scdn.co/image/abc",
      media: null,
      aboutMedia: true,
    });

    await firePaste({ text: "https://open.spotify.com/track/abc" });

    const made = itemsOnBoard()[0]!;
    expect(made.sourceAbout).toBe("media");
    expect(made.text).toContain("https://open.spotify.com/track/abc");
  });

  it("keeps a page about itself a card, on the same picture", async () => {
    // The control, and the whole of the distinction: identical fixtures bar one
    // bit. An article's picture is a banner and becomes the card's paper; a
    // watch page's is a still of the film and stays the subject.
    native.cardFor.set("https://e.org/cork", {
      title: "Cork (material)",
      siteName: null,
      image: "https://e.org/banner.jpg",
      media: null,
      aboutMedia: false,
    });

    await firePaste({ text: "https://e.org/cork" });

    const made = itemsOnBoard()[0]!;
    expect(made.sourceAbout).toBe("page");
    expect(made.text).toBe("Cork (material)");
    expect(made.w).toBe(CARD_UNITS.w);
  });

  /**
   * T-339. A business card is 85 by 55 mm whatever picture is washed into it, so
   * the banner's own shape decides nothing — which is the whole difference
   * between an object *about* a page and a print of one.
   */
  it("cuts a link card to a business card and not to its banner", async () => {
    native.cardFor.set("https://e.com/thing", {
      title: "A thing",
      siteName: null,
      image: "https://e.com/banner.jpg",
      media: null,
    });

    await firePaste({ text: "https://e.com/thing" });

    const made = itemsOnBoard()[0]!;
    expect(made.w).toBe(CARD_UNITS.w);
    expect(made.h).toBe(CARD_UNITS.h);
    // And the banner really would have decided the shape, so this is not a
    // fixture agreeing with itself: the same 1200 by 800 pasted on its own is a
    // print of that shape.
    expect(polaroidFor(1200, 800).w).not.toBe(CARD_UNITS.w);
  });

  /**
   * T-290, Q-305. The address is in the caption too, and the caption is not
   * good enough to open: it is text the person can edit, so the link would be
   * destroyed by rewriting the words around it.
   */
  it("keeps the page it stands in for where editing cannot reach it", async () => {
    native.cardFor.set("https://www.youtube.com/watch?v=abc", {
      title: "The Wexford Interview",
      siteName: "YouTube",
      image: "https://i.ytimg.com/vi/abc/hq.jpg",
      media: null,
    });
    await firePaste({ text: "https://www.youtube.com/watch?v=abc" });

    const made = itemsOnBoard()[0]!;
    expect(made.source).toBe("https://www.youtube.com/watch?v=abc");
  });

  it("gives no source to a photograph that came from a clipboard", async () => {
    // Only an object standing in for something that could not be brought onto
    // the board has one. A picture somebody pasted IS the thing.
    await firePaste({ text: "https://example.com/a.png" });
    expect(itemsOnBoard()[0]!.source).toBeNull();
  });

  it("gives no source to the media a page handed over", async () => {
    // The recording is on the board. There is nothing it stands in for, and a
    // link back to the page it was listed on is a different idea from this one.
    native.cardFor.set("https://archive.org/details/wexford", {
      title: "The Wexford Tapes",
      siteName: "Internet Archive",
      image: "https://archive.org/services/img/wexford",
      media: { url: "https://archive.org/download/wexford/01.mp3", mime: "audio/mpeg" },
    });
    native.mimeFor.set("https://archive.org/download/wexford/01.mp3", "audio/mpeg");
    await firePaste({ text: "https://archive.org/details/wexford" });
    expect(itemsOnBoard()[0]!.source).toBeNull();
  });

  /**
   * T-339 turned this one round. It used to assert that an untitled page kept
   * its address in the text, because a caption was the only surface there was to
   * write on. A card has three lines and reads them off `source`, so an untitled
   * page leaves the text **empty** — the host takes the top line instead, and
   * the empty text is what makes clicking into the card an invitation to name
   * the thing yourself. Nothing is lost: the address is still on the item.
   */
  it("leaves the text empty when a page offers a picture and no title", async () => {
    native.cardFor.set("https://e.com/thing", {
      title: null,
      siteName: null,
      image: "https://e.com/thumb.jpg",
      media: null,
    });
    await firePaste({ text: "https://e.com/thing" });
    const made = itemsOnBoard()[0]!;
    expect(made.text).toBe("");
    expect(made.source).toBe("https://e.com/thing");
  });

  it("writes nothing under a photograph somebody pasted themselves", async () => {
    // A caption is the person's own hand (D-46). Only a printed still gets one
    // written for it, because only it has to say where it came from.
    await firePaste({ text: "https://example.com/a.png" });
    expect(itemsOnBoard()[0]!.text).toBe("");
  });

  /**
   * T-340, and the half of "cover links in general" that T-339 left open.
   *
   * This test used to assert the opposite — that a page with a title and no
   * picture came out as a note with the URL in it. That was the metadata being
   * thrown away because there was nothing to fetch, and most of the web is
   * exactly this page: a title, a site name, and no `og:image` at all.
   */
  it("makes a card of a page that has a title and no picture", async () => {
    native.cardFor.set("https://e.com/an-essay", {
      title: "An essay",
      siteName: null,
      image: null,
      media: null,
    });
    await firePaste({ text: "https://e.com/an-essay" });

    const made = itemsOnBoard()[0]!;
    // No bytes, and that is the whole state: `archetypeOf` reads a card off the
    // source alone, and the renderer draws one with no banner as blank stock.
    expect(made.assetId).toBeNull();
    expect(made.type).toBe("polaroid");
    expect(made.text).toBe("An essay");
    expect(made.source).toBe("https://e.com/an-essay");
    // The same object at the same size as one that *did* have a banner — a card
    // is 85 by 55 mm whatever is on it, and two sizes would make them two things.
    expect(made.w).toBe(CARD_UNITS.w);
    expect(made.h).toBe(CARD_UNITS.h);
  });

  it("makes a note of a page that says nothing at all", async () => {
    // The address on its own is a link somebody copied, not an object about
    // somewhere, and a note with the link in it is the honest answer. This is
    // what stops the card becoming the fallback for every URL on the web.
    native.cardFor.set("https://e.com/silent", {
      title: null,
      siteName: null,
      image: null,
      media: null,
    });
    await firePaste({ text: "https://e.com/silent" });

    const made = itemsOnBoard()[0]!;
    expect(made.type).toBe("note");
    expect(made.source).toBeNull();
    expect(made.text).toBe("https://e.com/silent");
  });

  it("still makes a card when the picture a page declared will not come", async () => {
    // Declared and then would not fetch. The card is the same object with blank
    // stock, which is a better answer than the note this used to fall back to —
    // the page told us what it was and the failure was ours.
    native.cardFor.set("https://e.com/broken", {
      title: "A page whose banner is gone",
      siteName: null,
      image: "https://e.com/404.jpg",
      media: null,
    });
    native.refuse.add("https://e.com/404.jpg");
    await firePaste({ text: "https://e.com/broken" });

    const made = itemsOnBoard()[0]!;
    expect(made.assetId).toBeNull();
    expect(made.text).toBe("A page whose banner is gone");
    expect(made.source).toBe("https://e.com/broken");
  });

  /**
   * T-343 — four addresses, one scrap of paper, and only some of them worth a
   * word.
   *
   * The note is right in every case here and none of these change it. What
   * changes is whether the person is told *why* they got a note, because "the
   * page is not there" and "the page had nothing to say" are the same silence
   * and different next moves.
   */
  describe("a link that would not load", () => {
    it("says a dead address is dead, in the shell's own words", async () => {
      native.refusal.set("https://github.com/PhilVon/Transiter", {
        holdsNowhere: false,
        say: "is not there — the address answered 404",
      });
      await firePaste({ text: "https://github.com/PhilVon/Transiter" });

      // The object is unchanged: the link somebody copied, on a note.
      const made = itemsOnBoard()[0]!;
      expect(made.type).toBe("note");
      expect(made.text).toBe("https://github.com/PhilVon/Transiter");
      // Never "nothing here can hold it" — that is a claim about the board, and
      // the board is holding the note in front of them.
      expect(said).toEqual(["github.com/PhilVon/Transiter is not there — the address answered 404"]);
    });

    it("says nothing about a page that loaded and had nothing to say", async () => {
      // The ordinary answer for most of the web, and the whole reason this is
      // not simply "say something whenever a link becomes a note": a line on
      // every pasted URL is the board narrating its own plumbing.
      native.cardFor.set("https://e.com/silent", {
        title: null,
        siteName: null,
        image: null,
        media: null,
      });
      await firePaste({ text: "https://e.com/silent" });

      expect(itemsOnBoard()[0]!.type).toBe("note");
      expect(said).toEqual([]);
    });

    it("says nothing when the rejection is not a sentence the shell wrote", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The browser build, where `pageCard` rejects with "needs the native
      // shell" for every address anybody pastes. A real answer to a different
      // question, and reading it out would put it on screen a hundred times a
      // session — which is what refusing to match on prose buys here.
      await firePaste({ text: "https://e.com/undescribed" });

      expect(itemsOnBoard()[0]!.type).toBe("note");
      expect(said).toEqual([]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("says why a media address gave nothing, the same as a page's", async () => {
      // The other half of the same paste. A `.mp3` URL goes to the store rather
      // than to the page reader, and its failure was just as silent — one road
      // in and the same scrap of paper out.
      native.refusal.set("https://e.com/talk.mp3", {
        holdsNowhere: false,
        say: "would not load",
      });
      await firePaste({ text: "https://e.com/talk.mp3" });

      expect(itemsOnBoard()[0]!.type).toBe("note");
      expect(said).toEqual(["e.com/talk.mp3 would not load"]);
    });

    it("stays quiet about a picture a page declared, because a card still lands", async () => {
      // Three of the four fetches in this file are for something the person did
      // not paste and did not ask about, and each already falls back to a weaker
      // *object* rather than to nothing. A sentence about an `og:image` next to
      // the card it failed to put a banner on is noise.
      native.cardFor.set("https://e.com/essay", {
        title: "An essay",
        siteName: null,
        image: "https://e.com/banner.jpg",
        media: null,
      });
      native.refusal.set("https://e.com/banner.jpg", {
        holdsNowhere: false,
        say: "is not there — the address answered 404",
      });
      await firePaste({ text: "https://e.com/essay" });

      expect(itemsOnBoard()[0]!.text).toBe("An essay");
      expect(said).toEqual([]);
    });

    it("cuts a long address in the middle, where a line that fades can hold it", async () => {
      // The front says which site and the back says which thing on it. Cutting
      // either end loses the half somebody is checking, and the flash is 46
      // characters wide with a forty-character sentence already in it.
      const long =
        "https://archive.example.org/collections/1978/interviews/transcripts/wexford-tuesday-train.html";
      native.refusal.set(long, { holdsNowhere: false, say: "would not load" });
      await firePaste({ text: long });

      expect(said).toEqual(["archive.example.org/co…day-train.html would not load"]);
      // And the note still has the whole address on it — this is a shortening
      // for one line that fades, not for the thing that stays on the board.
      expect(itemsOnBoard()[0]!.text).toBe(long);
    });
  });

  it("leaves a URL that is not a picture as a note", async () => {
    await firePaste({ text: "https://example.com/an-article" });
    // The page is *asked* now (T-289) and said nothing, which is the ordinary
    // answer. What matters is unchanged: nothing was ingested and the note is
    // the address somebody copied.
    expect(native.calls).toEqual([{ method: "card", arg: "https://example.com/an-article" }]);
    expect(itemsOnBoard()[0]!.type).toBe("note");
  });

  it("ignores a file the webview handed over with no bytes in it", async () => {
    // An OS offering a name rather than a file. Nothing to ingest, so it falls
    // through to the shell.
    native.nativeFiles = ["C:/photos/one.png"];
    await firePaste({ files: [imageFile(0)] });
    expect(native.calls).toEqual([{ method: "path", arg: "C:/photos/one.png" }]);
    expect(itemsOnBoard()[0]!.type).toBe("polaroid");
  });

  it("takes the shell's path rather than the webview's bytes, when it can name one", async () => {
    // The same file by two roads. The bytes cross the IPC boundary at about
    // 55 MiB/s and a path crosses nothing (T-266, D-51) — so a film is seconds
    // apart depending on which is taken, for identical work at the far end.
    native.nativeFiles = ["C:/photos/photo.png"];
    await firePaste({ files: [imageFile(4_000_000)] });
    expect(native.calls).toEqual([{ method: "path", arg: "C:/photos/photo.png" }]);
    expect(itemsOnBoard()).toHaveLength(1);
  });

  it("keeps the file's own bytes when the shell cannot name a path for it", async () => {
    // Dropped out of a browser, or any File with nothing behind it on disk.
    await firePaste({ files: [imageFile(2048)] });
    expect(native.calls).toEqual([{ method: "bytes", arg: { length: 2048, mime: "image/png" } }]);
  });

  it("does not ask the shell at all when the webview handed over no files", async () => {
    // The round trip is only worth it where a path can exist. A paste of
    // markup or text must not grow one.
    await firePaste({ text: "just some words" });
    expect(native.itemReads).toBe(0);
  });

  it("keeps the bytes when the shell's names do not line up with the webview's", async () => {
    // Two roads to what may not be the same place. Nothing promises the two
    // lists are in the same order, so an unmatched name simply keeps its bytes.
    native.nativeFiles = ["C:/elsewhere/other.png"];
    await firePaste({ files: [imageFile(2048, "image/png", "photo.png")] });
    expect(native.calls).toEqual([{ method: "bytes", arg: { length: 2048, mime: "image/png" } }]);
  });

  it("keeps the bytes when two of the shell's paths share one name", async () => {
    native.nativeFiles = ["C:/a/photo.png", "C:/b/photo.png"];
    await firePaste({ files: [imageFile(2048, "image/png", "photo.png")] });
    expect(native.calls[0]).toEqual({ method: "bytes", arg: { length: 2048, mime: "image/png" } });
  });

  it("falls back to the bytes when the path the shell named cannot be opened", async () => {
    // A virtual file out of an archive or a mail client: named on the clipboard
    // and not on the disk. The webview is still holding real bytes for it, so
    // this is a reason to take the slow road rather than to lose the file.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.nativeFiles = ["C:/inside-a-zip/photo.png"];
    native.refuse.add("C:/inside-a-zip/photo.png");
    await firePaste({ files: [imageFile(2048)] });
    expect(native.calls).toEqual([
      { method: "path", arg: "C:/inside-a-zip/photo.png" },
      { method: "bytes", arg: { length: 2048, mime: "image/png" } },
    ]);
    expect(itemsOnBoard()).toHaveLength(1);
    warn.mockRestore();
  });

  it("keeps the bytes when the shell cannot read the clipboard at all", async () => {
    native.clipboardThrows = true;
    await firePaste({ files: [imageFile(2048)] });
    expect(native.calls).toEqual([{ method: "bytes", arg: { length: 2048, mime: "image/png" } }]);
  });

  it("refuses one file once, however many routes can see it", async () => {
    // Both file routes now ask the shell the same question. Without the guard
    // the same zip is ingested twice and named twice — "Nothing here can hold
    // 2 of those — backup.zip, C:/backup.zip" — one file counted twice.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.nativeFiles = ["C:/backup.zip"];
    native.mimeFor.set("C:/backup.zip", "application/zip");
    await firePaste({ files: [imageFile(900, "application/zip", "backup.zip")] });
    expect(itemsOnBoard()).toEqual([]);
    expect(native.calls).toEqual([{ method: "path", arg: "C:/backup.zip" }]);
    expect(said).toEqual([
      "Nothing here can hold C:/backup.zip — it is not a picture, a film, a recording or a document",
    ]);
    warn.mockRestore();
  });

  it("ignores things that are not pictures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await firePaste({ files: [imageFile(900, "application/zip", "backup.zip")] });
    expect(itemsOnBoard()).toEqual([]);
    warn.mockRestore();
  });

  it("offers a file to the store even when its name told the webview nothing", async () => {
    // WebView2 fills File.type from the registry entry for the extension, which
    // is empty for .heic, for camera RAW, and for .webp on some installs.
    // Filtering on it before asking would drop those silently — while dragging
    // the identical file in worked, because the drop route asks the bytes.
    await firePaste({ files: [imageFile(4096, "", "IMG_0421.heic")] });
    expect(native.calls).toEqual([{ method: "bytes", arg: { length: 4096, mime: undefined } }]);
  });

  it("keeps the file's name as the asset's provenance", async () => {
    await firePaste({ files: [imageFile(2048, "image/png", "dune.png")] });
    const asset = [...board.assets.values()][0];
    // DATA-MODEL section 10. It exists for one moment and is gone afterwards.
    expect(asset?.get("origName")).toBe("dune.png");
    expect(asset?.get("mime")).toBe("image/png");
    expect(asset?.get("size")).toBe(2048);
    expect(asset?.get("w")).toBe(1200);
  });

  it("refuses bytes that merely claim to be a picture", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A hostile page copies `<img src="data:image/png;base64,<anything>">`.
    // The store falls back to the caller's mime hint when the magic numbers say
    // nothing, so the type alone would put arbitrary content on the board as a
    // polaroid of a blank square. Nothing decoded, so there are no dimensions.
    native.decodes = false;
    await firePaste({ html: '<img src="data:image/png;base64,aGVsbG8=">' });
    expect(itemsOnBoard()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("will not open as one"));
    warn.mockRestore();
  });

  it("keeps the prose when a copied paragraph happens to contain an image", async () => {
    // Copying from Wikipedia or an email body puts markup with an <img> on the
    // clipboard alongside the words. Taking the image route would make a
    // polaroid of a thirty-pixel formula and throw the paragraph away.
    await firePaste({
      html: '<p>Dunes migrate <img src="https://e.com/formula.png"> downwind.</p>',
      text: "Dunes migrate downwind.",
    });
    expect(native.calls).toEqual([]);
    expect(itemsOnBoard()[0]).toMatchObject({ type: "note", text: "Dunes migrate downwind." });
  });

  it("resolves a relative image source against the page it was copied from", async () => {
    // What "copy image" actually puts on the clipboard on a great many sites.
    // Without the SourceURL it names nothing, and the paste used to be dropped.
    native.sourceUrl = "https://example.com/gallery/index.html";
    await firePaste({ html: '<img src="../photos/1.jpg">' });
    expect(native.calls).toEqual([
      { method: "sourceUrl", arg: null },
      { method: "url", arg: "https://example.com/photos/1.jpg" },
    ]);
    expect(itemsOnBoard()[0]).toMatchObject({ type: "polaroid" });
  });

  it("drops it when the shell has no source URL to offer", async () => {
    // Every platform but Windows, today. It asks, gets nothing, and leaves the
    // board alone rather than resolving against our own origin.
    native.sourceUrl = null;
    await firePaste({ html: '<img src="/photos/1.jpg">' });
    expect(native.calls).toEqual([{ method: "sourceUrl", arg: null }]);
    expect(itemsOnBoard()).toEqual([]);
  });

  it("does not go asking when the markup already names a location", async () => {
    // The round trip is only worth it when there is otherwise nothing to fetch.
    await firePaste({ html: '<img src="https://example.com/a.png">' });
    expect(native.calls.some((c) => c.method === "sourceUrl")).toBe(false);
  });

  it("does nothing at all with an empty clipboard", async () => {
    await firePaste({});
    expect(itemsOnBoard()).toEqual([]);
    expect(created).toEqual([]);
  });

  it("leaves a paste into a text field to the text field", async () => {
    const input = document.createElement("input");
    document.body.append(input);
    const event = clipboard({ text: "typed into a note" });
    input.dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 0));
    expect(itemsOnBoard()).toEqual([]);
  });
});

describe("where it lands", () => {
  it("puts it under the cursor when the cursor is over the board", async () => {
    camera.centreOn(0, 0);
    cursor = { x: 900, y: 100 };
    const expected = camera.screenToBoard(900, 100);
    await firePaste({ text: "here" });
    expect(Math.abs(itemsOnBoard()[0]!.x - expected.x)).toBeLessThan(20);
  });

  it("puts it in the middle of the view when it is not", async () => {
    camera.centreOn(0, 0);
    cursor = null;
    await firePaste({ text: "there" });
    expect(Math.abs(itemsOnBoard()[0]!.x)).toBeLessThan(20);
  });

  it("takes a drop from the OS at the point it was dropped", async () => {
    camera.centreOn(0, 0);
    const expected = camera.screenToBoard(300, 400);
    native.drop(["C:/photos/dropped.png"], 300, 400);
    await vi.waitFor(() => expect(board.items.size).toBe(1));
    expect(Math.abs(itemsOnBoard()[0]!.x - expected.x)).toBeLessThan(20);
    expect(native.calls).toEqual([{ method: "path", arg: "C:/photos/dropped.png" }]);
  });
});

describe("a handful at once", () => {
  it("creates everything in one transaction, so one paste is one undo", async () => {
    await firePaste({ files: [imageFile(1), imageFile(2), imageFile(3), imageFile(4)] });
    expect(itemsOnBoard()).toHaveLength(4);
    // "one entry for the whole paste even when it creates twenty items".
    expect(transactions).toBe(1);
  });

  it("hands back what it made, so it can be picked straight up", async () => {
    await firePaste({ files: [imageFile(11), imageFile(22)] });
    expect(created).toHaveLength(2);
  });

  it("makes nothing of a file that turns out not to be a picture", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.nativeFiles = ["C:/accounts.xlsx"];
    native.mimeFor.set("C:/accounts.xlsx", "application/octet-stream");
    await firePaste({});
    // Judged on what the bytes turned out to be, not on the name — and a
    // polaroid of a spreadsheet is not a representation of anything.
    expect(itemsOnBoard()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a picture"));
    warn.mockRestore();
  });

  it("keeps going when one of a handful cannot be read", async () => {
    native.nativeFiles = ["C:/a.png", "C:/broken.png", "C:/c.png"];
    native.refuse.add("C:/broken.png");
    await firePaste({});
    expect(itemsOnBoard()).toHaveLength(2);
    // And says which one. Two of three arriving with no mention of the third
    // reads as a paste that only ever had two things in it.
    // A read that broke is not the board refusing anything, so it does not
    // claim to be: the file could not be read, and nothing is said about what
    // this board can hold.
    expect(said).toEqual(["C:/broken.png could not be read"]);
  });

  /** T-308, T-309. This used to be a console line and no more. */
  it("says why, in the shell's words, when a picture is refused for its pixels", async () => {
    // Only the shell can see this one: a small file and an enormous photograph.
    // It is also the refusal with no other road behind it — the file is refused
    // however it arrives — so the sentence is the whole of what the person gets.
    native.refusal.set("C:/enormous-scan.png", {
      holdsNowhere: true,
      say: "is 16000 × 16000, which is more picture than this board can open — the pixels rather than the size of the file",
    });
    native.drop(["C:/enormous-scan.png"], 0, 0);
    await settle();

    expect(itemsOnBoard()).toEqual([]);
    expect(said).toEqual([
      "Nothing here can hold C:/enormous-scan.png — it is 16000 × 16000, which is more picture than this board can open — the pixels rather than the size of the file",
    ]);
  });

  /** T-309, and the sentence the task was actually filed about. */
  it("offers the other road rather than claiming the board cannot hold it", async () => {
    // A 400 MB interview refused by the paste route is one drag away from
    // working. "Nothing here can hold it" would be a claim about the *board*,
    // and a false one — the kind that stops somebody trying the thing that
    // works. Only the shell knows which of the two this is, which is why the
    // answer crosses as data rather than as prose to match on.
    native.refusal.set("C:/interview.wav", {
      holdsNowhere: false,
      say: "is too big to hand over in one piece — drag it in from a window instead",
    });
    native.drop(["C:/interview.wav"], 0, 0);
    await settle();

    expect(itemsOnBoard()).toEqual([]);
    expect(said).toEqual([
      "C:/interview.wav is too big to hand over in one piece — drag it in from a window instead",
    ]);
  });

  it("says so rather than silently dropping half of a very large paste", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.nativeFiles = Array.from({ length: 80 }, (_, i) => `C:/photo-${i}.png`);
    await firePaste({});
    expect(itemsOnBoard()).toHaveLength(50);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("50 of 80"));
    // To the person and not only to a console nobody has open — T-295. The
    // comment on `MAX_PER_PASTE` promised this from the day it was written; for
    // that whole time a paste of eighty put down fifty and looked like a paste
    // of fifty that had worked.
    expect(said).toEqual(["Only the first 50 of 80 files — the rest stayed put"]);
    warn.mockRestore();
  });

  // --- T-295: a dropped folder is a fan of objects, and the gate says so ----

  it("drops a folder as one object per file, in a fan", async () => {
    // The shell walks the folder and hands over the files it holds, so this
    // side never sees a directory — `expand` in `clipboard.rs`. What arrives is
    // a list of paths, and what the board gets is one object each.
    native.mimeFor.set("C:/case/b.pdf", "application/pdf");
    native.drop(["C:/case/a.png", "C:/case/b.pdf"], 40, 60);
    await settle();
    const items = itemsOnBoard();
    expect(items).toHaveLength(2);
    // A fan and never a pile: two objects put down together are at different
    // places, which is `layout` and is what makes it read as a handful.
    expect(items[0]!.x).not.toBe(items[1]!.x);
    expect(said).toEqual([]);
  });

  it("says how many of a big folder went down, and how many it found", async () => {
    // The gate Phil asked for on Q-319. A folder of four hundred is the gesture
    // that made him ask, and the cap on its own is only half an answer: the
    // board would look as though it had put down what it was given.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.drop(
      Array.from({ length: 400 }, (_, i) => `C:/case/${i}.png`),
      40,
      60,
    );
    await settle();
    expect(itemsOnBoard()).toHaveLength(50);
    expect(said).toEqual(["Only the first 50 of 400 files — the rest stayed put"]);
    warn.mockRestore();
  });

  it("quotes what the drop named rather than what crossed the wire", async () => {
    // The shell bounds a folder before it serialises it (`DROP_MAX_PATHS`), so
    // `paths` is not the count the person is owed. Four thousand files arriving
    // as five hundred must still be told as four thousand — the alternative is
    // a number that is true of the plumbing and false of the gesture.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.drop(
      Array.from({ length: 60 }, (_, i) => `C:/case/${i}.png`),
      40,
      60,
      4000,
    );
    await settle();
    expect(said).toEqual(["Only the first 50 of 4000 files — the rest stayed put"]);
    warn.mockRestore();
  });

  it("says nothing about a ceiling when a folder is dropped a second time", async () => {
    // Every path has been tried, so `fresh` is empty for a reason that has
    // nothing to do with a limit. "Putting down 0 of 400" would be a notice
    // about a gate that did not bite, on a gesture that did nothing.
    native.drop(["C:/case/a.png"], 40, 60);
    await settle();
    expect(itemsOnBoard()).toHaveLength(1);
    said.length = 0;

    native.drop(["C:/case/a.png"], 40, 60);
    await settle();
    expect(itemsOnBoard()).toHaveLength(1);
    expect(said).toEqual([]);
  });

  it("says the ceiling and the refusals in one sentence, because the flash replaces", async () => {
    // `flash.say` writes over what is there rather than queueing, so two
    // sentences in one run means only the second is ever read. The ceiling goes
    // first because it is the larger fact about what happened.
    const paths = Array.from({ length: 60 }, (_, i) => `C:/case/${i}.png`);
    // The last twenty are something the board has no object for, so they are
    // refused — and the first fifty are what the ceiling lets through, which
    // makes ten of the refusals fall inside it.
    for (const path of paths.slice(40)) native.mimeFor.set(path, "application/x-blender");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.drop(paths, 40, 60);
    await settle();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Only the first 50 of 60 files");
    expect(said[0]).toContain("could not be held");
    warn.mockRestore();
  });
});

/**
 * A board written by a newer build — T-224, Q-170's "read-only and say so".
 *
 * Refused at the top of the handler rather than at the create, and this is the
 * test that says which: a URL paste is up to thirty seconds of network and a
 * file paste puts bytes into the content-addressed store. Both would be work
 * done for an item that is never going to exist, and the second leaves the
 * bytes behind on a board whose collector has also been stopped.
 */
/**
 * T-324, and it is the *drop* that decides where the fix belongs.
 *
 * The bug was that `Ctrl`+`X` reached the board behind a film covering the
 * screen: `ui/crt.ts` swallows keydowns, and a `cut` is a different event from
 * the key that caused it. The obvious repair - name the three clipboard keys at
 * the set - would have fixed exactly half of it, because a file dragged onto
 * the window arrives from the *shell* with no keydown anywhere in the story. So
 * the predicate is asked here, at the boundary that actually ingests.
 */
describe("while something is covering the board", () => {
  it("ingests nothing from the clipboard and creates nothing", async () => {
    covered = true;

    await firePaste({ files: [imageFile(2048)] });
    await firePaste({ text: "a sentence" });

    expect(native.calls).toEqual([]);
    expect(itemsOnBoard()).toEqual([]);
    expect(created).toEqual([]);
  });

  /** The route no keydown swallow could ever have stopped. */
  it("takes no file dropped in from the shell", async () => {
    covered = true;

    native.drop(["C:/holiday.png"], 100, 100);
    await settle();

    expect(native.calls).toEqual([]);
    expect(itemsOnBoard()).toEqual([]);
  });

  it("takes both again the moment the set comes off", async () => {
    covered = true;
    native.drop(["C:/holiday.png"], 100, 100);
    await settle();
    expect(itemsOnBoard()).toEqual([]);

    covered = false;
    native.drop(["C:/holiday.png"], 100, 100);
    await settle();
    expect(itemsOnBoard()).toHaveLength(1);
  });
});

describe("on a sealed board", () => {
  it("ingests nothing and creates nothing", async () => {
    sealBoard(board);

    await firePaste({ files: [imageFile(2048)] });
    await firePaste({ text: "a sentence" });

    expect(native.calls).toEqual([]);
    expect(itemsOnBoard()).toEqual([]);
    expect(created).toEqual([]);
  });

  /** And the drop route, which never touches the clipboard at all. */
  it("takes no file dropped in from the shell", async () => {
    sealBoard(board);

    native.drop(["C:/holiday.png"], 100, 100);
    await settle();

    expect(native.calls).toEqual([]);
    expect(itemsOnBoard()).toEqual([]);
  });
});

/**
 * T-260. The whole image-only gate was one branch in `accept`, and every route
 * on to the board funnels through it — the clipboard, the native clipboard, a
 * data URL, a remote fetch and an OS drop. So this is the door, and what it is
 * asked is what the board can hold.
 */
describe("what the board will take", () => {
  const named = (name: string, type: string, bytes = 2048): unknown => ({
    name,
    type,
    size: bytes,
    arrayBuffer: async () => new ArrayBuffer(bytes),
  });

  /** AC-649. Three files that used to be a `console.warn` and nothing else. */
  it("takes a case file, a film and a recording, not only a photograph", async () => {
    // Three different byte lengths, because the fake store hashes by length —
    // three files of one size would be one asset with three items on it, which
    // is correct content-addressing and would make this assert nothing.
    await firePaste({
      files: [
        named("filing.pdf", "application/pdf", 2048),
        named("interview.mp4", "video/mp4", 4096),
        named("tape.mp3", "audio/mpeg", 8192),
      ],
    });

    const items = itemsOnBoard();
    expect(items).toHaveLength(3);
    // No new item types, whatever the file was: the face is chosen from the
    // asset's mime at render time (D-46 section 2), and a type an older build
    // has never heard of would be invisible *and* uncollectable-from.
    expect(items.map((item) => item.type)).toEqual(["polaroid", "polaroid", "polaroid"]);
    expect(items.every((item) => item.assetId !== null)).toBe(true);

    // And the record says what each one is, which is what the face will read.
    const mimes = [...board.assets.values()].map((asset) => asset.get("mime"));
    expect(mimes.sort()).toEqual(["application/pdf", "audio/mpeg", "video/mp4"]);
  });

  it("carries the page count and the runtime into the record, and no title", async () => {
    // AC-668's other half. The record is what reaches a peer *ahead* of the
    // bytes, so a fact the shell measured at ingest and this line dropped is a
    // fact nobody else can ever recover — there is no second chance to count
    // the pages of a document that machine will never hold.
    await firePaste({
      files: [
        named("filing.pdf", "application/pdf", 2048),
        named("interview.mp4", "video/mp4", 4096),
      ],
    });

    const records = [...board.assets.values()];
    const folder = records.find((asset) => asset.get("mime") === "application/pdf")!;
    const tape = records.find((asset) => asset.get("mime") === "video/mp4")!;
    expect(folder.get("pages")).toBe(14);
    expect(tape.get("duration")).toBe(92);

    // And each one carries only what is a fact about it. A photograph does not
    // spend a null on the wire to say it has no runtime, and a film does not
    // spend one to say it has no pages.
    expect(folder.has("duration")).toBe(false);
    expect(tape.has("pages")).toBe(false);

    // Nor does either carry a title. What a document says it is called is
    // derived locally and never enters the document (Q-211); this asserts the
    // absence, because the whole of that answer is that the key is not there.
    expect(records.some((asset) => asset.has("title"))).toBe(false);
  });

  it("takes a text file as the other kind of case file", async () => {
    // Q-255. Until T-298 this was the sentence a dropped .txt got — "it is not
    // a picture, a film, a recording or a document" — and it was the gate in
    // front of half of D-46 section 1, because a text file has no magic number
    // for the sniffer to find.
    await firePaste({ files: [named("statement.txt", "text/plain", 4096)] });

    const items = itemsOnBoard();
    expect(items).toHaveLength(1);
    const record = [...board.assets.values()][0];
    expect(record.get("mime")).toBe("text/plain");
    // A thickness, from a rule rather than from a page tree, and it reaches a
    // peer the same way a PDF's does.
    expect(record.get("pages")).toBe(3);
    expect(record.has("duration")).toBe(false);
    expect(said).toEqual([]);
  });

  it("puts a case file on the board even though it has no pixel box", async () => {
    // The half that only works because of T-261. `readAsset` used to refuse any
    // record with no dimensions, so opening this gate before that landed would
    // have produced an item with an assetId pointing at a record that read as
    // absent — and absent from `readAsset` is absent from the keep set.
    await firePaste({ files: [named("filing.pdf", "application/pdf")] });
    const [item] = itemsOnBoard();
    expect(item?.assetId).not.toBeNull();
    expect(readAsset(item!.assetId!, board.assets.get(item!.assetId!)!)).not.toBeNull();
  });

  /**
   * AC-650. The gate reads the shell's answer, which is a sniff of the magic
   * numbers, and never the name. Both halves are asserted, because a gate that
   * happened to agree with the extension every time would pass either way.
   */
  it("decides from what the bytes turned out to be, not from what they are called", async () => {
    // Named as a picture, sniffed as a document: it is a document.
    native.mimeFor.set("C:/decoy.jpg", "application/pdf");
    // Named as nothing in particular, sniffed as a film: it is a film.
    native.mimeFor.set("C:/BLOB", "video/webm");
    native.drop(["C:/decoy.jpg", "C:/BLOB"], 0, 0);
    await settle();

    const mimes = [...board.assets.values()].map((asset) => asset.get("mime"));
    expect(mimes.sort()).toEqual(["application/pdf", "video/webm"]);
  });

  it("refuses a file whose bytes are nothing it knows, whatever it is called", async () => {
    native.mimeFor.set("C:/holiday.jpg", "application/x-msdownload");
    native.drop(["C:/holiday.jpg"], 0, 0);
    await settle();
    expect(itemsOnBoard()).toEqual([]);
  });

  /** AC-651. A file that lands nowhere and says nothing is the failure. */
  it("says so on the cork when it will not take something", async () => {
    native.mimeFor.set("C:/model.blend", "application/octet-stream");
    native.drop(["C:/model.blend"], 0, 0);
    await settle();

    expect(itemsOnBoard()).toEqual([]);
    // The whole sentence, not a fragment of it: "1 of those" is a real thing a
    // plural-only version would say, and it reads as a machine counting rather
    // than as somebody telling you what happened.
    expect(said).toEqual([
      "Nothing here can hold C:/model.blend — it is not a picture, a film, a recording or a document",
    ]);
  });

  it("says it once for a folder of them rather than once each", async () => {
    // Dragging a folder in is one gesture. Four lines about four files is four
    // times the punishment for it.
    for (const path of ["C:/a.blend", "C:/b.blend", "C:/c.blend"]) {
      native.mimeFor.set(path, "application/octet-stream");
    }
    native.drop(["C:/a.blend", "C:/b.blend", "C:/c.blend"], 0, 0);
    await settle();

    expect(said).toHaveLength(1);
    expect(said[0]).toContain("3 of those");
  });

  it("says nothing at all when everything was taken", async () => {
    await firePaste({ files: [named("filing.pdf", "application/pdf")] });
    expect(itemsOnBoard()).toHaveLength(1);
    expect(said).toEqual([]);
  });

  it("puts down what it can and mentions only what it could not", async () => {
    native.mimeFor.set("C:/good.pdf", "application/pdf");
    native.mimeFor.set("C:/bad.blend", "application/octet-stream");
    native.drop(["C:/good.pdf", "C:/bad.blend"], 0, 0);
    await settle();

    expect(itemsOnBoard()).toHaveLength(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("bad.blend");
    expect(said[0]).not.toContain("good.pdf");
  });

  it("does not carry a refusal over into the next paste", async () => {
    native.mimeFor.set("C:/bad.blend", "application/octet-stream");
    native.drop(["C:/bad.blend"], 0, 0);
    await settle();
    expect(said).toHaveLength(1);

    await firePaste({ files: [named("filing.pdf", "application/pdf")] });
    expect(said).toHaveLength(1);
  });

  /**
   * AC-652. The point of the gate being one function is that no route can grow
   * its own idea of what is allowed. These are the four ways bytes reach it.
   */
  it("is the same gate on every route in", async () => {
    // 1. The web clipboard's files.
    await firePaste({ files: [named("one.pdf", "application/pdf")] });
    // Neither recording has a transcript beside it, which is the ordinary case
    // and has to be said out loud to this fake: its disk holds every path it is
    // asked for, so without these the sidecar probe of T-287 finds one for each
    // and this counts two assets nobody put down.
    native.refuse.add("C:/two.srt");
    native.refuse.add("C:/two.vtt");
    native.refuse.add("C:/four.srt");
    native.refuse.add("C:/four.vtt");
    // 2. The native clipboard, which is what an Explorer copy comes back as.
    native.nativeFiles = ["C:/two.mp3"];
    native.mimeFor.set("C:/two.mp3", "audio/mpeg");
    await firePaste({});
    native.nativeFiles = [];
    // 3. A data URL in a copied fragment.
    await firePaste({ html: '<img src="data:image/png;base64,aGVsbG8=">' });
    // 4. An OS drop.
    native.mimeFor.set("C:/four.mkv", "video/x-matroska");
    native.drop(["C:/four.mkv"], 0, 0);
    await settle();

    const mimes = [...board.assets.values()].map((asset) => asset.get("mime"));
    expect(mimes.sort()).toEqual([
      "application/pdf",
      "audio/mpeg",
      "image/png",
      "video/x-matroska",
    ]);
  });
});

/**
 * The sidecar transcript — T-287, D-46 section 3: *"a sidecar `.srt` sitting
 * next to the media file is worth ingesting"*.
 *
 * All of it is about the two routes that have a filesystem path, because there
 * is no *beside* without one.
 */
describe("a transcript sitting next to a recording", () => {
  /** What the recording's record says its transcript is. */
  function transcriptOf(sha256: string): string | null {
    const map = board.assets.get(sha256);
    return map ? (readAsset(sha256, map)?.transcript ?? null) : null;
  }

  function assetOf(mime: string): string | undefined {
    for (const [sha, map] of board.assets) if (map.get("mime") === mime) return sha;
    return undefined;
  }

  /** A disk holding exactly the paths named, and nothing else. */
  function onlyOnDisk(...paths: string[]): void {
    for (const path of ["C:/interview.mp4", "C:/interview.srt", "C:/interview.vtt"]) {
      if (!paths.includes(path)) native.refuse.add(path);
    }
  }

  it("is ingested and named on the recording, without becoming a folder on the wall", async () => {
    onlyOnDisk("C:/interview.mp4", "C:/interview.srt");
    native.mimeFor.set("C:/interview.mp4", "video/mp4");
    native.mimeFor.set("C:/interview.srt", "text/plain");
    native.drop(["C:/interview.mp4"], 0, 0);
    await settle();

    // One item, and it is the tape. The transcript is a property of it rather
    // than a thing on the board — a `.srt` sniffs as text and text is a case
    // file (D-60), so without this it would arrive as a second manilla folder.
    const probed = native.calls.filter((c) => c.method === "path").map((c) => c.arg);
    expect(probed).toEqual(["C:/interview.mp4", "C:/interview.srt"]);
    expect(itemsOnBoard()).toHaveLength(1);
    const tape = assetOf("video/mp4")!;
    expect(transcriptOf(tape)).toBe(assetOf("text/plain"));
  });

  it("has a record of its own, so a peer can be asked for the bytes", async () => {
    onlyOnDisk("C:/interview.mp4", "C:/interview.srt");
    native.mimeFor.set("C:/interview.mp4", "video/mp4");
    native.mimeFor.set("C:/interview.srt", "text/plain");
    native.drop(["C:/interview.mp4"], 0, 0);
    await settle();

    // The half that is easy to leave out: a hash on the recording with no record
    // behind it names a file nothing can ask for and the sweep cannot keep.
    const words = transcriptOf(assetOf("video/mp4")!);
    expect(words).not.toBeNull();
    expect(board.assets.has(words!)).toBe(true);
  });

  it("falls back to the .vtt spelling", async () => {
    onlyOnDisk("C:/interview.mp4", "C:/interview.vtt");
    native.mimeFor.set("C:/interview.mp4", "video/mp4");
    native.mimeFor.set("C:/interview.vtt", "text/vtt");
    native.drop(["C:/interview.mp4"], 0, 0);
    await settle();

    expect(itemsOnBoard()).toHaveLength(1);
    expect(transcriptOf(assetOf("video/mp4")!)).toBe(assetOf("text/vtt"));
  });

  /**
   * The ordinary case — most recordings have no transcript — and the one that
   * would be loudest if it were wrong. A miss is not a file the person asked
   * for, so it must not reach `refuse` and be read out as something the board
   * could not hold.
   */
  it("says nothing at all when there is no transcript there", async () => {
    onlyOnDisk("C:/interview.mp4");
    native.mimeFor.set("C:/interview.mp4", "video/mp4");
    native.drop(["C:/interview.mp4"], 0, 0);
    await settle();

    expect(itemsOnBoard()).toHaveLength(1);
    expect(said).toEqual([]);
    expect(transcriptOf(assetOf("video/mp4")!)).toBeNull();
    expect(board.assets.size).toBe(1);
  });

  /**
   * The cost, asserted rather than assumed: every recording anybody drops pays
   * for this in disk probes, and nothing else should pay at all.
   */
  it("does not go looking beside a photograph or a document", async () => {
    native.mimeFor.set("C:/holiday.png", "image/png");
    native.mimeFor.set("C:/filing.pdf", "application/pdf");
    native.drop(["C:/holiday.png", "C:/filing.pdf"], 0, 0);
    await settle();

    const probed = native.calls.filter((call) => call.method === "path").map((call) => call.arg);
    expect(probed).toEqual(["C:/holiday.png", "C:/filing.pdf"]);
  });

  /** A transcript dropped on its own is a text file, and a text file is a case
   *  file (D-60). Nothing about T-287 changes that. */
  it("is still a document when it is the thing that was dropped", async () => {
    native.mimeFor.set("C:/interview.srt", "text/plain");
    native.drop(["C:/interview.srt"], 0, 0);
    await settle();

    expect(itemsOnBoard()).toHaveLength(1);
  });
});

/**
 * A markdown file says so on its own record — T-345, Q-324, D-65.
 *
 * **The one fact on an asset record that a filename decides**, so these tests
 * are as much about how narrowly that exception is drawn as about the flag
 * itself. The mime is still sniffed and still outranks the name; what the name
 * settles is how text the bytes already agreed was text should be read.
 */
describe("a web page dragged in from disk", () => {
  // D-66, Q-331. The sheet can set six things and a page is a layout, so an
  // `.html` file is the one format T-322 names that gets no reader at all.
  // What the bytes of one look like is asserted in Rust, where the sniffer
  // lives: this mock shell answers a *path* with a mime and never reads a file,
  // so a fixture here would only be agreeing with itself.

  it("is refused for being a page and not for being a drop", async () => {
    // The state this replaces, and why refusing is an improvement rather than a
    // removal: an html file is ASCII, so before D-66 the text arm claimed it and
    // it became a manilla case file whose page was set with its own tags. The
    // control is the text file beside it — same route, same gesture, and it
    // still lands — so what is being asserted is the mime and nothing else.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.mimeFor.set("C:/saved.html", "text/html");
    native.mimeFor.set("C:/notes.txt", "text/plain");
    native.drop(["C:/saved.html", "C:/notes.txt"], 0, 0);
    await settle();
    expect(itemsOnBoard().length).toBe(1);
    expect(said).toEqual([
      "Nothing here can hold C:/saved.html — it is a web page, and this board sets writing on paper rather than layouts",
    ]);
    warn.mockRestore();
  });

  it("does not touch html arriving on the clipboard", async () => {
    // AC-969, and the distinction that would be expensive to rediscover: a
    // browser puts html on the transfer as a *flavour* beside the plain text,
    // and it never goes near a mime or a store. T-97, T-290 and T-342 all read
    // it from there.
    await firePaste({ html: '<p>He came up from <b>Wexford</b>.</p>', text: "He came up from Wexford." });
    await settle();
    expect(itemsOnBoard().length).toBe(1);
  });
});

describe("a markdown file", () => {
  function markdownOf(sha256: string): boolean {
    const map = board.assets.get(sha256);
    return map ? (readAsset(sha256, map)?.markdown ?? false) : false;
  }

  function onlyAsset(): string {
    const [sha] = [...board.assets.keys()];
    return sha!;
  }

  it("is marked as one when its name says so and its bytes are text", async () => {
    native.mimeFor.set("C:/notes.md", "text/plain");
    native.drop(["C:/notes.md"], 0, 0);
    await settle();
    expect(markdownOf(onlyAsset())).toBe(true);
  });

  it("takes the longer spelling too, and does not care about case", async () => {
    // `.markdown` is what a handful of older tools still write, and a README
    // copied off a Windows share arrives shouting.
    for (const name of ["C:/a.markdown", "C:/B.MD"]) native.mimeFor.set(name, "text/plain");
    native.drop(["C:/a.markdown", "C:/B.MD"], 0, 0);
    await settle();
    expect([...board.assets.keys()].every(markdownOf)).toBe(true);
  });

  it("leaves an ordinary text file alone", async () => {
    // The measurement behind Q-324: a hash at the start of a line is a comment
    // in half the languages anybody might drop, so nothing is read as markdown
    // unless it said it was.
    native.mimeFor.set("C:/server.log", "text/plain");
    native.drop(["C:/server.log"], 0, 0);
    await settle();
    expect(markdownOf(onlyAsset())).toBe(false);
  });

  it("does not believe a name over the bytes", async () => {
    // AC-650 survives this exception intact. A file called `holiday.md` that
    // sniffs as a JPEG is a photograph, and a photograph is never read at all —
    // so the flag would be a name overruling the one gate that decides what
    // this board is holding.
    native.mimeFor.set("C:/holiday.md", "image/jpeg");
    native.drop(["C:/holiday.md"], 0, 0);
    await settle();
    expect(markdownOf(onlyAsset())).toBe(false);
    // **The raw key and not the read**, because there are two guards here and
    // this test is about the first one. `readAsset` refuses a markdown flag on
    // anything that is not text, so asserting the *read* passes even with the
    // gate's own check deleted — which is what a mutation showed, and is how a
    // test ends up proving somebody else's rule.
    expect(board.assets.get(onlyAsset())!.has("markdown")).toBe(false);
  });

  it("writes nothing at all for a file that is not markdown", async () => {
    // An absent key and a `false` read identically, so writing the `false`
    // would be a byte on the wire per asset to state the default — on a board
    // where all but a handful of documents are not markdown.
    native.mimeFor.set("C:/server.log", "text/plain");
    native.drop(["C:/server.log"], 0, 0);
    await settle();
    expect(board.assets.get(onlyAsset())!.has("markdown")).toBe(false);
  });

  it("refuses a markdown flag a peer wrote onto something that is not text", async () => {
    // The coercion in `readAsset`, not the gate. A later build that learns to
    // read some other format this way must not be able to make this one hand a
    // JPEG to a markdown parser by setting one key.
    native.drop(["C:/photo.png"], 0, 0);
    await settle();
    const sha = onlyAsset();
    board.assets.get(sha)!.set("markdown", true);
    expect(markdownOf(sha)).toBe(false);
  });
  it("tells the shell to read it as markdown before it counts the pages", async () => {
    // The count on the record is taken over the text the reader will paginate,
    // so the shell has to know the reading at ingest — not afterwards. Getting
    // this wrong draws a folder too thick and prints "1 of 3" at the head of a
    // two page file.
    native.mimeFor.set("C:/notes.md", "text/plain");
    native.mimeFor.set("C:/server.log", "text/plain");
    native.drop(["C:/notes.md", "C:/server.log"], 0, 0);
    await settle();
    expect(native.readAs.get("C:/notes.md")).toBe(true);
    expect(native.readAs.get("C:/server.log")).toBe(false);
  });
});
