/**
 * Dragging a pin — the two-field write, as a gesture.
 *
 * > | Move a pin | Drag it | Follows the cursor; candidate items highlight with a ring |
 * > | Re-parent | Drop it over an item | Parents to that item; travels with it from now on |
 * > | Un-parent | Drag it off onto cork | Becomes free-floating |
 * > | Constrain | Hold `Ctrl` while dragging | Stays within the current parent; no re-parenting |
 * > — DESIGN section 3.3
 *
 * All four of those are one operation. A pin is parented or it is free, and
 * which one is decided entirely by `parent`; re-parenting is setting that field
 * and converting the coordinates into the new frame.
 *
 * > That two-field write is the entire "drag a pin onto a note" feature. It
 * > falls out of the representation rather than needing a mechanism.
 * > — DESIGN section 2.2
 *
 * This class is what turns a cursor into it. It lives outside `select.ts`
 * because it holds none of that tool's state — no selection, no start poses, no
 * marquee — and is grabbed by a different thing entirely.
 *
 * ## The scene is re-parented on every move, not on the drop
 *
 * The gesture puts the pin into the candidate's frame *while you are still
 * holding it*, so what is on screen is always "what you get if you let go now".
 * The alternative — carry it free and re-parent at the drop — looks identical
 * on a still board and diverges the moment the candidate item is moving, which
 * is exactly when a person is checking whether the pin has taken.
 *
 * ## One write, at the release
 *
 * No throttled crash-safety write, unlike an item drag. That write exists for
 * "you spent thirty seconds arranging photographs" (DESIGN section 7.3); a pin
 * drag is a sub-second gesture moving one small object, and the whole of it is
 * recoverable by doing it again. One write on release is also exactly one undo
 * entry with no origin gymnastics — "re-parenting is one entry" (section 3.3).
 */

import type { Point } from "@/lib/rotate";
import type { Vec2 } from "@/state/camera";
import { drawnPose, itemLocal } from "@/state/tools/frame";
import type { ToolContext, WritePose } from "@/state/tools/tool";

/**
 * Read as a level, not as an edge — the same reason `R`+drag is (see
 * `state/tools/machine.ts`). "Hold Ctrl while dragging" is a question asked
 * partway through the gesture, and answering it from the modifier flag on the
 * pointer event that happened to arrive would answer a different one.
 */
function constrained(ctx: ToolContext): boolean {
  return ctx.held.has("ControlLeft") || ctx.held.has("ControlRight");
}

interface Placement {
  parent: string | null;
  lx: number;
  ly: number;
}

export class PinDrag {
  private id: string | null = null;
  /** Where it was before the gesture, for `Esc` and for a lost pointer. */
  private start: Placement = { parent: null, lx: 0, ly: 0 };
  /**
   * Board-space offset from the pin to the cursor at the moment of the grab.
   *
   * Kept, rather than snapping the pin to the cursor: the grab radius is
   * deliberately wider than the head (`render/pins/dom.ts`), so a press that
   * takes hold of a pin is routinely several pixels off its centre, and a pin
   * that jumped that far on the first frame of the drag would read as the board
   * having grabbed something else.
   */
  private grabX = 0;
  private grabY = 0;

  /** Where the pin is now, board space — what the release writes. */
  private atX = 0;
  private atY = 0;

  private candidateId: string | null = null;

  private readonly board: Vec2 = { x: 0, y: 0 };
  private readonly probe: Point = { x: 0, y: 0 };

  get active(): boolean {
    return this.id !== null;
  }

  /** The item the pin would parent to if released now, or null for the cork.
   *  Drawn as a ring by the overlay. */
  get candidate(): string | null {
    return this.candidateId;
  }

  /** The item it was on when the drag began, or null. */
  get origin(): string | null {
    return this.start.parent;
  }

  /**
   * `screenX`/`screenY` are where the **press** landed, not where the drag
   * threshold was crossed — that is what makes the grab offset the distance
   * between the pin and the aim rather than that plus three pixels of travel.
   *
   * Returns false if the pin turned out not to be there.
   */
  begin(pinId: string, screenX: number, screenY: number, ctx: ToolContext): boolean {
    const pin = ctx.scene.pins.get(pinId);
    if (!pin) return false;
    this.id = pinId;
    this.start = { parent: pin.parent, lx: pin.lx, ly: pin.ly };
    const board = ctx.camera.screenToBoard(screenX, screenY, this.board);
    this.grabX = board.x - pin.wx;
    this.grabY = board.y - pin.wy;
    this.atX = pin.wx;
    this.atY = pin.wy;
    this.candidateId = pin.parent;
    return true;
  }

  move(screenX: number, screenY: number, ctx: ToolContext): void {
    if (this.id === null) return;
    const board = ctx.camera.screenToBoard(screenX, screenY, this.board);
    this.atX = board.x - this.grabX;
    this.atY = board.y - this.grabY;

    // Ctrl "stays within the current parent" — current meaning the one it was
    // on when the drag began, not the one it happens to be over. Otherwise
    // pressing Ctrl mid-drag would freeze the pin onto whatever it had already
    // wandered across, which is the opposite of a constraint.
    const parent = constrained(ctx) ? this.start.parent : ctx.hitTest(this.atX, this.atY);
    this.candidateId = parent;
    this.apply(ctx, parent);
  }

  /** The document write, and the end of the gesture. */
  end(ctx: ToolContext): void {
    const id = this.id;
    if (id === null) return;
    const pin = ctx.scene.pins.get(id);
    this.id = null;
    this.candidateId = null;
    if (!pin) return;
    // Unchanged after all — a click that trembled, or a drag that came back.
    // Writing anyway would put an undo entry on the stack that undoes nothing.
    if (pin.parent === this.start.parent && pin.lx === this.start.lx && pin.ly === this.start.ly) {
      return;
    }
    // What the scene already holds, which is the frame this gesture resolved.
    ctx.write.placePin(id, pin.parent, pin.lx, pin.ly, this.settle(ctx, pin.parent));
  }

  /**
   * The poses to write alongside the placement: up to two items, because a
   * re-parent changes the pin count at *both* ends and pin count is what an
   * item's physics is made of (DESIGN section 5.5).
   *
   * - The item it lands on, if that pin makes two. It was hanging and is now
   *   rigid, so `sim/torsion.ts` is about to zero the swing and the drift it
   *   was drawn with — and the pin was placed against exactly those.
   * - The item it left, if that took its last pin. It has stopped hanging
   *   altogether, which zeroes the same two transients. This is T-107's jump
   *   reached by dragging the pin off rather than deleting it, and
   *   `settleOnUnpin` never covered this route.
   *
   * Two-to-one at either end needs nothing: an item that *starts* hanging
   * swings there from where it already is, which is motion rather than a jump.
   *
   * The counts are read from the scene rather than through `settleOnPin`,
   * because this gesture re-parents the scene on every move — by the time it
   * commits, the pin has already been counted at its destination and
   * discounted at its origin. So the numbers tested here are one further on
   * than the ones every other tool tests.
   */
  private settle(ctx: ToolContext, onto: string | null): ReadonlyMap<string, WritePose> {
    const settle = new Map<string, WritePose>();
    const from = this.start.parent;
    if (onto !== from) {
      if (onto !== null && ctx.scene.pinCount(onto) === 2) {
        const pose = drawnPose(ctx.scene, onto);
        if (pose) settle.set(onto, pose);
      }
      if (from !== null && ctx.scene.pinCount(from) === 0) {
        const pose = drawnPose(ctx.scene, from);
        if (pose) settle.set(from, pose);
      }
    }
    return settle;
  }

  /**
   * `Esc`, a lost pointer, a lost window, a tool switch.
   *
   * Nothing has been written, so putting the scene back is the whole of it —
   * which is the other half of why the write waits for the release.
   */
  cancel(ctx: ToolContext): void {
    const id = this.id;
    this.id = null;
    this.candidateId = null;
    if (id === null) return;
    const pin = ctx.scene.pins.get(id);
    if (!pin) return;
    const wasOn = pin.parent;
    ctx.scene.putPin({ ...pin, ...this.start });
    ctx.dirty.pin(id);
    if (wasOn !== null) ctx.dirty.item(wasOn);
    if (this.start.parent !== null) ctx.dirty.item(this.start.parent);
  }

  /**
   * Put the pin down in `parent`'s frame at its current board position.
   *
   * Through the item's **rendered** pose — see `state/tools/frame.ts`. The
   * item is frozen for the duration of the gesture (`select.ts` counts both
   * ends of the move as held), so that pose does not move under the cursor
   * while the pin is being placed.
   */
  private apply(ctx: ToolContext, parent: string | null): void {
    const id = this.id;
    if (id === null) return;
    const pin = ctx.scene.pins.get(id);
    if (!pin) return;

    let lx = this.atX;
    let ly = this.atY;
    let onto = parent;
    const local = onto === null ? null : itemLocal(ctx.scene, onto, this.atX, this.atY, this.probe);
    if (onto !== null && !local) {
      onto = null;
    } else if (local) {
      lx = local.x;
      ly = local.y;
    }

    const previous = pin.parent;
    ctx.scene.putPin({ ...pin, parent: onto, lx, ly, wx: this.atX, wy: this.atY });
    ctx.dirty.pin(id);
    // Both ends of a re-parent: one item has gained a pin and the other has
    // lost one, and pin count is what an item's physics is made of.
    if (previous !== null) ctx.dirty.item(previous);
    if (onto !== null) ctx.dirty.item(onto);
  }
}
