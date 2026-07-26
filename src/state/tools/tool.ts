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
