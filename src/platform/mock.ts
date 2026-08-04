/**
 * The browser stand-in for the native side.
 *
 * Its purpose is the fast dev loop: the whole renderer, the whole simulation
 * and the whole document run in a plain browser tab with devtools open, and
 * nothing needs a Rust rebuild. It is not a second implementation of the
 * product — it is the smallest thing that keeps the frontend honest.
 *
 * What is genuinely real here, because faking it would let real bugs through:
 *
 *   - **Hashing.** Actual SHA-256 over the actual bytes, so content-addressing
 *     behaves — paste the same photograph twice and it costs nothing the
 *     second time, exactly as it will natively.
 *   - **Dimensions.** Decoded from the image, so an item is created at its
 *     true aspect ratio and nothing reflows later.
 *
 * What is honestly missing, and says so by throwing rather than by quietly
 * returning nothing: filesystem paths, URL fetching (the browser has a CORS
 * wall, which is one of the reasons this is a desktop app at all), the native
 * clipboard, bundles and sync.
 *
 * Assets live in memory for the session. The document does too. Reloading the
 * tab is a fresh board — which is the one place the mock will surprise you, so
 * it is stated here rather than discovered.
 */

import {
  CHUNK_BYTES,
  type AssetMeta,
  type AssetVariant,
  type BoardCard,
  type BoardOpened,
  type BoardPicked,
  type BundleWeighed,
  type BundleTidied,
  type BundleWritten,
  type ClipboardKind,
  type ClipboardManifest,
  type ClipboardPayload,
  type DocState,
  type DocumentPage,
  type ExportKind,
  type PageCard,
  type PageText,
  type Platform,
  type PlatformEvents,
  type SyncConfig,
  type SyncStatus,
  type Unlisten,
} from "@/platform/types";
import { EPUB } from "@/lib/objects";

/**
 * Always `await`ed by its callers rather than thrown directly, so an
 * unavailable capability arrives as a rejected promise. A Promise-returning
 * method that throws synchronously slips past every `.catch()` its caller
 * wrote and takes down the frame instead.
 */
function unavailable(what: string): Promise<never> {
  return Promise.reject(
    new Error(
      `${what} needs the native shell — run \`npm run tauri dev\` instead of \`npm run dev\`.`,
    ),
  );
}

/** Magic-number sniff. Enough for the formats a board can hold. */
/**
 * The magic numbers, as far as the browser dev loop needs them.
 *
 * **`assets.rs` is the real one** and this is deliberately the smaller list: it
 * exists so that the dev loop can put the four objects of D-46 on a board, not
 * so that two implementations of a sniffer have to agree. Anything that turns
 * on *which* film or *which* recording is Rust's, and is tested there.
 *
 * It grew past pictures with T-260. Before that a PDF read as
 * `application/octet-stream` here, which the ingest gate now refuses — so the
 * one feature this list is for would have been untestable in a browser without
 * it, and would have looked like a broken gate rather than a short sniffer.
 */
function readsAsText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 64);
  if (head.length === 0) return false;
  let text: string;
  try {
    // `stream` is what tolerates a multi-byte character the window cut in half:
    // it holds the incomplete tail back for a continuation that never comes,
    // rather than treating it as the file being malformed.
    text = new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
  } catch {
    return false;
  }
  return (
    text.length > 0 &&
    ![...text].some((ch) => ch.charCodeAt(0) < 0x20 && !"\t\n\r\f".includes(ch))
  );
}

function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (starts(bytes, "RIFF")) {
    if (at(bytes, 8, "WEBP")) return "image/webp";
    if (at(bytes, 8, "WAVE")) return "audio/wav";
    if (at(bytes, 8, "AVI ")) return "video/x-msvideo";
    return "application/octet-stream";
  }
  if (starts(bytes, "%PDF-")) return "application/pdf";
  // The `ftyp` box is second, not first, and the brand after it is what says
  // whether the identical container is a film or a song.
  if (at(bytes, 4, "ftyp")) {
    return at(bytes, 8, "M4A ") || at(bytes, 8, "M4B ") ? "audio/mp4" : "video/mp4";
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  if (starts(bytes, "OggS")) return "audio/ogg";
  if (starts(bytes, "fLaC")) return "audio/flac";
  if (starts(bytes, "ID3") || (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)) return "audio/mpeg";
  // Above the text arm rather than inside it, because an RTF is ASCII from end
  // to end and would otherwise come out of here as `text/plain` — a case file
  // whose page is set with its own control words on it (T-350).
  // The two containers (T-352). Only the epub half is mirrored honestly here,
  // because the epub half is the one that fits in a signature: OCF pins
  // `mimetype` to byte 30 and its content to byte 38. Telling a docx from a
  // xlsx needs the archive's index, and a test double that guessed at it would
  // be agreeing with itself rather than with `assets::zip_document` — so a
  // docx in a frontend test arrives the way every other mime does, from
  // `mimeFor` against a path.
  if (starts(bytes, "PK\x03\x04") && at(bytes, 30, "mimetype") && at(bytes, 38, EPUB)) {
    return EPUB;
  }
  if (starts(bytes, "{\\rtf")) return "text/rtf";
  // And a web page, named so that `assetKind` can refuse it (D-66). Same arm,
  // same place, same reason: an html file is ASCII and the text arm below would
  // otherwise call it a document.
  if (looksLikeHtml(bytes)) return "text/html";
  // Last, because text has no signature and the only honest form of the
  // question is what is left (Q-255). Mirrors `text::reads_as_text`: the same
  // window, the same three refusals, and the same tolerance for a character the
  // window cut in half.
  if (readsAsText(bytes)) return "text/plain";
  return "application/octet-stream";
}

function at(bytes: Uint8Array, offset: number, ascii: string): boolean {
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function starts(bytes: Uint8Array, ascii: string): boolean {
  return at(bytes, 0, ascii);
}

/**
 * Mirrors `assets::is_html`: a doctype or an opening `html`, `head` or `body`
 * tag, after a byte order mark and leading space and nothing else.
 *
 * Not "does it contain markup" — an SVG and an XML file both open with angle
 * brackets and neither is a web page.
 */
function looksLikeHtml(bytes: Uint8Array): boolean {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let from = bom ? 3 : 0;
  while (from < bytes.length && (bytes[from] ?? 0) <= 0x20) from += 1;
  const head = String.fromCharCode(...bytes.slice(from, from + 16)).toLowerCase();
  if (head.startsWith("<!doctype html")) return true;
  for (const name of ["<html", "<head", "<body"]) {
    if (!head.startsWith(name)) continue;
    const after = head.charCodeAt(name.length);
    // A tag and not a prefix: `<htmlish>` is not an `<html>`. `NaN` is the end
    // of the window, and a file that is exactly `<html` is one nobody has.
    return Number.isNaN(after) || after === 0x3e || after === 0x2f || after <= 0x20;
  }
  return false;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface StoredAsset {
  meta: AssetMeta;
  url: string;
  /**
   * Kept, where the shell keeps a file instead.
   *
   * The blob URL alone would be enough to *show* an asset, and was, until this
   * machine had to be able to *serve* one: a peer asking for a chunk is asking
   * for bytes, and reading them back out of a blob URL is a fetch. Holding the
   * original doubles the mock's memory for a board of photographs, which is a
   * fair price for the browser dev loop being able to exercise a transfer at
   * all — under Tauri this is a file on disk and costs nothing.
   */
  bytes: Uint8Array;
}

/** A transfer in progress: the chunks so far, and how many are expected. */
interface Partial {
  total: number;
  chunks: (Uint8Array | undefined)[];
}

export class MockPlatform implements Platform {
  readonly kind = "mock" as const;

  /** A browser prints its own page and cannot write a file, and every export
   *  row is already gone with the shell. False so nothing has to ask twice. */
  readonly canPrintPdf = false;

  private readonly assets = new Map<string, StoredAsset>();
  private readonly partials = new Map<string, Partial>();
  private readonly updates: Uint8Array[] = [];
  private snapshot: Uint8Array | null = null;
  private readonly bus = new EventTarget();

  async assetIngestBytes(bytes: Uint8Array, mime?: string): Promise<AssetMeta> {
    const sha256 = await sha256Hex(bytes);
    const existing = this.assets.get(sha256);
    if (existing) return existing.meta;

    const type = mime ?? sniffMime(bytes);
    const blob = new Blob([bytes as unknown as BlobPart], { type });

    let w = 0;
    let h = 0;
    if (type.startsWith("image/")) {
      try {
        const bitmap = await createImageBitmap(blob);
        w = bitmap.width;
        h = bitmap.height;
        bitmap.close();
      } catch {
        // Bytes that will not decode are not an image. Zero dimensions are a
        // state the item already renders (DESIGN section 7.5) — far better
        // than a rejected paste, which would violate "nothing blocks
        // thinking" over a file the user cannot do anything about.
      }
    }

    // No duration here, and it is a real difference from the shell rather than
    // an oversight (T-300). Reading one in the browser means attaching the
    // blob to a media element and waiting for `loadedmetadata` — an event that
    // never arrives under a test DOM, so the mock would either hang or invent a
    // timeout. `null` is the honest answer for a platform that did not measure
    // it, and it is the same `null` a container the shell cannot read produces.
    //
    // And no page count, which is the same answer for a harder reason: counting
    // a PDF's pages means parsing its cross-reference table, and the shapes that
    // could be faked without one — a `/Count` scraped out of the bytes, a tally
    // of `/Type /Page` — are both defeated by object streams, which is most
    // files. A folder in the browser showing no thickness is a platform that did
    // not measure it; a folder showing `0 pp.` would be one that measured wrong,
    // and this record is the thing that reaches a peer.
    //
    // A text file could be counted here — its pagination is a rule rather than a
    // parse (T-298) — and is deliberately not. The rule would then have two
    // implementations in two languages, and every stored page reference would
    // depend on which of them ingested the file. One writer, in `text.rs`.
    const meta: AssetMeta = {
      sha256,
      w,
      h,
      mime: type,
      size: bytes.byteLength,
      duration: null,
      pages: null,
    };
    this.assets.set(sha256, { meta, url: URL.createObjectURL(blob), bytes });
    // Natively this arrives once the variants are generated; here the bytes
    // are already resolved, so it fires on the next turn to keep the same
    // ordering guarantees callers will get in the shell.
    queueMicrotask(() => this.emit("asset:ready", { sha256 }));
    return meta;
  }

  assetIngestPath(): Promise<AssetMeta> {
    return unavailable("Reading a file path");
  }

  assetIngestUrl(): Promise<AssetMeta> {
    // Deliberately not a `fetch`: it would work for a handful of permissive
    // hosts and fail for most, which is worse than failing consistently.
    return unavailable("Fetching a URL without a CORS wall");
  }

  openLink(url: string): Promise<void> {
    // A browser can do this one perfectly well, and it is the one thing in this
    // file that has a real answer rather than a refusal.
    window.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve();
  }

  pageCard(): Promise<PageCard> {
    // For `assetIngestUrl`'s reason twice over: reading a page needs the fetch
    // that has no CORS wall, and the SSRF rules that make one safe live in
    // Rust. A browser build makes the note instead, which is what it made
    // before any of this existed.
    return unavailable("Reading what a page says it is");
  }

  async assetHas(hashes: string[]): Promise<boolean[]> {
    return hashes.map((hash) => this.assets.has(hash));
  }

  /**
   * Not faked with an `<a download>`, tempting as that is. A browser download
   * cannot report whether the user kept the file, so the mock would have to
   * resolve `true` and be wrong every time someone cancelled — and `true` versus
   * `false` is the entire return value of this call. Missing and saying so beats
   * lying about the one thing it says.
   */
  assetExport(): Promise<boolean> {
    return unavailable("Exporting an asset to disk");
  }

  async assetGc(keep: string[]): Promise<{ freedBytes: number }> {
    const kept = new Set(keep);
    let freedBytes = 0;
    for (const [hash, asset] of this.assets) {
      if (kept.has(hash)) continue;
      freedBytes += asset.meta.size;
      URL.revokeObjectURL(asset.url);
      this.assets.delete(hash);
    }
    return { freedBytes };
  }

  assetUrl(sha256: string, _variant: AssetVariant = "display"): string {
    // One blob per asset — the mock has no variants, and a display-size
    // downscale would only hide how expensive the real thing is.
    return this.assets.get(sha256)?.url ?? "";
  }

  /**
   * Nothing, for the reason the page count above is nothing: reading a `/Title`
   * means walking a cross-reference table and reading a film's means parsing its
   * container, and there is no parser for either on this side of the line.
   *
   * `null` is a state every one of the three objects already draws — it is the
   * same `null` a machine that does not hold the bytes gets, which under Q-211's
   * answer is an ordinary and expected condition rather than a fault. So the
   * browser dev loop shows a case number and no title, which is a real state of
   * the real application and not a mock-shaped hole. D-52 measured it as the
   * usual state for video besides.
   */
  async assetTitle(_sha256: string): Promise<string | null> {
    return null;
  }

  /**
   * Reading a page is missing here, and it is the same refusal `assetIngestBytes`
   * already writes down about the page *count* — carried through to the pages
   * themselves rather than reasoned about again.
   *
   * A PDF cannot be parsed in the browser without the megabyte of dependency
   * D-46 section 4 exists to refuse. A text file *could* be paginated here,
   * because its pagination is a rule rather than a parse — and that is exactly
   * why it is not: the rule would then have two implementations in two
   * languages, and a stored page reference would depend on which of them read
   * the file. One writer, in `text.rs`.
   *
   * So `npm run dev` opens a case file and is told the page cannot be read,
   * which is the same state a malformed PDF produces in the shell and therefore
   * a path the reading surface has to draw anyway. Developing the surface itself
   * wants `npm run tauri dev`.
   */
  documentPageCount(_sha256: string, _markdown?: boolean): Promise<number> {
    return unavailable("Counting the pages of a document");
  }

  documentPage(_sha256: string, _index: number, _markdown?: boolean): Promise<DocumentPage | null> {
    return unavailable("Reading a page of a document");
  }

  documentPageImage(
    _sha256: string,
    _index: number,
    _figure?: number,
    _markdown?: boolean,
  ): Promise<Uint8Array> {
    return unavailable("Lifting the image off a scanned page");
  }

  /**
   * Refused on the same argument, and it is the same argument twice over: the
   * parse is not available here, and the text a search matches has to be the
   * text `document::joined` produced or two boards would find different things
   * in the same file.
   */
  documentText(_sha256: string, _markdown?: boolean): Promise<readonly PageText[]> {
    return unavailable("Reading the text of a document");
  }

  /** Nothing is held open, so there is nothing to let go of. */
  async documentClose(_sha256: string): Promise<void> {}

  async docAppendUpdate(bytes: Uint8Array): Promise<void> {
    this.updates.push(bytes);
  }

  async docLoad(): Promise<DocState> {
    return { snapshot: this.snapshot, updates: [...this.updates] };
  }

  async docCompact(snapshot: Uint8Array): Promise<void> {
    this.snapshot = snapshot;
    this.updates.length = 0;
  }

  /**
   * Missing for the same reason `assetExport` is, and rather more so. A browser
   * could be talked into producing the zip — the document and the photographs
   * are both reachable from here — and it still could not report whether the
   * user kept the file, which is the difference between `null` and a written
   * bundle. And on the way back in there is no picker to read a `.schizo` with
   * at all.
   */
  bundleSaveAs(): Promise<BundleWritten | null> {
    return unavailable("Exporting a board");
  }

  bundleWeigh(): Promise<BundleWeighed> {
    // Weighing is the store's own directory, and a browser build has no store.
    return unavailable("Weighing a board");
  }

  // --- boards (T-356) -----------------------------------------------------
  //
  // A board is a file, and this platform has no files. So the two *readers*
  // answer honestly — a browser tab knows about no boards and is on none of
  // them — and everything that would touch the disk refuses out loud.
  //
  // `boardCurrent` returning `null` is not the same as saying there is no
  // document: there is one, in memory, and `docLoad` serves it. What there is
  // not is a board *file*, which is the only thing this shape describes.

  async boardList(): Promise<BoardCard[]> {
    return [];
  }

  async boardCurrent(): Promise<BoardCard | null> {
    return null;
  }

  boardOpenPicked(): Promise<BoardPicked | null> {
    return unavailable("Opening a board");
  }

  boardOpen(): Promise<BoardOpened> {
    return unavailable("Opening a board");
  }

  boardNew(): Promise<BoardCard> {
    return unavailable("Starting a new board");
  }

  boardFlush(): Promise<BundleWritten | null> {
    return unavailable("Saving a board");
  }

  boardHome(): Promise<BundleWritten> {
    return unavailable("Giving a board a home");
  }

  boardCompact(): Promise<BundleTidied | null> {
    return unavailable("Tidying a board's file");
  }

  boardCompactOnLeaving(): Promise<BundleWritten | null> {
    return unavailable("Tidying a board's file");
  }

  // A board is not a file here, so there is never anything to tidy — and this
  // one answers rather than refusing, because its caller is a menu row deciding
  // whether to exist, and a throw would be a row that never appears for a
  // reason that has nothing to do with the board.
  async boardWorthTidying(): Promise<boolean> {
    return false;
  }

  // And nothing for a workshop to be ahead of, for the same reason. Answers
  // rather than refusing on the same standing as the row above: its caller runs
  // at every boot, and a throw here would put an error in the console of every
  // browser session about a file that does not exist.
  async boardWorkshopAhead(): Promise<boolean> {
    return false;
  }

  /**
   * The name the next image export will be offered under.
   *
   * A browser has no save dialog to hold a *path* in, so this holds the only
   * part of the answer a download can use. The native pair keeps the path on
   * the shell's side for a security reason (ARCHITECTURE section 4.4); here
   * there is no path at all, which satisfies the same rule for free.
   */
  private exportName = "board.png";

  /**
   * A browser cannot do the PDF, and can do the image.
   *
   * The two are not the same question. A PDF here would have to be
   * `window.print()`, which opens a dialog, never says what came of it — losing
   * the difference between a saved file and a cancelled one — and hands the page
   * size to whoever is standing at the printer chooser, where the whole point of
   * T-205 is that the page is the shape of the board. Q-128 turned that route
   * down for the shell and it is no better here.
   *
   * An image has none of those problems: the picture is composited in the
   * renderer either way, so a browser needs nothing but somewhere to put the
   * bytes, and `<a download>` is somewhere.
   *
   * True without asking anybody, and that is the one honest difference from the
   * shell: a browser download has no cancel to report. Nobody is asked where
   * the file goes, so nobody can decline.
   */
  async exportChoose(title: string, kind: ExportKind): Promise<string | null> {
    if (kind !== "image") return unavailable("Exporting a board as a PDF");
    const stem = title.replace(/[^\p{L}\p{N} _.-]/gu, "").trim() || "board";
    // PNG, and no way to ask for anything else: a browser download has no
    // dialog to hang a format filter off, and inventing one in the page would
    // be a picker the shell does not have.
    this.exportName = `${stem}.png`;
    return "png";
  }

  exportPdfWrite(): Promise<string> {
    return unavailable("Exporting a board as a PDF");
  }

  /**
   * Hand the bytes to the browser as a download.
   *
   * The object URL is revoked on the next turn rather than immediately: a
   * revoke in the same task can beat the navigation the click starts, and what
   * that looks like is a download that silently does not happen.
   */
  async exportImageWrite(bytes: Uint8Array): Promise<string> {
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = this.exportName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return this.exportName;
  }

  async clipboardReadManifest(): Promise<ClipboardManifest> {
    // The web `paste` event is the fast path and handles inline images and
    // text on its own (ARCHITECTURE section 4.5). The native fallback exists
    // for file copies and reliable source URLs, and there is no browser
    // equivalent — so the honest answer is "nothing extra here".
    return { kinds: [] };
  }

  async clipboardReadItem(_kind: ClipboardKind): Promise<ClipboardPayload | null> {
    return null;
  }

  /** No browser exposes it — that is the whole reason it is a shell call. */
  async clipboardSourceUrl(): Promise<string | null> {
    return null;
  }

  syncStart(_config: SyncConfig): Promise<void> {
    return unavailable("Sync");
  }

  async syncStop(): Promise<void> {}

  async syncStatus(): Promise<SyncStatus> {
    return { connected: false, peers: [], mode: null, url: null, secret: null };
  }

  /**
   * Never. A browser has no `schizo://` handler and nothing registered one —
   * `?secret=` on the address bar is how a board is joined here, and is what the
   * invite link exists to replace everywhere an address bar does not exist.
   */
  async syncTakeInvite(): Promise<string | null> {
    return null;
  }

  /**
   * Implemented rather than refused, because the *reader* runs on every boot —
   * including in a plain browser — and a boot that threw on the way to deciding
   * which board to open would be a board that does not open.
   *
   * Always `null`, and since T-356 that is the only answer it could give: a room
   * is remembered against a board *file*, this platform has none, and nothing on
   * this side can set one any more. `?board=` on the address bar is how a
   * browser tab is put in a particular room, which `planSync` reads first.
   */
  async rememberedBoardId(): Promise<string | null> {
    return null;
  }

  // --- asset transfer -----------------------------------------------------
  //
  // Implemented rather than stubbed, and it is the one part of the mock that
  // earns its keep beyond "the frontend runs in a plain browser": two browser
  // windows on `?relay=` are how multiplayer is actually driven (T-72, T-151),
  // so a no-op here would mean the transfer could not be watched happening
  // until somebody built the Rust half and launched two shells. The chunking
  // and the hash check are real; only the store underneath them is a Map.

  async peerHaveSummary(): Promise<string[]> {
    return [...this.assets.keys()];
  }

  async assetSize(sha256: string): Promise<number> {
    return this.assets.get(sha256)?.meta.size ?? 0;
  }

  /**
   * The dense prefix, counted the long way round.
   *
   * Rust asks the filesystem for a length and gets this for nothing, because it
   * writes chunks at offsets into one file. This side keeps an array of chunks
   * and so has to walk it — and walking it *stopping at the first gap* is the
   * point rather than an inconvenience: it is the same number under both
   * implementations, including when a chunk is missing from the middle, which
   * is the case the two would otherwise disagree about.
   */
  async assetPartial(sha256: string): Promise<number> {
    const partial = this.partials.get(sha256);
    if (partial === undefined) return 0;
    let bytes = 0;
    for (const chunk of partial.chunks) {
      if (chunk === undefined) break;
      bytes += chunk.length;
    }
    return bytes;
  }

  async assetChunk(sha256: string, index: number): Promise<Uint8Array> {
    const asset = this.assets.get(sha256);
    if (asset === undefined) return new Uint8Array(0);
    const at = index * CHUNK_BYTES;
    return asset.bytes.subarray(at, Math.min(at + CHUNK_BYTES, asset.bytes.length));
  }

  async assetReceive(
    sha256: string,
    index: number,
    total: number,
    bytes: Uint8Array,
  ): Promise<void> {
    let partial = this.partials.get(sha256);
    if (partial === undefined || partial.total !== total) {
      partial = { total, chunks: new Array<Uint8Array | undefined>(total) };
      this.partials.set(sha256, partial);
    }
    if (index < total) partial.chunks[index] = bytes.slice();
  }

  /**
   * Hash what arrived before believing any of it.
   *
   * A missing chunk and a corrupted one are the same answer — `false`, and the
   * partial thrown away — because both mean the bytes are not the asset that
   * was asked for, and there is nothing to be gained by telling them apart.
   */
  async assetCommit(sha256: string): Promise<boolean> {
    const partial = this.partials.get(sha256);
    this.partials.delete(sha256);
    if (partial === undefined || partial.chunks.some((chunk) => chunk === undefined)) return false;

    const size = partial.chunks.reduce((n, chunk) => n + (chunk?.length ?? 0), 0);
    const whole = new Uint8Array(size);
    let at = 0;
    for (const chunk of partial.chunks) {
      if (chunk === undefined) return false;
      whole.set(chunk, at);
      at += chunk.length;
    }
    if ((await sha256Hex(whole)) !== sha256) return false;

    // Through ingestion rather than straight into the map, so that a received
    // asset and a pasted one land by exactly the same path — dimensions, mime
    // and the `asset:ready` that makes the item show all come out of it.
    await this.assetIngestBytes(whole);
    return true;
  }

  async assetAbort(sha256: string): Promise<void> {
    this.partials.delete(sha256);
  }

  async on<K extends keyof PlatformEvents>(
    event: K,
    handler: (payload: PlatformEvents[K]) => void,
  ): Promise<Unlisten> {
    const wrapped = (e: Event): void => handler((e as CustomEvent<PlatformEvents[K]>).detail);
    this.bus.addEventListener(event, wrapped);
    return () => this.bus.removeEventListener(event, wrapped);
  }

  /** Test and dev hook — lets a browser session drive the Rust-side events. */
  emit<K extends keyof PlatformEvents>(event: K, payload: PlatformEvents[K]): void {
    this.bus.dispatchEvent(new CustomEvent(event, { detail: payload }));
  }
}
