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
}

/** Everything on disk for this board's document, as opaque frames. */
export interface DocState {
  /** Most recent snapshot, or null on a board that has never been compacted. */
  snapshot: Uint8Array | null;
  /** Updates appended since that snapshot, in order. */
  updates: Uint8Array[];
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
}

export interface SyncStatus {
  connected: boolean;
  peers: string[];
  mode: SyncConfig["mode"] | null;
}

/** Rust -> frontend. ARCHITECTURE section 4.4. */
export interface PlatformEvents {
  "asset:ready": { sha256: string };
  "asset:progress": { sha256: string; received: number; total: number };
  "files:dropped": { paths: string[]; x: number; y: number };
  "doc:persist-error": { message: string };
  "deeplink:open": { url: string };
  "sync:peer-joined": { peer: string };
  "sync:peer-left": { peer: string };
}

export type Unlisten = () => void;

export interface Platform {
  readonly kind: "tauri" | "mock";

  // --- assets: Rust owns bytes ------------------------------------------
  assetIngestBytes(bytes: Uint8Array, mime?: string): Promise<AssetMeta>;
  assetIngestPath(path: string): Promise<AssetMeta>;
  assetIngestUrl(url: string): Promise<AssetMeta>;
  assetHas(hashes: string[]): Promise<boolean[]>;
  assetExport(sha256: string, dest: string): Promise<void>;
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

  // --- document: an append-only log of opaque frames ----------------------
  docAppendUpdate(bytes: Uint8Array): Promise<void>;
  docLoad(): Promise<DocState>;
  docCompact(snapshot: Uint8Array): Promise<void>;

  // --- clipboard ---------------------------------------------------------
  clipboardReadManifest(): Promise<ClipboardManifest>;
  clipboardReadItem(kind: ClipboardKind): Promise<ClipboardPayload | null>;

  // --- sync --------------------------------------------------------------
  syncStart(config: SyncConfig): Promise<void>;
  syncStop(): Promise<void>;
  syncStatus(): Promise<SyncStatus>;
  peerWant(sha256: string, priority: number): Promise<void>;

  // --- events ------------------------------------------------------------
  on<K extends keyof PlatformEvents>(
    event: K,
    handler: (payload: PlatformEvents[K]) => void,
  ): Promise<Unlisten>;
}
