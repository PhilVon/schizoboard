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
  type BundleOpened,
  type BundleWritten,
  type ClipboardKind,
  type ClipboardManifest,
  type ClipboardPayload,
  type DocState,
  type ExportKind,
  type Platform,
  type PlatformEvents,
  type SyncConfig,
  type SyncStatus,
  type Unlisten,
} from "@/platform/types";

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
function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return "application/octet-stream";
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
  /** Which board this "installation" is on — in memory, like everything else. */
  private board: string | null = null;

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
    const meta: AssetMeta = {
      sha256,
      w,
      h,
      mime: type,
      size: bytes.byteLength,
      duration: null,
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

  bundleOpen(): Promise<BundleOpened | null> {
    return unavailable("Opening a bundle");
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
   * Implemented rather than refused even though the only thing that mints one is
   * a bundle open, which this platform has no picker for: the *reader* runs on
   * every boot, including in a plain browser, and a boot that threw on the way
   * to deciding which board to open would be a board that does not open.
   *
   * In memory, like the document and the assets, so a reloaded tab is back on
   * the board it started on — which is the one place the mock will surprise you
   * and is stated at the top of this file.
   */
  async rememberedBoardId(): Promise<string | null> {
    return this.board;
  }

  async rememberBoardId(boardId: string): Promise<void> {
    this.board = boardId;
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
