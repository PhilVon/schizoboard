/**
 * Undo.
 *
 * > ```js
 * > new Y.UndoManager(
 * >   [items, pins, strings, boardInk],
 * >   { trackedOrigins: new Set([LOCAL_USER, DRAG_THROTTLE, INK_COMMIT]),
 * >     captureTimeout: 400 })
 * > ```
 * > — docs/DATA-MODEL.md section 11
 *
 * One manager per client. Undo reverts *your* operations rather than the last
 * thing that happened on the board — the only multiplayer semantic that isn't
 * infuriating in a shared session (DESIGN section 7.6). That is what
 * `trackedOrigins` buys, and it is the whole reason `crdt/origins.ts` exists:
 * `Y.UndoManager` tracks the `null` origin and nothing else by default, so a
 * forgotten origin doesn't fail, it produces an undo stack that quietly
 * ignores most of the application.
 *
 * Cascades are already atomic — every op wraps one transaction, and
 * `crdt/ops/cascade.ts` opens none of its own — so one undo entry restores an
 * item together with its pins, its string nodes and any string that healed
 * itself when they went. There is nothing to do here for that except not
 * break it, and `undo.test.ts` is what says it stayed unbroken.
 *
 * ## This module never decides *when*
 *
 * `undo()` opens a transaction. Calling it straight from a key listener would
 * write to the document between the LAYOUT and DOM phases of a frame already
 * in flight — precisely the hazard `state/tools/machine.ts` and
 * `state/navigation.ts` exist to prevent. So the caller queues it into phase 9
 * along with every other write.
 *
 * `boundary()` has the same requirement for a sharper reason: it must land
 * *after* the release write of the gesture it closes. Called during INPUT it
 * would end the entry before the drag's final pose joined it, and a drag would
 * take two Ctrl+Z to put back.
 */

import * as Y from "yjs";

import type { BoardDoc } from "@/crdt/doc";
import { TRACKED_ORIGINS } from "@/crdt/origins";

/**
 * DATA-MODEL section 11. `state/tools/select.ts` writes its crash-safety pose
 * every 300 ms specifically to sit inside this window, so a drag of any length
 * is one entry.
 */
export const CAPTURE_TIMEOUT_MS = 400;

/** "Cap the stack at around 200 entries" — DATA-MODEL section 11. */
export const MAX_ENTRIES = 200;

/** The key the camera and selection are stashed under in a stack item's meta. */
const VIEW_KEY = "schizo/view";

/**
 * Where the person was when they made the edit.
 *
 * Neither camera nor selection is in the document (DATA-MODEL section 9), but
 * "undo takes me back to where I was" still matters, so both ride along in the
 * stack item's metadata and are put back on the way through.
 */
export interface ViewState {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly selection: readonly string[];
}

export interface UndoOptions {
  /** Read the current view, to stash on a new entry. Null declines to stash. */
  captureView?: () => ViewState | null;
  /** Put a stashed view back. Called after the transaction has committed. */
  restoreView?: (view: ViewState) => void;
}

type StackEvent = {
  stackItem: { meta: Map<unknown, unknown> };
  type: "undo" | "redo";
};

export class UndoHistory {
  private readonly manager: Y.UndoManager;
  private readonly captureView: (() => ViewState | null) | undefined;
  private readonly restoreView: ((view: ViewState) => void) | undefined;

  constructor(board: BoardDoc, options: UndoOptions = {}) {
    this.captureView = options.captureView;
    this.restoreView = options.restoreView;

    this.manager = new Y.UndoManager(
      // `meta` is absent on purpose. The schema version, the title and the
      // cork seed are not edits, and a board whose cork changed colour because
      // somebody pressed Ctrl+Z would be a poltergeist.
      [board.items, board.pins, board.strings, board.boardInk],
      {
        captureTimeout: CAPTURE_TIMEOUT_MS,
        // A *copy* of the module-level set, because `Y.UndoManager` does
        // `trackedOrigins.add(this)` in its own constructor. Handing it the
        // shared constant would enrol every manager ever built — including
        // each test's — in the application's origin taxonomy, permanently.
        trackedOrigins: new Set<unknown>(TRACKED_ORIGINS),
        // DATA-MODEL section 11 is explicit about the semantic: "if someone
        // moved an item after you did, your undo restores your prior value and
        // their move is lost". Yjs defaults to the opposite — `redoItem`
        // refuses a map key that has been written since, so Ctrl+Z appears to
        // do nothing at all — which is the worse of the two surprises. T-78
        // owns proving this under real concurrency and the flash-highlight
        // that DESIGN section 7.6 asks for so it is never silent.
        ignoreRemoteMapChanges: true,
      },
    );

    this.manager.on("stack-item-added", this.onAdded);
    this.manager.on("stack-item-popped", this.onPopped);
  }

  get canUndo(): boolean {
    return this.manager.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.manager.redoStack.length > 0;
  }

  /** Entries available to Ctrl+Z. Read by tests and the dev HUD. */
  get depth(): number {
    return this.manager.undoStack.length;
  }

  get redoDepth(): number {
    return this.manager.redoStack.length;
  }

  /** True if anything actually changed — a stack of entries that all turned
   *  out to be no-ops against the current document reports false. */
  undo(): boolean {
    return this.manager.undo() !== null;
  }

  redo(): boolean {
    return this.manager.redo() !== null;
  }

  /**
   * End the current entry.
   *
   * "Call `stopCapturing()` on pointer-up, tool change and selection change.
   * Explicit boundaries beat time-based grouping" — DATA-MODEL section 11.
   * `captureTimeout` is the fallback for everything that isn't one of those
   * three, not the mechanism.
   */
  boundary(): void {
    this.manager.stopCapturing();
  }

  /** Everything forgotten — used when the document underneath is replaced. */
  clear(): void {
    this.manager.clear();
  }

  destroy(): void {
    this.manager.off("stack-item-added", this.onAdded);
    this.manager.off("stack-item-popped", this.onPopped);
    this.manager.destroy();
  }

  /**
   * A new entry. Fired once per entry — a drag's later crash-safety writes
   * merge into the same item and fire `stack-item-updated` instead, which is
   * deliberately not listened to: the view worth returning to is the one the
   * gesture *started* from, not wherever the camera drifted while it ran.
   */
  private readonly onAdded = (event: StackEvent): void => {
    const view = this.captureView?.();
    if (view) event.stackItem.meta.set(VIEW_KEY, view);

    // `type` names the stack the item landed on: a normal edit adds to undo, an
    // undo adds the inverse to redo.
    const stack = event.type === "undo" ? this.manager.undoStack : this.manager.redoStack;
    if (stack.length > MAX_ENTRIES) {
      // The oldest entries simply stop existing. Yjs keeps deleted structs
      // from being garbage-collected while a stack item still refers to them
      // and releases them in `clear()`, via an internal it does not export —
      // so a very long session holds a little more of its own history in
      // memory than it can still undo. Bounded and small; unbounded growth is
      // the risk DESIGN section 12 actually names.
      stack.splice(0, stack.length - MAX_ENTRIES);
    }
  };

  /**
   * An entry has just been applied. Emitted after the transaction commits, so
   * the scene mirror is already up to date and a restored selection can be
   * checked against it.
   */
  private readonly onPopped = (event: StackEvent): void => {
    const view = event.stackItem.meta.get(VIEW_KEY);
    if (view) this.restoreView?.(view as ViewState);
  };
}
