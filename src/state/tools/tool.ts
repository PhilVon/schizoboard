/**
 * The tool seam.
 *
 * A tool is the thing that turns pointer input into a change on the board.
 * `machine.ts` owns the listeners and the buffering; a tool owns the meaning.
 *
 * Two properties of this interface are load-bearing.
 *
 * **A tool never touches the document.** It calls `BoardWriter`, which queues.
 * Everything queued in the INPUT phase is flushed in phase 9, so the document
 * — and therefore the binding, and therefore the Scene — cannot change under
 * the renderer's feet halfway through a frame (ARCHITECTURE section 3).
 *
 * **A tool never touches the DOM.** It hit-tests through an injected function
 * and mutates only the scene mirror and the dirty sets. That is what lets the
 * whole of `select.ts` be tested with no document, no renderer and no browser
 * — and it is the same reason `state/scene.ts` imports nothing from `crdt/`.
 */

import type { Camera } from "@/state/camera";
import type { DirtySets } from "@/state/dirty";
import type { Scene } from "@/state/scene";
import type { Selection } from "@/state/selection";

/** A pointer position in screen (CSS pixel) space, with its modifiers. */
export interface PointerSample {
  x: number;
  y: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export type ToolInput =
  | { kind: "down"; at: PointerSample }
  | { kind: "move"; at: PointerSample }
  | { kind: "up"; at: PointerSample }
  /** Pointer capture lost — the OS took the gesture away, so revert it. */
  | { kind: "cancel" }
  | { kind: "key"; code: string; shift: boolean; ctrl: boolean; alt: boolean };

/** A pose to write to the document. `rot` absent means "leave it alone". */
export interface WritePose {
  x: number;
  y: number;
  rot?: number;
}

/**
 * A resize. The centre comes with the size and is not optional, because dragging
 * one edge of a note holds the opposite edge still — which means the centre moves
 * by half of whatever the size changed by. Sending the two apart would let a peer
 * observe a note that had grown but not moved, and it would be the wrong shape on
 * screen for as long as that took to correct.
 */
export interface WriteSize {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The document writes tools are allowed to make.
 *
 * Narrow and injected, so `state/tools/` needs no import from `crdt/` at all
 * and every document write a gesture can produce is listed in one place.
 */
export interface BoardWriter {
  /**
   * `live` is the throttled crash-safety write during a drag (DESIGN section
   * 7.3); `final` is the release. The two carry different transaction origins
   * so that the undo manager merges them into a single entry — one drag, one
   * undo (section 3.2).
   */
  setPoses(poses: ReadonlyMap<string, WritePose>, phase: "live" | "final"): void;
  /**
   * The same two phases, for a resize. Separate from `setPoses` because it is a
   * different write with a different cascade: a resize slides the paper under
   * pins that are pushed into the cork, so the op has to move them the other way
   * to leave them where they are.
   */
  setSizes(sizes: ReadonlyMap<string, WriteSize>, phase: "live" | "final"): void;
  /** `keepPins` is Shift+Delete: the evidence goes, the string web keeps its
   *  shape with a hole where it was (DESIGN section 3.8). */
  deleteItems(ids: readonly string[], keepPins: boolean): void;
  /**
   * A blank sheet of paper at a board point.
   *
   * The size is the caller's, not the tool's: an empty note's dimensions come
   * from the same function that sizes a pasted one (`app/ingest.ts`), and a tool
   * may not reach into `app/`. What arrives is a note with no text, which is
   * what DESIGN section 2.1 means by a scrap — "not a special type in the code
   * — it's a note that happens to have no text yet, which is exactly what a
   * blank piece of paper is".
   */
  createNote(boardX: number, boardY: number): void;
  /**
   * Push a pin in, parented to `parent` or free in the cork.
   *
   * `lx`/`ly` are already in the frame `parent` implies — item-local un-rotated
   * when parented, board coordinates when free. The tool converts rather than
   * the op, because only the tool can: an item hanging on one pin is drawn at a
   * rotation and about a centre that are both transient and neither of which is
   * in the document (`state/tools/frame.ts`).
   */
  createPin(parent: string | null, lx: number, ly: number): void;
  /**
   * Put an existing pin down: its parent and its position, in one transaction,
   * so no peer ever sees a pin whose two halves disagree. `parent` of `null` is
   * the cork — which is how a pin is un-parented (DESIGN section 3.3).
   */
  placePin(pinId: string, parent: string | null, lx: number, ly: number): void;
  /** `Alt`+click. The strings through them heal in the same entry. */
  deletePins(ids: readonly string[]): void;
}

export interface ToolContext {
  readonly scene: Scene;
  readonly dirty: DirtySets;
  readonly camera: Camera;
  readonly selection: Selection;
  readonly write: BoardWriter;
  /** Topmost item at a board point. Supplied by the renderer, which owns paint
   *  order — but it answers from the scene, never from the DOM. */
  hitTest(boardX: number, boardY: number): string | null;
  /**
   * The pin under a **screen** point, or null.
   *
   * Screen rather than board, unlike every other geometry question a tool asks,
   * because a pin's grab radius is in screen pixels and has a floor — that is
   * the whole of `render/pins/dom.ts`'s reason for existing. Converting to board
   * space first would throw away the thing being asked about.
   */
  hitPin(screenX: number, screenY: number): string | null;
  /**
   * Key codes held right now. A level rather than an edge, because `R`+drag
   * and `Ctrl`+drag are asked "is it down?" partway through a gesture, not
   * "was it pressed?" at the start of one.
   */
  readonly held: ReadonlySet<string>;
}

export interface Tool {
  readonly id: string;
  /** One buffered input, in the INPUT phase. */
  handle(input: ToolInput, ctx: ToolContext): void;
  /** Once per frame after this frame's inputs, with the frame's dt in ms.
   *  Where anything that eases over time is stepped. */
  tick(dt: number, ctx: ToolContext): void;
  /** Abandon any gesture in progress and put the board back. Called when the
   *  tool is switched away from, and when the window loses focus. */
  cancel(ctx: ToolContext): void;
}
