/**
 * The string tool — `S`. The primary verb.
 *
 * > | String tool | `S` | Enters stringing mode |
 * > | Basic run | Click pin A, click pin B | String joining them |
 * > | Extend | Keep clicking pins | Each click appends a node to the run |
 * > | Finish | `Enter`, `Esc`, or double-click | Ends the run |
 * > | **To a bare item** | Click an *item* rather than a pin while stringing | A pin is created there automatically and the run continues |
 * > | To bare cork | Click empty cork while stringing | A free pin is pushed in and the run continues |
 * > | Close a loop | `Shift`+click the first node | Loops the run back |
 * > — DESIGN section 3.4
 *
 * Every row of that table is one rule with three outcomes: a click lands on a
 * pin, on an item, or on the cork, and the run gains a stop either way. The
 * only branch is what the stop is made of.
 *
 * ## The fast path is the point (AC-68)
 *
 * > The "click an item and it makes its own pin" path is the fast path and it
 * > must exist. In practice most stringing is *this photo to that note*, and
 * > making the user place a pin first would double the interaction cost of the
 * > primary verb. — DESIGN section 3.4
 *
 * So there is no mode for it and no modifier. Clicking a photograph while
 * stringing pushes a pin into the photograph at the point you clicked and
 * carries on, and the pin-precise path stays available because a pin is a
 * bigger hit target than the paper under it (`render/pins/dom.ts`).
 *
 * ## Why the run is not written down until it ends
 *
 * The table reads as though the string exists after the second click, and on
 * screen it does — the run is drawn as it is built, by the overlay. What is
 * deferred is the *document write*, for two reasons that both come from the
 * architecture rather than from taste.
 *
 * A tool's writes are queued to phase 9 (`state/tools/tool.ts`), so a tool
 * cannot learn the id of anything it creates: by the time the pin exists, the
 * click that would have named it is long over. A run that auto-creates pins
 * therefore *cannot* be written incrementally without giving tools a synchronous
 * door into the document, which is the one thing the seam exists to prevent.
 *
 * And a run of four clicks that pushed in three pins is one thing a person did.
 * Written incrementally it is four undo entries, three of which leave a pin
 * behind in the cork. Written at the end it is one entry, and `Esc` on a run
 * you have changed your mind about leaves no litter at all.
 *
 * ## Ending a run
 *
 * `Enter`, `Esc` and a double-click all end it, which is what the table says —
 * `Esc` "ends the run" rather than reverting it, unlike `Esc` during a
 * mid-string drag (section 3.4 again), where reverting is stated explicitly. A
 * run of fewer than two stops has nothing to make and simply goes.
 */

import type { Vec2 } from "@/state/camera";
// The window and the slop are shared with `state/tools/machine.ts`, which flags
// the second *press* of a double for the select tool — two answers to "was that
// a double-click" on one surface would make the same two presses mean different
// things depending on which tool held the board.
import { DOUBLE_CLICK_MS, DOUBLE_CLICK_SLOP } from "@/state/input";
import { anchorAt, anchorParent, settleOnPin } from "@/state/tools/frame";
import type {
  PointerSample,
  StringAnchor,
  Tool,
  ToolContext,
  ToolInput,
} from "@/state/tools/tool";

/** How near the first stop a `Shift`+click has to land to close the loop. */
const CLOSE_LOOP_SLOP = 18;

export interface StringToolOptions {
  /** The run ended. The caller hands the board back to select, the way the
   *  note and pin tools do — nothing on screen says which tool is active. */
  onDone?: () => void;
  /** Wall clock, injected so the double-click window is testable. */
  now?: () => number;
}

/** One stop on the run, plus where it is so the run can be drawn. */
interface Stop {
  anchor: StringAnchor;
  /** Board position at the moment it was placed — for the preview only. */
  x: number;
  y: number;
}

export class StringTool implements Tool {
  readonly id = "string";

  private readonly options: StringToolOptions;
  private readonly stops: Stop[] = [];
  private lastClickAt = 0;
  private lastClickX = 0;
  private lastClickY = 0;

  constructor(options: StringToolOptions = {}) {
    this.options = options;
  }

  /**
   * The run as it stands, in board space, for `render/overlay.ts` to draw.
   *
   * The live cursor is appended so the last leg follows the pointer — which is
   * the whole of the feedback, and the reason a deferred write does not feel
   * like a deferred anything.
   *
   * Supplied by the caller rather than tracked here, because `machine.ts` only
   * forwards `move` to a tool while a pointer is *captured* — that is, during a
   * drag. A run between clicks has nothing captured, so the tool never hears
   * about the pointer at all; the machine's own hover position is the one that
   * knows. Found by driving the app, where the leg to the cursor was simply
   * missing.
   */
  preview(cursor: Vec2 | null): readonly Vec2[] | null {
    if (this.stops.length === 0) return null;
    const points: Vec2[] = this.stops.map((stop) => ({ x: stop.x, y: stop.y }));
    if (cursor) points.push({ x: cursor.x, y: cursor.y });
    return points;
  }

  handle(input: ToolInput, ctx: ToolContext): void {
    switch (input.kind) {
      case "up":
        this.onClick(input.at, ctx);
        return;
      case "cancel":
        this.cancel(ctx);
        return;
      case "key":
        if (input.code === "Enter" || input.code === "Escape") this.finish(ctx);
        return;
      default:
        return;
    }
  }

  tick(): void {
    /* nothing eases over time; the run is entirely click-driven */
  }

  cancel(ctx: ToolContext): void {
    this.stops.length = 0;
    ctx.dirty.camera = true;
  }

  private onClick(at: PointerSample, ctx: ToolContext): void {
    const now = this.options.now?.() ?? Date.now();
    const quick =
      now - this.lastClickAt < DOUBLE_CLICK_MS &&
      Math.abs(at.x - this.lastClickX) < DOUBLE_CLICK_SLOP &&
      Math.abs(at.y - this.lastClickY) < DOUBLE_CLICK_SLOP;
    this.lastClickAt = now;
    this.lastClickX = at.x;
    this.lastClickY = at.y;

    // A second click in the same place ends the run rather than adding a stop
    // on top of the one already there.
    if (quick && this.stops.length > 0) {
      this.finish(ctx);
      return;
    }

    // > Close a loop | Shift+click the first node — DESIGN section 3.4
    if (at.shift && this.closesLoopAt(at, ctx)) {
      this.finish(ctx, true);
      return;
    }

    const stop = this.stopAt(at, ctx);
    if (stop === null) return;
    this.stops.push(stop);
    ctx.dirty.camera = true;
  }

  /** What a click at this point adds to the run — see `anchorAt`, which is the
   *  same rule `Alt`+drag in the select tool reaches by another route. */
  private stopAt(at: PointerSample, ctx: ToolContext): Stop | null {
    return anchorAt(ctx.scene, ctx.camera, ctx.hitTest, ctx.hitPin, at.x, at.y);
  }

  /**
   * Is this click on the first stop of the run?
   *
   * Three stops minimum, because a loop through two pins is the same two
   * segments drawn on top of each other. Answered by pin identity when the run
   * started on a pin, and by proximity in *screen* space otherwise — the same
   * units the click was aimed in.
   */
  private closesLoopAt(at: PointerSample, ctx: ToolContext): boolean {
    if (this.stops.length < 3) return false;
    const first = this.stops[0]!;
    const pinId = ctx.hitPin(at.x, at.y);
    if (pinId !== null && "pin" in first.anchor && first.anchor.pin === pinId) return true;
    const screen = ctx.camera.boardToScreen(first.x, first.y);
    return Math.hypot(screen.x - at.x, screen.y - at.y) < CLOSE_LOOP_SLOP;
  }

  /**
   * Commit the run, in one write, and hand the board back.
   *
   * Fewer than two stops is not an error and not a string: a single click with
   * the string tool is someone who changed their mind, and it leaves nothing
   * behind — not even the pin that a written-as-you-go run would have pushed in.
   */
  private finish(ctx: ToolContext, closed = false): void {
    const anchors = this.stops.map((stop) => stop.anchor);
    this.stops.length = 0;
    ctx.dirty.camera = true;
    // Every item the run pushes a pin into, asked before any of it is written:
    // a run that clicked two hanging photographs stops both of them hanging,
    // and both poses belong in the one transaction the run already is.
    if (anchors.length >= 2) {
      ctx.write.createString(
        anchors,
        closed,
        settleOnPin(ctx.scene, anchors.map(anchorParent)),
      );
    }
    this.options.onDone?.();
  }
}
