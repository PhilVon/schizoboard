/**
 * The marker — `M`, and the first tool on this board that draws rather than
 * places.
 *
 * > | Marker | `M` | Opaque, width varies with pressure (pen) or velocity
 * > (mouse) | — DESIGN section 3.9
 *
 * Hold the button and move, and the mark follows the hand. The whole of that is
 * one array: the samples the pointer delivered, from the press to now, converted
 * out of screen pixels into whatever space the press fixed the stroke to (below).
 * `render/ink/wet.ts` turns it into a shape and
 * `render/ink/geometry.ts` decides what shape — this file only collects.
 *
 * ## It keeps every sample, and that is the point of it
 *
 * A drag tool wants the pointer's *position* and `machine.ts` collapses a frame's
 * moves down to one for exactly that reason. This wants the *path*, so it reads
 * `trail` — every sample the OS delivered between frames, recovered through
 * `getCoalescedEvents`. At speed that is a dozen samples per frame on a 1000 Hz
 * mouse, and reading only the collapsed position instead would sample the hand at
 * 60 Hz:
 *
 * > Input uses coalesced pointer events, which recover every sample the OS
 * > delivered between frames — the difference between a smooth curve and a
 * > visible polygon on a fast stroke. — DESIGN section 6.5
 *
 * Which is AC-76, and it fails harder the faster you draw — so the slow test
 * stroke that everybody tries first is the one that cannot detect it.
 *
 * The samples carry their own timestamps for a second reason too. Almost nothing
 * on this board is a pen, so almost every stroke's width comes from how fast the
 * hand was moving, and the interval between two samples is the only place that
 * number can come from — see [`MarkerTool.pressureOf`] and `lib/pressure.ts`.
 *
 * ## Nothing is written down yet
 *
 * The stroke lives while the pointer is down and is gone on release. That is not
 * a placeholder standing in for a commit: it is honestly the *wet* half of DESIGN
 * section 6.5's wet/dry split, and the dry half is a different job — a stroke
 * record is a packed `Uint8Array` (DATA-MODEL section 6.1), so committing one
 * needs the packing (T-59) and the per-item canvas to raster it into (T-57).
 * T-58 joins the two.
 *
 * The consequence worth stating plainly, because it looks like a bug otherwise:
 * let go and the mark disappears. It is not being lost — it was never saved.
 *
 * ## Which space, decided once
 *
 * > The stroke's coordinate space is fixed at pen-down: item-local if the press
 * > landed on a photograph, board if it landed on cork. `Ctrl` forces board
 * > space. — DESIGN section 3.9
 *
 * So the press does a hit test, and every sample after it is converted into
 * whatever that answered — see [`MarkerTool.item`]. Fixed, and not re-asked per
 * sample: a line drawn off the edge of a polaroid and onto the cork is one mark
 * on one surface, and a tool that re-tested would break it in half and glue the
 * halves to different things. It is also why the *press* is what matters and not
 * where the hand ends up.
 *
 * `Ctrl` is the escape hatch for the case the hit test cannot see: a mark you
 * want on the cork *behind* a photograph, which is otherwise unreachable because
 * the photograph is what the cursor is over.
 */

import {
  DEFAULT_INK_SIZE,
  DEFAULT_MARKER_COLOR,
  type InkSample,
  type InkTool,
  type WetStroke,
} from "@/lib/ink";
import { reportsRealPressure, VelocityPressure } from "@/lib/pressure";
import type { Point } from "@/lib/rotate";
import { itemLocal } from "@/state/tools/frame";
import type { PointerSample, Tool, ToolContext, ToolInput } from "@/state/tools/tool";

export interface MarkerToolOptions {
  /** `"marker"` or `"highlighter"` — the two differ in geometry and compositing,
   *  not in gesture, so they are this class twice rather than two classes. */
  readonly tool?: InkTool;
  readonly color?: string;
  /** Board units. */
  readonly size?: number;
  /** `Escape`. The caller hands the board back to `select`; a tool has no idea
   *  what other tools exist — see `state/tools/note.ts`. */
  onDone?: () => void;
}

export class MarkerTool implements Tool {
  readonly id: string;

  private readonly options: MarkerToolOptions;
  private readonly tool: InkTool;
  /** In [`space`], oldest first. Empty means no stroke in progress. */
  private samples: InkSample[] = [];
  /**
   * The item this stroke is glued to, or null for board space. Decided by the
   * press and then left alone — see the note at the top of the file.
   */
  private space: string | null = null;
  private drawing = false;
  /** Reused: `itemLocal` allocates a point otherwise, and this runs once per
   *  sample and there are a dozen of those per frame at speed. */
  private readonly local: Point = { x: 0, y: 0 };
  /** For the devices that do not measure pressure, which is most of them. Reset
   *  per stroke, not per tool — see [`VelocityPressure`]. */
  private readonly velocity = new VelocityPressure();

  constructor(options: MarkerToolOptions = {}) {
    this.options = options;
    this.tool = options.tool ?? "marker";
    this.id = this.tool;
  }

  /**
   * The stroke in progress, for the OVERLAY phase, or null when nothing is being
   * drawn.
   *
   * The live array rather than a copy. Copying it would allocate the whole stroke
   * every frame of every stroke, which on a long one is the largest allocation in
   * the frame — and the renderer only reads it. That is the same bargain
   * `sim/ropes.ts` makes when it hands out its `positions` buffer.
   *
   * Two samples minimum: one point is a press that has not moved yet, and there
   * is no evidence yet whether it is a dot or the start of a line. A dot is worth
   * drawing and will be, once a release can produce one (T-58) — drawing it now
   * would put a blob under every click that turned out to be the start of a
   * stroke.
   */
  get wet(): WetStroke | null {
    if (this.samples.length < 2) return null;
    return {
      tool: this.tool,
      color: this.options.color ?? DEFAULT_MARKER_COLOR,
      size: this.options.size ?? DEFAULT_INK_SIZE,
      item: this.space,
      samples: this.samples,
    };
  }

  /** Is a stroke being drawn right now? Read by `app/main.ts`, which suppresses
   *  the hover affordances of other tools while one is. */
  get stroking(): boolean {
    return this.drawing;
  }

  handle(input: ToolInput, ctx: ToolContext): void {
    switch (input.kind) {
      case "down":
        // A fresh array rather than `length = 0`, because the renderer was
        // handed the previous one and may still be holding it — see [`wet`].
        this.samples = [];
        this.drawing = true;
        // Before the first sample, because the first sample is already converted
        // into it.
        this.space = this.spaceAt(input.at, ctx);
        // Also before the first sample, so this stroke starts from rest rather
        // than from wherever the last one's hand was going.
        this.velocity.reset();
        this.add(input.at, ctx);
        return;
      case "move":
        if (!this.drawing) return;
        // Every sample, not just the position. `trail` is absent only where the
        // browser gave us nothing to coalesce, in which case the position *is*
        // the sample.
        if (input.trail) for (const at of input.trail) this.add(at, ctx);
        else this.add(input.at, ctx);
        return;
      case "up":
        if (!this.drawing) return;
        this.add(input.at, ctx);
        // Nothing to commit to yet, so the release is a discard. See the note at
        // the top of the file: the mark disappearing is not a lost write.
        this.reset();
        return;
      case "cancel":
        this.cancel(ctx);
        return;
      case "key":
        if (input.code === "Escape") {
          this.reset();
          this.options.onDone?.();
        }
        return;
      default:
        return;
    }
  }

  /**
   * The space a press at this point starts a stroke in — the item under it, or
   * null for the board.
   *
   * `ctrl` off the press's own sample rather than `ctx.held`, because this is
   * asked exactly once and at the moment of the press: it is a property of the
   * event, not a key that can be let go of halfway through the line.
   */
  private spaceAt(at: PointerSample, ctx: ToolContext): string | null {
    if (at.ctrl) return null;
    const board = ctx.camera.screenToBoard(at.x, at.y);
    return ctx.hitTest(board.x, board.y);
  }

  /**
   * One sample, converted out of screen pixels and into the stroke's space.
   *
   * Through the item's *rendered* pose when there is one, which is `itemLocal`'s
   * whole subject: an item hanging on a single pin is drawn at an angle and about
   * a centre that are transient and are in nobody's document, and converting
   * through the stored pose instead would land the ink as far from the cursor as
   * the swing has taken the paper.
   */
  private add(at: PointerSample, ctx: ToolContext): void {
    // A trail is a dozen samples handed over in one call, and the branch below
    // can end the stroke partway down it. Without this the rest of the batch
    // would land in a fresh, spaceless stroke nobody started.
    if (!this.drawing) return;
    const board = ctx.camera.screenToBoard(at.x, at.y);
    const pressure = this.pressureOf(at);
    if (this.space === null) {
      this.samples.push({ x: board.x, y: board.y, pressure });
      return;
    }
    const local = itemLocal(ctx.scene, this.space, board.x, board.y, this.local);
    // The paper went while the pointer was down — a peer deleted it, or an undo
    // took it. There is no frame left to hold the samples already collected and
    // no honest place to put this one, so the stroke goes with it. Nothing was
    // written down, so this costs the mark and nothing else.
    if (local === null) {
      this.reset();
      return;
    }
    this.samples.push({ x: local.x, y: local.y, pressure });
  }

  /**
   * > Pressure branches on pointer type: a real pen reports real pressure, while
   * > a mouse always reports exactly 0.5, so mouse and touch use velocity-derived
   * > simulated pressure instead. — DESIGN section 6.5
   *
   * The branch is on `pointerType` and not on the reading, because the reading
   * cannot tell you: a mouse's `0.5` and a pen genuinely held at half force are
   * the same number. So a pen is believed and everything else is measured.
   *
   * The velocity model is fed the **screen** position, before the board
   * conversion above — it is modelling how fast the hand moved, and the hand
   * moves across a screen rather than across the cork.
   *
   * The one case this gets wrong is a stylus with no force sensor, which reports
   * `pen` and a constant `0.5`, and will draw a flat line. There is nothing in
   * the event to distinguish it from a pen resting at half force, and guessing
   * from the *constancy* of the readings would mean second-guessing a real pen
   * held deliberately steady. Believing the device is the better failure.
   */
  private pressureOf(at: PointerSample): number {
    if (reportsRealPressure(at.pointer) && at.pressure !== undefined) return at.pressure;
    return this.velocity.next(at.x, at.y, at.time ?? 0);
  }

  /** Nothing eases: the stroke is entirely a function of where the hand has
   *  been, and the hand is not moving on a frame with no move in it. */
  tick(): void {}

  /**
   * A lost pointer or a lost window. Nothing has been written — a wet stroke is
   * never in the document — so abandoning it is forgetting the samples.
   *
   * `onDone` deliberately does not fire, for the reason `state/tools/note.ts`
   * gives: a window that lost focus mid-stroke has not finished with the marker,
   * and coming back to find the board in the select tool is worse than coming
   * back to the tool you chose.
   */
  cancel(_ctx: ToolContext): void {
    this.reset();
  }

  private reset(): void {
    this.samples = [];
    this.space = null;
    this.drawing = false;
  }
}
