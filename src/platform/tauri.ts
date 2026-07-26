/**
 * The real native boundary. **Every `invoke()` in the application is in this
 * file** (docs/ARCHITECTURE.md section 2.2) — that is the whole reason the
 * frontend can also run in a plain browser against `platform/mock.ts`.
 *
 * Commands land with their own tasks — assets T-21, `asset://` T-22, docstore
 * T-20, clipboard T-23, export T-94, sync T-69 — and until one has, its call
 * here rejects with "command not found". That is the correct failure and the
 * reason the whole surface is written down before any of it works: the interface
 * is the contract, and it is what stops `invoke` calls sprouting across the
 * renderer later. Sync is the half still outstanding.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
 * Split a raw response body into its length-prefixed frames.
 *
 * ```text
 * blob  := frame(snapshot) frame(update)*
 * frame := [u32 le length][length bytes]
 * ```
 *
 * The other side is `DocState::into_blob` in `src-tauri/src/docstore.rs`. The
 * shape exists because the obvious alternative — `{snapshot: number[],
 * updates: number[][]}` over JSON — turns a ten-megabyte snapshot into forty
 * megabytes of decimal digits, which is the same mistake as base64-ing a
 * photograph across IPC (ARCHITECTURE section 4.3).
 *
 * Each frame is a view onto the response buffer, not a copy: `applyUpdate`
 * reads them once and never keeps them.
 *
 * Takes either shape a raw response body can arrive in — Tauri hands back an
 * `ArrayBuffer` today, and a view of one would decode to nonsense through a
 * `DataView` built on the wrong offset rather than failing outright.
 */
function readFrames(body: ArrayBuffer | Uint8Array): Uint8Array[] {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: Uint8Array[] = [];
  let at = 0;
  while (at + 4 <= bytes.byteLength) {
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > bytes.byteLength) {
      throw new Error("doc_load returned a truncated frame");
    }
    frames.push(bytes.subarray(at, at + length));
    at += length;
  }
  return frames;
}

export class TauriPlatform implements Platform {
  readonly kind = "tauri" as const;

  // Passing a Uint8Array as the whole payload sends it as a raw request body
  // rather than a JSON array of numbers — a third smaller and no serialisation
  // stall (ARCHITECTURE section 4.4).
  //
  // The mime rides on a header of our own and not on `Content-Type`, which is
  // how Tauri itself decides the payload is raw in the first place. Rust treats
  // it as a hint anyway and trusts the magic numbers first.
  assetIngestBytes(bytes: Uint8Array, mime?: string): Promise<AssetMeta> {
    return invoke<AssetMeta>(
      "asset_ingest_bytes",
      bytes,
      mime ? { headers: { "x-asset-mime": mime } } : undefined,
    );
  }

  assetIngestPath(path: string): Promise<AssetMeta> {
    return invoke<AssetMeta>("asset_ingest_path", { path });
  }

  assetIngestUrl(url: string): Promise<AssetMeta> {
    return invoke<AssetMeta>("asset_ingest_url", { url });
  }

  assetHas(hashes: string[]): Promise<boolean[]> {
    return invoke<boolean[]>("asset_has", { hashes });
  }

  // A hash and a suggested name — no destination. The path comes from a native
  // save dialog on the Rust side, because this is the one command where the
  // renderer choosing the path would be the renderer choosing what to overwrite
  // (T-94). The name is a suggestion Rust reduces before the dialog sees it.
  assetExport(sha256: string, origName?: string): Promise<boolean> {
    return invoke<boolean>("asset_export", { sha256, origName });
  }

  assetGc(keep: string[]): Promise<{ freedBytes: number }> {
    return invoke<{ freedBytes: number }>("asset_gc", { keep });
  }

  /**
   * Never through IPC. The scheme handler streams from disk.
   *
   * The URL is *not* the same on every platform: WebView2 cannot register a
   * real custom scheme, so Tauri maps `asset` onto `http://asset.localhost/...`
   * on Windows and Android while macOS and Linux get `asset://localhost/...`.
   * `convertFileSrc` is Tauri's own answer to that question, and hard-coding
   * either form would produce an application that works on one developer's
   * machine and shows nothing but grey rectangles on another's.
   */
  assetUrl(sha256: string, variant: AssetVariant = "display"): string {
    return `${convertFileSrc(sha256, "asset")}?v=${variant}`;
  }

  docAppendUpdate(bytes: Uint8Array): Promise<void> {
    // Coalescing into ~200ms / 32kB batches is crdt/persistence.ts's job; by
    // the time a call reaches here it is already a batch.
    return invoke<void>("doc_append_update", bytes);
  }

  /**
   * The snapshot leads, and is a zero-length frame on a document that has never
   * been compacted. Rust refuses to write an empty snapshot, so "absent" and
   * "empty" cannot be confused for one another.
   */
  async docLoad(): Promise<DocState> {
    const frames = readFrames(await invoke<ArrayBuffer | Uint8Array>("doc_load"));
    const [snapshot, ...updates] = frames;
    return {
      snapshot: snapshot && snapshot.byteLength > 0 ? snapshot : null,
      updates,
    };
  }

  docCompact(snapshot: Uint8Array): Promise<void> {
    return invoke<void>("doc_compact", snapshot);
  }

  clipboardReadManifest(): Promise<ClipboardManifest> {
    return invoke<ClipboardManifest>("clipboard_read_manifest");
  }

  clipboardReadItem(kind: ClipboardKind): Promise<ClipboardPayload | null> {
    return invoke<ClipboardPayload | null>("clipboard_read_item", { kind });
  }

  syncStart(config: SyncConfig): Promise<void> {
    return invoke<void>("sync_start", { config });
  }

  syncStop(): Promise<void> {
    return invoke<void>("sync_stop");
  }

  syncStatus(): Promise<SyncStatus> {
    return invoke<SyncStatus>("sync_status");
  }

  peerWant(sha256: string, priority: number): Promise<void> {
    return invoke<void>("peer_want", { sha256, priority });
  }

  async on<K extends keyof PlatformEvents>(
    event: K,
    handler: (payload: PlatformEvents[K]) => void,
  ): Promise<Unlisten> {
    return await listen<PlatformEvents[K]>(event, (e) => handler(e.payload));
  }
}
