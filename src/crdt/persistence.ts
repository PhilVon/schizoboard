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
 * The `doc:persist-error` event in the IPC surface is not wired up yet, and
 * deliberately: every call this module makes is awaited, so a failed write
 * already arrives as a rejected promise with a caller. The event is for a
 * writer with nobody waiting on it, which is the embedded relay (T-69).
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
  /** Told the first time a write fails, and again after any write succeeds. */
  onError?: (error: unknown) => void;
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
        this.failing = false;
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
      this.failing = false;
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
}
