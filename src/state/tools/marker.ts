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
 * ## The release, and the frame that would otherwise be blank
 *
 * Pen-up hands the samples to `BoardWriter.commitStroke` and the stroke becomes a
 * record in the item's `strokes` map — DESIGN section 6.5's dry half, rastered
 * onto the item's own canvas by `render/ink/canvas.ts`.
 *
 * The two halves do not change over at the same instant, and the gap between them
 * is a whole frame wide. A tool's writes are *queued* to phase 9
 * (ARCHITECTURE section 3), the binding raises the ink dirty flag in response,
 * and phase 6 of the frame after that is what actually fills the bitmap. So a
 * release that forgot the stroke there and then would leave a frame with the mark
 * on neither surface — a blink under every pen-up, worst on exactly the long
 * stroke that took the most care to draw.
 *
 * So the samples are kept after the commit, in [`drying`], and the overlay goes
 * on drawing them. What ends that is the owner calling [`dry`] once the item's
 * canvas has caught up — `app/main.ts` asks the item layer, rather than counting
 * frames, because the re-raster is budgeted and can be several frames late on a
 * board full of ink. Overlap costs nothing (the same mark, drawn twice, in the
 * same place); a gap is the visible bug.
 *
 * A stroke on bare cork is the exception and it is discarded: `commitStroke`
 * deliberately refuses `item: null` while nothing renders board ink (T-61), so
 * for those the owner calls [`dry`] straight away and the mark disappears on
 * release. It is not being lost — it was never saved.
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
  DEFAULT_HIGHLIGHTER_COLOR,
  DEFAULT_HIGHLIGHTER_OPACITY,
  DEFAULT_HIGHLIGHTER_SIZE,
  DEFAULT_INK_SIZE,
  DEFAULT_MARKER_COLOR,
  INK_SIZES,
  inkSizeIndex,
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
  /** 0 to 1. Defaults to the tool's own — opaque for a marker, translucent for a
   *  highlighter — so that constructing one takes a tool name and nothing else. */
  readonly opacity?: number;
  /** `Escape`. The caller hands the board back to `select`; a tool has no idea
   *  what other tools exist — see `state/tools/note.ts`. */
  onDone?: () => void;
}

export class MarkerTool implements Tool {
  readonly id: string;

  private readonly options: MarkerToolOptions;
  private readonly tool: InkTool;
  /**
   * What this pen is currently loaded with. Every stroke it makes carries these.
   *
   * Per tool and not per stroke, which is the whole of why they live here: `[`
   * and `]` and the palette (DESIGN section 3.9) pick a *pen*, not a mark. A
   * stroke in progress is unaffected — see [`strokeInk`].
   */
  private ink: string;
  private nib: number;
  private readonly opacity: number;
  /**
   * The pen as it was at pen-down, which is the pen the whole stroke is made
   * with.
   *
   * Copied at the press rather than read at the release, so that `[` pressed
   * halfway down a line does not retroactively rewrite the width of the line
   * being drawn — a stroke has one width in the document and it should be the
   * one under the cursor while it was made. The next stroke gets the new pen.
   */
  private strokeInk = "";
  private strokeNib = 0;
  /** In [`space`], oldest first. Empty means no stroke in progress. */
  private samples: InkSample[] = [];
  /**
   * The item this stroke is glued to, or null for board space. Decided by the
   * press and then left alone — see the note at the top of the file.
   */
  private space: string | null = null;
  private drawing = false;
  /**
   * A stroke that has been handed to the writer but whose ink is not on the
   * item's canvas yet — see the note at the top of the file. Drawn by the
   * overlay exactly like a live one, and cleared by [`dry`].
   */
  private drying: WetStroke | null = null;
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
    const highlighter = this.tool === "highlighter";
    this.ink = options.color ?? (highlighter ? DEFAULT_HIGHLIGHTER_COLOR : DEFAULT_MARKER_COLOR);
    this.nib = options.size ?? (highlighter ? DEFAULT_HIGHLIGHTER_SIZE : DEFAULT_INK_SIZE);
    this.opacity = options.opacity ?? (highlighter ? DEFAULT_HIGHLIGHTER_OPACITY : 1);
  }

  /**
   * The stroke to draw on the overlay: the one in progress, or the one still
   * drying, or null when there is neither.
   *
   * The live array rather than a copy. Copying it would allocate the whole stroke
   * every frame of every stroke, which on a long one is the largest allocation in
   * the frame — and the renderer only reads it. That is the same bargain
   * `sim/ropes.ts` makes when it hands out its `positions` buffer.
   *
   * Two samples minimum: one point is a press that has not moved yet, and there
   * is no evidence yet whether it is a dot or the start of a line. Drawing it now
   * would put a blob under every click that turned out to be the start of a
   * stroke. The release settles it — a click that stayed a click is committed as
   * the dot it was, and arrives on the overlay drying rather than live.
   *
   * A drying stroke wins over a live one only because it cannot outlast the press
   * that starts one: [`handle`]'s `down` drops it, so the two are never both
   * here. A press that lands within a frame of the last release therefore costs
   * the previous mark its overlap, and the worst that shows is the blink this
   * whole arrangement exists to avoid — on the one gesture nobody makes by hand.
   */
  get wet(): WetStroke | null {
    if (this.drying !== null) return this.drying;
    if (this.samples.length < 2) return null;
    return this.snapshot();
  }

  /** Is a stroke being drawn right now? Read by `app/main.ts`, which suppresses
   *  the hover affordances of other tools while one is. */
  get stroking(): boolean {
    return this.drawing;
  }

  /**
   * Which pen this is, and what it is loaded with — for the menu that changes
   * them (`ui/boardmenu.ts`), which has to mark the current choices.
   *
   * Read-only accessors over the fields rather than public fields, because the
   * only supported way to change one is [`load`] and a menu that assigned
   * directly would be a second one.
   */
  get kind(): InkTool {
    return this.tool;
  }

  get color(): string {
    return this.ink;
  }

  get size(): number {
    return this.nib;
  }

  /**
   * Load the pen: a colour, a width, or both.
   *
   * Takes effect on the next stroke and never on the one in progress — see
   * [`strokeInk`]. Nothing validates the colour against the palette or the
   * size against the ladder: the palette is what the menu offers and the ladder
   * is what `[` and `]` walk, and a tool that also policed them would be a second
   * opinion about the same thing.
   */
  load(pen: { color?: string; size?: number }): void {
    if (pen.color !== undefined) this.ink = pen.color;
    if (pen.size !== undefined && pen.size > 0) this.nib = pen.size;
  }

  /**
   * `[` and `]` — one rung down or up the shared ladder (DESIGN section 3.9).
   *
   * Clamped at both ends rather than wrapping. A size key held down is somebody
   * asking for "bigger" repeatedly, and a nib that silently became the finest one
   * on the board at the top of the range is the opposite of what they asked for.
   */
  step(by: number): void {
    const at = inkSizeIndex(this.nib);
    const next = Math.min(INK_SIZES.length - 1, Math.max(0, at + by));
    this.nib = INK_SIZES[next]!;
  }

  handle(input: ToolInput, ctx: ToolContext): void {
    switch (input.kind) {
      case "down":
        // A fresh array rather than `length = 0`, because the renderer was
        // handed the previous one and may still be holding it — see [`wet`].
        this.samples = [];
        // The previous stroke stops being drawn here whether or not its ink has
        // landed. Its record is already written; all that is given up is the
        // overlap, and a stroke that shadowed the one now under the pointer
        // would be the worse bug of the two.
        this.drying = null;
        this.drawing = true;
        // Before the first sample, because the first sample is already converted
        // into it.
        this.space = this.spaceAt(input.at, ctx);
        // The pen, fixed for this stroke — see the note on [`strokeInk`].
        this.strokeInk = this.ink;
        this.strokeNib = this.nib;
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
        this.commit(ctx);
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
   * The release: hand the samples over, and keep drawing them until told the ink
   * has landed.
   *
   * The gesture is over here whatever happens next, so the live state is cleared
   * first and unconditionally — a stroke that failed to be worth committing must
   * not leave the tool believing a pointer is still down.
   *
   * `snapshot` before `samples = []`, and a fresh array rather than a clear, for
   * the reason `down` gives: the array handed over is the one the writer will
   * pack and the overlay is still drawing from, and the next stroke may not push
   * its own samples into it.
   *
   * A click commits too, and that is deliberate: a press and a release at one
   * point is two samples a hair apart, which `perfect-freehand` turns into a
   * round dot. That is the promise [`wet`] makes when it refuses to draw a
   * one-sample stroke — the blob is withheld until the gesture proves it was a
   * click rather than the start of a line, not withheld forever.
   *
   * Nothing else here asks whether the stroke is worth keeping. Whether it packed
   * to any bytes at all is the document's judgement (`crdt/ops/ink.ts`), and it is
   * the same call that decides a bare-cork stroke is not written yet — which is
   * why [`dry`] is the owner's to call rather than something this file can work
   * out for itself.
   */
  private commit(ctx: ToolContext): void {
    const stroke = this.samples.length === 0 ? null : this.snapshot();
    this.samples = [];
    this.space = null;
    this.drawing = false;
    if (stroke === null) return;
    this.drying = stroke;
    ctx.write.commitStroke(stroke);
  }

  /**
   * Stop drawing the committed stroke on the overlay — the ink is on the item's
   * canvas now, or there is no ink coming.
   *
   * Called by whoever owns the writer, because only that side can see either
   * answer: the commit's own verdict on a stroke it refused, and the re-raster
   * that phase 6 may not have got to yet. Safe to call at any time and twice —
   * it clears a slot and touches nothing about a stroke in progress.
   */
  dry(): void {
    this.drying = null;
  }

  /** The stroke as the overlay and the writer see it — see [`wet`] on why the
   *  sample array is shared rather than copied. */
  private snapshot(): WetStroke {
    return {
      tool: this.tool,
      color: this.strokeInk,
      size: this.strokeNib,
      opacity: this.opacity,
      item: this.space,
      samples: this.samples,
    };
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
   *
   * A stroke that is *drying* is not abandoned with it. That one is in the
   * document, and losing the pointer is no reason to stop drawing it a frame
   * before its ink appears.
   */
  cancel(_ctx: ToolContext): void {
    this.reset();
  }

  /** The live stroke, forgotten. Deliberately not [`drying`] — see `cancel`. */
  private reset(): void {
    this.samples = [];
    this.space = null;
    this.drawing = false;
  }
}
