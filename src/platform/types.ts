/**
 * The native boundary, as types.
 *
 * This is the whole IPC surface from docs/ARCHITECTURE.md section 4.4. It is
 * written down in one place, in the frontend's language, so that:
 *
 *   - `platform/tauri.ts` is the only file in the codebase containing an
 *     `invoke()`, and
 *   - `platform/mock.ts` can satisfy the same contract in a plain browser,
 *     which is what keeps the fast dev loop fast.
 *
 * The split it encodes (section 4.2): **Rust owns bytes, the frontend owns
 * meaning.** Nothing schema-shaped crosses this boundary — no items, no pins,
 * no strings. Rust sees hashes, opaque document frames and file paths.
 */

export type AssetVariant = "thumb" | "display" | "original";

/**
 * Longest edge of each generated variant, in pixels.
 *
 * Mirrors `THUMB_MAX_EDGE` and `DISPLAY_MAX_EDGE` in `src-tauri/src/assets.rs`,
 * which is a duplicated constant and cannot not be: the store decides what it
 * generates and the renderer decides what to ask for, and they are in different
 * languages. `original` is whatever was pasted, so it has no bound.
 *
 * These exist so a caller can pick a variant by the size an image will actually
 * be drawn at. Getting that wrong is expensive in a way that is easy to miss: an
 * `<img>` decodes at first paint, so pointing a 16-pixel-wide item at a 2560px
 * photograph pays for the whole decode to throw almost all of it away. D-15
 * measured that cost arriving as a 243 ms frame.
 */
export const VARIANT_MAX_EDGE: Record<AssetVariant, number> = {
  thumb: 256,
  display: 2560,
  original: Number.POSITIVE_INFINITY,
};

/**
 * Which stored variant serves an image about to be drawn `screenPx` across, in
 * device pixels.
 *
 * Here rather than in `app/main.ts` for one reason: `main.ts` is the wiring
 * module and nothing tests it, so a decision left there is a decision nothing
 * checks. The renderer supplies the size and this supplies the answer.
 *
 * `original` is never chosen. It is the untouched paste, kept for export (T-94),
 * and `display` is capped at 2560px — which `DISPLAY_MAX_EDGE` derives from the
 * 400% zoom ceiling on a 2x display, so nothing on screen can out-resolve it.
 *
 * The thumbnail is chosen only when a positive, finite size *establishes* that it
 * is enough. Everything else — zero, negative, NaN, infinite — falls through to
 * `display`, which is wrong in the direction that costs pixels rather than the
 * one that loses them: a thumbnail stretched across a 400% item is visibly
 * broken, a display variant on a tiny one is merely wasteful.
 */
export function variantFor(screenPx: number): AssetVariant {
  return screenPx > 0 && screenPx <= VARIANT_MAX_EDGE.thumb ? "thumb" : "display";
}

/**
 * What ingestion returns. Note what is *not* here: the bytes.
 *
 * Ingestion returns as soon as the hash and dimensions are known, so the item
 * appears instantly at the correct size while variants generate in the
 * background and an `asset:ready` event follows (ARCHITECTURE section 4.4).
 * Because `w` and `h` go into the document, an item is fully usable — pinnable,
 * stringable, annotatable — before its photograph has arrived at all.
 */
export interface AssetMeta {
  sha256: string;
  w: number;
  h: number;
  mime: string;
  size: number;
  /**
   * Seconds, for a film or a cassette. `null` for everything that is not one,
   * and for a container the shell could not read (T-300).
   *
   * `null` and `0` are not the same answer and must not be collapsed into one:
   * a spine with nothing written on it is a tape nobody has measured, and a
   * spine reading `0:00` is a tape with nothing on it. The number is read at
   * ingest by the machine holding the file, because the item reaches a peer
   * long before the bytes do — a 400 MB interview has to say how long it is
   * while it is still transferring.
   */
  duration: number | null;
  /**
   * Pages, for a document; `null` for everything else and for a PDF the shell
   * could not open — about 6% of real files, which D-47 measured and which
   * become a folder with nothing written where its thickness goes.
   *
   * Here for exactly the reason `duration` is, and the two are read off the
   * same file at the same moment. Its sibling — what the document says it is
   * *called* — is deliberately not here: Q-211 settled that a title is derived
   * locally and never enters the document, so it is asked for by
   * `documentTitle` against a file this machine holds rather than carried out
   * of an ingest to be written down.
   */
  pages: number | null;
}

/** Everything on disk for this board's document, as opaque frames. */
export interface DocState {
  /** Most recent snapshot, or null on a board that has never been compacted. */
  snapshot: Uint8Array | null;
  /** Updates appended since that snapshot, in order. */
  updates: Uint8Array[];
}

// --- bundles (T-84) ---------------------------------------------------------

/** What the shell has to be told to write a `.schizo`. Four things, none of
 *  them a document — Rust owns bytes and no schema. */
export interface BundleSpec {
  schemaVersion: number;
  /** Also the suggested filename, after Rust has reduced it to one. */
  title: string;
  /** Every hash the board references. Order and duplicates do not matter. */
  assets: string[];
}

/** `manifest.json`, as it was actually written. */
export interface BundleManifest {
  format: string;
  schemaVersion: number;
  title: string;
  /** What is *in the archive* — never what the board wished were in it. */
  assets: string[];
}

export interface BundleWritten {
  embedded: number;
  /** Referenced by the board and not on this disk, so not in the file. */
  missing: string[];
  bytes: number;
}

export interface BundleOpened {
  manifest: BundleManifest;
  /** The document the bundle holds, opaque — applying it is the caller's. */
  snapshot: Uint8Array;
  /** Hashes now in this machine's store. */
  ingested: string[];
  /** Listed by the manifest and not actually in the archive. */
  missing: string[];
}

/** A page for the PDF export (T-207), in the units the print pipeline takes. */
/**
 * Which *dialog* an export opens — see `exportChoose`.
 *
 * `image` is one kind and two formats: the dialog offers PNG and WebP as
 * filters and reports back which the user settled on, so the choice lives where
 * a person picks a filename rather than in a menu row per format.
 */
export type ExportKind = "pdf" | "image";

/**
 * Which file an image export turns out to be, as `exportChoose` reports it.
 *
 * PNG is lossless and always encodes. WebP is roughly a twentieth of the size
 * on a board of photographs (measured: 456 MB against 23 MB) and is not free —
 * it encodes three times slower, and past about 220 megapixels of photographic
 * content Chromium's encoder gives up and hands back nothing. See
 * `MAX_WEBP_PIXELS`.
 */
export type ImageFormat = "png" | "webp";

export interface PdfPage {
  /** Inches, because `ICoreWebView2PrintSettings` and `ExportView.inches` both
   *  speak them. Refused on the other side unless finite, positive and inside
   *  the format's own 200-inch limit. */
  width: number;
  height: number;
}

export type ClipboardKind = "image" | "text" | "html" | "files";

export interface ClipboardManifest {
  kinds: ClipboardKind[];
}

export type ClipboardPayload =
  | { kind: "image"; sha256: string }
  | { kind: "text"; text: string }
  | { kind: "html"; html: string; srcUrl?: string }
  /**
   * Paths, not hashes. Both routes for a file that came from the OS — a
   * clipboard copy and a drag-drop — then converge on `assetIngestPath`, which
   * is one ingest path with one set of tests rather than two that have to agree
   * about size limits and error handling. A path is not the bytes; nothing is
   * read into JavaScript by handing one over.
   */
  | { kind: "files"; paths: string[] };

export interface SyncConfig {
  mode: "lan" | "relay";
  /** Relay mode only. */
  url?: string;
  boardId: string;
  /**
   * The board's secret (T-70, Q-59 — "a secret in the invite link, checked at
   * connect"). Whoever holds it is a peer.
   *
   * Optional, and the two modes mean opposite things by leaving it out. In
   * `lan` mode, absent means *this* client is opening the board and the shell
   * invents one — somebody has to be first. In `relay` mode, absent means the
   * relay being dialled does not ask for one, which is every loopback relay a
   * developer runs.
   */
  secret?: string;
}

export interface SyncStatus {
  connected: boolean;
  peers: string[];
  mode: SyncConfig["mode"] | null;
  /**
   * Where the embedded relay is listening, when this client is the one hosting
   * (T-69). `null` in relay mode, where somebody else is.
   *
   * It has to come back out rather than go in, because the relay binds port
   * zero and is told its address by the operating system. A fixed port would
   * be one more thing to collide with on a machine somebody is working on, and
   * the mDNS advertisement (T-70) carries whatever this says.
   */
  url: string | null;
  /**
   * The board's secret, so a client that did not choose it can still put it in
   * an invite and can recognise its own board among the advertised ones.
   * `null` when this client is not hosting and was not given one.
   */
  secret: string | null;
}

/**
 * How much of an original one `assetChunk` is: 256 KB, from ARCHITECTURE
 * section 5.2.
 *
 * It lives here rather than with the protocol because it is what
 * `assetChunk(sha, index)` *means* — index two is the bytes at half a megabyte —
 * so every implementation of `Platform` has to cut at the same places, and the
 * sender's chunk count has to match the receiver's idea of one. Rust holds the
 * same number; it is the third and last thing the two languages agree on by
 * hand, after the message type and the frame.
 *
 * Large enough that a 12 MB photograph is fifty messages rather than three
 * thousand, small enough that one crossing IPC is not a visible stall in the
 * receiver's frame loop.
 */
export const CHUNK_BYTES = 256 * 1024;

/** Rust -> frontend. ARCHITECTURE section 4.4. */
export interface PlatformEvents {
  "asset:ready": { sha256: string };
  "asset:progress": { sha256: string; received: number; total: number };
  "files:dropped": { paths: string[]; x: number; y: number };
  "doc:persist-error": { message: string };
  /**
   * The operating system handed us a `schizo://` link (T-163).
   *
   * This is the *warm* arrival: the board is already open and somebody clicked
   * an invite. The cold one — a click that launched the application — cannot be
   * an event, because it happens before there is a frontend to hear it, and is
   * `syncTakeInvite` instead.
   *
   * A URL and nothing else, deliberately. What a link means is `app/invite.ts`'s
   * business; the shell's job is to notice one arrived.
   */
  "deeplink:open": { url: string };
  "sync:peer-joined": { peer: string };
  "sync:peer-left": { peer: string };
  /**
   * Somebody on this network is hosting a board we hold the secret to (T-70).
   *
   * The URL is dialable as it stands: the shell put our own secret on it,
   * because the mDNS advertisement never carried one. Re-announced periodically
   * and on every interface, so the same peer arrives repeatedly — `instance` is
   * what tells a re-announcement from a second peer.
   */
  "sync:peer-found": { url: string; board: string; instance: string };
}

export type Unlisten = () => void;

export interface Platform {
  readonly kind: "tauri" | "mock";

  /**
   * Whether this shell can write a PDF at all (T-210, Q-139).
   *
   * `PrintToPdf` is WebView2's. Tauri's own `print()` is the *dialog*, and only
   * on macOS; the cross-platform one is JS `window.print()`, which cannot be
   * handed the page shape the board computed and does not say when it finished
   * — so it is neither the same file nor a thing `posed()` could restore after.
   * Rather than ship a second, worse PDF nobody here can test, macOS and Linux
   * get the image export, which was already cross-platform: it composites in
   * the renderer and the shell only writes the bytes.
   *
   * So this is read once, at the menu: false removes the row rather than
   * disabling it, on exactly the standing the bundle rows have — a menu entry
   * that cannot work is a question nothing on screen can answer.
   *
   * Not a method, because it never changes within a run and the menu is built
   * synchronously.
   */
  readonly canPrintPdf: boolean;

  // --- assets: Rust owns bytes ------------------------------------------
  assetIngestBytes(bytes: Uint8Array, mime?: string): Promise<AssetMeta>;
  assetIngestPath(path: string): Promise<AssetMeta>;
  assetIngestUrl(url: string): Promise<AssetMeta>;
  assetHas(hashes: string[]): Promise<boolean[]>;

  /**
   * Save an asset's untouched original somewhere the user picks.
   *
   * Takes no destination, deliberately — ARCHITECTURE section 4.4 writes this as
   * `asset_export(sha256, dest)` and the `dest` is the part that had to go. A
   * path chosen in the renderer is a path an injected script can choose, and the
   * copy overwrites whatever is already at it. Rust opens a native save dialog
   * instead, so the user names the file and there is no path to hand over. The
   * full argument is above `asset_export` in `src-tauri/src/lib.rs`.
   *
   * `origName` is the asset's `AssetFields.origName` and is only ever a
   * *suggested filename* — Rust reduces it to one before the dialog sees it,
   * because the document is where a URL segment from someone else's page ends
   * up. Pass it: without it the dialog offers the asset's hash, which nobody
   * recognises their own photograph by. The extension is not taken from it
   * either way; the bytes on disk decide that.
   *
   * Resolves `false` when the user closed the dialog without saving. That is an
   * ordinary outcome, not a failure: only a rejection means the copy went wrong.
   */
  assetExport(sha256: string, origName?: string): Promise<boolean>;

  assetGc(keep: string[]): Promise<{ freedBytes: number }>;

  /**
   * The URL an `<img>` should point at. Synchronous by design.
   *
   * Under Tauri this is `asset://sha256/<hash>?v=display`, a custom URI scheme
   * handler that streams from disk with browser caching and range requests at
   * zero JavaScript memory cost. Base64-ing a 12 MB photograph across IPC is
   * the obvious first thing to try and roughly the worst available option
   * (ARCHITECTURE section 4.3).
   *
   * Returns an empty string for an asset this process has never seen, which
   * the item renders as its `unknown` state rather than as an error.
   */
  assetUrl(sha256: string, variant?: AssetVariant): string;

  /**
   * What a document says it is called, read off a file this machine holds.
   *
   * **A derived local index and nothing else** — Q-211. The answer never enters
   * the document, never crosses the wire and is never written down: a machine
   * that does not hold the bytes has no title for this asset, and that is the
   * intended state rather than a gap.
   *
   * Which is what makes it on-demand rather than a field out of ingestion. One
   * path serves a paste, a transfer that has just committed, a board reopened
   * tomorrow and a bundle somebody sent — none of which are ingests, and three
   * of which would otherwise each need their own answer.
   *
   * `null` for four things that are one thing to a label: no such asset, not a
   * document, a document this build cannot open, and a document that declares
   * no title. All four mean the folder writes its case number and stops.
   *
   * Reported exactly as the file states it, tidied of whitespace and capped.
   * Whether it is worth *writing* is `titleWorthWriting`'s question and is
   * answered on this side of the line, because it needs the filename and
   * because D-47 measured that most of these strings are not names.
   */
  documentTitle(sha256: string): Promise<string | null>;

  // --- document: an append-only log of opaque frames ----------------------
  docAppendUpdate(bytes: Uint8Array): Promise<void>;
  docLoad(): Promise<DocState>;
  docCompact(snapshot: Uint8Array): Promise<void>;

  // --- bundles: the whole board as one file -------------------------------
  /**
   * Write a `.schizo` — a zip holding the manifest, the document snapshot and
   * every photograph the board references (DATA-MODEL section 12).
   *
   * Takes no destination, on exactly the standing `assetExport` above sets out:
   * Rust opens a native save dialog and the renderer never names a path. What
   * crosses instead is `spec.title`, a *suggestion* that Rust reduces to a
   * filename before the dialog shows it.
   *
   * `spec.assets` is what the board references — `referencedAssets(board)`, the
   * same set the janitor spares — and the snapshot is `snapshot(board)`. Rust
   * never opens either: it is handed a list of hashes and a block of opaque
   * bytes, which is the whole of what a bundle is from that side.
   *
   * Resolves `null` when the user closed the dialog, like `assetExport`'s
   * `false`. Otherwise it resolves with what actually went in the file —
   * including `missing`, the hashes the board references that this disk does
   * not hold. That list is normally empty; it is not an error when it is not,
   * because a photograph that only ever lived on a peer who has left (DESIGN
   * section 11.1, risk 4) must not make a board un-handable.
   */
  bundleSaveAs(spec: BundleSpec, snapshot: Uint8Array): Promise<BundleWritten | null>;

  /**
   * Read a `.schizo` the user picks, putting its photographs in this machine's
   * store and handing back the document it holds.
   *
   * Hands back rather than applies, because what to *do* with another board is
   * a question about boards and this boundary owns bytes. Q-111 answered it:
   * the bundle replaces the board in this window.
   *
   * Resolves `null` for a cancelled dialog.
   */
  bundleOpen(): Promise<BundleOpened | null>;

  // --- export (T-207, T-206) ----------------------------------------------
  /**
   * Ask the user where an export of the board should go. `false` is a cancelled
   * dialog — an ordinary outcome, and nothing has moved.
   *
   * Takes no destination, on the standing `assetExport` and `bundleSaveAs` both
   * set out, and does not hand one back either: the path stays in the shell
   * between this and whichever writer follows. `title` is a *suggestion* Rust
   * reduces to a filename before the save dialog shows it.
   *
   * Separate from the write because the board has to be posed before the file
   * is made, and posing it while somebody is still typing a filename would mean
   * the window zooms out to answer a question about a file. It also makes the
   * *common* case the cheap one: a cancelled dialog costs no re-pose at all.
   *
   * One command for both routes rather than two nearly identical ones — they
   * differ in three strings, and everything worth getting right about them is
   * the same.
   */
  exportChoose(title: string, kind: ExportKind): Promise<string | null>;

  /**
   * Print the board into the file already chosen, one page of the given size in
   * inches, and resolve where it went.
   *
   * The *whole* of what crosses is a page, because the drawing is already done
   * by the time this is called: the shell asks its own webview to print itself,
   * so what lands in the file is whatever is on screen at that moment.
   * `app/exportPdf.ts` is what makes that moment the right one — the camera,
   * the canvases and the detail tier are put where the page needs them first,
   * and put back after.
   *
   * The path comes back as a string to show a person ("saved to …") and not as
   * a handle: no command on the other side takes one.
   */
  exportPdfWrite(page: PdfPage): Promise<string>;

  /**
   * Write an already-encoded image into the file already chosen, and resolve
   * where it went.
   *
   * The mirror image of `exportPdfWrite` in where the work happens. A PDF is
   * rendered by Chromium from the live document, so nothing of the board
   * crosses; an image is *composited in the renderer* — cork, board ink, both
   * rope layers and the items are each painters that take a camera, and none of
   * them exists on the shell's side — so what crosses is the finished picture
   * and the shell only writes it.
   */
  exportImageWrite(bytes: Uint8Array): Promise<string>;

  // --- clipboard ---------------------------------------------------------
  clipboardReadManifest(): Promise<ClipboardManifest>;
  clipboardReadItem(kind: ClipboardKind): Promise<ClipboardPayload | null>;
  /**
   * The page a copied fragment came from, or null.
   *
   * "Copy image" in a browser puts markup on the clipboard whose `<img src>` is
   * very often relative, and the only thing that can resolve it is the source
   * URL — which lives in a `CF_HTML` header the webview strips before the
   * `paste` event ever sees it. So it has to come from the shell, and null is
   * an ordinary answer: on a platform that has not been taught to read it, and
   * whenever the clipboard is carrying something else.
   */
  clipboardSourceUrl(): Promise<string | null>;

  // --- sync --------------------------------------------------------------
  syncStart(config: SyncConfig): Promise<void>;
  syncStop(): Promise<void>;
  syncStatus(): Promise<SyncStatus>;

  /**
   * The `schizo://` link that launched this window, once (T-163).
   *
   * *Take*, not read: the link is cleared as it is handed over, so a reload does
   * not re-join a board the user has since left. Null is the ordinary answer —
   * almost every launch is somebody opening their own board.
   *
   * This exists alongside `deeplink:open` because a cold arrival cannot be an
   * event. A click on an invite starts the application, so the link is known
   * before there is a frontend listening, and an emit at that moment reaches
   * nobody.
   */
  syncTakeInvite(): Promise<string | null>;

  // --- which board this is (T-195) ----------------------------------------
  //
  // Not part of sync, though only sync reads it: this is a fact about the
  // installation, kept beside the document by `src-tauri/src/board.rs`, and it
  // has to be answerable *before* there is a relay for `syncStatus` to describe.

  /**
   * The board this installation has been moved onto, or `null` for the one every
   * installation starts on.
   *
   * Only a bundle open ever sets it (Q-114): the document that arrives in a
   * `.schizo` replaces the one on disk, and the window must not reconnect to the
   * room the replaced board is in — the relay holds a document, and it would
   * answer with the whole of what was just discarded.
   */
  rememberedBoardId(): Promise<string | null>;

  /** This is the board from now on. See [`rememberedBoardId`]. */
  rememberBoardId(boardId: string): Promise<void>;

  // --- asset transfer: the bytes behind HAVE / WANT / DATA / DONE ----------
  //
  // `crdt/sync/exchange.ts` decides what to ask for and who to ask; these five
  // are everything it needs from the store, and none of them lets it read a
  // chunk. ARCHITECTURE section 5.2 puts chunking, verification and the commit
  // in Rust, so a payload leaves `assetChunk` and enters `assetReceive` without
  // JavaScript ever looking at it — which is also what keeps a 12 MB original
  // out of the renderer's heap.
  //
  // `peer_want(sha256, priority)` is gone, and D-28 says why: it puts the queue
  // in Rust, and Rust has no socket to the relay — the connection belongs to the
  // webview. ARCHITECTURE section 4.4 listed it for a while; it does not now,
  // and §5.2 records the removal.

  /**
   * Every hash this machine holds bytes for, for the `HAVE` announcement.
   *
   * Full hashes rather than the prefixes that go on the wire, so that the
   * prefix length stays a fact about the protocol and does not become a third
   * constant Rust and TypeScript have to agree on by hand.
   */
  peerHaveSummary(): Promise<string[]>;

  /** The original's size in bytes, or 0 for an asset this machine does not hold. */
  assetSize(sha256: string): Promise<number>;

  /**
   * One `CHUNK_BYTES` chunk of an original, to put on the wire.
   *
   * Empty when the asset has gone — collected, or never here — which the caller
   * treats as "stop", not as an error.
   */
  assetChunk(sha256: string, index: number): Promise<Uint8Array>;

  /** Put a received chunk where the commit will find it. Nothing is verified yet. */
  assetReceive(sha256: string, index: number, total: number, bytes: Uint8Array): Promise<void>;

  /**
   * Hash everything received and, only if it matches, commit it to the store.
   *
   * `false` means it did not match and nothing was written — the one outcome
   * that must never be confused with a failure to try, because a peer sending
   * bytes that are not the asset it named is exactly what verification is for.
   */
  assetCommit(sha256: string): Promise<boolean>;

  /** Throw away a partial transfer. Safe to call for one that does not exist. */
  assetAbort(sha256: string): Promise<void>;

  // --- events ------------------------------------------------------------
  on<K extends keyof PlatformEvents>(
    event: K,
    handler: (payload: PlatformEvents[K]) => void,
  ): Promise<Unlisten>;
}
