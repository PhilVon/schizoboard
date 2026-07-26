/**
 * The select tool — `V`, and the one the board starts in.
 *
 * Click to select, `Shift`+click to add, drag on empty cork for a marquee,
 * `Ctrl+A` for everything visible, `Delete` to remove, `R`+drag or the rotation
 * handle to rotate, and an edge of a sheet of paper to resize it (DESIGN
 * sections 3.2 and 3.8).
 *
 * ## The chrome is asked first
 *
 * A press is offered to the selection's handles before it is offered to the
 * board, because the rotation knob stands off the top edge in open cork and the
 * resize band straddles the paper's edge — in both cases the press would
 * otherwise mean something else entirely, and in the knob's case that something
 * else is a marquee that clears the selection the knob belongs to. Where the
 * handles are is `state/handles.ts`, shared with the overlay that draws them, so
 * that what is grabbable and what is visible are the same geometry.
 *
 * ## Nothing snaps to anything
 *
 * > There is no grid, no alignment guide, no distribution tool. This is
 * > deliberate and it is not a missing feature. — DESIGN section 3.2
 *
 * So a drag is arithmetic and nothing else: every selected item's start pose
 * plus the board-space delta the cursor has travelled. No rounding, no
 * quantisation, no candidate positions. The delta is measured between two
 * *board* points rather than accumulated from screen deltas, which also means
 * zooming mid-drag leaves the item exactly where it was under the cursor.
 *
 * ## Carried, not teleported
 *
 * > While an item is dragged, its shadow lifts and softens, it scales up by
 * > about 2%, and it gains a slight lag-and-catch-up rotation in the direction
 * > of travel. On release it settles. — DESIGN section 3.2
 *
 * None of that is in the document, so all of it lives in the scene's two
 * transient arrays — `lift` and `swing` — and is stepped in `tick()` from the
 * frame's dt. There are no CSS transitions on board content, by rule
 * (ARCHITECTURE section 3): the loop owns every pixel of motion, which is also
 * why the lag survives a paused tab and a 5 fps frame rate without lurching.
 *
 * ## The document sees two writes per drag, not sixty
 *
 * A throttled `live` write every half second is crash safety (DESIGN section
 * 7.3); the `final` write is the release. Both are queued and flushed in phase
 * 9, and their origins are chosen so the undo manager merges them into one
 * entry — one drag, one undo.
 */

import { rotateIn, rotateOut, type Point } from "@/lib/rotate";
import { splitSlack } from "@/lib/slack";
import type { Bounds, Vec2 } from "@/state/camera";
import {
  chromeFrame,
  emptyFrame,
  handleAt,
  handleAxes,
  type HandleFrame,
  type HandleId,
} from "@/state/handles";
import type { ItemPose } from "@/state/scene";
import { anchorAt, anchorParent, drawnPose, settleOnPin, stringAt } from "@/state/tools/frame";
import { PinDrag } from "@/state/tools/pindrag";
import type {
  PointerSample,
  StringHit,
  Tool,
  ToolContext,
  ToolInput,
  WritePose,
  WriteSize,
} from "@/state/tools/tool";

/** Screen pixels the pointer must travel before a press becomes a drag. Below
 *  this, a click that trembles is still a click. */
const DRAG_THRESHOLD_PX = 3;

/**
 * Crash-safety write interval during a drag.
 *
 * DESIGN section 7.3 says "a throttled write every half second... merged into
 * the same undo entry", and those two clauses are in conflict: DATA-MODEL
 * section 11 fixes the undo manager at `captureTimeout: 400`, and merging is
 * purely a matter of the gap between transactions — the origin decides whether
 * a change is *tracked*, never whether it *merges*. Write every 500 ms and
 * every one of them lands 100 ms outside the window, so a three-second drag
 * becomes seven undo entries and Ctrl+Z walks the photograph home in hops.
 *
 * "One drag, one undo entry" (section 3.2) is the requirement; half a second
 * was the illustration. So: comfortably inside 400.
 */
export const LIVE_WRITE_MS = 300;

/** Time constants for the carry. Picking up is quicker than putting down,
 *  which is what reads as weight rather than as a lag spike. */
const LIFT_RISE_MS = 55;
const LIFT_FALL_MS = 130;

/**
 * The lag. `LAG_PER_VELOCITY` is radians per screen-pixel-per-millisecond of
 * travel; a brisk drag is around 2 px/ms, so the cap is reached at speed and
 * approached gently below it.
 *
 * Positive velocity gives positive rotation, and that direction is not
 * arbitrary: an object held at the top and carried to the right trails to the
 * left of its pivot, which in a y-down space is a clockwise turn.
 */
const LAG_PER_VELOCITY = 0.045;
const LAG_MAX_RAD = 0.08;
const LAG_TAU_MS = 70;

/** Below this, a transient is written to exactly zero and stops costing a
 *  dirty flag. Three thousandths of a degree; nobody is watching. */
const SETTLED_EPSILON = 5e-5;

/** Screen pixels from the pivot inside which a rotation angle is noise. */
const ROTATE_DEAD_RADIUS_PX = 24;

/**
 * The smallest a sheet of paper can be dragged down to, in board units.
 *
 * The schema floor is one unit (invariant 6), and an item one unit across is a
 * dot: legal, unhittable, and unrecoverable without undo. Items arrive between
 * about 170 and 330 units across (`lib/polaroid.ts`), so this is small enough to
 * be a deliberate scrap and large enough to still be a thing you can get hold of.
 */
export const MIN_RESIZE = 24;

type GesturePhase =
  | "idle"
  | "pending"
  /** `Alt`+drag from a pin: a new string being pulled out (DESIGN 3.4). */
  | "pulling"
  /** Drag from the middle of a string: a loop of it being pulled out to a new
   *  pin — the headline gesture (DESIGN 3.4). */
  | "looping"
  | "dragging"
  | "rotating"
  | "resizing"
  | "marquee"
  | "pin";

function approach(current: number, target: number, dt: number, tau: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/**
 * The pose to write for an item about to lose the pin it hangs from, or an
 * empty map when nothing is about to.
 *
 * An item on one pin is drawn at `rot + swing` about a centre shifted by
 * `drift`, and neither transient is in the document. Take the pin out and both
 * stop existing, so the paper snaps back to an authored rotation that has been
 * invisible ever since it started hanging — which is what T-107 was. Writing
 * the pose it was drawn at, in the same transaction that removes the pin,
 * leaves the paper exactly where it looks.
 *
 * Only the *last* pin. Going from two to one starts it hanging, which is a
 * swing rather than a jump; three to two changes nothing at all.
 */
function settleOnUnpin(ctx: ToolContext, pinId: string): ReadonlyMap<string, WritePose> {
  const settle = new Map<string, WritePose>();
  const parent = ctx.scene.pins.get(pinId)?.parent ?? null;
  if (parent === null || ctx.scene.pinCount(parent) !== 1) return settle;
  const pose = drawnPose(ctx.scene, parent);
  if (pose) settle.set(parent, pose);
  return settle;
}

export class SelectTool implements Tool {
  readonly id = "select";

  private phase: GesturePhase = "idle";

  /**
   * The pin an `Alt` press landed on, while it is still undecided whether the
   * gesture is a removal or a pull.
   */
  private pullFrom: string | null = null;
  /** Where that pin is, in board space, so the pull can be drawn. */
  private pullX = 0;
  private pullY = 0;

  /**
   * The string being pulled out, for `render/overlay.ts` — the pin it started
   * on, and the cursor.
   *
   * The same shape the string tool's `preview` returns, and drawn by the same
   * code, because they are the same thing arrived at two ways: a run that has
   * not been written down yet.
   */
  pullPreview(cursor: { x: number; y: number } | null): readonly { x: number; y: number }[] | null {
    if (this.phase !== "pulling" || !cursor) return null;
    return [{ x: this.pullX, y: this.pullY }, cursor];
  }

  /**
   * The string a press landed on, before the press became a drag. A click that
   * never moves selects it instead (DESIGN section 3.4).
   */
  private pendingString: StringHit | null = null;

  /**
   * The insertion being pulled out of a string, held from the press until the
   * release — and *only* here, because nothing about it is written until then.
   * That is the whole of AC-71: `Esc` mid-drag reverts by dropping these.
   *
   * The two neighbouring pins are held by id rather than by position, so the
   * chords are measured against wherever they are at the moment of the release
   * rather than wherever they were when the string was grabbed.
   */
  private loopString: string | null = null;
  private loopIndex = 0;
  /** Arc-length fraction along the grabbed segment — where the user took hold
   *  of the string, which is what `splitSlack` divides the sag at. */
  private loopT = 0;
  /** The gap's slack before the split; the sum of the two halves has to come
   *  back to it, or the string flinches at the instant it succeeds. */
  private loopSlack = 0;
  private loopFrom: string | null = null;
  private loopTo: string | null = null;
  /** The three-point run drawn while the loop is out. Reused rather than minted
   *  per frame; the overlay reads it and does not keep it. */
  private readonly loopPoints: Vec2[] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];

  /**
   * The loop being pulled out, for `render/overlay.ts` — the pin behind, the
   * cursor, and the pin ahead.
   *
   * > A new pin is born at that point on the string, free-floating, and follows
   * > your cursor. The string now runs *through* it. — DESIGN section 3.4
   *
   * Straight legs, like the string tool's run and for the same reason: there is
   * no rope for a node that has not been written down, and inventing a second
   * catenary here would show as a jump the moment the real one took over.
   */
  loopPreview(cursor: { x: number; y: number } | null): readonly Vec2[] | null {
    if (this.phase !== "looping" || !cursor) return null;
    this.loopPoints[1]!.x = cursor.x;
    this.loopPoints[1]!.y = cursor.y;
    return this.loopPoints;
  }


  /** Where the press landed, in both spaces. */
  private downX = 0;
  private downY = 0;
  private downBoardX = 0;
  private downBoardY = 0;

  /** The most recent pointer position, screen space. */
  private lastX = 0;
  private lastY = 0;
  /** Where it was at the previous tick — the whole of the velocity model. */
  private prevTickX = 0;

  /** Pose of every item the gesture picked up, at the moment it picked it up. */
  private readonly starts = new Map<string, ItemPose>();
  /** The same ids, as a set, because phase 3 asks "is this one held?" of every
   *  item it is about to swing and a Map's keys are not a set. */
  private readonly holding = new Set<string>();

  /**
   * The carry lag, eased — one number for the whole gesture rather than one per
   * item, because it is a property of how fast the *hand* is moving.
   *
   * Kept here as well as written into the scene so that `sim/torsion.ts` can
   * add it on top of where a single-pinned item hangs, rather than the two
   * fighting over one Float32Array.
   */
  private lag = 0;

  /** Items whose `lift`/`swing` are not zero and not finished moving. */
  private readonly animating = new Set<string>();

  /** Selection at the moment a marquee began, so `Shift` extends rather than
   *  replaces — and so `Esc` can put it back. */
  private marqueeBase: ReadonlySet<string> = new Set();
  private rect: Bounds | null = null;
  private readonly rectBuf: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  /**
   * Pressing an item that is *already* selected must not collapse the
   * selection, or a group could never be dragged — but a plain click on one
   * still has to mean "just this one" (DESIGN section 3.8). So the intent is
   * recorded here at pointer-down and only acted on at pointer-up, if the
   * gesture turned out not to be a drag.
   */
  private pendingSelect: string | null = null;

  /** Reused, because the camera hands back a fresh object otherwise and this
   *  runs on every pointer move of every gesture. */
  private readonly board: Vec2 = { x: 0, y: 0 };
  /** Two, not one: a resize converts a point in and another one back out on the
   *  same pointer move, and sharing a scratch between them is a trap. */
  private readonly probe: Point = { x: 0, y: 0 };
  private readonly placed: Point = { x: 0, y: 0 };

  private pivotX = 0;
  private pivotY = 0;
  private rotateApplied = 0;
  private lastAngle: number | null = null;

  /**
   * Which piece of selection chrome this gesture started on, or null for a press
   * that landed on the board itself. Set at pointer-down and read at `begin`,
   * because the handle under the *press* is what the gesture means — by the time
   * it has become a drag the pointer is somewhere else entirely.
   */
  private grabbed: HandleId | null = null;
  private resizeId: string | null = null;
  /** Which way the grabbed edge pushes, in the item's un-rotated frame. */
  private axisU = 0;
  private axisV = 0;
  /** Reused; `chromeFrame` fills it rather than minting one per press. */
  private readonly frame: HandleFrame = emptyFrame();

  private sinceWrite = 0;
  /** Has this gesture already put a crash-safety pose in the document? */
  private wroteLive = false;

  /**
   * Pins are grabbable in the select tool, not only in the pin tool — DESIGN
   * section 3.3 names the tool for the three rows that *place* a pin and for
   * none of the rows that manipulate one, and section 6.2 puts pins in a layer
   * of their own labelled "hit targets", above items. See `state/tools/pin.ts`.
   *
   * The gesture itself lives next door because it shares none of this tool's
   * state: no selection, no start poses, no marquee.
   */
  private readonly pinDrag = new PinDrag();
  /** The pin a press took hold of, before the press became a drag. */
  private pendingPin: string | null = null;

  /** The marquee rectangle in **board** coordinates, or null. Board rather
   *  than screen so it stays anchored to the cork if the camera moves under
   *  it. Read by the overlay in phase 8. */
  get marquee(): Bounds | null {
    return this.rect;
  }

  /** True while a gesture is in progress — the pointer is captured and the
   *  board is being changed. */
  get gesturing(): boolean {
    return this.phase !== "idle";
  }

  /**
   * The handle this gesture has hold of, or null. Read by the cursor, which must
   * keep saying "resize" while the pointer is dragged far away from the edge it
   * started on — a cursor that reverts halfway through the gesture reads as the
   * gesture having been dropped.
   */
  get activeHandle(): HandleId | null {
    return this.grabbed;
  }

  /**
   * The item a pin being dragged would parent to if it were let go now, or
   * null. Drawn as a ring by the overlay — "candidate items highlight with a
   * ring" (DESIGN section 3.3), which is the only feedback that says whether
   * the drop has taken before you commit to it.
   */
  get pinCandidate(): string | null {
    return this.pinDrag.candidate;
  }

  /**
   * The items this gesture has hold of, and the carry rotation it has built up.
   *
   * Read by `sim/torsion.ts` in phase 3. A single-pinned item's `swing` belongs
   * to the swing simulation, not to this tool — it does not settle to zero, it
   * settles to wherever the item hangs — so the two divide it: this owns the
   * lag, that owns the hang, and the sum is written once, over there.
   */
  get heldItems(): ReadonlySet<string> {
    return this.holding;
  }

  get carryLag(): number {
    return this.lag;
  }

  /**
   * Where a held item was pivoting when the gesture took hold, for the items
   * this tool knows better than the scene does — which today is exactly one:
   * the item a pin being dragged hangs from, because the pin whose position
   * phase 3 would otherwise read is the one this gesture is moving.
   *
   * Empty for every other gesture. A drag or a rotation moves the item and
   * leaves its pins where they are in its own frame, so the scene is still the
   * best answer and `sim/torsion.ts` goes on asking it.
   */
  get heldPivots(): ReadonlyMap<string, { lx: number; ly: number }> {
    return this.pinDrag.heldPivots;
  }

  handle(input: ToolInput, ctx: ToolContext): void {
    switch (input.kind) {
      case "down":
        this.onDown(input.at, ctx);
        break;
      case "move":
        this.onMove(input.at, ctx);
        break;
      case "up":
        this.onUp(input.at, ctx);
        break;
      case "cancel":
        this.cancel(ctx);
        break;
      case "key":
        this.onKey(input, ctx);
        break;
    }
  }

  // --- pointer --------------------------------------------------------------

  private onDown(at: PointerSample, ctx: ToolContext): void {
    // A collaborator may have deleted something we still think we have hold
    // of. Dragging a ghost silently does nothing, which is the worst kind.
    ctx.selection.prune(
      (id) => ctx.scene.has(id),
      (id) => ctx.scene.strings.has(id),
    );

    this.downX = this.lastX = this.prevTickX = at.x;
    this.downY = this.lastY = at.y;
    this.pendingSelect = null;
    this.pendingPin = null;
    this.pendingString = null;
    this.grabbed = null;
    const board = ctx.camera.screenToBoard(at.x, at.y, this.board);
    this.downBoardX = board.x;
    this.downBoardY = board.y;

    /**
     * `Alt` on a pin means two different things and the pointer decides which:
     *
     * > | Remove | `Alt`+click, or context menu | Strings through it heal
     * > | Quick pull | `Alt`+drag from a pin, in any tool | Pulls a new string
     * >   out without switching tools — DESIGN sections 3.3 and 3.4
     *
     * So neither can happen here. Removing the pin on the press, which is what
     * this used to do, makes the drag unreachable — the pin is gone before the
     * pointer has had a chance to move. The press only records which pin was
     * under it; `begin` turns that into a pull once the pointer has travelled,
     * and `onUp` removes it if it never did.
     */
    const pin = ctx.hitPin(at.x, at.y);
    if (pin !== null && at.alt) {
      this.pullFrom = pin;
      this.phase = "pending";
      return;
    }

    /**
     * The chrome gets the press before the board does, and that ordering is the
     * whole reason the handle works at all: the rotation knob stands off the top
     * edge in open cork, so a press that reached it would otherwise fall through
     * to `hitTest`, find nothing, and start a marquee — which clears the very
     * selection the knob belongs to. The edges are the same story one step in,
     * where falling through starts a drag instead of a resize.
     *
     * Nothing about the selection changes here, `Shift` included. Pressing an
     * item's own handle is not a statement about what is selected.
     */
    const frame = chromeFrame(ctx.camera, ctx.scene, ctx.selection, this.frame);
    const handle = frame ? handleAt(frame, at.x, at.y) : null;
    if (handle !== null) {
      this.grabbed = handle;
      this.phase = "pending";
      return;
    }

    /**
     * A pin, then. It beats the item beneath it because it is physically on
     * top of it — and nothing about the selection changes, for the same reason
     * pressing a handle does not: taking hold of a pin is not a statement about
     * which photographs are selected.
     */
    if (pin !== null) {
      this.pendingPin = pin;
      this.phase = "pending";
      return;
    }

    /**
     * A string, then — the headline gesture (DESIGN section 3.4), and it beats
     * the item under it for the same reason the pin does: where a run is drawn
     * over items it is physically on top of them. `stringAt` is what decides
     * that, and it is the same function the hover highlight asks, so a press
     * cannot mean something the highlight did not offer.
     *
     * Which of the two things a press on a string means — pull a loop out, or
     * select it — is not decided here. The pointer decides, exactly as it does
     * for `Alt` on a pin: travel makes it a pull, stillness makes it a click.
     */
    const onString = stringAt(
      ctx.scene,
      ctx.camera,
      ctx.hitTest,
      ctx.hitPin,
      ctx.hitString,
      at.x,
      at.y,
    );
    if (onString !== null) {
      this.pendingString = onString;
      this.phase = "pending";
      return;
    }

    const hit = ctx.hitTest(board.x, board.y);

    if (hit === null) {
      // Empty cork: a marquee. Without Shift it starts from nothing, which is
      // also what makes a plain click on the cork a deselect.
      if (!at.shift) ctx.selection.clear();
      this.marqueeBase = new Set(ctx.selection.members);
      this.rectBuf.minX = this.rectBuf.maxX = board.x;
      this.rectBuf.minY = this.rectBuf.maxY = board.y;
      this.rect = this.rectBuf;
      this.phase = "marquee";
      return;
    }

    if (at.shift) {
      ctx.selection.toggle(hit);
      // Shift-clicking something *out* of the selection must not then drag the
      // rest of it around — the gesture was a deselect and it is over.
      if (!ctx.selection.has(hit)) {
        this.phase = "idle";
        return;
      }
    } else if (!ctx.selection.has(hit)) {
      ctx.selection.replace([hit]);
    } else {
      // Already selected. Keep the rest of the selection for now so a group
      // drag works, and narrow to this one at release if no drag happened.
      this.pendingSelect = hit;
    }

    this.phase = "pending";
  }

  private onMove(at: PointerSample, ctx: ToolContext): void {
    this.lastX = at.x;
    this.lastY = at.y;

    switch (this.phase) {
      case "pending": {
        const dx = at.x - this.downX;
        const dy = at.y - this.downY;
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        if (!this.begin(ctx)) return;
        // Fall through into the first frame of the gesture, so the item does
        // not sit still for the frame in which it was picked up.
        this.applyGesture(ctx);
        return;
      }
      case "dragging":
      case "rotating":
      case "resizing":
      case "pin":
      case "looping":
        this.applyGesture(ctx);
        return;
      case "marquee":
        this.applyMarquee(at, ctx);
        return;
      default:
        return;
    }
  }

  private onUp(at: PointerSample, ctx: ToolContext): void {
    /**
     * The two ends of the `Alt` gesture. A pull that got as far as moving
     * writes a string from the pin it started on to whatever the release
     * landed on — pin, item or bare cork, by the same rule the string tool
     * uses. One that never moved was a click, and a click removes the pin.
     */
    if (this.pullFrom !== null) {
      const from = this.pullFrom;
      this.pullFrom = null;
      if (this.phase === "pulling") {
        const to = anchorAt(ctx.scene, ctx.camera, ctx.hitTest, ctx.hitPin, at.x, at.y);
        // A pull that ended back on its own pin is a string of one node, which
        // is not a string. Nothing written, nothing removed — it was a drag,
        // so it was not a click either.
        const onItself = "pin" in to.anchor && to.anchor.pin === from;
        // The far end may be an item that hangs, and this is the pin that stops
        // it — `settleOnPin`. The near end is a pin that already exists and
        // changes nobody's count.
        if (!onItself) {
          ctx.write.createString(
            [{ pin: from }, to.anchor],
            false,
            settleOnPin(ctx.scene, [anchorParent(to.anchor)]),
          );
        }
      } else {
        // "Strings through it heal", which the op does in the same transaction.
        ctx.write.deletePins([from], settleOnUnpin(ctx, from));
      }
      this.phase = "idle";
      ctx.dirty.camera = true;
      return;
    }

    /**
     * The two ends of the string gesture, and the same shape as the `Alt` one
     * above. A loop that got as far as moving writes the new pin and the node
     * that carries it; one that never moved was a click, and
     *
     * > A plain click without dragging selects the string instead.
     * > — DESIGN section 3.4
     */
    if (this.phase === "looping") {
      this.commitLoop(at, ctx);
      this.resetLoop();
      this.phase = "idle";
      ctx.dirty.camera = true;
      return;
    }
    if (this.pendingString !== null) {
      const stringId = this.pendingString.string;
      this.pendingString = null;
      ctx.selection.replaceStrings([stringId]);
      this.phase = "idle";
      return;
    }

    if (this.phase === "pin") {
      this.lastX = at.x;
      this.lastY = at.y;
      this.pinDrag.move(at.x, at.y, ctx);
      this.pinDrag.end(ctx);
      // Let go: the item is free to re-hang from wherever the pin ended up.
      this.holding.clear();
    } else if (
      this.phase === "dragging" ||
      this.phase === "rotating" ||
      this.phase === "resizing"
    ) {
      // The release position is part of the gesture. Skipping it drops the
      // last few pixels of a fast flick, which is exactly where the pointer
      // moves furthest between samples.
      this.lastX = at.x;
      this.lastY = at.y;
      this.applyGesture(ctx);
      this.commit(ctx, "final");
      this.release();
    } else if (this.phase === "marquee") {
      this.rect = null;
    } else if (this.pendingSelect !== null) {
      // A press on an already-selected item that never became a drag. It was a
      // click, so it means that one item — DESIGN section 3.8, "click to
      // select" — and the group it was standing in goes.
      ctx.selection.replace([this.pendingSelect]);
    }
    this.pendingSelect = null;
    // A click on a handle that never became a drag rotates and resizes by
    // nothing, which is the right amount, and must not deselect either. A click
    // on a pin is the same: it moves the pin nowhere, and leaves the selection
    // exactly as it found it.
    this.pendingPin = null;
    this.grabbed = null;
    this.phase = "idle";
  }

  /**
   * `R` is read here rather than at pointer-down so that pressing it after
   * putting the cursor down still rotates — which is how people actually reach
   * for a modifier they only just decided they wanted. The *handle*, by
   * contrast, was decided at pointer-down, because a handle is a place and the
   * pointer has left it by now.
   *
   * Returns false if there turned out to be nothing to pick up.
   */
  private begin(ctx: ToolContext): boolean {
    // The pointer moved with `Alt` held on a pin, so this is a quick pull and
    // not a removal. Nothing is written until the release says where to.
    if (this.pullFrom !== null) {
      const pin = ctx.scene.pins.get(this.pullFrom);
      if (!pin) {
        this.pullFrom = null;
        this.phase = "idle";
        return false;
      }
      this.pullX = pin.wx;
      this.pullY = pin.wy;
      this.phase = "pulling";
      return true;
    }

    // The press landed on a string and the pointer has moved, so a loop is
    // being pulled out of it. Like the pull above, nothing is written until the
    // release says where the new pin goes.
    if (this.pendingString !== null) {
      const hit = this.pendingString;
      this.pendingString = null;
      if (!this.beginLoop(hit, ctx)) {
        this.phase = "idle";
        return false;
      }
      this.phase = "looping";
      return true;
    }

    // A pin was under the press, so this drag is that pin's and nothing else's
    // — no selection is picked up and no item moves.
    if (this.pendingPin !== null) {
      const pin = this.pendingPin;
      this.pendingPin = null;
      if (!this.pinDrag.begin(pin, this.downX, this.downY, ctx)) {
        this.phase = "idle";
        return false;
      }
      this.phase = "pin";
      this.markPinHold();
      return true;
    }

    // This is a drag, so the click that would have narrowed the selection to
    // one item is off.
    this.pendingSelect = null;
    this.starts.clear();
    this.holding.clear();
    this.resizeId = null;
    for (const id of ctx.selection.members) {
      const pose = ctx.scene.poseOf(id);
      if (!pose) continue;
      this.starts.set(id, pose);
      this.holding.add(id);
      this.animating.add(id);
    }
    if (this.starts.size === 0) {
      this.phase = "idle";
      return false;
    }

    this.sinceWrite = 0;
    this.prevTickX = this.lastX;

    if (this.grabbed !== null && this.grabbed !== "rotate") {
      // A resize handle only exists on a single selection (`state/handles.ts`),
      // so there is exactly one item here and it is the one that was grabbed.
      const axes = handleAxes(this.grabbed);
      this.axisU = axes.u;
      this.axisV = axes.v;
      for (const id of this.starts.keys()) this.resizeId = id;
      this.phase = "resizing";
      return true;
    }

    if (this.grabbed === "rotate" || ctx.held.has("KeyR")) {
      /**
       * What is being turned about what.
       *
       * A single item hanging on a single pin turns about **the pin**, because
       * the pin is stuck in the cork and does not move — the same rule the
       * swing follows (`sim/torsion.ts`), and the one place it was not being
       * followed. Turning such an item about its own centre slides the pin
       * across the board for as long as the handle is held, which is exactly
       * the thing that makes a hanging photograph read as a sticker.
       *
       * Otherwise the centre of what is being turned: for a rigid or loose item
       * its own centre, so it spins in place; for a group the middle of the
       * group, so the whole arrangement turns as one thing.
       */
      const sole = this.solePinPivot(ctx);
      const bounds = sole ? null : ctx.scene.boundsOfMany(this.starts.keys());
      this.pivotX = sole ? sole.wx : bounds ? (bounds.minX + bounds.maxX) / 2 : this.downBoardX;
      this.pivotY = sole ? sole.wy : bounds ? (bounds.minY + bounds.maxY) / 2 : this.downBoardY;
      this.rotateApplied = 0;
      this.lastAngle = null;
      this.phase = "rotating";
    } else {
      this.phase = "dragging";
    }
    return true;
  }

  /**
   * While a pin is being dragged, the items at either end of the move count as
   * held — which stops `sim/torsion.ts` swinging them.
   *
   * Without this the gesture chases itself: moving the pin changes where the
   * item hangs, the item swings, and a parented pin's world position is derived
   * from the item's pose — so the item carries the pin out from under the
   * cursor and the pin becomes almost impossible to place. Freezing the swing
   * for the duration means the pin goes exactly where it is put and the item
   * re-hangs when it is let go, which is also what happens when you move a pin
   * on a wall: the photograph does not move until you take your hand off it.
   */
  /**
   * The pin a rotation should turn about, or null.
   *
   * One item, one pin. A group has no single pin to turn about, and asking two
   * pinned photographs to rotate about one of their pins would swing the other
   * one across the board.
   *
   * `wx`/`wy` are the pin's world position, which for a hanging item is
   * invariant under the swing by construction — so the arithmetic below holds
   * whether the item is mid-swing or settled: rotating its stored centre about
   * this point and adding the same angle to `rot` leaves the pin exactly here.
   */
  private solePinPivot(ctx: ToolContext): { wx: number; wy: number } | null {
    if (this.starts.size !== 1) return null;
    for (const id of this.starts.keys()) return ctx.scene.solePin(id);
    return null;
  }

  private markPinHold(): void {
    this.holding.clear();
    const from = this.pinDrag.origin;
    const onto = this.pinDrag.candidate;
    if (from !== null) this.holding.add(from);
    if (onto !== null) this.holding.add(onto);
  }

  /**
   * Take hold of the segment the press landed on: which string, where in its
   * run the new node goes, and which two pins the split is between.
   *
   * `node` is the index of the node the segment *starts* at, so the insert goes
   * at `node + 1` — and on the wrap segment of a closed run that is the end of
   * the run, which is where a node between the last pin and the first one
   * belongs (DATA-MODEL section 5.2).
   *
   * Returns false if the run or either of its pins has gone — a collaborator
   * can delete the string between the press and the pointer moving, and pulling
   * a loop out of nothing should be no gesture at all rather than a write.
   */
  private beginLoop(hit: StringHit, ctx: ToolContext): boolean {
    const run = ctx.scene.strings.get(hit.string);
    if (!run) return false;
    const from = run.nodes[hit.node];
    const to = run.nodes[(hit.node + 1) % run.nodes.length];
    if (!from || !to) return false;
    if (!ctx.scene.pins.has(from.pin) || !ctx.scene.pins.has(to.pin)) return false;

    this.loopString = hit.string;
    this.loopIndex = hit.node + 1;
    this.loopT = hit.t;
    this.loopSlack = from.slackAfter;
    this.loopFrom = from.pin;
    this.loopTo = to.pin;
    this.refreshLoop(ctx);
    return true;
  }

  /** Where the two neighbouring pins are *now*, for the preview. Re-read every
   *  move rather than captured at the press, so a loop held while a
   *  collaborator drags the photograph at one end stays attached to it. */
  private refreshLoop(ctx: ToolContext): void {
    const a = this.loopFrom === null ? undefined : ctx.scene.pins.get(this.loopFrom);
    const b = this.loopTo === null ? undefined : ctx.scene.pins.get(this.loopTo);
    if (a) {
      this.loopPoints[0]!.x = a.wx;
      this.loopPoints[0]!.y = a.wy;
    }
    if (b) {
      this.loopPoints[2]!.x = b.wx;
      this.loopPoints[2]!.y = b.wy;
    }
  }

  /**
   * The release: one write, or none.
   *
   * The drop lands by the same rule every other string end does — a pin, an
   * item that gets its own pin, or the bare cork (`anchorAt`) — and the two
   * slack ratios come from `lib/slack.ts` against the chords as they are at this
   * instant. That is the critical detail of the whole gesture:
   *
   * > when the string splits at that point, the slack must split proportionally
   * > so the two new segments together sag exactly as the original did. Get this
   * > wrong and the string visibly jumps at the moment of insertion.
   * > — DESIGN section 3.4
   *
   * A drop onto a hanging item carries one more thing: that item's pose, by
   * `settleOnPin` and in the same transaction, because the pin being written is
   * the one that stops it hanging.
   */
  private commitLoop(at: PointerSample, ctx: ToolContext): void {
    const stringId = this.loopString;
    const from = this.loopFrom;
    const to = this.loopTo;
    if (stringId === null || from === null || to === null) return;
    const a = ctx.scene.pins.get(from);
    const b = ctx.scene.pins.get(to);
    if (!a || !b) return;

    const drop = anchorAt(ctx.scene, ctx.camera, ctx.hitTest, ctx.hitPin, at.x, at.y);
    // Dropped back onto one of the two pins this segment already runs between.
    // That is a node with nothing on one side of it — a duplicate stop, not a
    // pin in the middle of anything — so nothing is written, which is the same
    // revert `Esc` gives and the same rule the `Alt` pull follows.
    if ("pin" in drop.anchor && (drop.anchor.pin === from || drop.anchor.pin === to)) return;

    const chord = Math.hypot(b.wx - a.wx, b.wy - a.wy);
    const first = Math.hypot(drop.x - a.wx, drop.y - a.wy);
    const second = Math.hypot(b.wx - drop.x, b.wy - drop.y);
    const [before, after] = splitSlack(chord, this.loopSlack, first, second, this.loopT);
    ctx.write.insertPin(
      stringId,
      this.loopIndex,
      drop.anchor,
      before,
      after,
      settleOnPin(ctx.scene, [anchorParent(drop.anchor)]),
    );
  }

  /** Let go of the segment. Nothing to put back: nothing was written. */
  private resetLoop(): void {
    this.loopString = null;
    this.loopFrom = null;
    this.loopTo = null;
  }

  private applyGesture(ctx: ToolContext): void {
    if (this.phase === "pin") {
      this.pinDrag.move(this.lastX, this.lastY, ctx);
      this.markPinHold();
      return;
    }
    if (this.phase === "resizing") {
      this.applyResize(ctx);
      return;
    }
    if (this.phase === "looping") {
      // Nothing on the board moves while a loop is out — the string is still
      // exactly where the document says it is, and the pulled shape lives in
      // the overlay until the release writes it down.
      this.refreshLoop(ctx);
      return;
    }

    const board = ctx.camera.screenToBoard(this.lastX, this.lastY, this.board);

    if (this.phase === "rotating") {
      const dx = board.x - this.pivotX;
      const dy = board.y - this.pivotY;
      const dead = ROTATE_DEAD_RADIUS_PX / ctx.camera.zoom;
      if (dx * dx + dy * dy < dead * dead) {
        // Too close to the pivot for the direction to mean anything. Drop the
        // reference so coming back out re-anchors instead of snapping.
        this.lastAngle = null;
      } else {
        const angle = Math.atan2(dy, dx);
        if (this.lastAngle !== null) {
          let step = angle - this.lastAngle;
          // Crossing the ±pi seam is a small step the long way round.
          if (step > Math.PI) step -= 2 * Math.PI;
          else if (step < -Math.PI) step += 2 * Math.PI;
          this.rotateApplied += step;
        }
        this.lastAngle = angle;
      }

      // Hoisted, so turning forty selected items about one pivot costs two
      // calls to Math.cos rather than eighty.
      const cos = Math.cos(this.rotateApplied);
      const sin = Math.sin(this.rotateApplied);
      for (const [id, start] of this.starts) {
        const turned = rotateOut(
          start.x - this.pivotX,
          start.y - this.pivotY,
          this.pivotX,
          this.pivotY,
          cos,
          sin,
          this.probe,
        );
        ctx.scene.setPose(id, {
          x: turned.x,
          y: turned.y,
          rot: start.rot + this.rotateApplied,
        });
        ctx.dirty.item(id);
      }
      return;
    }

    const dx = board.x - this.downBoardX;
    const dy = board.y - this.downBoardY;
    for (const [id, start] of this.starts) {
      ctx.scene.setPose(id, { x: start.x + dx, y: start.y + dy });
      ctx.dirty.item(id);
    }
  }

  /**
   * The edge follows the cursor and the opposite edge stays exactly where it is.
   *
   * All of it happens in the item's own un-rotated frame — the cursor's travel is
   * rotated into that frame, the size changes along those axes, and the centre's
   * compensating half-step is rotated back out. Working in board space instead
   * would mean the east edge of a note lying at 30° grew towards the screen's
   * right rather than towards the note's own right, which is not what the cursor
   * looked like it was doing.
   *
   * Measured from the press point against the *start* pose rather than
   * accumulated per move, for the same reason the drag is (see the file header):
   * zooming mid-gesture then leaves the edge under the cursor instead of drifting
   * off it, and the clamp at [`MIN_RESIZE`] cannot ratchet. When an axis is
   * clamped the centre stops moving with it, because both come from the same
   * clamped size — so a note squashed to the floor and dragged further stays put
   * rather than sliding away.
   *
   * The angle is the item's *authored* rotation, not the rendered one. A resize
   * cannot start while the item is still turning, and the settling swing of an
   * item just released is at most a few degrees for a few frames.
   */
  private applyResize(ctx: ToolContext): void {
    const id = this.resizeId;
    const start = id === null ? undefined : this.starts.get(id);
    if (id === null || !start) return;

    const board = ctx.camera.screenToBoard(this.lastX, this.lastY, this.board);
    const cos = Math.cos(start.rot);
    const sin = Math.sin(start.rot);
    // How far the cursor has travelled, in the item's frame. The press point is
    // the centre of that frame, so the "point" being converted is the delta.
    const travel = rotateIn(board.x, board.y, this.downBoardX, this.downBoardY, cos, sin, this.probe);

    const w = this.axisU === 0 ? start.w : Math.max(MIN_RESIZE, start.w + this.axisU * travel.x);
    const h = this.axisV === 0 ? start.h : Math.max(MIN_RESIZE, start.h + this.axisV * travel.y);
    // Half the growth, towards the edge being dragged, so the other one holds.
    const centre = rotateOut(
      (this.axisU * (w - start.w)) / 2,
      (this.axisV * (h - start.h)) / 2,
      start.x,
      start.y,
      cos,
      sin,
      this.placed,
    );

    ctx.scene.setPose(id, { x: centre.x, y: centre.y, w, h });
    ctx.dirty.item(id);
  }

  /**
   * Walks every item on the board per pointer move. That is a few thousand
   * cheap arithmetic tests at the very worst, it only happens while a marquee
   * is actually being dragged, and the alternative is a spatial index that has
   * to be kept correct — which is T-27's job and worth doing once, there.
   */
  private applyMarquee(at: PointerSample, ctx: ToolContext): void {
    const board = ctx.camera.screenToBoard(at.x, at.y, this.board);
    const rect = this.rectBuf;
    rect.minX = Math.min(this.downBoardX, board.x);
    rect.minY = Math.min(this.downBoardY, board.y);
    rect.maxX = Math.max(this.downBoardX, board.x);
    rect.maxY = Math.max(this.downBoardY, board.y);
    this.rect = rect;

    const inside = new Set(this.marqueeBase);
    for (const id of ctx.scene.itemIds()) {
      if (ctx.scene.intersectsRect(id, rect)) inside.add(id);
    }
    ctx.selection.replace(inside);
  }

  // --- keys -----------------------------------------------------------------

  private onKey(
    input: Extract<ToolInput, { kind: "key" }>,
    ctx: ToolContext,
  ): void {
    switch (input.code) {
      case "Escape":
        // Mid-gesture Escape reverts; otherwise it drops the selection.
        if (this.gesturing) this.cancel(ctx);
        else ctx.selection.clear();
        return;

      case "Delete":
      case "Backspace": {
        if (this.gesturing || ctx.selection.isEmpty) return;
        const doomed = ctx.selection.toArray();
        ctx.selection.clear();
        for (const id of doomed) this.animating.delete(id);
        // Shift+Delete keeps the pins: "the string web keeps its shape with a
        // hole where the evidence was" (DESIGN section 3.8).
        ctx.write.deleteItems(doomed, input.shift);
        return;
      }

      case "KeyA": {
        if (!input.ctrl || this.gesturing) return;
        // "Ctrl+A for everything visible" — on an unbounded board, everything
        // is not a useful selection.
        const view = ctx.camera.visibleBounds();
        const seen: string[] = [];
        for (const id of ctx.scene.itemIds()) {
          if (ctx.scene.intersectsRect(id, view)) seen.push(id);
        }
        ctx.selection.replace(seen);
        return;
      }

      default:
        return;
    }
  }

  // --- the frame ------------------------------------------------------------

  tick(dt: number, ctx: ToolContext): void {
    if (
      dt > 0 &&
      (this.phase === "dragging" || this.phase === "rotating" || this.phase === "resizing")
    ) {
      this.sinceWrite += dt;
      if (this.sinceWrite >= LIVE_WRITE_MS) {
        this.sinceWrite = 0;
        this.commit(ctx, "live");
      }
    }

    if (this.animating.size === 0) return;

    // Screen pixels per millisecond. Screen rather than board, so a carried
    // item lags by the same amount whatever the zoom — the lag is about how
    // fast your hand is moving, not how much board it covered.
    const velocity = dt > 0 && this.phase === "dragging" ? (this.lastX - this.prevTickX) / dt : 0;
    this.prevTickX = this.lastX;

    const lagTarget = Math.max(
      -LAG_MAX_RAD,
      Math.min(LAG_MAX_RAD, velocity * LAG_PER_VELOCITY),
    );
    // Rotation is deliberate, so it gets the lift but not the lag; a turning
    // item that also leaned would read as two things happening at once.
    this.lag = approach(this.lag, this.phase === "dragging" ? lagTarget : 0, dt, LAG_TAU_MS);

    for (const id of this.animating) {
      const slot = ctx.scene.slotOf(id);
      if (slot === undefined) {
        this.animating.delete(id);
        continue;
      }

      // `starts` is populated by begin() and emptied by release(), so
      // membership is exactly "this gesture is holding it".
      const held = this.starts.has(id);
      const liftTarget = held ? 1 : 0;

      const lift = approach(
        ctx.scene.lift[slot]!,
        liftTarget,
        dt,
        liftTarget > ctx.scene.lift[slot]! ? LIFT_RISE_MS : LIFT_FALL_MS,
      );

      /**
       * Whose rotation is this?
       *
       * A single-pinned item hangs, and `sim/torsion.ts` owns its `swing`
       * outright — it does not settle to zero, it settles to wherever the item
       * hangs, and the carry lag is added on top of that over there. Everything
       * else — rigid on two pins, flat on none — still eases its lag back to
       * nothing here, exactly as it did before any of this existed.
       */
      const hangs = ctx.scene.pinCount(id) === 1;
      // Eased from the target rather than from `this.lag`, even though the two
      // are the same calculation: chaining them would put a second first-order
      // filter in the path and the carry would visibly lose its snap.
      const swingTarget = held && this.phase === "dragging" ? lagTarget : 0;
      const swing = hangs
        ? ctx.scene.swing[slot]!
        : approach(ctx.scene.swing[slot]!, swingTarget, dt, LAG_TAU_MS);

      const done =
        !held &&
        Math.abs(lift) < SETTLED_EPSILON &&
        (hangs || Math.abs(swing) < SETTLED_EPSILON);

      ctx.scene.lift[slot] = done ? 0 : lift;
      if (!hangs) ctx.scene.swing[slot] = done ? 0 : swing;
      ctx.dirty.item(id);
      if (done) this.animating.delete(id);
    }
  }

  /**
   * Abandon the gesture and put the board back — `Esc`, a lost pointer, a lost
   * window, a tool switch, teardown.
   *
   * Every phase has to be handled, not just the two that move things. A
   * marquee abandoned halfway has already rewritten the selection, and leaving
   * it rewritten means the next `Delete` removes items the user believed they
   * had just cancelled out of.
   */
  cancel(ctx: ToolContext): void {
    // A pull that was taken away wrote nothing and removed nothing, which is
    // the right revert for both halves of the `Alt` gesture at once.
    this.pullFrom = null;
    /**
     * And the same for a loop pulled out of a string:
     *
     * > `Esc` mid-drag → the whole thing reverts, string unchanged.
     * > — DESIGN section 3.4, AC-71
     *
     * "Completely" is what makes this two lines rather than an inverse
     * operation: the pin and the node are made in one transaction at the
     * release and nowhere else, so before the release there is nothing in the
     * document to undo and the string is still the string it always was.
     */
    this.pendingString = null;
    this.resetLoop();
    // Nothing was written, so putting the pin back is the whole of the revert.
    if (this.phase === "pin") {
      this.pinDrag.cancel(ctx);
      this.holding.clear();
    }

    if (this.phase === "dragging" || this.phase === "rotating" || this.phase === "resizing") {
      // "Esc mid-drag → the whole thing reverts" (DESIGN section 3.4).
      const resizing = this.phase === "resizing";
      const poses = new Map<string, WritePose>();
      const sizes = new Map<string, WriteSize>();
      for (const [id, start] of this.starts) {
        ctx.scene.setPose(id, start);
        ctx.dirty.item(id);
        if (resizing) sizes.set(id, { x: start.x, y: start.y, w: start.w, h: start.h });
        else poses.set(id, { x: start.x, y: start.y, rot: start.rot });
      }
      // Putting the scene back is only half of it if a crash-safety write has
      // already landed: the document would still hold the intermediate pose
      // and the next observer event would drag the item straight back out.
      // Reverting a resize goes back through the resize op, because the pins it
      // moved on the way out have to come back with it.
      if (this.wroteLive) {
        if (resizing) {
          if (sizes.size > 0) ctx.write.setSizes(sizes, "final");
        } else if (poses.size > 0) {
          ctx.write.setPoses(poses, "final");
        }
      }
      this.release();
    } else if (this.phase === "marquee") {
      ctx.selection.replace(this.marqueeBase);
    }

    // The carry goes with the gesture rather than easing down, because a
    // cancel means it never happened — and because after a tool switch or a
    // teardown there is no further `tick` to finish an ease, which would
    // strand items scaled up and lit as though still held.
    for (const id of this.animating) {
      const slot = ctx.scene.slotOf(id);
      if (slot !== undefined) {
        ctx.scene.lift[slot] = 0;
        // A hanging item's rotation is not this tool's to zero — zeroing it
        // would stand a photograph up at its authored angle for the frame
        // before phase 3 notices and hangs it again.
        if (ctx.scene.pinCount(id) !== 1) ctx.scene.swing[slot] = 0;
      }
      ctx.dirty.item(id);
    }
    this.animating.clear();
    this.lag = 0;

    this.pendingSelect = null;
    this.pendingPin = null;
    this.pendingString = null;
    this.grabbed = null;
    this.rect = null;
    this.phase = "idle";
  }

  /** End of a gesture: the items stay in `animating` until their transients
   *  have eased back to nothing. */
  private release(): void {
    this.starts.clear();
    this.holding.clear();
    this.lastAngle = null;
    this.rotateApplied = 0;
    this.sinceWrite = 0;
    this.wroteLive = false;
    this.grabbed = null;
    this.resizeId = null;
  }

  private commit(ctx: ToolContext, phase: "live" | "final"): void {
    if (this.phase === "resizing") {
      this.commitSize(ctx, phase);
      return;
    }
    const poses = new Map<string, WritePose>();
    const rotating = this.phase === "rotating";
    // Once a crash-safety pose is in the document, the release must write
    // every item it touched even if that item ended up back where it started —
    // otherwise the intermediate pose is the last word.
    const force = phase === "final" && this.wroteLive;
    for (const [id, start] of this.starts) {
      const pose = ctx.scene.poseOf(id);
      if (!pose) continue;
      if (!force && pose.x === start.x && pose.y === start.y && pose.rot === start.rot) continue;
      poses.set(id, rotating ? { x: pose.x, y: pose.y, rot: pose.rot } : { x: pose.x, y: pose.y });
    }
    if (poses.size === 0) return;
    if (phase === "live") this.wroteLive = true;
    ctx.write.setPoses(poses, phase);
  }

  /** The same two writes, for the gesture that changes the paper's size as well
   *  as where its centre is. */
  private commitSize(ctx: ToolContext, phase: "live" | "final"): void {
    const id = this.resizeId;
    const start = id === null ? undefined : this.starts.get(id);
    if (id === null || !start) return;
    const pose = ctx.scene.poseOf(id);
    if (!pose) return;

    const force = phase === "final" && this.wroteLive;
    const unchanged =
      pose.x === start.x && pose.y === start.y && pose.w === start.w && pose.h === start.h;
    if (!force && unchanged) return;

    if (phase === "live") this.wroteLive = true;
    ctx.write.setSizes(
      new Map([[id, { x: pose.x, y: pose.y, w: pose.w, h: pose.h }]]),
      phase,
    );
  }
}
