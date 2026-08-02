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
 * nothing else — which is the property that lets this be a plain `Map` rather
 * than anything with a policy.
 *
 * **The blob URLs are the one thing that leaks if this is wrong.** A lifted scan
 * is half a megabyte the browser holds until the URL is revoked, and a page turn
 * would mint one a turn. So every URL this creates is revoked in exactly one
 * place — `forget` — and every path that drops a page goes through it.
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
}

const READING: PageView = { phase: "reading", page: null, reason: null, imageUrl: null };

/** One page, and whatever we have made of it. */
interface Held {
  view: PageView;
  /** Revoked in `forget` and nowhere else. */
  url: string | null;
}

export class PageReader {
  private readonly held = new Map<string, Held>();
  /** The document currently being read, so shutting one can let go of exactly
   *  its pages and the shell can be told which file to release. */
  private reading: string | null = null;
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

    this.held.set(key, { view: READING, url: null });
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
  open(sha256: string, pages: number | null): void {
    this.count = Math.max(1, pages ?? 1);
    if (this.reading === sha256) return;
    if (this.reading !== null) this.close(this.reading);
    this.reading = sha256;
    this.at = 1;
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
    this.arrived(this.reading);
    return true;
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
    if (held?.url) URL.revokeObjectURL(held.url);
    this.held.delete(key);
  }

  private async fetch(key: string, sha256: string, index: number): Promise<void> {
    try {
      const page = await this.native.documentPage(sha256, index);
      if (!this.held.has(key)) return; // shut while it was in flight
      if (page === null) {
        this.land(key, sha256, {
          phase: "unreadable",
          page: null,
          reason: "there is no page here",
          imageUrl: null,
        });
        return;
      }

      // A scan wants its bytes as well, and they come on their own road because
      // half a megabyte of JPEG has no business inside a JSON value.
      let url: string | null = null;
      if (page.content.kind === "image") {
        const bytes = await this.native.documentPageImage(sha256, index);
        if (!this.held.has(key)) return;
        if (bytes.byteLength > 0) {
          url = URL.createObjectURL(
            new Blob([bytes as unknown as BlobPart], { type: page.content.image.mime }),
          );
        }
      }

      this.land(key, sha256, { phase: "ready", page, reason: null, imageUrl: url }, url);
    } catch (error) {
      if (!this.held.has(key)) return;
      // The shell's own sentence, which `document.rs` writes to be read: "the
      // document is password protected", "could not read the document: …". It is
      // the one thing a person can act on, so it is carried rather than replaced
      // with a generic failure.
      this.land(key, sha256, {
        phase: "unreadable",
        page: null,
        reason: sentenceOf(error),
        imageUrl: null,
      });
    }
  }

  private land(key: string, sha256: string, view: PageView, url: string | null = null): void {
    this.held.set(key, { view, url });
    this.arrived(sha256);
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
