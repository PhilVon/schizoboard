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
  /**
   * `Alt`+click. The strings through them heal in the same entry.
   *
   * `settle` is the pose to write for any item that has just lost the pin it
   * was hanging from. An item on one pin is drawn at `rot + swing` about a
   * shifted centre, and none of that is in the document — so when the pin goes,
   * the transient carrying the difference goes with it and the paper would jump
   * to an angle nobody chose. The tool supplies the poses because the rendered
   * pose lives in the scene mirror and `crdt/` may not read it.
   */
  deletePins(ids: readonly string[], settle?: ReadonlyMap<string, WritePose>): void;
  /**
   * A whole run of string, and any pins it needs, in one write.
   *
   * A run is handed over complete rather than a node at a time because a tool's
   * writes are queued to phase 9 and it therefore never learns the id of
   * anything it creates — see `state/tools/string.ts`. It is also the atomicity
   * the run deserves: four clicks that pushed in three pins is one thing the
   * user did, so it is one undo entry.
   */
  createString(anchors: readonly StringAnchor[], closed: boolean): void;
  /**
   * Push a pin into the middle of a run — the headline gesture (DESIGN section
   * 3.4), as one transaction so that undoing it takes the pin with it.
   *
   * `index` is where in the run the new node goes; `slackBefore` and
   * `slackAfter` are what the gap either side of it becomes. Those two are the
   * tool's to compute and not the op's, because they are geometry — the chords
   * come from where the neighbouring pins actually are, and `crdt/` may not read
   * the scene. `lib/slack.ts` does the arithmetic; getting it wrong is the one
   * visible failure this gesture has.
   *
   * `settle` is `deletePins`' argument arriving from the other direction, and
   * for the same reason: an item that had one pin and now has two has stopped
   * hanging, so the swing and the drift it was drawn with stop existing. Its
   * rendered pose written in the same transaction is what keeps the paper — and
   * the pin just placed in it — where the cursor left them.
   */
  insertPin(
    stringId: string,
    index: number,
    anchor: StringAnchor,
    slackBefore: number,
    slackAfter: number,
    settle?: ReadonlyMap<string, WritePose>,
  ): void;
}

/**
 * One stop on a run being drawn: a pin that already exists, or somewhere to
 * push a new one in — an item, or the bare cork.
 *
 * Declared here rather than imported from `crdt/`, so that the tool seam still
 * names every write a gesture can make without `state/tools/` depending on the
 * document at all.
 */
export type StringAnchor =
  | { readonly pin: string }
  | { readonly parent: string | null; readonly lx: number; readonly ly: number };

/**
 * Where a board point lands on a string — what `RopeSet.nearest` answers,
 * named here for the same reason `StringAnchor` is: the tool seam describes
 * everything a gesture reads and writes without `state/tools/` depending on
 * either the document or the simulation.
 *
 * Against the rope's *particles*, not the chord between its pins. A string with
 * any drape in it is nowhere near its own chord in the middle, and the whole
 * gesture is grabbing it where it actually hangs.
 */
export interface StringHit {
  readonly string: string;
  /** Index of the node the segment starts at; an insert goes at `node + 1`. */
  readonly node: number;
  /** Arc-length fraction along that segment, 0 at `node` and 1 at `node + 1` —
   *  which is what `lib/slack.ts` needs to split the sag without it jumping. */
  readonly t: number;
  /** The point itself, board space. */
  readonly x: number;
  readonly y: number;
  readonly distance: number;
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
   * The nearest point on any string to a **board** point, within `reach` board
   * units, or null.
   *
   * Board rather than screen, unlike `hitPin`, because the answer is a point on
   * a curve rather than a target with a grab radius — the caller converts its
   * screen-space tolerance on the way in (`state/tools/frame.ts`). Supplied by
   * the simulation, which is the only thing that knows where a rope hangs.
   */
  hitString(boardX: number, boardY: number, reach: number): StringHit | null;
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
