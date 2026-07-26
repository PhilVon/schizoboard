/**
 * Getting things onto the board.
 *
 * > **Paste is the primary verb.** `Ctrl+V` and the board figures it out.
 * > [...] Paste point is the cursor if it's over the board, otherwise the
 * > viewport centre. Dragging files in from the OS behaves identically.
 * > — DESIGN section 3.1
 *
 * This is the orchestration; the decisions are in `lib/ingest.ts`, which is
 * pure and where the interesting cases are tested. What lives here is the part
 * that talks to the clipboard, the shell and the document.
 *
 * ## The fast path, and what it turned out to cover
 *
 * > Try the web `paste` event first — it's the fast path, needs no permission,
 * > and handles inline images and text well. Fall back to native when it comes
 * > back empty or reports zero-length files, which is what happens with
 * > Explorer and Finder file copies. — ARCHITECTURE section 4.5
 *
 * Measured rather than assumed, because the answer decides how much of this
 * has to be native. On Windows and WebView2 an Explorer copy of three files
 * arrives at the web `paste` event as three `File`s with their real types and
 * real byte lengths — so the case the fallback exists for does not arise there,
 * and everything below step one is currently unreachable on this platform. The
 * ordering stays because the policy is right and other platforms are not
 * measured yet; what is *not* here is native code written on the strength of an
 * assumption that turned out to be wrong on the only platform anyone has run.
 *
 * ## One paste, one undo entry
 *
 * Every payload is resolved before a single item is created, and then all of
 * them are created in one `createItems` call — one transaction, one entry, one
 * update on the wire, "even when it creates twenty items".
 *
 * Nothing here queues its document write the way `state/tools/` does. It does
 * not need to: this runs from a promise continuation, and a microtask cannot
 * interleave with a frame — the nine phases run to completion inside one
 * `requestAnimationFrame` callback, so a write from here always lands between
 * frames rather than in the middle of one.
 */

import { createItems, type CreateItemInput } from "@/crdt/ops";
import type { BoardDoc } from "@/crdt/doc";
import {
  decodeDataUrl,
  isHttpUrl,
  layout,
  looksLikeImageUrl,
  readHtml,
  resolveAgainst,
  type BoardPoint,
  type Ingested,
} from "@/app/ingest";
import type { AssetMeta, Platform } from "@/platform/types";
import type { Camera } from "@/state/camera";
import { isTextTarget } from "@/state/input";

/**
 * Most items one paste will create.
 *
 * Selecting a folder of four hundred photographs and pressing Ctrl+V is a thing
 * people do by accident. The cap is high enough that no deliberate paste hits
 * it and low enough that an accidental one is survivable — and when it does
 * bite it says so, because a paste that silently drops half of what you gave it
 * is worse than one that refuses.
 */
const MAX_PER_PASTE = 50;

/**
 * Most things one paste will go to the network for.
 *
 * A separate, much smaller budget than the item cap, because a remote fetch is
 * not a local read: each one can hold a blocking thread for the shell's
 * thirty-second timeout, and they run in turn. Fifty of those is twenty-five
 * minutes of a paste that has put nothing on the board yet. A copied image is
 * one; a fragment carrying more than a handful is not the case this is for.
 */
const MAX_REMOTE_FETCHES = 8;

export interface PasteOptions {
  native: Platform;
  board: BoardDoc;
  camera: Camera;
  /** Last known cursor position in screen space, or null when the pointer is
   *  not over the board. */
  cursor: () => { x: number; y: number } | null;
  /** The ids of everything a paste created, in order. */
  onCreated?: (itemIds: string[]) => void;
}

/** Everything the clipboard held, read *synchronously* — see `onPaste`. */
interface Snapshot {
  files: File[];
  text: string;
  html: string;
}

export class Paste {
  private readonly options: PasteOptions;
  private readonly disposers: (() => void)[] = [];
  /**
   * Ingestions run one after another, in the order they were asked for.
   *
   * Not for safety — nothing here races on shared state — but because a paste
   * takes as long as its slowest fetch, and without this a quick second paste
   * finishes first. That reorders `z` (each batch stacks above the last), and
   * it hands the selection to whichever paste happened to finish last rather
   * than to the one the user made last. A drop landing mid-paste does the same.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PasteOptions) {
    this.options = options;
  }

  async attach(): Promise<void> {
    const onPaste = (e: ClipboardEvent): void => this.onPaste(e);
    window.addEventListener("paste", onPaste, true);
    this.disposers.push(() => window.removeEventListener("paste", onPaste, true));

    // Files dragged in from the OS never reach the webview: the shell
    // intercepts the drop and hands over paths, which is what lets the bytes go
    // straight into the store without ever touching JavaScript.
    const unlisten = await this.options.native.on("files:dropped", ({ paths, x, y }) => {
      // Where it was dropped, read now rather than when the bytes finish
      // arriving — same reason as `onPaste`.
      const at = this.options.camera.screenToBoard(x, y);
      this.enqueue(async () => this.create(await this.ingestPaths(paths), at));
    });
    this.disposers.push(unlisten);
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  /**
   * The handler is synchronous for a reason: a `DataTransfer` is only valid for
   * the duration of the event it arrived on. Read anything from it after the
   * first `await` and it is empty — the files have to be taken out *now*, and
   * the `File` objects that come out stay readable afterwards.
   */
  private onPaste(event: ClipboardEvent): void {
    if (isTextTarget(event.target)) return;
    const data = event.clipboardData;
    const clip: Snapshot = {
      files: data ? Array.from(data.files) : [],
      text: data?.getData("text/plain") ?? "",
      html: data?.getData("text/html") ?? "",
    };
    // Where the paste happened, not where the cursor ends up once the bytes
    // have arrived. Ingestion can take a moment for a file and up to thirty
    // seconds for a URL, and in that time the pointer moves, the camera pans,
    // and the pointer leaves the window — which would put the item at the
    // viewport centre instead. The drop route captures its point for the same
    // reason, and the two have to agree: "Dragging files in from the OS behaves
    // identically" (DESIGN section 3.1).
    const at = this.pastePoint();
    event.preventDefault();
    this.enqueue(async () => {
      const payloads = await this.resolve(clip);
      if (payloads.length === 0 && hadSomething(clip)) {
        console.warn("paste: nothing on the clipboard this board could take", {
          files: clip.files.map((f) => `${f.name || "?"} (${f.type || "no type"}, ${f.size}B)`),
          text: clip.text.slice(0, 80),
          html: clip.html.slice(0, 80),
        });
      }
      this.create(payloads, at);
    });
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch((error) => {
      // The chain must survive a failure or every later paste is dropped too.
      console.warn("paste failed:", error);
    });
  }

  private create(payloads: readonly Ingested[], at: BoardPoint): void {
    if (payloads.length === 0) return;
    const inputs: CreateItemInput[] = layout(payloads, at);
    const created = createItems(this.options.board, inputs);
    this.options.onCreated?.(created.map((item) => item.itemId));
  }

  /** The cursor if it is over the board, otherwise the middle of the view. */
  private pastePoint(): BoardPoint {
    const { camera } = this.options;
    const cursor = this.options.cursor();
    const screen = cursor ?? { x: camera.width / 2, y: camera.height / 2 };
    return camera.screenToBoard(screen.x, screen.y);
  }

  /**
   * The six cases of DESIGN section 3.1, in the order they have to be tried.
   *
   * Order is the whole design. Copying an image out of a web browser puts
   * *three* things on the clipboard at once — the bytes, a fragment of markup
   * pointing at the original, and the page's text — and taking the last of
   * those would turn a photograph into a note. First usable answer wins.
   */
  private async resolve(clip: Snapshot): Promise<Ingested[]> {
    const attempts = [
      () => this.fromFiles(clip.files),
      () => this.fromNativeClipboard(),
      () => this.fromHtml(clip.html),
      () => this.fromText(clip.text),
    ];
    for (const attempt of attempts) {
      const found = await attempt();
      if (found.length > 0) return found;
    }
    return [];
  }

  /**
   * Bytes on the clipboard, inline or from a file copy the webview could read.
   *
   * Everything with any content is offered to the store and judged on what came
   * back, rather than filtered on `File.type` first. That type is derived from
   * the file *name* — on Windows, from the registry's entry for the extension —
   * and it is empty for `.heic`, for camera RAW, and for `.webp` on an install
   * without the key. Filtering on it drops those with no item, no warning and
   * no way to tell the paste was received, while dragging the identical file in
   * works, because the drop route asks the bytes.
   *
   * Zero-length entries are the OS offering a name rather than a file; they
   * ingest to nothing, fail the check, and let the native fallback have a go.
   */
  private async fromFiles(files: readonly File[]): Promise<Ingested[]> {
    const out: Ingested[] = [];
    for (const file of this.capped(files, "things on the clipboard")) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length === 0) continue;
        const meta = await this.options.native.assetIngestBytes(bytes, file.type || undefined);
        this.accept(out, meta, file.name || "clipboard", file.name);
      } catch (error) {
        // One unreadable file must not take the rest of the paste with it. The
        // clipboard's copy of a file can be gone by the time it is asked for.
        console.warn(`could not read ${file.name || "a clipboard file"}:`, error);
      }
    }
    return out;
  }

  /**
   * Take an ingested payload if it turned out to be a picture.
   *
   * The evidence is the store's, not the caller's: `mime` is sniffed from the
   * magic numbers, and non-zero dimensions mean it actually decoded. Both are
   * needed. A `data:image/png;base64,<anything>` from a hostile page arrives
   * with a mime *hint* the store falls back to when the bytes say nothing, so
   * the type alone would let arbitrary content onto the board as a polaroid of
   * a blank square — and so would any URL that answered 200 with an HTML
   * interstitial or a tracking pixel's JSON.
   */
  private accept(out: Ingested[], meta: AssetMeta, what: string, origName?: string): void {
    if (!meta.mime.startsWith("image/") || meta.w <= 0 || meta.h <= 0) {
      console.warn(`not a picture, so nothing to put on the board: ${what} (${meta.mime})`);
      return;
    }
    out.push({
      kind: "image",
      sha256: meta.sha256,
      asset: {
        w: meta.w,
        h: meta.h,
        mime: meta.mime,
        size: meta.size,
        ...(origName ? { origName } : {}),
      },
    });
  }

  /** Ask the shell what it can see that the webview could not. */
  private async fromNativeClipboard(): Promise<Ingested[]> {
    try {
      const manifest = await this.options.native.clipboardReadManifest();
      if (!manifest.kinds.includes("files")) return [];
      const payload = await this.options.native.clipboardReadItem("files");
      if (payload?.kind !== "files") return [];
      return await this.ingestPaths(payload.paths);
    } catch {
      // A shell that does not implement the fallback is not an error — it is
      // the browser, or a platform where the fast path already covers this.
      return [];
    }
  }

  private async ingestPaths(paths: readonly string[]): Promise<Ingested[]> {
    const out: Ingested[] = [];
    for (const path of this.capped(paths, "files")) {
      try {
        this.accept(out, await this.options.native.assetIngestPath(path), path, baseName(path));
      } catch (error) {
        console.warn(`could not read ${path}:`, error);
      }
    }
    return out;
  }

  /**
   * "Copy image from a web page" — markup on the clipboard, picture elsewhere.
   *
   * Only when the fragment is *just* an image. Copying a paragraph that happens
   * to contain an inline formula or a signature logo also puts markup with an
   * `<img>` on the clipboard, and taking that route would make a polaroid of a
   * thirty-pixel icon and throw the prose away. The row in DESIGN section 3.1
   * is about copying an image; a fragment with words in it is the row below.
   */
  private async fromHtml(html: string): Promise<Ingested[]> {
    const { images, relative, text } = readHtml(html);
    if (text.length > 0) return [];

    let sources = images;
    if (sources.length === 0 && relative.length > 0) {
      // The ordinary case for an image copied out of a page: `<img src="/a.jpg">`,
      // which means nothing without the page it came from. That is in a CF_HTML
      // header the webview strips, so it takes a trip to the shell — worth it
      // only here, where there is otherwise nothing at all to fetch.
      const base = await this.options.native.clipboardSourceUrl().catch(() => null);
      if (base) sources = resolveAgainst(relative, base);
    }
    if (sources.length === 0) return [];

    const out: Ingested[] = [];
    for (const source of this.capped(
      sources.slice(0, MAX_REMOTE_FETCHES),
      "images in the pasted markup",
    )) {
      await this.fetchImage(out, source);
    }
    return out;
  }

  private async fromText(raw: string): Promise<Ingested[]> {
    const text = raw.trim();
    if (!text) return [];
    // "A URL: note showing the URL; if it's an image URL, fetched natively (no
    // CORS wall) and made a polaroid."
    if (looksLikeImageUrl(text)) {
      const out: Ingested[] = [];
      await this.fetchImage(out, text);
      if (out.length > 0) return out;
      // The fetch failed, or what came back was not a picture. The URL is still
      // what the user copied, so it falls through and becomes a note — which is
      // the other half of the same row.
    }
    return [{ kind: "text", text }];
  }

  private async fetchImage(out: Ingested[], source: string): Promise<void> {
    const { native } = this.options;
    try {
      const decoded = decodeDataUrl(source);
      if (decoded) {
        this.accept(out, await native.assetIngestBytes(decoded.bytes, decoded.mime), "a data URL");
        return;
      }
      if (!isHttpUrl(source)) return;
      this.accept(out, await native.assetIngestUrl(source), source, baseName(source));
    } catch (error) {
      // Not fatal, and not silent. A photograph that would not come is a note
      // with its address on it, which is more use than nothing.
      console.warn(`could not fetch ${source}:`, error);
    }
  }

  private capped<T>(values: readonly T[], what: string): readonly T[] {
    if (values.length <= MAX_PER_PASTE) return values;
    console.warn(`paste: taking ${MAX_PER_PASTE} of ${values.length} ${what}`);
    return values.slice(0, MAX_PER_PASTE);
  }
}

/** Did the clipboard hold anything at all? Used only to tell a paste that found
 *  nothing from a paste of nothing. */
function hadSomething(clip: Snapshot): boolean {
  return clip.files.length > 0 || clip.text.trim().length > 0 || clip.html.trim().length > 0;
}

/** The last path or URL segment, kept as the asset's `origName` — the one piece
 *  of provenance that is gone the moment ingestion returns. */
function baseName(pathOrUrl: string): string | undefined {
  const withoutQuery = pathOrUrl.split(/[?#]/)[0] ?? "";
  const last = withoutQuery.split(/[\\/]/).pop();
  return last && last.length > 0 ? last : undefined;
}
