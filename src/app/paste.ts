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

import { attachTranscript, createItems, type CreateItemInput } from "@/crdt/ops";
import { boardSealed, type BoardDoc } from "@/crdt/doc";
import {
  decodeDataUrl,
  isHttpUrl,
  layout,
  looksLikeFileUrl,
  readHtml,
  resolveAgainst,
  tooMuchForANote,
  type BoardPoint,
  type Ingested,
} from "@/app/ingest";
import { assetKind, type SourceAbout } from "@/lib/objects";
import type { AssetMeta, PageCard, Platform, Refusal } from "@/platform/types";
import { refusalOf } from "@/platform/types";
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

/**
 * The spellings a transcript sits beside a recording under — T-287.
 *
 * `.srt` first because it is what anybody's tooling emits and what a broadcaster
 * hands over; `.vtt` second because it is the one a browser wants. Two and not a
 * list: every further spelling is another disk probe on every recording anybody
 * ever drops, paid by everyone to serve nobody until somebody asks.
 */
const SIDECAR_EXTENSIONS = [".srt", ".vtt"] as const;

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
  /**
   * Is something covering the board — T-324.
   *
   * True only while a film is on the set, which is the one thing in this
   * application that takes the screen (DESIGN section 1.3). It is asked here
   * rather than swallowed at the set, and the reason is the whole of the bug:
   *
   * > `ui/crt.ts` is a capture-phase **keydown** listener, and a keydown swallow
   * > can only ever be a modal for keydowns.
   *
   * A `cut` is a different event from the `Ctrl`+`X` that caused it, so
   * `stopPropagation` on the key does nothing to it; and a file dragged in from
   * the OS arrives from the shell with no key involved at all. Two of the three
   * routes into this board are therefore not keydowns, so the modal cannot be
   * implemented once at the set however much one would like it to be. What
   * *can* be implemented once is the predicate, which is this — one function,
   * asked by the boundary that actually ingests.
   *
   * Optional, and false when absent: a harness with no set has nothing covering
   * its board, which is the honest answer rather than a missing one.
   */
  covered?: () => boolean;
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
  private refused: { what: string; why: string; holdsNowhere: boolean }[] = [];
  /**
   * And what this run would not even attempt, because there was too much of it
   * — `capped`, and one slot rather than a list (T-295).
   *
   * One, because a run that hits the ceiling on two of its routes at once is not
   * a thing that happens: a drop is files, a paste is the clipboard or the
   * markup in it. Latest wins, which is the honest answer if it ever does.
   */
  private overflowed: { what: string; took: number; of: number } | null = null;

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
    const unlisten = await this.options.native.on("files:dropped", ({ paths, x, y, found }) => {
      // The shell has the paths and has not read them yet, so a sealed board
      // costs nothing here either — see `onPaste`.
      if (boardSealed(this.options.board)) return;
      // **The route that settles where T-324's fix belongs.** A file dragged
      // onto the window while a film is on the set involves no keydown at all —
      // it comes from the shell — so no amount of swallowing at `ui/crt.ts`
      // could ever have stopped it. See [`PasteOptions.covered`].
      if (this.options.covered?.() === true) return;
      // Where it was dropped, read now rather than when the bytes finish
      // arriving — same reason as `onPaste`.
      const at = this.options.camera.screenToBoard(x, y);
      this.enqueue(async () => this.create(await this.ingestPaths(paths, found), at));
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
    // And nothing lands on a board somebody cannot see (T-324). Refused here
    // for the same reason the seal is: a paste is up to thirty seconds of
    // network and a fileful of bytes in the store, and both would be work done
    // for an item nobody asked for.
    if (this.options.covered?.() === true) return;
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
  private refuse(what: string, why: string, holdsNowhere = true): void {
    console.warn(`nothing to put on the board: ${what} — it ${why}`);
    this.refused.push({ what, why, holdsNowhere });
  }

  /**
   * Refuse a file the shell would not take, in the shell's own words.
   *
   * The sentence comes from the far side because that is the side holding the
   * numbers — a picture's shape, a paste ceiling — and it arrives as data
   * rather than as prose to match on (T-309). Anything that is not a
   * {@link Refusal} is something that went wrong before the command was
   * reached, and gets the sentence that claims least.
   */
  private refuseFromShell(what: string, error: unknown): void {
    const refusal = refusalOf(error);
    this.refuse(what, refusal?.say ?? "could not be read", refusal?.holdsNowhere ?? false);
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
   *
   * **Two things can be left out and there is one line to say them in** (T-295).
   * `flash.say` replaces rather than queues, so a second sentence would take the
   * first one down before anybody read it. The ceiling goes first because it is
   * the larger fact — how much of what you handed over was even looked at —
   * and the refusals follow as a clause about what was.
   */
  private sayWhatWasLeftOut(): void {
    const refused = this.refused;
    const over = this.overflowed;
    this.refused = [];
    this.overflowed = null;
    const say = this.options.say;
    if (!say) return;
    if (over !== null) {
      // **A claim about what was looked at, not about what landed**, and the
      // difference is not pedantry: the first wording said "putting down 50 of
      // 400" and then "50 could not be held" in the same breath, which is two
      // numbers that cannot both be true of the same fifty. The ceiling is on
      // how many were *taken up*; whether each one then found a place on the
      // board is the clause after it.
      //
      // "Stayed put" because they did: a folder is not consumed by being
      // dropped, and the files this did not reach are still where they were.
      const rest =
        refused.length === 0
          ? ""
          : `, and ${refused.length === 1 ? "one" : String(refused.length)} of those could not be held`;
      say(`Only the first ${over.took} of ${over.of} ${over.what} — the rest stayed put${rest}`);
      return;
    }
    if (refused.length === 0) return;
    if (refused.length === 1) {
      const [only] = refused;
      // **The reason, not just the fact** (Q-235). "Nothing here can hold this"
      // and no more leaves somebody to work out for themselves whether the file
      // is the wrong sort of thing, too big, or broken — three different things
      // to do next.
      //
      // And a file the board *could* hold by another road does not get told
      // that nothing here can hold it, because that sentence is a claim about
      // the board rather than about the attempt: a 400 MB interview refused by
      // the paste route is one drag away from working, and being told the board
      // cannot take it would be a lie that stops somebody trying.
      say(
        only.holdsNowhere
          ? `Nothing here can hold ${only.what} — it ${only.why}`
          : `${only.what} ${only.why}`,
      );
      return;
    }
    // The plural stays as it was. Four files with four reasons is four lines
    // again, which is what collecting them was for.
    const names = refused.map((one) => one.what);
    say(`Nothing here can hold ${names.length} of those — ${names.join(", ")}`);
  }

  private create(payloads: readonly Ingested[], at: BoardPoint): void {
    // Before the early return, not after it: a paste of nothing but refusals is
    // exactly the case that most needs saying out loud.
    this.sayWhatWasLeftOut();
    if (payloads.length === 0) return;
    const inputs: CreateItemInput[] = layout(payloads, at);
    const created = createItems(this.options.board, inputs);
    // After the items and in its own transaction, which is what keeps one
    // Ctrl+Z the undo of one paste: `Origin.SIDECAR` is off the undo stack, so
    // this cannot land on top of the thing the person actually did. It has to
    // come second rather than first — `createItems` is what registers the
    // recording's record, and `attachTranscript` is silent on a recording that
    // is not there (T-287).
    for (const payload of payloads) {
      if (payload.kind !== "asset" || payload.sidecar === undefined) continue;
      attachTranscript(
        this.options.board,
        payload.sha256,
        payload.sidecar.sha256,
        payload.sidecar.asset,
      );
    }
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
          // Only on this arm. The fallback below is holding bytes the webview
          // gave it and has no path at all, and a transcript is found by looking
          // *beside* a file — there is no beside without one (T-287).
          await this.sidecar(out, path);
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
        this.refuseFromShell(file.name || "a clipboard file", error);
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
   * it beside the others instead and a clipboard carrying a file list *and*
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
      // clipboard held for a moment by whoever last wrote it. The bytes are
      // right there. Since T-303 it is no longer a *platform* that cannot
      // answer: all three read the file list the same way.
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
  private accept(
    out: Ingested[],
    meta: AssetMeta,
    what: string,
    origName?: string,
    caption?: string,
    from?: string,
    about?: SourceAbout,
  ): void {
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
      // Only a printed still has one — see `Ingested`. Omitted rather than
      // passed as `""`, so a photograph's caption stays the empty thing the
      // person is meant to write in themselves.
      ...(caption !== undefined && caption !== "" ? { caption } : {}),
      // The page this stands in for, kept where rewriting the caption cannot
      // reach it (T-290, Q-305).
      ...(from !== undefined && from !== "" ? { source: from } : {}),
      // And what that page was about, which is what the renderer chooses the
      // face from (T-342). Only ever `media` here: `page` is the default and
      // writing it would be a key saying the default on every card.
      ...(about === "media" ? { sourceAbout: about } : {}),
    });
  }

  /**
   * Look beside a recording for its transcript, and hang it off the payload —
   * T-287, D-46 section 3: *"audio is quoted from a transcript, because you
   * cannot select a sound — which is why a sidecar `.srt` sitting next to the
   * media file is worth ingesting."*
   *
   * **By name, and that is not the exception to AC-650 it looks like.** The rule
   * that an extension is what somebody typed and the bytes are what the board
   * decides on is about *what a file is*, and it is untouched: the sidecar goes
   * through `assetIngestPath` like everything else and is sniffed there. What is
   * decided by name here is only *which file to look at*, and a sidecar
   * convention is a naming convention — `interview.srt` beside `interview.mp4`
   * is the whole of it. There is nothing in the bytes of a directory to sniff.
   *
   * Two spellings, `.srt` first because it is the one anybody's tooling emits.
   * A miss is the ordinary case rather than an error: most recordings have no
   * transcript, `assetIngestPath` refuses a path that is not there, and that
   * refusal is swallowed here — it is not a file the person asked for, so it
   * must not reach `refuse` and be read out as something the board could not
   * hold.
   */
  private async sidecar(out: Ingested[], path: string): Promise<void> {
    const last = out[out.length - 1];
    if (last?.kind !== "asset") return;
    const kind = assetKind(last.asset.mime);
    if (kind !== "video" && kind !== "audio") return;
    const stem = withoutExtension(path);
    if (stem === null) return;
    for (const extension of SIDECAR_EXTENSIONS) {
      const beside = `${stem}${extension}`;
      if (this.tried.has(beside)) continue;
      this.tried.add(beside);
      try {
        const meta = await this.options.native.assetIngestPath(beside);
        // A recording that is its own transcript is a filesystem answering the
        // same bytes for two names. `attachTranscript` refuses it too; refusing
        // here as well is what stops the sidecar being *ingested* a second time
        // under a name the store will only dedupe back to the first.
        if (meta.sha256 === last.sha256) return;
        out[out.length - 1] = {
          ...last,
          sidecar: {
            sha256: meta.sha256,
            asset: {
              w: meta.w,
              h: meta.h,
              mime: meta.mime,
              size: meta.size,
              ...(baseName(beside) ? { origName: baseName(beside) } : {}),
            },
          },
        };
        return;
      } catch {
        // No transcript by that spelling. The common case, and silent.
      }
    }
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

  /**
   * `found` is what the *drop* named, which is not always what arrived — a
   * folder past the shell's own bound is cut before it crosses (T-295). It is
   * the number the notice quotes, so the person hears what they dropped.
   *
   * The dedupe below runs first and can only shrink the list, so `found` stays
   * the drop's count and does not become the fresh one: a second drop of the
   * same folder that puts nothing down should say nothing rather than claim a
   * ceiling it did not reach.
   */
  private async ingestPaths(paths: readonly string[], found?: number): Promise<Ingested[]> {
    const out: Ingested[] = [];
    // Not what `fromFiles` already took by path. It runs first and now asks the
    // shell the same question, so without this a file it ingested and `accept`
    // *refused* would be ingested and refused a second time here — and the
    // notice would read "Nothing here can hold 2 of those — backup.zip,
    // C:/backup.zip", one file counted twice against one paste.
    const fresh = paths.filter((path) => !this.tried.has(path));
    // The shell's own bound is only worth quoting when nothing was deduped.
    // Dropping the same folder twice leaves `fresh` short of `paths` for a
    // reason that has nothing to do with a ceiling, and "putting down 3 of four
    // thousand" would be arithmetic across two different questions.
    const of = fresh.length === paths.length ? (found ?? paths.length) : fresh.length;
    for (const path of this.capped(fresh, "files", of)) {
      try {
        this.tried.add(path);
        this.accept(out, await this.options.native.assetIngestPath(path), path, baseName(path));
        await this.sidecar(out, path);
      } catch (error) {
        // Said rather than swallowed, on the same argument as `fromFiles`: this
        // road has no fallback behind it, so a file that fails here is a file
        // the person watched disappear.
        this.refuseFromShell(path, error);
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
      await this.fetchFile(out, source);
    }
    return out;
  }

  private async fromText(raw: string): Promise<Ingested[]> {
    const text = raw.trim();
    if (!text) return [];
    // "A URL: note showing the URL; if it's an image URL, fetched natively (no
    // CORS wall) and made a polaroid." — and since T-289 that is true of a film,
    // a recording and a document too. Nothing here decides which: the store
    // sniffs the bytes and `accept` picks the object, exactly as it does for a
    // file dragged in from the OS.
    if (looksLikeFileUrl(text)) {
      const out: Ingested[] = [];
      const refusal = await this.fetchFile(out, text);
      if (out.length > 0) return out;
      // The fetch failed, or what came back was refused. The URL is still what
      // the user copied, so it falls through and becomes a note — which is the
      // other half of the same row, and is what a link to a web page has always
      // been.
      //
      // Said out loud since T-343, and only here: this is the one call to
      // `fetchFile` whose address is the thing the person actually pasted. The
      // refusal is null when what came back was merely refused by the gate,
      // because `accept` has already written that line.
      this.sayWhyNotFetched(text, refusal);
    } else if (isHttpUrl(text)) {
      // An address that names no file. Most of what anybody pastes is one of
      // these, and until T-289 every one of them was a note — including the
      // archive.org item and the Commons file page that have the thing you
      // wanted one link away.
      const out = await this.fromPage(text);
      if (out.length > 0) return out;
    }
    if (tooMuchForANote(text)) {
      const out: Ingested[] = [];
      await this.asManuscript(out, text);
      if (out.length > 0) return out;
    }
    return [{ kind: "text", text }];
  }

  /**
   * Text that will not fit on a note, as the document it already is — T-294.
   *
   * A note is a thing you take in at a glance, and four thousand words is not
   * one. It is also, until this, four thousand words *lost*: `.paper-text` is
   * `overflow: hidden` and a note stops growing, so everything past the paper
   * was held in the document and shown nowhere, with nothing on screen saying
   * so. `tooMuchForANote` is that exact bound rather than a number chosen
   * beside it.
   *
   * **Through the store, like every other document on this board.** The bytes
   * are offered to `assetIngestBytes` as `text/plain` and `accept` picks the
   * object from what the shell sniffs, so a manuscript arrives as the same
   * manilla folder a `.txt` dragged in from Explorer becomes — paginated by the
   * same reader (D-60), searchable by the same index (T-280), quotable by the
   * same rectangle (T-282). Nothing here knows it is making a folder, which is
   * why it cannot make a *different* folder from the one the file road makes.
   *
   * It arrives with no name, and that is honest: nobody named it. `caseNumber`
   * writes the hash's first eight characters on the tab, which is what the
   * store already calls the file and is the same case number on every machine
   * holding it.
   *
   * A refusal falls back to the note. The one that can really happen is the
   * paste ceiling — a clipboard holding a hundred megabytes of text — and a
   * clipped note is a worse object than a folder but a better one than nothing.
   * `accept` has already said why, if the reason was the board's.
   */
  private async asManuscript(out: Ingested[], text: string): Promise<void> {
    try {
      const bytes = new TextEncoder().encode(text);
      this.accept(out, await this.options.native.assetIngestBytes(bytes, "text/plain"), "that text");
    } catch (error) {
      console.warn("[paste] a long paste could not be kept as a document", error);
    }
  }

  /**
   * A page, read for what it says it is — T-289, T-290, Q-304.
   *
   * Two outcomes and they are different objects, which is the point.
   *
   * **A page that declares real media gets the media.** An archive.org item
   * says its audio is `audio/mpeg` and names the mp3, so what lands is the
   * cassette, and the page was only ever the way to find it.
   *
   * **Anything else that offers a picture gets a printed still** — a polaroid
   * of whatever the page shows, with the page's title and its address written
   * underneath. That is T-290's object, and the reason it is not a tape is one
   * line up in Rust: a watch page's `og:video` is a player typed `text/html`,
   * and `opengraph.rs` will not call that media. So the honest thing arrives —
   * a picture of the thing, and the address to go and watch it — rather than a
   * VHS that cannot play.
   *
   * Empty for everything else, which is most of the web, and the caller then
   * makes the note it would always have made. A page that will not load is the
   * same answer: `pageCard` rejects, and a link that turns out to be dead is
   * still the link somebody copied.
   */
  private async fromPage(url: string): Promise<Ingested[]> {
    let card;
    try {
      card = await this.options.native.pageCard(url);
    } catch (error) {
      console.warn(`could not read ${url} as a page:`, error);
      // Said out loud since T-343, and the argument that kept it quiet still
      // holds for the case it was written about: every URL anybody pastes comes
      // through here, and a sentence about Open Graph on each one would be the
      // board explaining its own plumbing. But that ordinary case — a page that
      // loaded and had nothing worth a card — does not come through here at all.
      // It is a card with no title, one return below, and it is still silent.
      // What reaches this line is an address that did not give us a page, and
      // `page_card` has already written which of the three that was.
      this.sayWhyNotFetched(url, refusalOf(error));
      return [];
    }

    const out: Ingested[] = [];
    if (card.media !== null) {
      await this.fetchFile(out, card.media.url);
      if (out.length > 0) return out;
      // Declared and then would not come. Falls through to the still, which is
      // a weaker object rather than a broken one.
    }
    // What the page turned out to be about, which decides the object from here
    // down (T-342). `media` is a page that named a film or a recording and gave
    // us a player instead — a watch page, a track page. Its picture is a *still
    // of the thing*, so the picture stays the subject and the address is written
    // under it; a page about itself offers a banner, and a banner is a card's
    // paper. The `about` travels with the payload because the renderer chooses
    // the face from it and nothing downstream can work it out again.
    const about: SourceAbout = card.aboutMedia ? "media" : "page";
    if (card.image !== null) {
      await this.fetchFile(out, card.image, captionFor(card, about, url), url, about);
      if (out.length > 0) return out;
      // Declared a picture and it would not come. Falls through to the card
      // below, which is the same object with blank stock rather than nothing.
    }
    // No picture, or none that arrived — and the page still told us what it is
    // (T-340). That metadata used to be thrown away and the caller made the note
    // it would always have made, which is wrong under "cover links in general":
    // a card with a title and a site name and no picture is still a card, and
    // most of the web is exactly that.
    //
    // The title is what earns it. A page that says nothing has nothing on it but
    // the address somebody copied, and a note with the link in it is the honest
    // object for that — so `pageCard` rejecting, or returning a bare card, both
    // still end in a note.
    // A card, always, whatever the page was about. There is no picture, so there
    // is no still to make — a printed still with nothing printed on it is a
    // frame around nothing — and a page that named a film we could neither fetch
    // nor illustrate is at least a card that says where the film is.
    const title = titleOf(card);
    if (title !== "") out.push({ kind: "page", title, source: url });
    return out;
  }

  /**
   * Fetch one address and offer whatever came back to the gate.
   *
   * Named for the file rather than for the picture since T-289, because that is
   * all it ever did: it ingests bytes and `accept` decides what they are. Its
   * two callers ask different questions and neither is answered here — the
   * markup arm is asking about an `<img src>` it found, and the text arm about
   * a URL somebody copied.
   */
  private async fetchFile(
    out: Ingested[],
    source: string,
    caption?: string,
    from?: string,
    about?: SourceAbout,
  ): Promise<Refusal | null> {
    const { native } = this.options;
    try {
      const decoded = decodeDataUrl(source);
      if (decoded) {
        this.accept(out, await native.assetIngestBytes(decoded.bytes, decoded.mime), "a data URL");
        return null;
      }
      if (!isHttpUrl(source)) return null;
      this.accept(
        out,
        await native.assetIngestUrl(source),
        source,
        baseName(source),
        caption,
        from,
        about,
      );
      return null;
    } catch (error) {
      // Not fatal, and not silent. A photograph that would not come is a note
      // with its address on it, which is more use than nothing.
      console.warn(`could not fetch ${source}:`, error);
      // **Handed back rather than said here** (T-343). Three of the four callers
      // are fetching something the person did not paste and did not ask about —
      // an `<img>` inside copied markup, a page's `og:image`, the film a watch
      // page declared — and each of those already lands a *weaker object* rather
      // than nothing. Only the caller holding the pasted address knows the
      // failure is the whole story, so only it gets to say so.
      return refusalOf(error);
    }
  }

  /**
   * Why a pasted address became a note — T-343.
   *
   * A note that says nothing is the same note whether the page 404ed, would not
   * answer, was not a page at all, or loaded perfectly well and had nothing on
   * it worth a card. The last of those is most of the web and stays silent; the
   * others are one line, because they are the ones where somebody would
   * otherwise go looking for a fault on this side.
   *
   * **Only a sentence the shell wrote speaks.** `null` here is the browser
   * build, whose `pageCard` rejects with "needs the native shell" on every URL
   * anybody pastes — a real answer to a different question, and the one thing
   * that would turn this into the board narrating its own plumbing. The console
   * keeps it either way.
   *
   * `holdsNowhere` is false whatever the shell said, and not passed through:
   * nothing here is a claim about the board. A link the board could not read is
   * a link, and the note with it on is the object it was always going to be.
   */
  private sayWhyNotFetched(url: string, refusal: Refusal | null): void {
    if (refusal === null) return;
    // Onto the queue directly rather than through `refuse`, for the one thing
    // `refuse` does besides queueing: it logs "nothing to put on the board",
    // and there is something to put on the board — the note is about to be
    // made. Both callers have already logged the address and the error.
    this.refused.push({ what: linkLabel(url), why: refusal.say, holdsNowhere: false });
  }

  /**
   * The ceiling, and **it says so** — T-295.
   *
   * `MAX_PER_PASTE`'s own doc comment has always promised this: "when it does
   * bite it says so, because a paste that silently drops half of what you gave
   * it is worse than one that refuses". It did not. It wrote a line to a console
   * nobody has open and dropped the rest, which is precisely the failure AC-651
   * exists to stop — a folder of four hundred photographs put down as fifty,
   * with the board looking as though it had done what was asked.
   *
   * `of` is the true count and is not always `values.length`: a dropped folder
   * is bounded on the far side too (`DROP_FOLDER_DEPTH`, `DROP_MAX_PATHS`), so
   * the shell says how many it found and that is the number worth hearing. A
   * person who dropped four thousand files needs to be told four thousand, not
   * the five hundred that survived the wire.
   *
   * Recorded rather than said here, on `refuse`'s argument one step further:
   * `flash.say` *replaces*, so two sentences in one run means only the second
   * is ever read. One run of the queue gets one notice, and `sayWhatWasLeftOut`
   * is where it is assembled.
   */
  private capped<T>(values: readonly T[], what: string, of = values.length): readonly T[] {
    // Nothing to put down is not a ceiling. A folder dropped twice arrives with
    // every path already tried, and "putting down 0 of 400" would be a notice
    // about a limit that did not bite.
    if (values.length === 0) return values;
    if (values.length <= MAX_PER_PASTE) {
      // Still worth saying when the wire bounded it and this did not — a drop of
      // four thousand that arrives as five hundred is a truncated drop whether
      // or not the item cap is what truncated it.
      if (of > values.length) this.overflowed = { what, took: values.length, of };
      return values;
    }
    console.warn(`paste: taking ${MAX_PER_PASTE} of ${of} ${what}`);
    this.overflowed = { what, took: MAX_PER_PASTE, of };
    return values.slice(0, MAX_PER_PASTE);
  }
}

/**
 * What is written on the object a link becomes — T-290, T-339, T-342.
 *
 * **Two answers, because there are two objects, and which one is asked for is
 * the argument.** This has been rewritten twice and both rewrites are in it:
 *
 * - **A page about itself becomes a business card, and gets the title alone.**
 *   The card has three lines and knows where they go — the name from here, the
 *   company and the address off the item's `source` (`lib/objects.ts`'s
 *   `siteLabel` and `addressLabel`) — so leaving the URL here would print it on
 *   the card twice. That the address is not in the item's *text* is the point:
 *   text is what a person can edit and `source` is not, which is the split
 *   Q-305 made.
 * - **A page about a film it would not hand over becomes a printed still, and
 *   gets the title and the address on two lines.** The same split still holds —
 *   `source` is what gets opened — but a photograph has one surface to write on
 *   and the address has to be *legible*, not merely present, because the whole
 *   reason the object exists is that the film could not come.
 *
 * `""` for a card whose page gave no title, and the card is a card without it:
 * the host carries the top line instead, and the empty text is an invitation to
 * name the thing yourself. A still with no title falls back to the address,
 * which is the one thing it must not be silent about.
 */
function captionFor(card: PageCard, about: SourceAbout, url: string): string {
  const title = titleOf(card);
  if (about === "page") return title;
  // A printed still, and this is T-290's original caption restored. The address
  // is the load-bearing half of it: the object exists *because* the film could
  // not be brought onto the board, so the one thing it owes anybody is the way
  // back to it — written where a person can read it, not only in a field.
  //
  // The address is on `source` as well, and that is not a duplicate serving two
  // masters: this is what the object *says*, and that is what the board *opens*.
  // Q-305 separated them precisely because a caption is a thing a person edits.
  return title === "" ? url : `${title}\n${url}`;
}

/** A page's own name for itself, trimmed. `""` for a page that gave none. */
function titleOf(card: PageCard): string {
  return (card.title ?? "").trim();
}

/** Did the clipboard hold anything at all? Used only to tell a paste that found
 *  nothing from a paste of nothing. */
function hadSomething(clip: Snapshot): boolean {
  return clip.files.length > 0 || clip.text.trim().length > 0 || clip.html.trim().length > 0;
}

/**
 * The path with its last extension taken off, or `null` when it has none.
 *
 * Split on the *basename* rather than the whole path, so a directory with a dot
 * in it — `C:/case files v2/interview` — is not read as an extension and does
 * not send the search off to a sibling that could never exist.
 */
function withoutExtension(path: string): string | null {
  const name = baseName(path);
  if (name === undefined) return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return path.slice(0, path.length - (name.length - dot));
}

/**
 * An address, short enough for a line that fades — T-343.
 *
 * The scheme goes because `https://` is on the front of everything and
 * identifies nothing, and a trailing slash goes for the same reason. What is
 * left is cut in the *middle* if it has to be cut: the front of a URL says which
 * site and the back says which thing on it, and dropping either end loses the
 * half somebody is checking. The flash is 46 characters wide and the sentence
 * that follows this takes about forty of them.
 */
function linkLabel(url: string): string {
  const bare = url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (bare.length <= 38) return bare;
  return `${bare.slice(0, 22)}…${bare.slice(-14)}`;
}

/** The last path or URL segment, kept as the asset's `origName` — the one piece
 *  of provenance that is gone the moment ingestion returns. */
function baseName(pathOrUrl: string): string | undefined {
  const withoutQuery = pathOrUrl.split(/[?#]/)[0] ?? "";
  const last = withoutQuery.split(/[\\/]/).pop();
  return last && last.length > 0 ? last : undefined;
}
