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
  BundleOpened,
  BundleSpec,
  BundleWritten,
  ClipboardKind,
  ClipboardManifest,
  ClipboardPayload,
  DocState,
  ExportKind,
  PdfPage,
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

  /**
   * A little JSON in front of a lot of bytes: `[u32 le length][json][snapshot]`,
   * the same framing `docLoad` reads back and for the same reason.
   *
   * Tauri's raw body is all-or-nothing — a command takes a raw payload or it
   * takes JSON arguments, never both — and the snapshot has to be raw. Sending
   * it as a JSON array of numbers is the mistake ARCHITECTURE section 4.3
   * already rejected for photographs, and putting the manifest in a header
   * makes a five-hundred-photograph board's asset list thirty kilobytes of
   * header. `bundle::split_payload` is the other end.
   */
  async bundleSaveAs(spec: BundleSpec, snapshot: Uint8Array): Promise<BundleWritten | null> {
    const json = new TextEncoder().encode(JSON.stringify(spec));
    const payload = new Uint8Array(4 + json.byteLength + snapshot.byteLength);
    new DataView(payload.buffer).setUint32(0, json.byteLength, true);
    payload.set(json, 4);
    payload.set(snapshot, 4 + json.byteLength);
    return invoke<BundleWritten | null>("bundle_save_as", payload);
  }

  async bundleOpen(): Promise<BundleOpened | null> {
    const body = await invoke<ArrayBuffer | Uint8Array>("bundle_open");
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    // An empty body is a cancelled dialog — a `Response` has no room for the
    // `null` the save side can return.
    if (bytes.byteLength === 0) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(0, true);
    if (4 + length > bytes.byteLength) {
      throw new Error("bundle_open returned a truncated manifest");
    }
    const opened = JSON.parse(
      new TextDecoder().decode(bytes.subarray(4, 4 + length)),
    ) as Omit<BundleOpened, "snapshot">;
    return { ...opened, snapshot: bytes.subarray(4 + length) };
  }

  // A name and then a page, and no destination in either direction — the third
  // place on that standing (T-207). The path the user picks stays in the shell
  // between the two calls. Nothing of the board itself crosses: it prints its
  // own webview, so `app/exportPdf.ts` has already put the board where the page
  // needs it by the time the write is called.
  exportChoose(title: string, kind: ExportKind): Promise<boolean> {
    return invoke<boolean>("export_choose", { title, kind });
  }

  exportPdfWrite(page: PdfPage): Promise<string> {
    return invoke<string>("export_pdf_write", { page });
  }

  // Raw, for the reason `assetIngestBytes` is: a four-megabyte PNG as a JSON
  // array of numbers is about six times the bytes and a parse stall on top.
  exportImageWrite(bytes: Uint8Array): Promise<string> {
    return invoke<string>("export_image_write", bytes);
  }

  clipboardReadManifest(): Promise<ClipboardManifest> {
    return invoke<ClipboardManifest>("clipboard_read_manifest");
  }

  clipboardReadItem(kind: ClipboardKind): Promise<ClipboardPayload | null> {
    return invoke<ClipboardPayload | null>("clipboard_read_item", { kind });
  }

  clipboardSourceUrl(): Promise<string | null> {
    return invoke<string | null>("clipboard_source_url");
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

  syncTakeInvite(): Promise<string | null> {
    return invoke<string | null>("sync_take_invite");
  }

  rememberedBoardId(): Promise<string | null> {
    return invoke<string | null>("board_remembered");
  }

  rememberBoardId(boardId: string): Promise<void> {
    return invoke<void>("board_remember", { boardId });
  }

  peerHaveSummary(): Promise<string[]> {
    return invoke<string[]>("peer_have_summary");
  }

  assetSize(sha256: string): Promise<number> {
    return invoke<number>("asset_size", { sha256 });
  }

  // Raw both ways, for the same reason `assetIngestBytes` is: a 256 KB chunk as
  // a JSON array of numbers is about six times the bytes and a parse stall on
  // every one of them. Tauri hands a raw response back as an ArrayBuffer.
  async assetChunk(sha256: string, index: number): Promise<Uint8Array> {
    const bytes = await invoke<ArrayBuffer | Uint8Array>("asset_chunk", { sha256, index });
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  // The chunk is the whole payload, so the three things Rust needs to file it
  // ride on headers — the same trick `asset_ingest_bytes` plays with the mime.
  assetReceive(sha256: string, index: number, total: number, bytes: Uint8Array): Promise<void> {
    return invoke<void>("asset_receive", bytes, {
      headers: {
        "x-asset-sha256": sha256,
        "x-asset-index": String(index),
        "x-asset-total": String(total),
      },
    });
  }

  assetCommit(sha256: string): Promise<boolean> {
    return invoke<boolean>("asset_commit", { sha256 });
  }

  assetAbort(sha256: string): Promise<void> {
    return invoke<void>("asset_abort", { sha256 });
  }

  async on<K extends keyof PlatformEvents>(
    event: K,
    handler: (payload: PlatformEvents[K]) => void,
  ): Promise<Unlisten> {
    return await listen<PlatformEvents[K]>(event, (e) => handler(e.payload));
  }
}
