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

import type {
  AssetMeta,
  AssetVariant,
  ClipboardKind,
  ClipboardManifest,
  ClipboardPayload,
  DocState,
  Platform,
  PlatformEvents,
  SyncConfig,
  SyncStatus,
  Unlisten,
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
}

export class MockPlatform implements Platform {
  readonly kind = "mock" as const;

  private readonly assets = new Map<string, StoredAsset>();
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

    const meta: AssetMeta = { sha256, w, h, mime: type, size: bytes.byteLength };
    this.assets.set(sha256, { meta, url: URL.createObjectURL(blob) });
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
    return { connected: false, peers: [], mode: null, url: null };
  }

  async peerWant(): Promise<void> {}

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
