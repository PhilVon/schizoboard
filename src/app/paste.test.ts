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
  Platform,
  PlatformEvents,
  Refusal,
} from "@/platform/types";
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

  async assetIngestBytes(bytes: Uint8Array, mime?: string): Promise<AssetMeta> {
    this.calls.push({ method: "bytes", arg: { length: bytes.length, mime } });
    return this.meta(`b${bytes.length}`, mime, bytes.length);
  }
  async assetIngestPath(path: string): Promise<AssetMeta> {
    this.calls.push({ method: "path", arg: path });
    const refusal = this.refusal.get(path);
    if (refusal) throw refusal;
    if (this.refuse.has(path)) throw new Error("no such file");
    return this.meta(`p${path}`, this.mimeFor.get(path));
  }
  async assetIngestUrl(url: string): Promise<AssetMeta> {
    this.calls.push({ method: "url", arg: url });
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
  drop(paths: string[], x: number, y: number): void {
    this.handler?.({ paths, x, y });
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
function itemsOnBoard(): { type: string; assetId: string | null; text: string; x: number }[] {
  const out = [];
  for (const [id, map] of board.items) {
    const fields = readItem(id, map);
    if (!fields) continue;
    const text = map.get("text");
    out.push({
      type: fields.type,
      assetId: fields.assetId,
      text: String(text ?? ""),
      x: fields.x,
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
    expect(native.calls).toEqual([]);
    expect(itemsOnBoard()[0]!.type).toBe("note");
  });

  it("never fetches a page, whatever it is called", async () => {
    // Q-265 cut `html` from the extractors for this reason: the shell has no
    // signature for markup, so it falls back to text/plain, which `assetKind`
    // calls a document. A fetched page would open as angle brackets set in the
    // board's own hand.
    await firePaste({ text: "https://example.com/report.html" });
    expect(native.calls).toEqual([]);
    expect(itemsOnBoard()[0]!.type).toBe("note");
  });

  it("leaves a URL that is not a picture as a note", async () => {
    await firePaste({ text: "https://example.com/an-article" });
    expect(native.calls).toEqual([]);
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
