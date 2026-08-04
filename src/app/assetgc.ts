/**
 * Reclaiming the disk behind photographs the board no longer refers to.
 *
 * > Assets are reference-counted against the document. An asset no item points
 * > at goes to a thirty-day trash tier before it is deleted for real.
 * > — DATA-MODEL section 10
 *
 * All of that was built, tested and registered — `assets.rs` has the trash
 * tier, the collect, the purge and the restore, and `asset_gc` is a live
 * command with a binding on both platforms. Nothing ever called it (T-219). A
 * board that had a hundred photographs deleted off it a year ago was still
 * carrying every byte, and the trash tier was dead code outside its own tests.
 *
 * This module is the missing caller, and it is almost entirely policy: *when*
 * to sweep, and *when not to*. The collecting itself is one line.
 *
 * ## What is kept
 *
 * `referencedAssets` reads the document, not the scene. That matters — it is
 * the same set `bundleSaveAs` embeds, so what survives a collection is exactly
 * what a bundle would carry, and neither depends on what happens to be mounted
 * or mirrored at the moment the question is asked.
 *
 * ## The clause that is not implemented, and why not
 *
 * DESIGN adds "never collect on a peer that may be the only holder without
 * confirming another peer has it". Nothing implements that on either side, and
 * on Q-158 the answer was that the thirty-day trash tier *is* that
 * confirmation: a collection is reversible for a month, `restore_from_trash`
 * pulls bytes back out on re-ingest rather than rewriting them, and the Rust
 * half already argues the same thing in its own words — "being briefly wrong
 * about what is referenced has to be survivable, and a thirty-day tier is what
 * makes it so". A peer round-trip would need a wire message, a rule for the
 * common case where no peer is online at all, and would then never purge on a
 * single-machine board.
 */

import type { BoardDoc } from "@/crdt/doc";
import { referencedAssets } from "@/crdt/doc";
import type { Platform } from "@/platform/types";

/**
 * How long after boot the store is swept.
 *
 * Late enough that a LAN peer has normally finished its first sync, so the
 * document being measured is the whole board rather than this machine's half of
 * it. Early enough that an ordinary sitting reaches it.
 *
 * There is no second sweep and no interval. **Once, at boot, is deliberate:**
 * it means nothing deleted during this session can be collected while the
 * person who deleted it might still press Ctrl+Z. A collection only ever
 * concerns itself with what was already gone when the window opened, and the
 * undo stack does not reach back that far because it does not survive a reload.
 */
export const ASSET_SWEEP_DELAY_MS = 30_000;

export interface SweepResult {
  /** Bytes that actually left the disk — purges, not the move into the trash. */
  readonly freedBytes: number;
  /** How many distinct assets the document still refers to. */
  readonly kept: number;
}

export interface SweepOptions {
  /**
   * Whether the document on disk failed to load.
   *
   * The one condition that must stop a sweep dead, and the reason this
   * parameter exists rather than being inferred: a store that would not open
   * leaves the board **empty**, so `referencedAssets` returns nothing, so every
   * photograph on the disk looks unreferenced. The collection would be
   * reversible — that is what the trash is for — but it would also be a
   * hundred per cent wrong, and `crdt/persistence.ts` already refuses to write
   * a byte in this state for the same reason. It should not be undone by
   * something sweeping the assets out from under it.
   */
  readonly readOnly: boolean;
  /**
   * Whether this session has put everything the board refers to into the
   * board's own file (T-363).
   *
   * The second condition, on exactly `readOnly`'s standing and for a reason of
   * the same shape: a fact this module cannot work out and must not guess.
   *
   * ## What it is guarding, which is not this board
   *
   * `assets/` is one store for the whole *installation* and `asset_gc` takes
   * one keep-set — the board this window is on. So a sweep does not merely
   * collect what this board has stopped referring to; it collects every
   * photograph belonging to every board this window is not on. That is only
   * survivable because each board's photographs are in its own pack and
   * `take_up` puts them back on the next open, and this flag is what says
   * whether that is true of this board yet. A file written without a photograph
   * the board refers to — `missing` non-empty — is a file the recovery does not
   * come out of, and those bytes are then on this disk and nowhere else.
   *
   * `app/pack.ts` computes it, because only the thing that wrote the file knows
   * what went into it.
   */
  readonly packedCleanly: boolean;
}

/**
 * Collect once. Returns what happened, or null when it declined to run.
 *
 * Never throws. A sweep is housekeeping nobody asked for and nobody is waiting
 * on; a store that cannot be walked is a line in the console, not an error in
 * somebody's afternoon.
 */
export async function sweepAssets(
  native: Platform,
  board: BoardDoc,
  options: SweepOptions,
): Promise<SweepResult | null> {
  if (options.readOnly || !options.packedCleanly) return null;

  const keep = referencedAssets(board);
  try {
    const { freedBytes } = await native.assetGc(keep);
    return { freedBytes, kept: keep.length };
  } catch (error) {
    console.warn("[assets] the store could not be swept", error);
    return null;
  }
}
