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

import type { InkSurface, WetStroke } from "@/lib/ink";
import type { ItemStyle } from "@/lib/style";
import type { Bounds, Camera, Vec2 } from "@/state/camera";
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
  /**
   * How hard, 0 to 1 — and only the ink tools have any use for it.
   *
   * Optional because the number is not always meaningful and pretending it is
   * would be worse than leaving it out: a mouse reports exactly 0.5 for every
   * sample it ever delivers, which is the trap DESIGN section 6.5 calls "a very
   * common mistake" and produces dead, uniform lines. `pointer` below is what
   * lets a tool tell a real reading from that constant, and branching on it is
   * T-55.
   */
  pressure?: number;
  /** `"mouse"`, `"pen"` or `"touch"` — the event's `pointerType`, carried for
   *  the branch above. */
  pointer?: string;
  /**
   * The event's own `timeStamp`, in milliseconds.
   *
   * The event's and not a clock read here, because these arrive in batches: a
   * coalesced `pointermove` carries a dozen samples the OS stamped as it took
   * them, and asking a clock when the batch was *unpacked* would give all twelve
   * the same instant. Speed derived from that is speed derived from nothing —
   * which is the flat-line failure `lib/pressure.ts` is about.
   */
  time?: number;
}

export type ToolInput =
  /**
   * `double` is the second press of a double-click, decided by `machine.ts`
   * from the time and the distance since the last one.
   *
   * On the press rather than as an input of its own, and acted on at the
   * release, because a double-click and a drag that happens to start with one
   * are different gestures and only the pointer knows which this is: pressing
   * twice on a string and then pulling means pull a loop out of it, not toggle
   * it taut and also pull a loop out of it. The flag is where the tool needs it
   * — alongside the rest of what the press landed on, which is decided at
   * pointer-down and resolved at pointer-up.
   */
  | { kind: "down"; at: PointerSample; double?: boolean }
  /**
   * `at` is where the pointer is now. `trail` is every sample the OS actually
   * delivered on the way there, oldest first, with `at` as its last entry.
   *
   * The two exist because the board's two kinds of gesture want opposite things
   * from a move. Dragging a photograph wants the *position* — the samples before
   * the last one are history, and `machine.ts` collapses several moves in one
   * frame down to one for exactly that reason. Drawing wants the *path*, and
   * every sample thrown away between two frames is a corner cut off the curve:
   *
   * > Input uses coalesced pointer events, which recover every sample the OS
   * > delivered between frames — the difference between a smooth curve and a
   * > visible polygon on a fast stroke. — DESIGN section 6.5
   *
   * A fast stroke on a 1000 Hz mouse is a dozen samples per frame. Reading only
   * `at` turns that into one vertex every 16 ms, and at speed that is a
   * measurable distance — which is AC-76 failing, and failing worse the faster
   * the hand moves.
   *
   * So a collapse concatenates the trails rather than discarding them, and a tool
   * picks whichever of the two fields matches what it is doing.
   */
  | { kind: "move"; at: PointerSample; trail?: readonly PointerSample[] }
  | { kind: "up"; at: PointerSample }
  /** Pointer capture lost — the OS took the gesture away, so revert it. */
  | { kind: "cancel" }
  | { kind: "key"; code: string; shift: boolean; ctrl: boolean; alt: boolean }
  /**
   * A wheel notch the tool asked for — see `Tool.claimsWheel`. `dy` is the
   * event's `deltaY`, summed over however many landed in this frame, so the
   * sign convention is the DOM's: negative is away from the user.
   *
   * A tool is only handed the ones it claimed, so an unclaimed wheel is the
   * camera's and never reaches here at all.
   */
  | { kind: "wheel"; at: PointerSample; dy: number };

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
   * Override what the seed decides about how these items look — DATA-MODEL
   * section 3's `style` map, reached from the item context menu.
   *
   * A **patch**, and `undefined` in it means *clear*: it takes the override off
   * and lets the seed answer again. That is not the same as writing a default,
   * and the difference is the whole design — see `lib/style.ts`. So a menu row
   * that says "back to whatever this sheet was" passes `{ paperStock: undefined }`
   * rather than a stock name.
   */
  setItemStyle(ids: readonly string[], patch: Partial<ItemStyle>): void;
  /**
   * Move these items to one end of the stack — DESIGN section 2.1's z-order,
   * reached from the item context menu.
   *
   * Both ends rather than one call with a direction, on the argument `setPoses`
   * and `setSizes` make: they are two writes, not one write with a flag. Front
   * generates keys above the board's maximum and back below its minimum, and the
   * two scan opposite ends of a fractional index that has no notion of the
   * middle.
   *
   * What they share is the rule about a group, and it is stated here once. A
   * selection keeps the order it already had among itself: raising three
   * photographs puts all three above everything else and leaves them stacked
   * against each other exactly as they were. Anything else would be a gesture
   * that quietly rearranged what it was asked to move together.
   *
   * Neither writes when it would change nothing. That guard is the op's, in
   * `crdt/ops/z.ts`, and it is there rather than here because the reason for it
   * — key growth, and an undo entry that undoes to the same picture — is a fact
   * about the document rather than about menus.
   */
  bringToFront(ids: readonly string[]): void;
  /** The other end. See [`BoardWriter.bringToFront`]. */
  sendToBack(ids: readonly string[]): void;
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
   *
   * `settle` is `frame.ts`'s `settleOnPin`: the pose to write for an item this
   * pin stops from hanging. Every write on this interface that can hand an item
   * a pin carries one, and they all mean the same thing.
   */
  createPin(
    parent: string | null,
    lx: number,
    ly: number,
    settle?: ReadonlyMap<string, WritePose>,
  ): void;
  /**
   * Put an existing pin down: its parent and its position, in one transaction,
   * so no peer ever sees a pin whose two halves disagree. `parent` of `null` is
   * the cork — which is how a pin is un-parented (DESIGN section 3.3).
   *
   * `settle` carries up to *two* items here rather than one, because a
   * re-parent changes the count at both ends: the item that gained the pin may
   * have stopped hanging, and the item that lost it may have stopped hanging
   * too. See `state/tools/pindrag.ts`.
   */
  placePin(
    pinId: string,
    parent: string | null,
    lx: number,
    ly: number,
    settle?: ReadonlyMap<string, WritePose>,
  ): void;
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
   *
   * `settle` may name several items, since a run can push a pin into each of
   * them; `frame.ts`'s `settleOnPin` takes the whole run at once for that
   * reason.
   */
  createString(
    anchors: readonly StringAnchor[],
    closed: boolean,
    settle?: ReadonlyMap<string, WritePose>,
  ): void;
  /**
   * Push a pin into the middle of a run — the headline gesture (DESIGN section
   * 3.4), as one transaction so that undoing it takes the pin with it.
   *
   * `after` is the id of the node the grabbed segment *starts* at — the new one
   * goes immediately behind it — and `split` says where the cut fell. Those
   * measurements are the tool's and not the op's, because they are geometry:
   * the chords come from where the neighbouring pins actually are, and `crdt/`
   * may not read the scene.
   *
   * An id rather than a position in the run, for the reason `setNodeSlack`
   * below states at length and this gesture is the worst case of: the segment
   * is grabbed on one frame and the write is queued to the next flush, so an
   * index is a handle a peer's insert invalidates in between — and the loop
   * would come out of the neighbouring segment with nothing to show it had. The
   * op refuses outright if the node has gone, rather than clamping to a gap the
   * user did not point at.
   *
   * What the tool deliberately does *not* send is the two slack ratios the cut
   * produces. It used to, and that was wrong: the tool knows the segment's slack
   * only as it was at pointer-down, and the write lands a gesture and a queue
   * flush later. Dividing against a number that stale silently discards a peer's
   * re-slack of the very segment being cut. The op reads it inside its own
   * transaction instead — DATA-MODEL section 5.4. `lib/slack.ts` still does the
   * arithmetic, just on the other side of the seam; getting it wrong is the one
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
    after: string,
    anchor: StringAnchor,
    split: SegmentSplit,
    settle?: ReadonlyMap<string, WritePose>,
  ): void;
  /**
   * The slack of **one gap** — the wheel over a segment, and the double-click
   * that snaps it taut (DESIGN section 3.4).
   *
   * Named by the id of the node the gap starts at, not by its index in the run.
   * A wheel edit reads the current slack on one frame and writes the new one on
   * the next, and an index is exactly the kind of handle a concurrent insert
   * invalidates in between — it would silently adjust the neighbouring gap.
   */
  setNodeSlack(stringId: string, nodeId: string, slack: number): void;
  /**
   * The same gap, multiplied — one notch of the wheel over a segment.
   *
   * A factor and not a value, because a tool's writes are queued to phase 9: a
   * tool that read the slack out of the scene and wrote back the product would
   * read a frame-old number every time, so a steady roll would move the sag by
   * one notch and then stop. The document compounds it instead.
   */
  scaleNodeSlack(stringId: string, nodeId: string, factor: number): void;
  /** Every gap of these strings to one value — the `1`-`9` presets. Absolute,
   *  because pressing `1` means taut whatever the run looked like before. */
  setStringSlack(stringIds: readonly string[], slack: number): void;
  /**
   * Every gap of these strings multiplied — `Alt`+wheel, "all segments
   * together".
   *
   * A factor and not a value, so that a run whose gaps are deliberately unequal
   * — which is every run that has had a pin pulled out of its middle — gains
   * drape without losing the shape `lib/slack.ts` gave it.
   */
  scaleStringSlack(stringIds: readonly string[], factor: number): void;
  /**
   * Which side of the items these strings run — DESIGN section 3.4's "tuck
   * behind", and the one field the two rope canvases sort themselves by.
   *
   * Absolute rather than a toggle, for the same reason the `1`-`9` presets are:
   * a mixed selection has no single state to flip, and a write that meant
   * "invert whatever each one currently is" would scatter a selection the
   * gesture was trying to make agree. The tool decides the one target layer and
   * names it; see `ui/boardmenu.ts`.
   */
  setStringLayer(stringIds: readonly string[], layer: "over" | "under"): void;
  /**
   * > | Restyle | Context menu | Colour (red is default - also blue, green,
   * > yellow, black, white), thickness, material — DESIGN section 3.4
   *
   * Only the fields named are written. Not tidiness: a restyle that read the
   * other four out of the scene and echoed them back would collide with a
   * peer's concurrent restyle of *those* fields for no reason at all, and the
   * last writer would win an argument nobody was having.
   *
   * Separate from `setStringLayer` even though both end in the same op, because
   * `layer` is not styling — it decides which of the two rope canvases draws
   * the string, and it carries a rule of its own about what a mixed selection
   * means. These three are each one value applied to everything named.
   */
  setStringStyle(stringIds: readonly string[], style: StringStyle): void;
  /**
   * > | Cut | `Ctrl`+`Alt`+click a string, **in any tool** — the scissors — or
   * > *Delete* | String removed; its pins stay where they are
   * > — DESIGN section 3.4
   *
   * Its own write rather than a branch of `deleteItems`, because a string and
   * an item are deleted by different rules and only one of them cascades: an
   * item takes its pins and heals the strings through them (DESIGN section
   * 3.8), and a string takes nothing at all. Pins outlive the strings that
   * reference them by construction — D-1, "pins are the primitive" — so there
   * is no `keepPins` to pass and no decision to get wrong.
   */
  deleteStrings(stringIds: readonly string[]): void;
  /**
   * Free pins carried by a group gesture — the leaves of DESIGN section 3.8's
   * "free pins inside the selection have their board coordinates transformed as
   * leaves of the same transform".
   *
   * Board coordinates, because that is what a free pin's stored position *is*.
   * Parented pins are absent by construction: they are stored in their item's
   * frame and travel with it for nothing, which is the whole reason the frame
   * is the item's.
   *
   * Phased like `setPoses` and for the same reason — a long drag lands an
   * intermediate write so a crash does not lose the gesture, and the release
   * then writes the final position whether or not it changed.
   */
  movePins(positions: ReadonlyMap<string, Vec2>, phase: "live" | "final"): void;
  /**
   * One finished gesture — the dry half of DESIGN section 6.5's wet/dry split.
   *
   * > Everything up to pen-up is local and ephemeral. The commit is a single
   * > `Y.Map` insertion. — DATA-MODEL section 6.2
   *
   * A **list**, because one gesture is not always one mark. A line drawn off the
   * side of a photograph and onto the cork is broken at the edge and the pieces
   * are glued to what they are actually over (T-137), so this arrives as one run
   * per surface, in the order the hand made them, each in the frame its own
   * `item` names. The common case is a list of one.
   *
   * Handed over whole rather than a run at a time for the same reason
   * `createString` takes a whole run: it is one thing the user did, and therefore
   * one transaction and one undo entry. Splitting it here would make Ctrl+Z take
   * back the half on the cork and leave the half on the paper.
   *
   * The caller keeps drawing the runs on the overlay until [`Tool`]'s owner says
   * their canvases have caught up — see `MarkerTool.dry`. A write that *lands* is
   * not a mark that is *drawn*: the commit runs in phase 9 and the re-raster is a
   * phase 6 the frame after, so dropping the wet copies on the strength of having
   * queued the write leaves a frame with the mark on no surface at all.
   */
  commitStrokes(runs: readonly WetStroke[]): void;
  /**
   * Whole stroke records, gone.
   *
   * > **Erasing deletes stroke records.** Ink is never rasterised and flattened;
   * > that would destroy both undo and merge. — DATA-MODEL section 6.2
   *
   * One surface per call rather than a flat list of ids, because a stroke id is
   * only unique within the map it is in — an item's `strokes` or a `boardInk`
   * tile — and the two are different documents' worth of addressing. A sweep
   * that crossed from a photograph onto the cork would be two calls, and the
   * eraser does not make that sweep: it fixes the surface at the press, exactly
   * as a pen fixes the space it draws in (DESIGN section 2.4).
   */
  eraseStrokes(surface: InkSurface, ids: readonly string[]): void;
}

/**
 * The three restyle fields, all optional — see `BoardWriter.setStringStyle`.
 *
 * Named here rather than imported from `crdt/`, like `StringAnchor` below and
 * for the same reason: the tool seam describes every write a gesture can make
 * without `state/` depending on the document.
 */
export interface StringStyle {
  readonly color?: string;
  readonly thickness?: number;
  readonly material?: "string" | "yarn" | "wire";
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
 * Where a segment was cut — three chords off the scene and the arc-length
 * fraction the cursor was at. See `BoardWriter.insertPin`.
 *
 * Declared here rather than imported from `crdt/` for the same reason
 * `StringAnchor` is. Notably it carries no slack: that is the one input to the
 * split that belongs to the document rather than to the gesture.
 */
export interface SegmentSplit {
  readonly chord: number;
  readonly first: number;
  readonly second: number;
  readonly t: number;
}

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
   * The same, stopping at the **paper** rather than at the item's rectangle —
   * what a pen is over (T-186, Q-149).
   *
   * A second question rather than a stricter version of the first, because the
   * two have different right answers and the difference is deliberate. A sheet's
   * silhouette recedes from its rectangle by up to nine board units along a torn
   * head, and a mark has to land where you can see paper while a grab target
   * wants to be forgiving. So `hitTest` is what you can pick up and this is what
   * you can write on; only the pens ask this one.
   */
  inkHitTest(boardX: number, boardY: number): string | null;
  /**
   * Which page of this item's document is the face on show, or null for the
   * object itself — T-278.
   *
   * Null for everything but the one case file that is open, and that is the
   * whole of the rule: a photograph has one face, a shut folder shows its
   * cover, and only a folder that has been turned up is showing something that
   * is not itself.
   *
   * Asked rather than derived from the scene because the scene does not know.
   * It knows an item is *open* (`openOf`) and nothing about what is on the
   * paper — the reader that decides which page is drawn is `app/pages.ts`, and
   * it deliberately knows nothing about items in return. The application is the
   * one place that holds both, so it is the one place that can answer, exactly
   * as it is for `inkHitTest` and paint order.
   */
  shownPage(itemId: string): number | null;
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
  /**
   * Put the caret in an item's text — DESIGN section 3.6, and Q-92's
   * double-click.
   *
   * Injected like `hitTest` and for the same reason: writing on a note means a
   * caret, a caret means a real text field, and a tool never touches the DOM.
   * What the tool knows is which piece of paper the pointer meant; everything
   * after that belongs to whoever owns the presentation.
   *
   * Not on `BoardWriter`, because it is not a write. Opening an editor changes
   * nothing about the document and nothing a peer can see — it is a statement
   * about where this person's attention is, and the text it produces arrives
   * through the ordinary character-level writes afterwards.
   */
  edit(itemId: string): void;
  /**
   * Open what is inside an item — read a document, watch a tape, hear a
   * cassette (T-274, Q-257).
   *
   * Injected exactly like {@link edit}, and not a write for the same reason:
   * opening a folder changes nothing about the document and nothing a peer can
   * see. It is a statement about where this person's attention is.
   *
   * **The tool does not decide what is openable.** It knows which item the
   * selection meant and nothing else; whether that item is one of D-46's three
   * objects is a question about the asset record, which a tool has no business
   * reading. So this is safe to call on anything, and does nothing for a note.
   * The same function backs the menu's *Open* row (`ui/boardmenu.ts`), which is
   * what stops the pointer and the keyboard forming two opinions.
   *
   * **`null` shuts whatever is open**, which is `Escape`'s route in (T-273).
   * One capability with two verbs rather than two, because the tool would
   * otherwise be holding an "open" and a "close" that could disagree about what
   * counts as open. The boolean is what lets `Escape` fall through: with
   * nothing open it must still drop the selection, which is what it has always
   * done, so this reports rather than swallowing and the tool decides.
   */
  open(itemId: string | null): boolean;

  /**
   * Turn `by` pages in whatever case file is open, and answer whether it moved
   * (T-321).
   *
   * The same shape as `open` above and for the same reason: the tool knows a
   * keystroke happened and nothing about documents, and the boolean is what
   * lets a press at the last page fall through rather than be swallowed. With
   * nothing open it does nothing and says so.
   */
  turnPage(by: number): boolean;

  /**
   * Follow a thread back to where it was quoted from: open whatever this pin is
   * taped to, at the page it is taped to — T-285, D-46 section 3.
   *
   * **The tool does not decide which pin is a citation**, which is {@link open}'s
   * rule and matters more here. A tape and a pushpin differ by a `kind` and a
   * page number, and both of those are facts about the document; a tool that
   * tested them would be a tool that knows what a case file is. So this is safe
   * to call on **any** pin, and answers `false` for all the ordinary ones —
   * every pin on every board that has never quoted anything.
   *
   * That falsehood is load-bearing rather than defensive. The gesture is a
   * double-click on a string, which already means *toggle taut* (DESIGN section
   * 3.4), and the two coexist by this report: a string with something to follow
   * follows it, and a string without one toggles exactly as it always has. So
   * the caller offers each of the run's pins and takes the first `true` —
   * see `select.ts`. Refusing loudly, or opening at page one, would spend a
   * documented gesture on every string on the board to buy the few that are
   * citations.
   */
  follow(pinId: string): boolean;

  /**
   * Cut a clipping out of the page on show, and hang it on the board — T-282,
   * D-46 section 3.
   *
   * `rect` is **item-local and un-rotated**, the frame every write against a
   * piece of paper uses (`state/tools/frame.ts`): square with the page rather
   * than with the screen, because a folder is read at whatever angle it was
   * scattered to and a screen-aligned cut would run diagonally across the text.
   *
   * ## Why this is a capability and not a `BoardWriter` method
   *
   * It ends in a write — a card, two pins and a string — but everything before
   * that write is a question only the application can answer and only
   * asynchronously. What the rectangle *yields* depends on what is on the page
   * (Q-284: pixels off a scan, the words off a typed page), which is the
   * reader's business; lifting pixels means rasterising DOM, which is the
   * renderer's; and storing them means an ingest that crosses to Rust and comes
   * back with a hash. A tool that could do any of that would be a tool holding
   * an element and a promise.
   *
   * So this is shaped like {@link open} and {@link edit}: the tool knows which
   * paper the pointer meant and hands that over. Unlike those two it does not
   * report — there is nothing for the gesture to fall through to, and the
   * answer arrives long after the pointer has gone up.
   *
   * **Safe to call on anything**, for {@link open}'s reason: whether an item is
   * a case file with a page on show is a question about a document and an asset
   * record, and a tool has no business reading either.
   */
  clip(itemId: string, rect: Bounds): void;
}

/**
 * One line of a tool's help — a gesture, what it does, and what has to be down
 * for it to mean anything.
 *
 * `holds` is what makes the readout teach rather than list: a row whose keys are
 * *currently* down is drawn live (`ui/toolhint.ts`), so holding `Ctrl` and
 * watching a row brighten is the gesture demonstrating itself. That matters most
 * for the ones nothing else suggests — `app/main.ts` says as much about the
 * scissors: "`Ctrl`+`Alt` was chosen precisely because nothing else can be
 * pressed by accident — and the cost of that is that nothing suggests it
 * either."
 *
 * The three modifiers and no more. `R`+drag is the one gesture on this board
 * held on an ordinary letter, and it is deliberately not expressible here: the
 * held set is `KeyboardEvent.code`s and `"Shift"` already stands for two of them
 * (`ShiftLeft` and `ShiftRight`), so admitting `"KeyR"` would be mixing the
 * vocabulary the reader sees with the one the browser uses. The row still
 * appears; it simply never lights.
 */
export interface ToolHintRow {
  /** As a person would say it — `"Alt+drag"`, `"[ and ]"`, `"1-9"`. */
  readonly keys: string;
  /** What it does, lower case, no full stop: `"pull a new string out of a pin"`. */
  readonly does: string;
  /** Held for this row to be live. Absent or empty means always available. */
  readonly holds?: readonly ("Shift" | "Control" | "Alt")[];
}

/**
 * What a tool does, in the tool's own words.
 *
 * Declared on the tool rather than gathered in the widget that draws it, which
 * is the whole reason this interface exists: a gesture and the sentence
 * describing it then live in one file and change together. The alternative was
 * a table in `ui/`, and a table in `ui/` is a second inventory of `state/` that
 * goes stale silently — which is exactly what the hint line it replaces did. It
 * described a board that had changed underneath it for nine phases.
 *
 * **Required**, unlike `claimsWheel` and `pullPreview` below. A tool that says
 * nothing about itself is how the application got back to being undiscoverable.
 */
export interface ToolHint {
  /** `"Select"`, `"Highlighter"` — how the tool is named to a person. */
  readonly name: string;
  /** Its row of DESIGN section 3.9's `Tools` line: `"V"`, `"M"`, `"Shift+E"`. */
  readonly key: string;
  /**
   * The plain gesture, with nothing held — what the tool is *for*.
   *
   * Separate from the rows because it is the one thing that is true before you
   * have learned anything: every row below it is a modifier on this.
   */
  readonly verb: string;
  readonly rows: readonly ToolHintRow[];
}

export interface Tool {
  readonly id: string;
  /** What this tool does, for the info bar — see [`ToolHint`]. */
  readonly hint: ToolHint;
  /** One buffered input, in the INPUT phase. */
  handle(input: ToolInput, ctx: ToolContext): void;
  /**
   * Does a wheel notch here mean something to this tool? Absent means no, which
   * is the answer for every tool but select.
   *
   * The wheel is the one input the camera and the board both want. Everything
   * else divides cleanly — navigation has the middle button and the space bar,
   * the machine has the primary button — but "wheel zooms" (DESIGN section 3.7)
   * and "wheel over a selected segment adjusts its slack" (section 3.4) are the
   * same event, so one of them has to ask the other first. This is the asking,
   * and it is the mirror of `ToolMachineOptions.suppressed`: that one is the
   * board standing aside for a pan, this one is the camera standing aside for a
   * gesture.
   *
   * **Pure.** Unlike `handle`, this is called from the wheel listener rather
   * than from the INPUT phase, because the camera needs its answer in time to
   * not zoom — so it may read, and it may not change anything. `handle` is where
   * the notch is acted on, and it asks the same question again a fraction of a
   * frame later; the two agreeing is a property of this being a function of
   * state neither of them touches.
   */
  claimsWheel?(at: PointerSample, ctx: ToolContext): boolean;
  /** Once per frame after this frame's inputs, with the frame's dt in ms.
   *  Where anything that eases over time is stepped. */
  tick(dt: number, ctx: ToolContext): void;
  /** Abandon any gesture in progress and put the board back. Called when the
   *  tool is switched away from, and when the window loses focus. */
  cancel(ctx: ToolContext): void;
  /**
   * The string being pulled out of a pin right now, for the overlay to draw —
   * `state/tools/quickpull.ts`.
   *
   * On the interface rather than on the select tool because the gesture is on
   * every tool: "`Alt`+drag from a pin, **in any tool**" (DESIGN section 3.4).
   * Optional only so that a tool written later is not obliged to hold one, and
   * every tool that exists does.
   */
  pullPreview?(cursor: Vec2 | null): readonly Vec2[] | null;
}
