/**
 * @vitest-environment happy-dom
 *
 * The order in which paste makes up its mind, which is the whole of the
 * feature. `lib/ingest.test.ts` covers what each payload becomes; this covers
 * which payload wins, and that the document sees one transaction rather than
 * one per photograph.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialiseBoard, openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { readItem } from "@/crdt/schema";
import { Paste } from "@/app/paste";
import type { AssetMeta, ClipboardPayload, Platform, PlatformEvents } from "@/platform/types";
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
  /** What the bytes behind a path turn out to be. */
  readonly mimeFor = new Map<string, string>();
  nativeFiles: string[] = [];
  private handler: ((payload: PlatformEvents["files:dropped"]) => void) | null = null;

  /**
   * Models the store: the mime is sniffed from the bytes and falls back to the
   * caller's hint, and dimensions stay at zero when nothing decoded.
   */
  private meta(seed: string, mime = "image/png", size = 1): AssetMeta {
    const decoded = mime.startsWith("image/") && this.decodes;
    return {
      sha256: seed.padEnd(64, "0").slice(0, 64),
      w: decoded ? 1200 : 0,
      h: decoded ? 800 : 0,
      mime,
      size,
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
    if (this.refuse.has(path)) throw new Error("no such file");
    return this.meta(`p${path.length}`, this.mimeFor.get(path));
  }
  async assetIngestUrl(url: string): Promise<AssetMeta> {
    this.calls.push({ method: "url", arg: url });
    if (this.refuse.has(url)) throw new Error("could not fetch");
    return this.meta(`u${url.length}`);
  }
  async clipboardReadManifest(): Promise<{ kinds: ("files" | "text")[] }> {
    return { kinds: this.nativeFiles.length > 0 ? ["files"] : [] };
  }
  async clipboardReadItem(): Promise<ClipboardPayload | null> {
    return this.nativeFiles.length > 0 ? { kind: "files", paths: this.nativeFiles } : null;
  }
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

let board: BoardDoc;
let native: FakeNative;
let camera: Camera;
let paste: Paste;
let cursor: { x: number; y: number } | null;
let created: string[];
let transactions: number;

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
  paste = new Paste({
    native: native as unknown as Platform,
    board,
    camera,
    cursor: () => cursor,
    onCreated: (ids) => created.push(...ids),
  });
  await paste.attach();
});

// Paste listens on `window`, so an instance left attached goes on answering
// every later test's events — with its own board and its own stale fake behind
// it, which shows up as counts that make no sense.
afterEach(() => paste.destroy());

describe("what wins", () => {
  it("makes a polaroid of image bytes on the clipboard", async () => {
    await firePaste({ files: [imageFile(2048)] });
    const items = itemsOnBoard();
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("polaroid");
    expect(items[0]!.assetId).toMatch(/^b2048/);
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a picture"));
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
