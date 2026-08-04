/**
 * The board's own file — the coarse tier of saving (T-356).
 *
 * `crdt/persistence.ts` is the fine tier: log frames every 200 ms, a snapshot
 * at a megabyte of log, crash-safe and completely private to the installation.
 * This is the other one. A `.schizo` at a path the user chose is *the board*
 * now rather than an export of it, and this module is the frontend half of
 * putting the document into it.
 *
 * Two tiers, one level up from `docstore.rs`'s two, and the same division of
 * labour:
 *
 * | | fine, crash-safe, cheap | coarse, portable, the thing you hand over |
 * |---|---|---|
 * | inside a board | `log.bin` frames | `snapshot.bin` |
 * | the installation | the workshop | the pack |
 *
 * ## Everything that writes a pack builds its spec here
 *
 * `packSpec` is one function with three callers — the export, the home, and the
 * flush — because they are three ways of writing *the same file* and a second
 * copy of that reader would drift. It has drifted before on this board: a paste
 * grew its own asset writer and was a field behind the real one for a
 * fortnight, and nothing failed while it was.
 *
 * The set it reports is `referencedAssets`, which is also the set `assetgc.ts`
 * spares. That is not a coincidence and it must not become one — what survives
 * a collection is exactly what a pack carries.
 *
 * ## When the pack is written (T-362)
 *
 * On idle, on a switch, and on the way out — never on a Save button, because
 * there is not one and never will be (DESIGN section 7.8). [`Pack`] below is
 * the timer and the policy; `board_flush` is the write.
 *
 * The document is *already* safe by the time any of that runs, which is what
 * makes every decision in this file affordable. A pack that is a few seconds
 * behind costs nothing: the workshop is the crash-safe copy, and `board_open`
 * prefers it over the pack precisely because a workshop with anything in it is
 * a session that ended before its pack was flushed. So this tier may skip a
 * beat, back off, or give up for a session, and the worst outcome is a file
 * that is stale rather than a board that is lost.
 */

import type { BoardDoc } from "@/crdt/doc";
import { boardSchemaVersion, boardTitle, referencedAssets, snapshot } from "@/crdt/doc";
import type { BundleSpec, Platform } from "@/platform/types";

/**
 * How long after boot a board with no file of its own is given one.
 *
 * Long enough that the first frames are drawn before `snapshot()` walks the
 * whole document, which on a large board is a real stall — and the first paint
 * of a session is the most visible possible moment to stall. Short enough that
 * it is finished long before `ASSET_SWEEP_DELAY_MS`, so nothing starts
 * reclaiming bytes against a board that is not in a file yet.
 */
export const HOME_DELAY_MS = 1_500;

/**
 * What the shell has to be told to write this board into a file.
 *
 * Read at the moment of writing rather than held, for `exportBoard`'s reason: a
 * photograph can arrive from a peer between the gesture and the write, and the
 * later read is the better one.
 */
export function packSpec(board: BoardDoc): BundleSpec {
  return {
    schemaVersion: boardSchemaVersion(board),
    title: boardTitle(board),
    assets: referencedAssets(board),
  };
}

/**
 * What happened when a board with no file of its own was given one.
 *
 * `null` from [`homeBoard`] rather than a third case, because "this board
 * already has a file" is not news — it is every launch after the first, and a
 * caller that had to match on it would be matching on nothing happening.
 */
export type Homing =
  | {
      readonly kind: "homed";
      /**
       * The *display name* of the directory the file went into, straight out of
       * the register — `Schizoboard`, normally.
       *
       * Not a path, and this side could not have worked one out: the shell
       * chose the location (`a_home_for`) and reports it as a name, which is
       * ARCHITECTURE section 4.4 read outward. Saying "your Documents folder"
       * from here would be this side asserting a location it was deliberately
       * not told.
       */
      readonly folder: string;
      readonly bytes: number;
      /** Referenced by the board, not on this disk, so not in the file. */
      readonly missing: readonly string[];
    }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * Give this window's board a file of its own, if it has not got one.
 *
 * There are two ways to arrive with no file and this answers both. A data
 * directory from before T-356 is adopted in place by `board.rs`'s
 * `adopt_legacy` — its log stays exactly where it is, which is what keeps the
 * change reversible — and it has no pack at all until this runs. And a board
 * from *New board…* is a board before it is a file for the same few seconds.
 *
 * ## The failure is the interesting case, and it is survivable by construction
 *
 * `board_home` writes the pack **before** it records the home, so a write that
 * failed leaves the entry unhomed and the board running out of its workshop
 * exactly as it was a moment earlier. Nothing has been moved, nothing is half
 * done, and the only thing missing is the file. So this reports rather than
 * throws, and the caller puts a row on the menu to try again — a migration that
 * can fail and has no manual path leaves somebody stuck.
 *
 * ## Why the register is read twice
 *
 * Once to find out whether there is anything to do, and once afterwards to
 * learn where the shell put the file. The second read is the only way to say
 * *where* without a path crossing the boundary: `BundleWritten` carries a size
 * and a pack id and no location, on purpose, and the folder name lives in the
 * register that has just been amended.
 */
export async function homeBoard(native: Platform, board: BoardDoc): Promise<Homing | null> {
  let card;
  try {
    card = await native.boardCurrent();
  } catch (error) {
    return { kind: "failed", error };
  }
  // `null` is a plain browser, where a board is not a file and never will be.
  if (card === null || card.homed) return null;

  let written;
  try {
    written = await native.boardHome(packSpec(board), snapshot(board));
  } catch (error) {
    return { kind: "failed", error };
  }

  let folder = "";
  try {
    // Not fatal, and deliberately: the file is written and the home is
    // recorded by the time this runs. A register that will not answer costs a
    // word in one sentence, and losing the whole outcome over it would report a
    // migration that worked as one that did not.
    folder = (await native.boardCurrent())?.folder ?? "";
  } catch (error) {
    console.warn("[pack] the board was homed but the register would not say where", error);
  }
  return { kind: "homed", folder, bytes: written.bytes, missing: [...written.missing] };
}

// --- the flush --------------------------------------------------------------

export interface PackOptions {
  /** How long the board has to go quiet before its file is rewritten. */
  idleMs?: number;
  /**
   * `crdt/persistence.ts`'s pair, kept verbatim rather than merely resembled:
   * told once at the start of a run of failures, and its partner told when a
   * write succeeds after one has fired and never otherwise. That is what lets a
   * caller hold one standing sentence up and take it down again without keeping
   * its own flag.
   */
  onError?: (error: unknown) => void;
  onRecovered?: () => void;
}

const PACK_DEFAULTS = {
  /**
   * Long enough that it lands between gestures rather than inside a working
   * rhythm — a whole-file rewrite is the expensive tier, and one that fired
   * between two drags would be paying that price for a board nobody has
   * finished changing.
   */
  idleMs: 5_000,
} as const;

/**
 * When the board's own file is rewritten, and when it is not.
 *
 * ## One callback, not a second subscriber to the document
 *
 * The obvious build is `board.doc.on("update", …)` and it is wrong twice over.
 * ARCHITECTURE section 2.1 keeps the subscriber count deliberately small, and
 * `crdt/persistence.ts` has already argued its own way past that rule by never
 * looking inside an update. More practically: what this tier needs to know is
 * not "the document changed" but "the document changed *and reached the
 * disk*", and only `Persistence` knows the second half. A document subscriber
 * would rearm the timer for an edit whose write then failed, and the pack would
 * be rewritten out of a workshop that had not been updated.
 *
 * So `Persistence` calls [`Pack.wrote`] after every successful append and
 * compaction, and this class holds no subscription at all.
 *
 * ## There is no size gate, and there was one
 *
 * Stage 1 wrote the whole pack every time, which is O(the file) rather than
 * O(what changed) — gigabytes of copying on a board of photographs. So the idle
 * flush stood down above a quarter of a gigabyte and only a switch and the way
 * out wrote the file, and that gate was the whole argument for stage 2.
 *
 * T-366 spent the argument. A flush is now one appended `gen/<n>` entry, which
 * costs O(the snapshot) whatever the pack weighs, so the constant and the
 * branch that read it are gone rather than raised — a six-gigabyte board and an
 * empty one now flush on exactly the same terms, which is a thing this class no
 * longer has an opinion about.
 */
export class Pack {
  private readonly board: BoardDoc;
  private readonly native: Platform;
  private readonly idleMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly onRecovered: () => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The document has moved on since the last successful flush. */
  private behind = false;
  /** Every flush, in order — `crdt/persistence.ts`'s chain, and for its reason. */
  private chain: Promise<void> = Promise.resolve();
  private failing = false;
  private stopped = false;
  /** See [`packedCleanly`]. False until a flush has actually put it all in. */
  private clean = false;

  constructor(board: BoardDoc, native: Platform, options: PackOptions = {}) {
    this.board = board;
    this.native = native;
    this.idleMs = options.idleMs ?? PACK_DEFAULTS.idleMs;
    this.onError =
      options.onError ??
      ((error) => console.error("[pack] the board's own file could not be written", error));
    this.onRecovered = options.onRecovered ?? (() => console.info("[pack] the board's file is being written again"));
  }

  /**
   * The document has reached the disk, so the file is now behind it.
   *
   * Called by `Persistence` rather than by a document subscriber — see the
   * class note. Rearms rather than resets: every write pushes the flush out
   * again, so a board being worked on continuously is not interrupted by one.
   */
  wrote(): void {
    if (this.stopped) return;
    this.behind = true;
    this.rearm();
  }

  /**
   * Write the file now and settle when it has been written.
   *
   * The one to await before a switch. D-67 fixes the order and it is
   * load-bearing: `pack.flushNow()` → `persistence.close()` → `board_open` →
   * reload. This first, because it reads the *document*, and `close()` is the
   * one-way door past which this window may no longer be writing to the board
   * it thinks it is.
   *
   * Returns the chain rather than one job, so a caller that awaits it is
   * guaranteed nothing of this tier's is still in flight.
   */
  flushNow(): Promise<void> {
    this.disarm();
    if (!this.behind || this.stopped) return this.chain;
    return this.enqueue();
  }

  /**
   * The way out, where nothing can be awaited.
   *
   * `pagehide` cannot hold the window open, so this starts a flush and returns.
   * What that loses at worst is one idle interval **of the pack** and never of
   * the document — `Persistence` has its own `pagehide` line and the workshop
   * is what the next launch reads.
   *
   * The call goes through the chain like every other, so it is issued one
   * microtask later rather than synchronously. That is inside the task that is
   * unloading the page, which is the whole of what this needs; going around the
   * chain to save a microtask would buy nothing and would let the last write of
   * a session overtake one already in flight.
   */
  flushBestEffort(): void {
    void this.flushNow();
  }

  /**
   * Stop writing this board's file, for good.
   *
   * Its one caller is a board this build may only partly read. `packSpec`
   * builds its asset list through `readItem`, so a future build's item has a
   * photograph in no list — a file written from here would be missing
   * photographs that are plainly on the board, and would then be the copy
   * somebody hands over. The workshop still holds every byte, so what is
   * refused is the *export* of a board and never the board.
   */
  seal(): void {
    this.stopped = true;
    this.clean = false;
    this.disarm();
  }

  /** Whether a flush is owed — for a caller deciding whether to await one. */
  get pending(): boolean {
    return this.behind;
  }

  /**
   * Whether this session has put everything the board refers to into its file
   * (T-363).
   *
   * `app/assetgc.ts`'s second condition, on exactly `readOnly`'s standing: a
   * fact the sweep cannot work out and must not guess. The store is one store
   * for the whole installation and `asset_gc` takes one board's keep-set, so a
   * sweep trashes every photograph belonging to every board this window is not
   * on. That is only recoverable because a board's photographs are in its pack
   * and `take_up` puts them back on the next open — and this is the flag that
   * says whether that sentence is true of *this* board yet.
   *
   * **False until a flush has actually succeeded**, which includes a board
   * nobody has edited this session. That reads like a regression in the
   * collector and is not one: the sweep runs once, thirty seconds after boot,
   * and only ever collects what was already gone when the window opened. A
   * session with nothing to flush leaves that rubbish for the next session that
   * writes something, rather than collecting it against a file that may not
   * hold what the board refers to.
   */
  get packedCleanly(): boolean {
    return this.clean;
  }

  private rearm(): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.idleMs);
  }

  private disarm(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private enqueue(): Promise<void> {
    this.chain = this.chain.then(() => this.write());
    return this.chain;
  }

  private async write(): Promise<void> {
    if (this.stopped || !this.behind) return;
    // Cleared *before* the write rather than after it, so an edit landing while
    // this is in flight leaves the flag up and earns its own flush. Clearing it
    // afterwards would swallow exactly the edits made during the slowest
    // writes, which are the ones on the largest boards.
    this.behind = false;
    try {
      const written = await this.native.boardFlush(packSpec(this.board), snapshot(this.board));
      if (written === null) {
        // A board with no file of its own yet — the adopted pre-T-356 board in
        // the second and a half before `homeBoard` runs, or one whose home
        // failed. Nothing was written, so the flag goes back up: it says "the
        // file is behind the document", and a board with no file at all is as
        // behind as it is possible to be. It does not spin, because only
        // `wrote` arms the timer and nothing here does.
        this.behind = true;
        // Cannot fire today and is not dead: a board's path is only ever set,
        // never cleared, so `clean` is still false from construction when this
        // runs. It is here because "there is no file" and "the file holds
        // everything" must never be true together, and the day something makes
        // a board un-homed — a forget verb, T-368's refusal — the failure would
        // be a sweep trashing the only copy of somebody's photographs. A
        // mutation survives this line for exactly that reason; the state it
        // guards has no test because it has no producer.
        this.clean = false;
        return;
      }
      // A file that went out without a photograph the board refers to is not
      // one the sweep may collect against — those bytes are on this disk and
      // nowhere else. `missing` is normally empty and is the whole reason it is
      // a list rather than a count.
      this.clean = written.missing.length === 0;
      this.recovered();
    } catch (error) {
      // Put back, exactly as `Persistence` puts a batch back. The document is
      // not at risk — this tier is a copy of a copy — but a file left silently
      // a session behind is the thing somebody hands to somebody else.
      this.behind = true;
      this.clean = false;
      this.report(error);
    }
  }

  /** One report per run of failures, so a disconnected disk is not a loop. */
  private report(error: unknown): void {
    if (this.failing) return;
    this.failing = true;
    this.onError(error);
  }

  private recovered(): void {
    if (!this.failing) return;
    this.failing = false;
    this.onRecovered();
  }
}
