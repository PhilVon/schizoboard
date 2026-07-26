/**
 * The real native boundary. **Every `invoke()` in the application is in this
 * file** (docs/ARCHITECTURE.md section 2.2) — that is the whole reason the
 * frontend can also run in a plain browser against `platform/mock.ts`.
 *
 * Most of the Rust side does not exist yet; the commands land with their own
 * tasks (assets T-21, `asset://` T-22, docstore T-20, clipboard T-23, sync
 * T-69). Until then these calls reject with "command not found", which is the
 * correct failure: the interface is the contract, and writing it down first is
 * what stops `invoke` calls sprouting across the renderer later.
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

/** Rust returns frames as plain byte arrays over the response body. */
function toBytes(value: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(value);
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

  assetExport(sha256: string, dest: string): Promise<void> {
    return invoke<void>("asset_export", { sha256, dest });
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
    // Coalescing into ~200ms / 32kB batches is crdt/persistence.ts's job
    // (T-20); by the time a call reaches here it is already a batch.
    return invoke<void>("doc_append_update", bytes);
  }

  async docLoad(): Promise<DocState> {
    const raw = await invoke<{
      snapshot: number[] | null;
      updates: number[][];
    }>("doc_load");
    return {
      snapshot: raw.snapshot ? toBytes(raw.snapshot) : null,
      updates: raw.updates.map(toBytes),
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
