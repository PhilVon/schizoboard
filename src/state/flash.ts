/**
 * What an undo just changed, lit for a moment.
 *
 * > It can still surprise: if someone moved an item after you did, your undo
 * > restores your earlier value and their move is lost. That's inherent. The
 * > mitigation is to flash-highlight what changed so it's never silent.
 * > — docs/DESIGN.md section 7.6
 *
 * The surprise is not that undo is origin-scoped — that is the only multiplayer
 * semantic worth having, and `crdt/undo.ts` argues it. The surprise is that
 * pressing Ctrl+Z can move something you were not looking at: a photograph a
 * collaborator dragged across the board after you last touched it snaps back to
 * where *you* left it, on a frame you were watching some other corner. Nothing
 * about that is wrong, and with no mark on it nothing about it is visible
 * either. So the things an undo touched glow amber for the best part of a
 * second, and the answer to "what did that just do?" is on the board rather
 * than in your memory of it.
 *
 * ## Where the ids come from
 *
 * From the dirty sets, which is to say from `crdt/binding.ts`, which is the
 * only Yjs observer in the application (ARCHITECTURE section 1). An undo is a
 * transaction like any other: the binding sees its events, mirrors them into
 * the scene and names exactly the items, pins and strings that moved. Reading
 * the `Y.UndoManager`'s own `stack-item-popped` payload would mean a second
 * observer translating document structure into scene ids — the one job that
 * module exists to be alone in doing.
 *
 * `around()` is therefore a *diff*: what was dirty before the write, and what
 * is dirty after. `state/dirty.ts` is cleared at the top of the FLUSH phase and
 * the queued writes drain immediately after, so in practice the "before" set is
 * whatever earlier queued writes in the same drain touched — rarely anything,
 * but the diff costs two small set walks and does not have to assume it.
 *
 * ## Decay, not deadlines
 *
 * Each id carries a life from 1 down to 0, stepped by frame `dt` like
 * everything else that moves (ARCHITECTURE section 3: nothing animates on its
 * own). No timestamps, so nothing here needs a clock — which matters because
 * the write that raises a flash happens in phase 9 and the frame that first
 * draws it is the next one, and a start time taken in between would be
 * comparing `performance.now()` against an rAF timestamp for no gain.
 */

import type { DirtySets } from "@/state/dirty";
import type { Scene } from "@/state/scene";

/**
 * How long a flash lasts. Long enough to catch the eye of somebody looking
 * elsewhere on the board, short enough that holding Ctrl+Z down does not leave
 * a trail of everything the last two seconds went through.
 */
export const FLASH_MS = 800;

/** Life lost per millisecond. */
const DECAY = 1 / FLASH_MS;

export class Flashes {
  /** id -> life, 1 at the moment of the undo and 0 when it is over. */
  readonly items = new Map<string, number>();
  readonly pins = new Map<string, number>();
  readonly strings = new Map<string, number>();

  /** What was already dirty when `around` started. Reused; see the note on
   *  allocation in `state/dirty.ts` — this runs on a keystroke, not a frame,
   *  but the sets are held rather than rebuilt for the same reason. */
  private readonly wasItems = new Set<string>();
  private readonly wasPins = new Set<string>();
  private readonly wasStrings = new Set<string>();

  get isEmpty(): boolean {
    return this.items.size === 0 && this.pins.size === 0 && this.strings.size === 0;
  }

  /**
   * Run a document write and light whatever it turned out to change.
   *
   * Only undo and redo come through here. Every other write is something the
   * person just did on purpose and is already looking at; a flash on those
   * would be a board that blinks whenever it is used.
   */
  around<T>(dirty: DirtySets, scene: Scene, write: () => T): T {
    copy(dirty.items, this.wasItems);
    // Ink counts as the item changing. Undoing a stroke drawn on a photograph
    // moves nothing and dirties no item — only `dirty.ink` says anything
    // happened, and without this the one edit whose result can be a subtle
    // change to a picture is the one edit that flashes nothing.
    for (const id of dirty.ink) this.wasItems.add(id);
    copy(dirty.pins, this.wasPins);
    copy(dirty.strings, this.wasStrings);

    const result = write();

    // Board ink is deliberately not here. A cork tile is not a thing on the
    // board, it is the board, and a rectangle lighting up around a patch of
    // nothing would say that a tile changed rather than that a mark did.
    for (const id of dirty.items) this.raiseItem(id, scene);
    for (const id of dirty.ink) this.raiseItem(id, scene);
    for (const id of dirty.pins) {
      if (!this.wasPins.has(id) && scene.pins.has(id)) this.pins.set(id, 1);
    }
    for (const id of dirty.strings) {
      if (!this.wasStrings.has(id) && scene.strings.has(id)) this.strings.set(id, 1);
    }

    this.wasItems.clear();
    this.wasPins.clear();
    this.wasStrings.clear();
    return result;
  }

  /** One frame of fading. */
  step(dt: number): void {
    if (this.isEmpty) return;
    const spent = dt * DECAY;
    decay(this.items, spent);
    decay(this.pins, spent);
    decay(this.strings, spent);
  }

  /** Used when the document underneath is replaced — the ids stop meaning
   *  anything, and a stale one would light whatever inherited its id. */
  clear(): void {
    this.items.clear();
    this.pins.clear();
    this.strings.clear();
  }

  /**
   * An id is lit only if it is still *on* the board.
   *
   * Undoing a paste un-creates what it made: the binding dirties every id it
   * removed, and every one of them is now a name for nothing. A flash needs
   * something to be drawn around, and there is nothing more to say about a
   * photograph that has just stopped existing than that it is gone.
   */
  private raiseItem(id: string, scene: Scene): void {
    if (!this.wasItems.has(id) && scene.has(id)) this.items.set(id, 1);
  }
}

function copy(from: ReadonlySet<string>, to: Set<string>): void {
  for (const id of from) to.add(id);
}

function decay(lives: Map<string, number>, spent: number): void {
  for (const [id, life] of lives) {
    const left = life - spent;
    if (left <= 0) lives.delete(id);
    else lives.set(id, left);
  }
}
