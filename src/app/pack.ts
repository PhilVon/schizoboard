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
 * `packSpec` is one function with three callers — the export, the home below,
 * and (T-362) the flush — because they are three ways of writing *the same
 * file* and a second copy of that reader would drift. It has drifted before on
 * this board: a paste grew its own asset writer and was a field behind the real
 * one for a fortnight, and nothing failed while it was.
 *
 * The set it reports is `referencedAssets`, which is also the set `assetgc.ts`
 * spares. That is not a coincidence and it must not become one — what survives
 * a collection is exactly what a pack carries.
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
