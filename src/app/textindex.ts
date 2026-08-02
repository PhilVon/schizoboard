/**
 * What the case files on this board say, so that `Ctrl+F` can look inside them.
 *
 * > Page text, transcripts and any other extracted content are a **derived
 * > local index** and never enter the document. — D-46 section 2
 *
 * Which is one sentence carrying three separate rules, and all three of them
 * are why this class is as small as it is.
 *
 * **Derived.** Nothing here is authored. Every character in it came out of a
 * file the asset store already holds, addressed by the hash of its own bytes —
 * so an entry keyed on a hash stays true for as long as that hash exists, can
 * be thrown away at any moment, and costs time and nothing else to make again.
 * There is no state to migrate, none to repair, and none that can be *wrong*.
 * `pages.rs` makes the same argument one level down and in the same words.
 *
 * **Local.** It never crosses the wire and is never written down. A machine
 * that holds none of the bytes has no index, and that is the intended state
 * rather than a degraded one: it is the same machine that cannot show you the
 * photographs either. Two boards agreeing about what a file says is a property
 * of the file, not of anything synced.
 *
 * **Never in the document.** It is bytes, and DESIGN section 2.6 settled where
 * bytes go. Putting a filing's text in a `Y.Map` would put a megabyte of prose
 * on the wire, in the undo history and in every snapshot, to answer a question
 * a local walk answers in a millisecond.
 *
 * ## What is stored is normalised, and it is the index rather than the text
 *
 * Lowercased, with every run of whitespace collapsed to one space. That is not
 * a saving — it is what makes the answer right. A PDF splits a line at every
 * font and kerning change and the shell joins those runs by a **gap rule**
 * rather than by the reading surface's line-breaking one (`document::joined`),
 * so the two sides agree about the characters and disagree about which
 * whitespace sits between them. Normalising is what makes that disagreement
 * invisible, and doing it once per document rather than once per keystroke is
 * why it can happen at all.
 *
 * The consequence, stated rather than discovered: **this holds no snippet.** A
 * search field that wants to show the line a match is on asks `documentPage`
 * for that page, which is one page of one document and is the call the reading
 * surface was already going to make.
 *
 * ## One at a time, because each one opens a file
 *
 * A board of forty case files firing forty `documentText` calls would put forty
 * documents' structure in memory at once and hand the blocking pool forty file
 * reads to interleave. So this is a queue of one, the shape `PosterGrabber`
 * takes for the same reason at a different cost — and it means at most one file
 * is open for indexing beside whatever somebody is reading.
 *
 * What that costs is written down because it is the whole of Q-271: measured
 * cold on 40 real multi-page PDFs off this machine, a document is 8.5 ms to
 * open and 11.1 ms a page to take the text off, so an average case file is
 * about 215 ms and the worst on that corpus — a 100-page permit — was 4.9
 * seconds. Q-271 chose to pay that when a folder appears rather than when
 * somebody first searches, so that `Ctrl+F` is complete from the first
 * keystroke; a board of twenty filings spends a few seconds of background work
 * at every boot whether or not anybody looks for anything.
 */

import { isHash } from "@/crdt/sync/assets";
import { normalise } from "@/lib/textnorm";
import type { NoText, PageText, Platform } from "@/platform/types";

/** What is known about one document's text right now. */
export type IndexPhase =
  /** Nobody has asked. Either it is not a document or its bytes are not here. */
  | "unasked"
  /** Asked; the shell has not answered yet. */
  | "reading"
  /** Here. `pages` is the answer, and may still be all silence. */
  | "read"
  /** The shell could not read the file at all — the 6% D-47 measured. */
  | "unreadable";

/**
 * How many of a document's pages have nothing on them to find, by reason.
 *
 * Kept because "no match" and "its scans are not searchable" are different
 * sentences and only one of them is honest about a filing that is photographs
 * of paper. There is no OCR (D-46 section 6), so `scan` is permanent rather
 * than pending.
 */
export type Silence = Readonly<Record<NoText, number>>;

const NO_SILENCE: Silence = { scan: 0, empty: 0, unreadable: 0 };

/** One document, as far as this index has got with it. */
export interface DocumentIndex {
  readonly phase: IndexPhase;
  /**
   * Normalised page text, index-aligned: element `n` is page `n + 1`. A page
   * with nothing to read is `""`, which is why [`silence`] exists — the empty
   * string cannot say which of the three kinds of nothing it is.
   */
  readonly pages: readonly string[];
  readonly silence: Silence;
}

const UNASKED: DocumentIndex = { phase: "unasked", pages: [], silence: NO_SILENCE };
const READING: DocumentIndex = { phase: "reading", pages: [], silence: NO_SILENCE };
const UNREADABLE: DocumentIndex = { phase: "unreadable", pages: [], silence: NO_SILENCE };

export class TextIndex {
  private readonly held = new Map<string, DocumentIndex>();
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * @param arrived Called when a document's text lands, readable or not.
   *
   * There was no such hook until T-286, on the argument that nothing an index
   * holds is drawn and a hook with no caller is a hook nobody can check. The
   * caller exists now and is exactly the case that argument named: a search
   * field already on screen while a folder is still being read. Without this,
   * a query typed during those few hundred milliseconds keeps the answer it
   * had — the count would say `2 of 2` on a board where three folders say the
   * word, and nothing would ever correct it.
   *
   * It fires **per document rather than per board**, and the caller re-walks
   * on each. A board of forty folders is forty walks over a few hundred items
   * spread across the seconds the queue takes, which is beneath the cost of one
   * keystroke's worth of typing.
   */
  constructor(
    private readonly native: Platform,
    private readonly arrived: (sha256: string) => void = () => {},
  ) {}

  /**
   * Read this document's text if it has not been read.
   *
   * Called from the same place the title probe and the poster grab are — the
   * renderer asking what a record says, which is the layer that already decides
   * what is on this board (ARCHITECTURE section 5.2). Returns immediately; the
   * work is queued behind whatever else is indexing.
   *
   * Asked **once per hash per session**, and the mark goes down before the
   * await: a board of forty folders is forty reads and not forty a frame.
   */
  wants(sha256: string): void {
    if (!isHash(sha256) || this.held.has(sha256)) return;
    this.held.set(sha256, READING);
    this.queue = this.queue.then(() => this.read(sha256)).catch(() => undefined);
  }

  /** What is known about this document now. Never null; see [`UNASKED`]. */
  of(sha256: string): DocumentIndex {
    return this.held.get(sha256) ?? UNASKED;
  }

  /**
   * The first page of this document the needle is on, one-based, or `null`.
   *
   * One-based because that is the number printed on the page and the second
   * half of the `(sha256, page)` pair a citation carries (D-60) — so the answer
   * can be handed straight to the reading surface without either side doing
   * arithmetic on it.
   *
   * First rather than all, and for the same reason `Search` flies to one match
   * at a time: what a reader wants is to be taken somewhere, and stepping is
   * what the ones after it are for.
   */
  find(sha256: string, needle: string): number | null {
    const wanted = normalise(needle);
    if (wanted === "") return null;
    const pages = this.of(sha256).pages;
    for (const [at, text] of pages.entries()) {
      if (text.includes(wanted)) return at + 1;
    }
    return null;
  }

  /** For a test, and for a shutdown that waits on nothing else. */
  async idle(): Promise<void> {
    await this.queue;
  }

  private async read(sha256: string): Promise<void> {
    let text: readonly PageText[];
    try {
      text = await this.native.documentText(sha256);
    } catch {
      // A malformed PDF, a password on it, a container this build cannot parse
      // — about 6% of real files (D-47) — and, in a browser, every one of them,
      // because `mock.ts` refuses this call outright. All of it is one outcome:
      // a case file whose pages nobody can look inside. The folder is still
      // findable by its label, which is what `Search` already does.
      this.held.set(sha256, UNREADABLE);
      // Announced like any other landing. A file the shell refused is not a
      // non-event for a search field: it is the difference between "still
      // reading" and "there is nothing in here to find", and only the second
      // of those is a sentence worth putting on screen.
      this.arrived(sha256);
      return;
    }
    const pages: string[] = [];
    const silence = { ...NO_SILENCE };
    for (const page of text) {
      if (page.kind === "text") {
        pages.push(normalise(page.text));
        continue;
      }
      pages.push("");
      silence[page.why] += 1;
    }
    this.held.set(sha256, { phase: "read", pages, silence });
    this.arrived(sha256);
  }
}
