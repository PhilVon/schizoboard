/**
 * The pages of the case file somebody is reading — asked for once, held while it
 * is open, and let go when it is shut (T-320).
 *
 * ## Why there is a cache on this side at all
 *
 * The shell already has one. `pages.rs` holds one document open and its pages
 * under a byte ceiling, and re-reading a page it has is a memory copy. So this
 * is not here to save Rust work; it is here because **a view cannot await.**
 * `DomItemLayer` binds inside a frame, and a page arrives from an IPC round trip
 * that will not be back for milliseconds. Every other asynchronous thing this
 * renderer draws takes the same shape — `AssetResolver` answers with what is
 * known *now* and a phase saying what is happening — and a page is one more.
 *
 * ## What is held, and what is let go
 *
 * One document's pages, and only while it is open. Shutting the folder drops
 * them and tells the shell to let the file go, which on a 51 MB scan is 51 MB of
 * working set. Nothing here survives that: a page is derived from
 * content-addressed bytes (Q-206), so losing every one of them costs time and
 * nothing else.
 *
 * **And of that document, only a window — the page being read and the one
 * either side of it (T-279).** This started out as a plain `Map` with no policy
 * on the argument that losing a page costs time and nothing else. The argument
 * is sound and the conclusion did not follow: a `Map` with no policy grows one
 * entry per page *visited*, and reading a 200-page scan end to end left 199
 * pages held, with 199 blob URLs and 77 MiB of JPEG among them, to draw one
 * page. A thousand-page filing — which D-46 section 4 says is a court record
 * rather than an edge case — is 388 MiB.
 *
 * So the culling rule the board already runs, one level down. `render/cull.ts`
 * keeps what is near the camera and drops what is not; this keeps what is near
 * the page somebody is on. The unit of nearness is a page rather than a board
 * unit, and there is no hysteresis, because there is no boundary to thrash
 * across: a page is asked for once and either inside the window or gone.
 *
 * **The blob URLs are the one thing that leaks if this is wrong.** A lifted scan
 * is half a megabyte the browser holds until the URL is revoked, and a page turn
 * mints one a turn — and since T-329 a typed page mints one per figure on it as
 * well. So every URL this creates is revoked in exactly one place — `forget` —
 * and every path that drops a page goes through it. That is also why a figure's
 * bytes are turned into a URL only *after* the check that the page is still
 * held: bytes dropped on the floor are collected, and a blob URL is not.
 *
 * ## Why the neighbours are fetched rather than merely kept
 *
 * Q-276. Not for the latency: a cold page is 6.4 ms typed and 10.8 ms scanned,
 * measured on the running app over a hundred turns into pages nobody had asked
 * for, and both are under a frame. What a turn actually costs is **one frame in
 * which the sheet is blank and its header says "200 pp."** — the shut label,
 * where the page number should be — because for that one frame the phase is
 * `reading` and `setPage` has no page to name. Holding the next one means a
 * turn never passes through that phase at all.
 *
 * It is worth being plain that this is the reader forming its own opinion about
 * what is wanted, which the note on `page` below says it would not. The opinion
 * is a narrow one — *the page next to the one being read* — and it is the same
 * opinion the board already holds about what is next to the camera.
 */

import type { DocumentPage, Platform } from "@/platform/types";

/** What is known about a page right now. */
export type PagePhase =
  /** Asked for; the shell has not answered yet. */
  | "reading"
  /** Here. `page` is set. */
  | "ready"
  /** The shell could not read it, and `reason` is the sentence why. */
  | "unreadable";

export interface PageView {
  readonly phase: PagePhase;
  readonly page: DocumentPage | null;
  /**
   * Why this page cannot be read, in a sentence somebody can act on — a
   * password-protected filing, a malformed PDF, a container this build does not
   * know. `null` unless the phase is `unreadable`.
   */
  readonly reason: string | null;
  /**
   * A blob URL for the page's lifted image, when it has one and the bytes have
   * arrived. `null` for a typed page, and `null` for a scan whose bytes are
   * still coming — the sheet draws the paper either way and the image lands on
   * it, which is the same undeveloped-film shape a photograph already has.
   */
  readonly imageUrl: string | null;
  /**
   * The same thing for a typed page's figures — index for index with
   * `content.figures`, so the nth entry belongs to the nth figure and nothing
   * has to be matched up by anything else (T-329).
   *
   * `null` in a slot is a figure with no bytes to show: one this build could
   * not lift, which carries its own sentence instead, or one whose read came
   * back empty. Empty on every page that is not a typed one.
   *
   * A figure is asked for on its own road for the reason the page image is —
   * half a megabyte of JPEG has no business inside a JSON value — and
   * `documentPageImage` already takes the `(page, figure)` pair that names one.
   */
  readonly figureUrls: readonly (string | null)[];
}

const NO_FIGURES: readonly (string | null)[] = [];

const READING: PageView = {
  phase: "reading",
  page: null,
  reason: null,
  imageUrl: null,
  figureUrls: NO_FIGURES,
};

/**
 * How many pages either side of the one being read are held, and fetched ahead.
 *
 * One, and the reason it is not more is that a wider window buys nothing at a
 * steady pace. At page N holding N-1, N and N+1, turning forward finds N+1
 * already here and asks for N+2 — so the *next* turn is instant whatever this
 * number is, and all a larger one changes is how much is held while the reader
 * sits still. On a scan that is 0.39 MiB a page: three pages is a megabyte and
 * a half, and eleven would be four and a half for no turn made faster.
 *
 * There is no auto-repeat on the arrows to outrun, either — `machine.ts` drops
 * a repeat, deliberately, because a page is an IPC round trip and a re-typeset.
 */
const NEIGHBOURS = 1;

/** One page, and whatever we have made of it. */
interface Held {
  view: PageView;
  /**
   * Every blob URL this page minted — the scan's, or one per lifted figure.
   * Revoked in `forget` and nowhere else, which is why they are held together
   * rather than read back off the view: a page with four figures has four URLs
   * to let go of and exactly one place that may do it.
   */
  urls: readonly string[];
}

export class PageReader {
  private readonly held = new Map<string, Held>();
  /** The document currently being read, so shutting one can let go of exactly
   *  its pages and the shell can be told which file to release. */
  private reading: string | null = null;
  /**
   * How the document being read is to be read — the asset record's `markdown`,
   * handed in by `open` (T-347).
   *
   * Held here rather than passed down from every caller because it is a fact
   * about the *document*, not about the page: the page resolver the renderer
   * holds asks for a page by hash alone, and threading a reading through it
   * would put a question about a file into a call about a frame. One field, set
   * where the folder is opened, and every fetch below reads it.
   *
   * It has to reach the shell at all because Rust never sees a filename, and
   * `PageStore` is keyed on it — two callers disagreeing open the same file
   * twice and evict each other's reading.
   */
  private markdown = false;
  /**
   * The page it is open at, one-based, and how many there are (T-321).
   *
   * **Local, and never on the wire.** Same rule D-46 section 4 gives a playhead
   * and for the same reason: where somebody has got to in a document is a fact
   * about the person reading it rather than about the board, and a field every
   * peer had to agree about would be one more thing the document carries
   * forever. Two people can read the same filing at different pages, which is
   * what happens with a paper one.
   *
   * It goes back to page one when a different document is opened, deliberately.
   * A folder shut and opened again is a folder somebody put down and picked up,
   * and remembering the page would be a piece of state with nowhere honest to
   * live: not the document, and not per machine either, since it is about one
   * reading rather than about this installation.
   */
  private at = 1;
  private count = 1;

  /**
   * @param arrived Called when a page lands, with the hash it belongs to. The
   * caller's job is to mark whatever is drawing it dirty — this module knows
   * nothing about items, and an item id would be a second fact about the same
   * page that could disagree with the asset it came off.
   */
  constructor(
    private readonly native: Platform,
    private readonly arrived: (sha256: string) => void,
  ) {}

  /**
   * The page, or what is happening instead.
   *
   * Asking is what fetches it — the same arrangement `assetUrl` takes, and for
   * the same reason: the layer that already decided to draw this page is a
   * better answer to "is it wanted" than a second opinion about the viewport.
   */
  page(sha256: string, index: number = this.at): PageView {
    const key = `${sha256}:${index}`;
    const held = this.held.get(key);
    if (held !== undefined) return held.view;

    this.held.set(key, { view: READING, urls: [] });
    void this.fetch(key, sha256, index);
    return READING;
  }

  /**
   * Which document is being read, and how many pages it has.
   *
   * `pages` comes off the asset record, which knows it without touching the
   * disk — it crossed the wire ahead of the bytes so that a peer could draw the
   * folder's thickness (DATA-MODEL section 10). `null` is a document nobody
   * has counted, and one page is the honest floor: there is always a page, and
   * turning is what finds out there is not a second one.
   *
   * Idempotent, and shutting the last one first is what keeps the shell holding
   * one file rather than two.
   */
  open(sha256: string, pages: number | null, markdown = false): void {
    this.count = Math.max(1, pages ?? 1);
    this.markdown = markdown;
    if (this.reading !== sha256) {
      if (this.reading !== null) this.close(this.reading);
      this.reading = sha256;
      this.at = 1;
    }
    // Even on the folder already being read: `pages` may have arrived since,
    // and a window cut against a count of one is a window of one page.
    this.window();
  }

  /** The page being read, one-based. */
  get pageAt(): number {
    return this.at;
  }

  /** How many there are, as the asset record said. */
  get pageCount(): number {
    return this.count;
  }

  /**
   * How many pages are held, and how many of those are holding a blob URL.
   *
   * A readout rather than a feature: one page is on the sheet and everything
   * else this class does is memory, so there is no pixel anywhere that says
   * what a long read has accumulated. `window.schizo.reader` is where a driven
   * session reads it.
   */
  get heldPages(): { pages: number; urls: number } {
    let urls = 0;
    for (const held of this.held.values()) urls += held.urls.length;
    return { pages: this.held.size, urls };
  }

  /**
   * Turn `by` pages, and answer whether anything moved.
   *
   * Clamped rather than wrapped: a document has a first page and a last one, and
   * running off either end into the other is a thing no physical file does. The
   * answer is what lets the caller decide whether the keystroke was used — the
   * same shape `closeOpen` takes, so a press at the last page can fall through
   * to whatever else wants it rather than being silently swallowed.
   */
  turn(by: number): boolean {
    if (this.reading === null) return false;
    const to = Math.min(this.count, Math.max(1, this.at + by));
    if (to === this.at) return false;
    this.at = to;
    this.window();
    this.arrived(this.reading);
    return true;
  }

  /**
   * Go to a page by number, one-based, and answer whether anything moved.
   *
   * The other way in, beside [`turn`], and the only one that is not a hand on
   * the corner of a sheet: a search match is a `(document, page)` pair (T-286)
   * and the flight has to land on the second half of it. Clamped like `turn`,
   * for the same reason and against a worse input — a page number derived from
   * an index read off bytes that may have been indexed before the record said
   * how many pages there were.
   *
   * It is **not** part of `open`. Opening at a page and then turning is two acts
   * on one object, and `open` is idempotent precisely so that a search stepping
   * twice through the same folder does not shut and reopen the file underneath
   * itself.
   */
  goto(page: number): boolean {
    if (this.reading === null) return false;
    const to = Math.min(this.count, Math.max(1, Math.trunc(page)));
    if (to === this.at) return false;
    this.at = to;
    this.window();
    this.arrived(this.reading);
    return true;
  }

  /**
   * Hold the page being read and its neighbours, and let go of the rest.
   *
   * Run wherever the page moves, and *before* `arrived` in both callers: the
   * layer redraws off that callback and asks for the page it is on, so cutting
   * the window first is what makes a turn find its page already here rather
   * than starting the fetch it was supposed to have got ahead of.
   *
   * The forget pass walks every key rather than the window's own, because what
   * has to go is defined by what is *outside* it — and a page fetched for a
   * document that has since been shut is outside it by the widest possible
   * margin.
   */
  private window(): void {
    const sha = this.reading;
    if (sha === null) return;
    const first = Math.max(1, this.at - NEIGHBOURS);
    const last = Math.min(this.count, this.at + NEIGHBOURS);

    const prefix = `${sha}:`;
    for (const key of [...this.held.keys()]) {
      if (!key.startsWith(prefix)) {
        this.forget(key);
        continue;
      }
      const index = Number(key.slice(prefix.length));
      if (index < first || index > last) this.forget(key);
    }

    // Asking is fetching, so the window is filled by reading it.
    for (let index = first; index <= last; index++) this.page(sha, index);
  }

  /**
   * The folder has been shut. Drop its pages and let the shell release the file.
   *
   * `documentClose` names the hash rather than saying "whatever is open",
   * because two folders opened in quick succession would otherwise have the
   * loser's close land on the winner's file.
   */
  close(sha256: string): void {
    if (this.reading === sha256) this.reading = null;
    for (const key of [...this.held.keys()]) {
      if (key.startsWith(`${sha256}:`)) this.forget(key);
    }
    void this.native.documentClose(sha256).catch(() => {
      // A shell that will not let go costs memory and nothing a reader can act
      // on, so it is not worth a sentence on the board. The next document
      // opened evicts this one anyway (`pages.rs`).
    });
  }

  /** Everything, for a window going away. */
  destroy(): void {
    for (const key of [...this.held.keys()]) this.forget(key);
    if (this.reading !== null) void this.native.documentClose(this.reading).catch(() => {});
    this.reading = null;
  }

  /** The one place a blob URL is revoked. */
  private forget(key: string): void {
    const held = this.held.get(key);
    for (const url of held?.urls ?? []) URL.revokeObjectURL(url);
    this.held.delete(key);
  }

  private async fetch(key: string, sha256: string, index: number): Promise<void> {
    try {
      const page = await this.native.documentPage(sha256, index, this.markdown);
      if (!this.held.has(key)) return; // shut while it was in flight
      if (page === null) {
        this.land(key, sha256, index, {
          phase: "unreadable",
          page: null,
          reason: "there is no page here",
          imageUrl: null,
          figureUrls: NO_FIGURES,
        });
        return;
      }

      // A scan wants its bytes as well, and they come on their own road because
      // half a megabyte of JPEG has no business inside a JSON value.
      let url: string | null = null;
      if (page.content.kind === "image") {
        const bytes = await this.native.documentPageImage(sha256, index, undefined, this.markdown);
        if (!this.held.has(key)) return;
        url = blobUrl(bytes, page.content.image.mime);
      }

      // And so does every figure on a typed page (T-329). Together rather than
      // one after another: they are independent reads off a document the shell
      // already has open, and a page carrying six of them would otherwise be
      // six round trips deep before the sheet could be drawn.
      let figureUrls: readonly (string | null)[] = NO_FIGURES;
      const figures = page.content.kind === "text" ? page.content.figures : [];
      if (figures.length > 0) {
        const lifted = await Promise.all(
          figures.map(async (figure, at) => {
            // A figure this build could not lift has a sentence and no bytes.
            // Asking for them anyway would be a round trip whose only possible
            // answer is the empty one.
            if (figure.content.kind !== "image") return null;
            try {
              return await this.native.documentPageImage(sha256, index, at, this.markdown);
            } catch {
              // Caught per figure and not left to take the page down with it.
              // A page whose words are here and whose chart would not read is
              // still a page somebody can read — the page-level `unreadable`
              // arm is for a page that has *nothing*, and reaching it from here
              // would throw away runs that arrived perfectly well.
              return null;
            }
          }),
        );
        // Every URL is minted on this side of the check, which is what keeps
        // `forget` the only place one is ever revoked: a page shut while its
        // figures were in flight drops bytes, which the collector takes, rather
        // than blob URLs, which it does not.
        if (!this.held.has(key)) return;
        figureUrls = figures.map((figure, at) =>
          figure.content.kind === "image" ? blobUrl(lifted[at] ?? null, figure.content.image.mime) : null,
        );
      }

      this.land(
        key,
        sha256,
        index,
        { phase: "ready", page, reason: null, imageUrl: url, figureUrls },
        [url, ...figureUrls].filter((one): one is string => one !== null),
      );
    } catch (error) {
      if (!this.held.has(key)) return;
      // The shell's own sentence, which `document.rs` writes to be read: "the
      // document is password protected", "could not read the document: …". It is
      // the one thing a person can act on, so it is carried rather than replaced
      // with a generic failure.
      this.land(key, sha256, index, {
        phase: "unreadable",
        page: null,
        reason: sentenceOf(error),
        imageUrl: null,
        figureUrls: NO_FIGURES,
      });
    }
  }

  private land(
    key: string,
    sha256: string,
    index: number,
    view: PageView,
    urls: readonly string[] = [],
  ): void {
    // Through `forget`, so this stays the one place a blob URL is revoked. It
    // matters now that the window lets a page go: a scan let go of and asked
    // for again has two fetches in flight against one key, and whichever loses
    // would otherwise leave half a megabyte behind with nothing pointing at it.
    this.forget(key);
    this.held.set(key, { view, urls });
    // Only the page on the sheet is worth a redraw. A neighbour arriving
    // changes nothing anybody is looking at, and `arrived` is a whole item
    // rebind — so an unconditional call here would make fetching ahead cost a
    // rebind per page rather than nothing (T-279).
    if (sha256 === this.reading && index === this.at) this.arrived(sha256);
  }
}

/**
 * A rejected command as a sentence.
 *
 * Rust's side of this road flattens its errors into strings deliberately
 * (`crate::blocking`), so what arrives is an `Error` whose message is already
 * the sentence somebody should read.
 */
function sentenceOf(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error);
  return said.trim() || "this page could not be read";
}

/**
 * Lifted bytes as something an `<img>` can point at, or `null` for no bytes.
 *
 * Zero length is the shell saying it has nothing here rather than an error —
 * `reading.rs` answers an empty vector for a `(page, figure)` pair it cannot
 * satisfy — and a blob URL over an empty blob is a broken-image box, which is
 * the one thing this feature exists to stop putting on a sheet.
 */
function blobUrl(bytes: Uint8Array | null, mime: string): string | null {
  if (bytes === null || bytes.byteLength === 0) return null;
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
}
