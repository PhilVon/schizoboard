/**
 * The batched adapter over the native update log.
 *
 * > `doc_append_update` is coalesced in JS (roughly every 200 ms or 32 kB)
 * > before crossing the boundary. — docs/ARCHITECTURE.md section 4.4
 *
 * Yjs hands out an update per transaction, and a drag alone produces one every
 * few hundred milliseconds. Each one crossing IPC on its own would be a syscall
 * and a frame in the log for a few dozen bytes; merged, a whole gesture is one
 * frame. That is the whole of this module's job — merging, and knowing when to
 * stop merging.
 *
 * ## Why this file is allowed to subscribe to the document
 *
 * ARCHITECTURE section 2.1 says `crdt/binding.ts` is the only file in the
 * codebase that subscribes to Yjs events, and it stays true: the binding
 * subscribes to *type* events and translates them into the scene. This
 * subscribes to the document's opaque update stream and never looks inside it —
 * the bytes go to Rust exactly as they arrive. There is nothing here to
 * translate and no second path from the document to the screen.
 *
 * ## When it stops writing
 *
 * If the document on disk cannot be read — the log is not ours, a frame is not
 * a Yjs update, the store never opened — this goes **read-only**: it never
 * subscribes, never appends and never compacts. The board opens empty and the
 * error is reported, but the file the user actually cares about is left exactly
 * as it was. The alternative is an empty board that snapshots itself over their
 * work a minute later, which is the one failure this whole subsystem exists to
 * make impossible (AC-146).
 *
 * ## How a failed write gets out of here
 *
 * Not through `doc:persist-error`. That event is declared in the IPC surface
 * and has no producer in Rust and no listener here, and it does not need one:
 * `doc_append_update` and `doc_compact` both await the disk before they return
 * (`lib.rs`), so every failure this module can have arrives as a rejected
 * promise on a call it made. The event was for a writer with nobody waiting on
 * it, and there is no such writer — the relay never touches the docstore. It is
 * left where it is with the other declared-and-unproduced events for the doc
 * pass to settle (T-237).
 *
 * What was actually missing was the last hop (T-220). The rejection reached
 * `report`, `report` called `onError`, and `onError` defaulted to
 * `console.error` because the one construction of this class passed no options
 * — so a board that had stopped being saved looked exactly like a board that
 * was being saved. [`PersistenceOptions.onError`] and
 * [`PersistenceOptions.onRecovered`] are the two ends of that, and `app/main.ts`
 * puts them on the bottom-right flash.
 */

import * as Y from "yjs";

import { snapshot, type BoardDoc } from "@/crdt/doc";
import { applyPersisted } from "@/crdt/ops";
import { Origin } from "@/crdt/origins";
import type { Platform } from "@/platform/types";

export interface PersistenceOptions {
  /** How long a batch may sit before it crosses. */
  batchMs?: number;
  /** Cross early once the batch reaches this many bytes. */
  batchBytes?: number;
  /** Write a snapshot and start the log again once it has grown past this. */
  compactBytes?: number;
  /**
   * Told once at the start of a run of failures, and not again until one has
   * ended — a disconnected disk is one piece of news, not sixty a second.
   *
   * Also told when the store could not be opened at all, which is a different
   * and worse thing: that one is permanent for the session and `readOnly` is
   * how a caller tells them apart.
   */
  onError?: (error: unknown) => void;
  /**
   * Told when a write succeeds after [`onError`] fired — and never otherwise,
   * so a caller can pair the two without keeping its own flag.
   *
   * This exists because the sentence a user is shown for a failure is a
   * standing one ("the board is not being saved"), and a standing sentence that
   * is no longer true is worse than never having said it.
   */
  onRecovered?: () => void;
}

const DEFAULTS = {
  batchMs: 200,
  batchBytes: 32 * 1024,
  /**
   * A megabyte of log costs a megabyte of replay at boot. Past this, rewriting
   * the snapshot is cheaper than carrying the log — and on a board of any size
   * the snapshot is smaller than the updates that built it, because Yjs is
   * storing the result rather than the history of arriving at it.
   */
  compactBytes: 1024 * 1024,
} as const;

export class Persistence {
  private readonly board: BoardDoc;
  private readonly native: Platform;
  private readonly batchMs: number;
  private readonly batchBytes: number;
  private readonly compactBytes: number;
  private readonly onError: (error: unknown) => void;
  private readonly onRecovered: () => void;

  /** Updates seen since the last flush, in order. */
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Every call to Rust, in order. Appends must never overtake a compaction. */
  private chain: Promise<void> = Promise.resolve();

  /** Bytes in the log on disk, as far as this session knows. */
  private stored = 0;
  private compactAt: number;

  private subscribed = false;
  private broken = false;
  private failing = false;

  constructor(board: BoardDoc, native: Platform, options: PersistenceOptions = {}) {
    this.board = board;
    this.native = native;
    this.batchMs = options.batchMs ?? DEFAULTS.batchMs;
    this.batchBytes = options.batchBytes ?? DEFAULTS.batchBytes;
    this.compactBytes = options.compactBytes ?? DEFAULTS.compactBytes;
    this.compactAt = this.compactBytes;
    this.onError =
      options.onError ??
      ((error) => console.error("the board could not be written to disk:", error));
    this.onRecovered = options.onRecovered ?? (() => console.info("the board is being written again"));
  }

  /** Nothing is being written, and nothing will be. */
  get readOnly(): boolean {
    return this.broken;
  }

  /**
   * Replay what is on disk into the document, then follow it.
   *
   * Call this **before** `initialiseBoard` and before the binding starts: the
   * first fills in `meta` only when there is no `schemaVersion`, so a board
   * loaded first keeps its own cork seed and creation date instead of having a
   * fresh one merged over the top; the second mirrors the whole document in one
   * pass rather than watching it arrive.
   */
  async open(): Promise<void> {
    let frames: Uint8Array[];
    try {
      const state = await this.native.docLoad();
      frames = state.snapshot ? [state.snapshot, ...state.updates] : [...state.updates];
      this.stored = state.updates.reduce((total, update) => total + update.byteLength, 0);
    } catch (error) {
      return this.giveUp(error);
    }

    try {
      applyPersisted(this.board, frames);
    } catch (error) {
      return this.giveUp(error);
    }

    this.board.doc.on("update", this.onUpdate);
    this.subscribed = true;

    // A long log at boot is a session that ended before it compacted. Not
    // awaited: the board is already on screen and this is housekeeping.
    if (this.stored >= this.compactAt) void this.compact();
  }

  /** Send what is pending now, and settle when every queued call has. */
  flush(): Promise<void> {
    this.disarm();
    if (this.broken || this.pending.length === 0) return this.chain;

    // One update needs no merging, and `mergeUpdates` on a single entry still
    // decodes and re-encodes it.
    const batch = this.pending.length === 1 ? this.pending[0]! : Y.mergeUpdates(this.pending);
    this.pending = [];
    this.pendingBytes = 0;

    return this.enqueue(async () => {
      try {
        await this.native.docAppendUpdate(batch);
        this.stored += batch.byteLength;
        this.recovered();
        if (this.stored >= this.compactAt) await this.compactNow();
      } catch (error) {
        // Kept, not dropped. A write that failed because a disk was briefly
        // busy goes out with the next batch; the cost of being wrong the other
        // way is somebody's afternoon.
        this.pending.unshift(batch);
        this.pendingBytes += batch.byteLength;
        this.arm(this.batchMs);
        this.report(error);
      }
    });
  }

  /**
   * Write the whole document as a snapshot and start the log again.
   *
   * Flushes first so the log is empty rather than holding frames the snapshot
   * already contains. Not for correctness — the snapshot comes from the live
   * document, so it is always at least as new as anything queued behind it, and
   * a Yjs update applied twice changes nothing — but a log that starts the next
   * session with redundant frames in it is a puzzle for whoever reads it.
   */
  compact(): Promise<void> {
    if (this.broken) return this.chain;
    void this.flush();
    return this.enqueue(() => this.compactNow());
  }

  /**
   * Put somebody else's document on disk in place of this one, and stop
   * following the board that is still on screen (T-84, Q-111).
   *
   * The one destructive thing in this class, and the order is the whole of it:
   * **unsubscribe first, write second.** Persistence batches roughly 200 ms of
   * updates before they cross, so a replace that compacted while still
   * following the live document would truncate the log to the new snapshot and
   * then, a fifth of a second later, append a frame of the *old* board on top
   * of it — a document that is two boards at once, and no error anywhere to say
   * so. `close()` is what makes that impossible, and it flushes on the way out
   * so nothing pending is silently dropped either.
   *
   * Deliberately **not** applied to the live `Y.Doc`. Applying another board's
   * snapshot to this one is a merge, and merging is exactly what Q-111 did not
   * choose: the answer was replace, and the only honest way to replace a
   * document that half the application holds references to is to write it down
   * and start again. The caller reloads the window, which is the same thing
   * Q-77 settled for the invite rewire.
   *
   * Refuses on a broken store rather than reporting, because there is a window
   * about to be reloaded: a replace that quietly failed would come back as the
   * board the user was told had gone.
   */
  async replaceWith(snapshot: Uint8Array): Promise<void> {
    if (this.broken) throw new Error("the board is read-only; nothing was replaced");
    await this.close();
    await this.native.docCompact(snapshot);
    this.stored = 0;
    this.compactAt = this.compactBytes;
  }

  /** Stop following the document and send whatever is left. */
  async close(): Promise<void> {
    if (this.subscribed) {
      this.board.doc.off("update", this.onUpdate);
      this.subscribed = false;
    }
    await this.flush();
  }

  /**
   * Runs inside the transaction, which runs inside phase 9 of the frame, so it
   * does exactly one thing: push. The merge and the IPC call happen on a timer,
   * where a millisecond costs nobody a frame.
   */
  private readonly onUpdate = (update: Uint8Array, origin: unknown): void => {
    // Our own replay. Writing it back would append a copy of the file to
    // itself on every launch.
    if (origin === Origin.LOAD) return;

    this.pending.push(update);
    this.pendingBytes += update.byteLength;
    this.arm(this.pendingBytes >= this.batchBytes ? 0 : this.batchMs);
  };

  /**
   * Arm the flush timer, moving it earlier but never later — a batch that has
   * hit the byte ceiling should not wait out a timer set when it was small.
   */
  private arm(delay: number): void {
    if (this.timer !== null) {
      if (delay > 0) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(this.fire, delay);
  }

  private disarm(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private readonly fire = (): void => {
    this.timer = null;
    void this.flush();
  };

  private async compactNow(): Promise<void> {
    try {
      await this.native.docCompact(snapshot(this.board));
      this.stored = 0;
      this.compactAt = this.compactBytes;
      this.recovered();
    } catch (error) {
      // Back off by a whole threshold rather than retrying on the next flush:
      // encoding the document is the expensive half, and doing it every 200 ms
      // against a disk that is refusing writes would cost more than the log.
      this.compactAt = this.stored + this.compactBytes;
      this.report(error);
    }
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(job).catch((error) => this.report(error));
    return this.chain;
  }

  private giveUp(error: unknown): void {
    this.broken = true;
    this.onError(error);
  }

  /** One report per run of failures, so a disconnected disk is not a loop. */
  private report(error: unknown): void {
    if (this.failing) return;
    this.failing = true;
    this.onError(error);
  }

  /**
   * The other end of [`report`] — a write that worked after one that did not.
   *
   * Silent unless there was something to recover from, which is what lets a
   * caller hold a standing "not being saved" line up and take it down again
   * without tracking the state a second time. A board whose disk has never
   * misbehaved never calls this at all.
   *
   * **Not called on a broken store.** `giveUp` reports and sets `broken`, and
   * nothing writes after that, so there is no success to recover with — which
   * is correct: a board that opened read-only stays read-only for the session.
   */
  private recovered(): void {
    if (!this.failing) return;
    this.failing = false;
    this.onRecovered();
  }
}
