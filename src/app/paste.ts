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
import { boardSealed, type BoardDoc } from "@/crdt/doc";
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
import { assetKind } from "@/lib/objects";
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
  /**
   * The board's own clipboard, asked first — true means this paste was its
   * paper and has already been put down (`app/clipboard.ts`).
   *
   * A question rather than a second `paste` listener, because two listeners
   * deciding the same thing independently are ordered only by the order they
   * happened to be registered in.
   */
  claim?: (data: DataTransfer | null, at: BoardPoint) => boolean;
  /**
   * Say one line to the person, transiently — `ui/flash.ts`, which is where
   * the export report and the board's other passing remarks already go.
   *
   * Optional because a `Paste` in a test has nobody to talk to, and because a
   * refusal that cannot be announced is still a refusal.
   */
  say?: (message: string) => void;
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
  /**
   * What this run of the queue could not put down, named for the person.
   *
   * An instance field rather than a return value because refusals happen four
   * routes deep — `fromFiles`, the native clipboard, the HTML fragment and the
   * OS drop all funnel into `accept` — and threading a second list back out of
   * all of them would be four signatures changed to carry one sentence. Safe
   * because `queue` serialises runs: one paste is finished with this before the
   * next one starts.
   */
  private refused: string[] = [];

  /**
   * Paths this run has already handed to the store.
   *
   * Two routes now ask the shell the same question — `fromFiles`, for the file
   * it is already holding bytes for, and `fromNativeClipboard` behind it — and
   * a file ingested twice would be *refused* twice, counted twice against the
   * cap, and named twice in the notice. An instance field for the same reason
   * `refused` is one, and safe for the same reason: `queue` serialises runs.
   */
  private tried = new Set<string>();

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
      // The shell has the paths and has not read them yet, so a sealed board
      // costs nothing here either — see `onPaste`.
      if (boardSealed(this.options.board)) return;
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
    // A board this build may not write to (T-224). Refused here rather than in
    // `create` so that nothing is fetched or ingested first: a URL paste is up
    // to thirty seconds of network and a file paste puts bytes in the store,
    // and both would be work done for an item that is never going to exist.
    // Not `preventDefault`ed — the board is not a text field, so letting the
    // event go on its way does nothing at all.
    if (boardSealed(this.options.board)) return;
    const data = event.clipboardData;
    // Asked before anything is read out of the transfer: a token of ours on the
    // system clipboard means the last copy on this machine was a piece of this
    // board, and what should land is the paper rather than the text describing
    // it. Anything copied anywhere since takes the token with it, which is the
    // whole of how the two clipboards decide who is more recent.
    if (this.options.claim?.(data, this.pastePoint()) === true) {
      event.preventDefault();
      return;
    }
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

  /**
   * Something was handed over that this board cannot hold.
   *
   * Collected rather than said one at a time: dragging a folder in is one
   * gesture, and four lines about four files is four times the punishment for
   * it. Reported by `create`, which is the end of every route.
   */
  private refuse(what: string, why: string): void {
    console.warn(`nothing to put on the board: ${what} — it ${why}`);
    this.refused.push(what);
  }

  /**
   * Say what was left out, if anything was.
   *
   * **A notice rather than silence** (AC-651). A file that lands nowhere and
   * says nothing is indistinguishable from a paste that did not happen — and
   * the person is then left wondering whether the board is broken, which is a
   * worse state to be in than being told no.
   *
   * Plain register on purpose, the same choice `state/missing.ts` makes for its
   * line: this is a corkboard, and "⚠ UNSUPPORTED FILE TYPE" is exactly what
   * the whole design is avoiding.
   */
  private sayWhatWasRefused(): void {
    const refused = this.refused;
    this.refused = [];
    if (refused.length === 0) return;
    const say = this.options.say;
    if (!say) return;
    if (refused.length === 1) {
      say(`Nothing here can hold ${refused[0]}`);
      return;
    }
    say(`Nothing here can hold ${refused.length} of those — ${refused.join(", ")}`);
  }

  private create(payloads: readonly Ingested[], at: BoardPoint): void {
    // Before the early return, not after it: a paste of nothing but refusals is
    // exactly the case that most needs saying out loud.
    this.sayWhatWasRefused();
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
    // Cleared here rather than at the end of the last run, on the same argument
    // `sayWhatWasRefused` makes: a run that threw would otherwise leave its
    // paths behind and silently skip them on the next paste.
    this.tried.clear();
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
    const taken = this.capped(files, "things on the clipboard");
    const paths = await this.pathsFor(taken);
    for (const [index, file] of taken.entries()) {
      const path = paths[index];
      try {
        if (path !== undefined) {
          this.tried.add(path);
          this.accept(out, await this.options.native.assetIngestPath(path), path, baseName(path));
          continue;
        }
      } catch (error) {
        // A path the shell named and the shell cannot open — a virtual file out
        // of an archive or a mail client, or something moved between the copy
        // and the paste. The webview is still holding bytes for it, so this is
        // a reason to take the slow road rather than to lose the file.
        console.warn(`could not read ${path}, falling back to its bytes:`, error);
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length === 0) continue;
        const meta = await this.options.native.assetIngestBytes(bytes, file.type || undefined);
        this.accept(out, meta, file.name || "clipboard", file.name);
      } catch (error) {
        // One unreadable file must not take the rest of the paste with it. The
        // clipboard's copy of a file can be gone by the time it is asked for.
        //
        // Refused rather than only logged, because this is the *end* of the road
        // for this file — the path attempt above falls through on purpose and is
        // the one place a failure here is not final. A file that reaches this
        // line and says nothing is indistinguishable from a paste that never
        // happened, which is the state AC-651 exists to prevent, and it is how a
        // picture refused for its pixels would have vanished (T-308).
        this.refuse(file.name || "a clipboard file", `would not read: ${String(error)}`);
      }
    }
    return out;
  }

  /**
   * The path behind each `File`, where the shell can name one.
   *
   * **This is a cheaper road to the same place, not a fifth case.** The four
   * routes in `resolve` are competing readings of one clipboard and their order
   * is the design; this is asked *inside* the file route, so it can only ever
   * change how a file's bytes reach the store and never which reading wins. Ask
   * it beside the others instead and a clipboard carrying `CF_HDROP` *and*
   * markup — Outlook, some Office copies — would stop being a note and start
   * being a file, which is a different feature.
   *
   * Worth the round trip because the bytes are otherwise read into the JS heap
   * and pushed back over the IPC boundary, and that boundary is about 55 MiB/s
   * against `asset_ingest_path`'s nothing at all (T-266, D-51). It costs about
   * 7 ms, and only when the webview handed over files in the first place — a
   * paste of text or markup never asks.
   *
   * Paired by **file name**, and only where that is unambiguous: the shell
   * reports the clipboard's own order and so does the webview, but nothing
   * promises they are the same list, and two files with one name between them
   * is not worth guessing about. Anything unmatched simply keeps its bytes.
   */
  private async pathsFor(files: readonly File[]): Promise<(string | undefined)[]> {
    const none = files.map(() => undefined);
    if (files.length === 0) return none;
    let paths: readonly string[];
    try {
      const payload = await this.options.native.clipboardReadItem("files");
      if (payload?.kind !== "files" || payload.paths.length === 0) return none;
      paths = payload.paths;
    } catch {
      // A shell that cannot answer is not an error — it is the browser, or a
      // platform this has not been written for. The bytes are right there.
      return none;
    }
    const byName = new Map<string, string[]>();
    for (const path of paths) {
      // A path the shell named with nothing after the last separator has no
      // name to pair a `File` with, so it stays in the fallback's hands.
      const name = baseName(path);
      if (name === undefined) continue;
      const bucket = byName.get(name);
      if (bucket) bucket.push(path);
      else byName.set(name, [path]);
    }
    return files.map((file) => {
      const bucket = file.name ? byName.get(file.name) : undefined;
      return bucket?.length === 1 ? bucket[0] : undefined;
    });
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
    const kind = assetKind(meta.mime);
    // Decided from the sniffed bytes and never from the name. `meta.mime` is
    // the shell's answer after reading the magic numbers (`assets.rs`), so a
    // `.jpg` holding a zip is a zip here — which is the point of AC-650: an
    // extension is what somebody typed, and this gate is the one place the
    // board decides what it is holding.
    if (kind === "unknown") {
      this.refuse(what, "is not a picture, a film, a recording or a document");
      return;
    }
    // A picture is the one kind judged on its box, because a picture that will
    // not decode has no other way of being wrong: the bytes are there, the mime
    // is right, and the item would hang on the wall as a frame around nothing.
    // A cassette has no box and is not judged on one (T-261).
    if (kind === "image" && (meta.w <= 0 || meta.h <= 0)) {
      this.refuse(what, "says it is a picture and will not open as one");
      return;
    }
    out.push({
      kind: "asset",
      sha256: meta.sha256,
      asset: {
        w: meta.w,
        h: meta.h,
        mime: meta.mime,
        size: meta.size,
        ...(origName ? { origName } : {}),
        // Carried from here even though the gate above still only lets
        // pictures past, and a picture never has one. The shell measures this
        // at ingest for whatever it was handed (T-300), and the moment the
        // gate learns about kinds (T-260) a cassette arrives through this
        // same line with its duration already on it. Dropping it here would
        // mean the record is written without a duration the shell already
        // knew — and there is no second chance to measure it on a peer that
        // never holds the bytes.
        ...(meta.duration !== null ? { duration: meta.duration } : {}),
        // And the page count, on exactly the same argument (AC-668). A folder's
        // thickness reaches a peer ahead of the file, and there is no second
        // chance to count the pages of a document that machine never holds.
        //
        // Its sibling does not come through here. What the document says it is
        // *called* is derived locally and never enters the record (Q-211), so
        // there is nothing to carry — the folder asks for it separately, against
        // a file this machine has.
        ...(meta.pages !== null ? { pages: meta.pages } : {}),
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
    // Not what `fromFiles` already took by path. It runs first and now asks the
    // shell the same question, so without this a file it ingested and `accept`
    // *refused* would be ingested and refused a second time here — and the
    // notice would read "Nothing here can hold 2 of those — backup.zip,
    // C:/backup.zip", one file counted twice against one paste.
    const fresh = paths.filter((path) => !this.tried.has(path));
    for (const path of this.capped(fresh, "files")) {
      try {
        this.tried.add(path);
        this.accept(out, await this.options.native.assetIngestPath(path), path, baseName(path));
      } catch (error) {
        // Said rather than swallowed, on the same argument as `fromFiles`: this
        // road has no fallback behind it, so a file that fails here is a file
        // the person watched disappear.
        this.refuse(path, `would not read: ${String(error)}`);
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
