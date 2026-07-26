/**
 * The select tool — `V`, and the one the board starts in.
 *
 * Click to select, `Shift`+click to add, drag on empty cork for a marquee,
 * `Ctrl+A` for everything visible, `Delete` to remove, `R`+drag to rotate
 * (DESIGN sections 3.2 and 3.8).
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

import type { Bounds, Vec2 } from "@/state/camera";
import type {
  PointerSample,
  Tool,
  ToolContext,
  ToolInput,
  WritePose,
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
const LIVE_WRITE_MS = 300;

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

type GesturePhase = "idle" | "pending" | "dragging" | "rotating" | "marquee";

interface StartPose {
  x: number;
  y: number;
  rot: number;
}

function approach(current: number, target: number, dt: number, tau: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export class SelectTool implements Tool {
  readonly id = "select";

  private phase: GesturePhase = "idle";

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
  private readonly starts = new Map<string, StartPose>();

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

  private pivotX = 0;
  private pivotY = 0;
  private rotateApplied = 0;
  private lastAngle: number | null = null;

  private sinceWrite = 0;
  /** Has this gesture already put a crash-safety pose in the document? */
  private wroteLive = false;

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
    ctx.selection.prune((id) => ctx.scene.has(id));

    this.downX = this.lastX = this.prevTickX = at.x;
    this.downY = this.lastY = at.y;
    this.pendingSelect = null;
    const board = ctx.camera.screenToBoard(at.x, at.y, this.board);
    this.downBoardX = board.x;
    this.downBoardY = board.y;

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
    if (this.phase === "dragging" || this.phase === "rotating") {
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
    this.phase = "idle";
  }

  /**
   * `R` is read here rather than at pointer-down so that pressing it after
   * putting the cursor down still rotates — which is how people actually reach
   * for a modifier they only just decided they wanted.
   *
   * Returns false if there turned out to be nothing to pick up.
   */
  private begin(ctx: ToolContext): boolean {
    // This is a drag, so the click that would have narrowed the selection to
    // one item is off.
    this.pendingSelect = null;
    this.starts.clear();
    for (const id of ctx.selection.members) {
      const pose = ctx.scene.poseOf(id);
      if (!pose) continue;
      this.starts.set(id, { x: pose.x, y: pose.y, rot: pose.rot });
      this.animating.add(id);
    }
    if (this.starts.size === 0) {
      this.phase = "idle";
      return false;
    }

    this.sinceWrite = 0;
    this.prevTickX = this.lastX;

    if (ctx.held.has("KeyR")) {
      // The centre of what is being turned. For one item that is its own
      // centre, so it spins in place; for a group it is the middle of the
      // group, so the whole arrangement turns as one thing.
      const bounds = ctx.scene.boundsOfMany(this.starts.keys());
      this.pivotX = bounds ? (bounds.minX + bounds.maxX) / 2 : this.downBoardX;
      this.pivotY = bounds ? (bounds.minY + bounds.maxY) / 2 : this.downBoardY;
      this.rotateApplied = 0;
      this.lastAngle = null;
      this.phase = "rotating";
    } else {
      this.phase = "dragging";
    }
    return true;
  }

  private applyGesture(ctx: ToolContext): void {
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

      const cos = Math.cos(this.rotateApplied);
      const sin = Math.sin(this.rotateApplied);
      for (const [id, start] of this.starts) {
        const ox = start.x - this.pivotX;
        const oy = start.y - this.pivotY;
        ctx.scene.setPose(id, {
          x: this.pivotX + ox * cos - oy * sin,
          y: this.pivotY + ox * sin + oy * cos,
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
    if (dt > 0 && (this.phase === "dragging" || this.phase === "rotating")) {
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
      // Rotation is deliberate, so it gets the lift but not the lag; a turning
      // item that also leaned would read as two things happening at once.
      const swingTarget = held && this.phase === "dragging" ? lagTarget : 0;

      const lift = approach(
        ctx.scene.lift[slot]!,
        liftTarget,
        dt,
        liftTarget > ctx.scene.lift[slot]! ? LIFT_RISE_MS : LIFT_FALL_MS,
      );
      const swing = approach(ctx.scene.swing[slot]!, swingTarget, dt, LAG_TAU_MS);

      const done =
        !held &&
        Math.abs(lift) < SETTLED_EPSILON &&
        Math.abs(swing) < SETTLED_EPSILON;

      ctx.scene.lift[slot] = done ? 0 : lift;
      ctx.scene.swing[slot] = done ? 0 : swing;
      ctx.dirty.item(id);
      // Settled. T-35 takes over here for a single-pinned item, which does not
      // settle to zero — it swings.
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
    if (this.phase === "dragging" || this.phase === "rotating") {
      // "Esc mid-drag → the whole thing reverts" (DESIGN section 3.4).
      const restore = new Map<string, WritePose>();
      for (const [id, start] of this.starts) {
        ctx.scene.setPose(id, start);
        ctx.dirty.item(id);
        restore.set(id, { x: start.x, y: start.y, rot: start.rot });
      }
      // Putting the scene back is only half of it if a crash-safety write has
      // already landed: the document would still hold the intermediate pose
      // and the next observer event would drag the item straight back out.
      if (this.wroteLive && restore.size > 0) ctx.write.setPoses(restore, "final");
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
        ctx.scene.swing[slot] = 0;
      }
      ctx.dirty.item(id);
    }
    this.animating.clear();

    this.pendingSelect = null;
    this.rect = null;
    this.phase = "idle";
  }

  /** End of a gesture: the items stay in `animating` until their transients
   *  have eased back to nothing. */
  private release(): void {
    this.starts.clear();
    this.lastAngle = null;
    this.rotateApplied = 0;
    this.sinceWrite = 0;
    this.wroteLive = false;
  }

  private commit(ctx: ToolContext, phase: "live" | "final"): void {
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
}
