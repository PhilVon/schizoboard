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
/**
 * What the shell says about a file it would not take.
 *
 * The three `assetIngest*` calls reject with one of these rather than with a
 * string, and it is the only boundary on this board that does. The reason is
 * that this is the only one whose failure is a *sentence somebody reads* — and
 * the alternative to carrying it as data was matching on the prose of an error
 * message, which is not a contract (T-309).
 *
 * `say` is a verb phrase with the file as its subject, written on the shell's
 * side because that is the side holding the numbers: a picture's shape, a paste
 * ceiling, the road that would clear it. This side supplies the file's name and
 * the frame.
 */
export interface Refusal {
  /**
   * Whether the board will refuse the file **however it arrives**.
   *
   * The one thing this side cannot work out and must not guess. "Nothing here
   * can hold it" is a claim about the board: true of a four-hundred-megapixel
   * scan, a lie about a file that is only too big to hand across the IPC
   * boundary — that one has another road, and its sentence offers it.
   */
  holdsNowhere: boolean;
  say: string;
}

/**
 * A rejected ingest read back as a {@link Refusal}, or null if it was something
 * else entirely — a promise that rejected before the command was reached, a
 * platform that is not the shell.
 */
export function refusalOf(error: unknown): Refusal | null {
  if (typeof error !== "object" || error === null) return null;
  const { holdsNowhere, say } = error as Partial<Refusal>;
  return typeof holdsNowhere === "boolean" && typeof say === "string" ? { holdsNowhere, say } : null;
}

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
   * locally and never enters the document, so it is asked for by `assetTitle`
   * against a file this machine holds rather than carried out of an ingest to
   * be written down. The same is true of a film's and a recording's name, which
   * come off their containers by the same route (T-302).
   */
  pages: number | null;
}

/**
 * What a page says it is — T-289, T-290, Q-304.
 *
 * The other half of a pasted URL. `assetIngestUrl` is for an address that names
 * a file; this is for one that names a *page about* a file, which is what an
 * archive.org item, a Commons file page and a watch page all are.
 *
 * Every field is absent far more often than not, and a card with nothing in it
 * is the ordinary answer for most of the web — the paste then falls back to the
 * note it would always have made.
 */
export interface PageCard {
  readonly title: string | null;
  readonly siteName: string | null;
  /**
   * A picture the page offers, absolute. **A lead, not a picture**: it goes
   * back through `assetIngestUrl` like any other address, so the store sniffs
   * the bytes and a page claiming its image is a PDF gets a folder.
   */
  readonly image: string | null;
  /**
   * A film or a recording the page declares *and gives a media type for*.
   *
   * Null for a watch page, and that is the whole of T-290 rather than an
   * omission: such a page does declare an `og:video`, and it is an embed URL
   * typed `text/html` — a player, not a film. Rust refuses to call that media,
   * so there is nothing here to hang a tape on that could not play.
   */
  readonly media: { readonly url: string; readonly mime: string } | null;
  /**
   * Whether the page says it is **about** a film or a recording — T-342.
   *
   * The bit `media` alone cannot carry, and the reason this interface had a hole
   * in it. `media: null` covers two pages that are nothing like each other: a
   * watch page, which declared a video and offered a player instead of a film,
   * and an article, which never mentioned one. Reading those as the same thing
   * is how a YouTube paste became a business card.
   *
   * Three answers, and the caller needs all three — `media` first, then this:
   *
   * | media | aboutMedia | the object |
   * |---|---|---|
   * | set | — | the file itself: a tape, a cassette |
   * | null | `true` | a printed still of a page about media, with its address |
   * | null | `false` | a business card |
   *
   * It is the page's *claim*, not anything fetched, which is what keeps Q-304's
   * single rule: nothing here knows what YouTube is.
   */
  readonly aboutMedia: boolean;
}

// --- reading a document (T-297, T-299, T-318) -------------------------------

/**
 * One page of a case file, as the shell reads it.
 *
 * **`width` and `height` are points and are both zero for a text file**, which
 * is the honest answer rather than a missing one. A PDF states the shape it is
 * meant to be looked at in; a text file states nothing, so the sheet it goes on
 * is the board's decision and `text.rs`'s 66×46 grid is what sizes it. A reading
 * surface that treats a zero as a page shape draws a page with no area.
 *
 * `index` is one-based — the number printed on it, and the second half of the
 * `(sha256, page)` pair every citation will carry (D-60).
 */
export interface DocumentPage {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly content: PageContent;
  /**
   * When each cue on this page was said — T-287, Q-301. Empty for every page
   * that is not a page of a transcript, which is most of them.
   *
   * Beside the content rather than inside it, because on paper a transcript
   * *is* plain text: same hand, same measure, same grid, quoted by the same
   * gesture. What is not plain about it is where it came from, and that is
   * already the kind of fact that lives out here beside `index`.
   */
  readonly cues: readonly PageCue[];
  /**
   * What each stretch of this page is, for a page of markdown — T-348. Empty
   * for every other page, which is most of them.
   *
   * Beside the content for `cues`' reason and one of its own: on paper a
   * markdown file is plain text, cut the same way on the same grid and quoted
   * by the same gesture, so its content arrives as `Plain` like any other text
   * file. What is not plain about it is what the words *were*, and that is a
   * fact about where the page came from rather than about the characters on it.
   *
   * In document order, outermost first where two overlap — so a heading arrives
   * before the bold word inside it and a reader can nest them by containment.
   */
  readonly roles: readonly PageRole[];
}

/** What a stretch of a markdown page is — the six a sheet can draw. */
export type PageRoleName = "heading" | "item" | "quote" | "code" | "emphasis" | "strong";

/**
 * One stretch of a page, and what it is.
 *
 * `start` and `end` are into the page's own text in the units a `Range` counts
 * in — UTF-16 code units — for exactly `PageCue`'s reason: the only thing that
 * compares one of these against a position is a DOM range.
 *
 * `level` is one-based for a heading, zero-based for a list item's nesting, and
 * `0` for the other four, which have no depth rather than a depth of zero.
 */
export interface PageRole {
  readonly start: number;
  readonly end: number;
  readonly role: PageRoleName;
  readonly level: number;
}

/**
 * One cue's place on a page, and the moment it names in the recording.
 *
 * `offset` is into the page's own text, in the units a `Range` counts in —
 * **UTF-16 code units, not bytes**. The conversion happens in Rust where the
 * page text is in hand (`document.rs`), because the only thing that ever
 * compares one of these against a position is a DOM caret: the two agree while
 * a transcript is ASCII and part company at the first accent.
 *
 * `at` is seconds from the start of the recording. Two numbers rather than a
 * formatted string, because how a citation *reads* is `lib/objects.ts`'s to
 * decide and it already decides it for a page and for a frame.
 */
export interface PageCue {
  readonly offset: number;
  readonly at: number;
}

/**
 * What is on a page. Five answers, and the distinctions between them are the
 * whole of AC-681 and AC-682.
 *
 * `empty` and a `plain` page holding `""` would draw the same blank sheet and
 * only one of them is allowed to: a page that yields nothing has to *say so*,
 * because a blank sheet where an exhibit was is the failure this union exists to
 * stop. `unsupported` is the same rule one step further along — this build
 * cannot read what is there, and it names what rather than passing it off as
 * empty.
 *
 * The decision is per page and not per document (D-46 section 4): a filing is
 * routinely typed pages with scanned exhibits behind them, so `text` and `image`
 * sit side by side inside one folder.
 */
export type PageContent =
  | { readonly kind: "text"; readonly runs: readonly TextRun[]; readonly figures: readonly PageFigure[] }
  | { readonly kind: "plain"; readonly text: string }
  | { readonly kind: "image"; readonly image: PageImage }
  | { readonly kind: "empty" }
  | { readonly kind: "unsupported"; readonly reason: string };

/**
 * A run of text and the box it was set in — points from the page's top left,
 * `y` downwards, `/Rotate` already applied.
 *
 * A run has **no identity**: it is a positional element of a vector in
 * content-stream order, so nothing may cite one. A page survives every extractor
 * improvement; "run 47" survives none of them (D-60).
 */
export interface TextRun {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly size: number;
}

/** A lifted image on a typed page, and where on it that image sits. */
export interface PageFigure {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly content:
    | { readonly kind: "image"; readonly image: PageImage }
    | { readonly kind: "unsupported"; readonly reason: string };
}

/**
 * What a lifted image is, without being it. `bytes` is a **length** — the bytes
 * themselves come back from `documentPageImage`, because half a megabyte of
 * scan through JSON is a third bigger again and nothing here would read it.
 */
export interface PageImage {
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/**
 * What one page *says* — the much smaller thing a page can be asked for, and
 * the whole of what a derived local text index is made of (D-46 section 2).
 *
 * Two arms against `PageContent`'s five, and the shortfall is deliberate. A
 * typed page and a page of a text file are the same answer to "what does it
 * say"; a scan, a blank page and a page this build cannot read are three
 * different answers to "why does it say nothing". The reading surface needs the
 * first distinction; a search field needs the second, because "its scans are
 * not searchable" is a sentence somebody can act on and a silent miss is not
 * (D-46 section 4).
 *
 * `text` is the page's runs already joined, and joined by a **gap rule** rather
 * than by `linesOfRuns`'s line-breaking one. The two agree on the same
 * non-space characters in the same order and disagree about which whitespace
 * sits between them, which is invisible to a search that normalises whitespace
 * — see `document::joined` in the shell for why that is the promise the two
 * sides can actually keep.
 */
export type PageText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "none"; readonly why: NoText };

/** Why a page has no characters on it. */
export type NoText =
  /** A picture covering the page. There is no OCR (D-46 section 6), so this one
   *  is permanent rather than pending. */
  | "scan"
  /** Genuinely blank. */
  | "empty"
  /** Something is on it and this build cannot read it. */
  | "unreadable";

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
  /**
   * Which file this is, when it has been written at least once (T-359).
   *
   * Absent on every `.schizo` written before T-356, and absent is a perfectly
   * good answer: it means nothing here has claimed this file yet.
   */
  packId?: string;
}

export interface BundleWritten {
  /**
   * Which file this now is (T-359).
   *
   * Minted by Rust when the caller had none, which for `bundleSaveAs` is
   * always: a copy is a different board, and two files sharing a pack id are
   * two files the register cannot tell apart. This side never supplies one —
   * see `BundleSpec`.
   */
  packId: string;
  embedded: number;
  /** Referenced by the board and not on this disk, so not in the file. */
  missing: string[];
  bytes: number;
}

/**
 * What an export would weigh, asked before there is a file to measure — T-291.
 *
 * `bytes` is the sum of the assets on this disk and **not** the size of the
 * file: the snapshot is not in it, because this side is holding that and can
 * add its length without sending it across; nor is the zip's per-entry
 * overhead; nor is what deflate takes off a transcript. Everything that makes a
 * bundle heavy is stored byte for byte (D-64 measured why), so it is a tight
 * upper bound — and the word for it on the way out is "about".
 */
export interface BundleWeighed {
  embedded: number;
  /** Referenced by the board and not on this disk, so it will not be in it. */
  missing: number;
  bytes: number;
}

// --- boards (T-356) ---------------------------------------------------------

/**
 * One board, as the side that may not know where it is sees it.
 *
 * ARCHITECTURE section 4.4's rule — no path crosses the boundary — reads in
 * both directions, and a renderer handed every board's absolute path can name a
 * location just as surely as one that asked for a path. So `folder` is the
 * *display name* of the directory the file sits in and nothing more: enough to
 * tell two boards called "Untitled board" apart, and not somewhere on a disk.
 *
 * `packId` is an opaque token issued by the shell. It is the only handle this
 * side ever has on a board, and it is what `boardOpen` takes.
 */
export interface BoardCard {
  packId: string;
  title: string;
  /** Empty for a board that has no file of its own yet. */
  folder: string;
  homed: boolean;
  current: boolean;
}

/** The board the user picked out of a dialog — see `boardOpenPicked`. */
export interface BoardPicked {
  packId: string;
  title: string;
}

export interface BoardOpened {
  board: BoardCard;
  /**
   * True when this machine had no workshop for that board and its file was read
   * to make one.
   *
   * False is the ordinary case for a board you already had, and it is also what
   * a *recovery* looks like: a workshop with anything in it is a session that
   * ended before its file was written, so it is newer than the file and wins.
   */
  seeded: boolean;
  /** Referenced by that board's file and not actually in it. Normally empty. */
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
  /**
   * A drop from the OS, already expanded into the files a folder holds.
   *
   * `found` is how many files the drop named, which is **not** `paths.length`
   * once a folder is big enough: the shell keeps a bounded number and reports
   * the true count so the notice can say "50 of 4000" rather than "50 of 500"
   * (T-295). Optional, because the browser build's mock bus has no folders to
   * walk and nothing to be truncated — absent means `paths` is all there was.
   */
  "files:dropped": { paths: string[]; x: number; y: number; found?: number };
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
  //
  // These three reject with a `Refusal` (below) rather than with a string, and
  // they are the only commands that do.
  assetIngestBytes(bytes: Uint8Array, mime?: string): Promise<AssetMeta>;
  assetIngestPath(path: string, markdown?: boolean): Promise<AssetMeta>;
  assetIngestUrl(url: string): Promise<AssetMeta>;
  /**
   * What a page says it is — {@link PageCard}, T-289.
   *
   * Rejects rather than returning an empty card when the page will not load
   * or is not a page at all, because those are different from a page that
   * loaded and had nothing to say — and only the caller knows that both end
   * in the same note.
   */
  pageCard(url: string): Promise<PageCard>;
  /**
   * Hand a web address to whatever the operating system opens links with —
   * T-290, Q-305.
   *
   * **`http` and `https` only**, checked again in Rust, because the address
   * comes off an item's `source` and an item is a thing a *peer* can write. A
   * scheme this refuses is a link that does nothing, which is the right failure:
   * the alternative is handing an unknown handler an argument.
   */
  openLink(url: string): Promise<void>;
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
   * What this file says it is called, read off a copy this machine holds.
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
   * **One question for all three objects.** A folder reads a PDF's `/Title`, a
   * tape and a cassette read their container's own name field — ID3v2, `udta`,
   * Matroska's `Info`, a Vorbis comment, a RIFF `INFO` list. Which parser
   * answers is a fact about the bytes rather than about the label, so the shell
   * decides it from the file's own head and this side never asks.
   *
   * `null` for five things that are one thing to a label: no such asset, a kind
   * that carries no name, a container this build cannot read, a document it
   * cannot open, and — much the commonest — a file that declares no title at
   * all. D-52 measured that last one at 1 film in 461. All five mean the label
   * writes its case number and stops.
   *
   * Reported exactly as the file states it, tidied of whitespace and capped.
   * Whether it is worth *writing* is `titleWorthWriting`'s question and is
   * answered on this side of the line, because it needs the filename and
   * because D-47 measured that most of these strings are not names.
   */
  assetTitle(sha256: string): Promise<string | null>;

  // --- reading a document (T-318) -----------------------------------------

  /**
   * How many pages, without reading one.
   *
   * The asset record's `pages` answers this without touching the disk and is
   * what the folder's thickness is drawn from, so this is for the case that
   * record cannot cover: a document ingested by a machine which could not count
   * it — an older build, or a peer that has never held the bytes.
   *
   * Costs a structure load and no page read: 3 to 53 ms on the corpus D-47
   * swept, 221 ms on the largest file that machine held.
   */
  documentPageCount(sha256: string, markdown?: boolean): Promise<number>;

  /**
   * One page, by the number printed on it, one-based.
   *
   * `null` means there is no such page. That is a *different answer* from a page
   * which came back `empty`, and collapsing the two would turn "you asked for
   * page 300 of a 200-page filing" into "page 300 is blank".
   *
   * **Costs one page and not a document**, which is a requirement rather than an
   * optimisation: T-299 measured a real 100-page scan at 5,860 ms to read
   * through and 57 ms to read the first page of. The shell holds the structure
   * open between calls, which is what makes turning a page affordable and what
   * `documentClose` exists to give back.
   */
  documentPage(sha256: string, index: number, markdown?: boolean): Promise<DocumentPage | null>;

  /**
   * The bytes of a lifted image — the page's own scan when `figure` is absent,
   * or the nth figure on a typed page.
   *
   * Ask only when `documentPage` has already said there is an image at that
   * pair; the page is in the shell's cache by then, so this is a copy rather
   * than a second decode. An empty result means the pair names no image, which
   * covers all four ways that can be true and is one thing to a caller.
   */
  documentPageImage(
    sha256: string,
    index: number,
    figure?: number,
    markdown?: boolean,
  ): Promise<Uint8Array>;

  /**
   * Every page's characters, in one answer, index-aligned so element `n` is
   * page `n + 1`.
   *
   * **The whole document, and that is the cheap shape rather than the greedy
   * one.** Asking page by page would pay the structure load again per page —
   * unless the shell held the reader between calls, which is the one slot
   * `documentClose` exists to hand back to whoever is reading.
   *
   * Measured cold on 40 real multi-page files (772 pages): 8.5 ms to open a
   * document and 11.1 ms a page to take the text off it, so an average case
   * file is about 215 ms of background work and a 100-page one is five seconds.
   * Reading the same pages through `documentPage` is 18.5 ms a page on that
   * corpus and much worse on a scanned filing, because this never lifts a scan
   * or a figure.
   *
   * Text, never runs — a few hundred kilobytes for a long filing where the runs
   * and their boxes would be an order of magnitude more, all of it discarded by
   * the caller on arrival.
   */
  documentText(sha256: string, markdown?: boolean): Promise<readonly PageText[]>;

  /**
   * The folder has been shut. Let the file go.
   *
   * The shell holds **one** document open at a time and holding one costs about
   * the size of the file — a 51 MB scan is 51 MB of working set. The pages
   * already read stay cached, so opening the same folder again does not re-do
   * the work; it is the document-sized allocation this hands back.
   *
   * Nothing breaks if it is never called: the next document opened evicts this
   * one. What it costs is one file's worth of memory held for as long as the
   * board is up.
   */
  documentClose(sha256: string): Promise<void>;

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
   * What a bundle of this board would weigh, before one is written — T-291.
   *
   * The spec alone and no snapshot: only the shell knows which of the board's
   * assets are actually on this disk, and it can weigh them from its own
   * directory. Sending several megabytes of document across the boundary to be
   * told a number would be the expensive half of an export done twice.
   */
  bundleWeigh(spec: BundleSpec): Promise<BundleWeighed>;

  // --- boards (T-356) ------------------------------------------------------
  //
  // A `.schizo` stopped being an export and became the board: a file at a path
  // the user chose, written to continuously, and switched between. These seven
  // are the whole of that from this side, and between them they carry no path
  // in either direction.
  //
  // They replace `bundleOpen`, whose native "Opening X will replace the board
  // in this window" is the sentence that stopped being true: opening board B
  // now leaves board A intact in its own file, so there is nothing to warn
  // about and nothing to agree to.

  /** Every board this installation knows about, most recently opened first. */
  boardList(): Promise<BoardCard[]>;

  /** The board this window is on, or `null` before there is one. */
  boardCurrent(): Promise<BoardCard | null>;

  /**
   * Ask which board the user wants — the dialog half of *Open a board…*.
   *
   * Deliberately does **not** switch: this side has to close its persistence
   * between finding out that a board was picked and moving onto it, and it
   * cannot close it before, because a cancelled dialog would leave a window
   * that had stopped saving. `boardOpen` is the switch, and it is the same call
   * a recents row makes.
   *
   * `null` for a cancelled dialog.
   */
  boardOpenPicked(): Promise<BoardPicked | null>;

  /**
   * Point this window's document log at another board.
   *
   * **Close persistence first.** Nothing may append to the old board's log
   * after this resolves, and the shell cannot enforce that — a lock there would
   * serialise an append against the switch and then let the append win.
   * `Persistence.close()` unsubscribes before it awaits its own flush, so when
   * it resolves there is nothing left that could enqueue. Then reload: half the
   * application holds a reference to the `Y.Doc` this window opened with.
   */
  boardOpen(packId: string): Promise<BoardOpened>;

  /**
   * A board nothing has ever been on — *New board…*.
   *
   * No dialog, and the asymmetry with `boardOpenPicked` is the design: a new
   * board has no file to find. It is given one by `boardHome` once there is a
   * title to name it by. Same contract as `boardOpen` — close, then reload.
   */
  boardNew(): Promise<BoardCard>;

  /**
   * Write the open board into its own file — the second tier of saving.
   *
   * The same `spec` and `snapshot` an export takes, and the difference is
   * entirely on the shell's side: this writes to the file that board already
   * *is*, keeping the pack id it already has, where `bundleSaveAs` writes a copy
   * and mints a new one. Two files sharing a pack id would be two boards the
   * register cannot tell apart.
   *
   * `null` for a board that has no file yet — not a failure, and `boardHome` is
   * what answers it.
   */
  boardFlush(spec: BundleSpec, snapshot: Uint8Array): Promise<BundleWritten | null>;

  /**
   * Give a board with no file one, and write it there.
   *
   * The location is chosen entirely by the shell — this side supplies a *title*
   * and gets back what was written, which is `assetExport`'s rule kept. No
   * dialog: a board that has been running out of the data directory since before
   * T-356 has already been decided on.
   */
  boardHome(spec: BundleSpec, snapshot: Uint8Array): Promise<BundleWritten>;

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
   * The room the open board is in, or `null` for the one every installation
   * starts on.
   *
   * **Read-only since T-356, and that is the whole change here.** Its partner
   * `rememberBoardId` let this side *set* the room, and had one caller: a bundle
   * open, which replaced this window's document and had to mint a room the
   * discarded board was not in (Q-114). Opening a board no longer discards one,
   * so nothing on this side mints a room any more — the shell's register does
   * it, on first sight of a board file it has never seen.
   */
  rememberedBoardId(): Promise<string | null>;

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
   * How many bytes of an interrupted transfer are still on this disk, so the
   * exchange can ask for the rest rather than for all of it again (T-265).
   *
   * A **length**, not a count of chunks, and it is only a resume point because
   * of a promise the exchange keeps: it asks from a contiguous point and a
   * holder serves in order, so a partial is always dense. Divide by
   * `CHUNK_BYTES` for the chunk to start at.
   *
   * `0` for every way of not having one — never transferred, already committed,
   * or swept by the store's own hour-long tidy of abandoned temporaries. Zero
   * means "from the beginning" the whole way down, so nothing has to special
   * case it.
   */
  assetPartial(sha256: string): Promise<number>;

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
