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
 * Pen-up hands the runs to `BoardWriter.commitStrokes` and each becomes a record
 * on the surface it ended up on — DESIGN section 6.5's dry half, rastered by
 * `render/ink/canvas.ts` or `render/ink/board.ts`.
 *
 * The two halves do not change over at the same instant, and the gap between them
 * is a whole frame wide. A tool's writes are *queued* to phase 9
 * (ARCHITECTURE section 3), the binding raises the ink dirty flag in response,
 * and phase 6 of the frame after that is what actually fills the bitmap. So a
 * release that forgot the stroke there and then would leave a frame with the mark
 * on neither surface — a blink under every pen-up, worst on exactly the long
 * stroke that took the most care to draw.
 *
 * So the runs are kept after the commit, in [`drying`], and the overlay goes on
 * drawing them. What ends that is the owner calling [`dry`] once every surface's
 * canvas has caught up — `app/main.ts` asks the layers, rather than counting
 * frames, because the re-raster is budgeted and can be several frames late on a
 * board full of ink. Overlap costs nothing (the same mark, drawn twice, in the
 * same place); a gap is the visible bug.
 *
 * A stroke on bare cork takes the same route through a different surface: it is
 * committed into a `boardInk` tile and rastered by `render/ink/board.ts`, and
 * the owner waits for that tile's canvas exactly as it waits for an item's
 * (T-61). Nothing in this file knows the difference — it names a surface per run
 * and the writer takes it from there.
 *
 * ## Which space, asked every sample (T-137)
 *
 * > The stroke's coordinate space is fixed at pen-down: item-local if the press
 * > landed on a photograph, board if it landed on cork. `Ctrl` forces board
 * > space. — DESIGN section 3.9
 *
 * That was the rule until the cork could hold ink, and it was the right rule
 * while it could not: a tool that re-tested would have broken a line at the edge
 * of a photograph and thrown the outside half away, because there was nowhere for
 * it to go. Now there is (T-61), and the honest answer is the one a real pen
 * gives — **the mark stays where the hand put it, on whatever it was over**.
 *
 * So the hit test runs on every sample, and when the answer changes the run so
 * far is finished and a new one starts in the new frame. One gesture becomes
 * several records; the crossing sample belongs to *both* runs, so the two marks
 * meet at the edge instead of leaving a gap the width of one hand-movement. All
 * of them are written in one transaction, which is what keeps it one undo entry —
 * a Ctrl+Z that took back the half on the cork and left the half on the
 * photograph would be undoing something nobody did.
 *
 * The pieces stay glued to what they landed on for ever after, which is the whole
 * of what section 3.9's rule was protecting: move the photograph and its half of
 * the line goes with it, while the cork's half stays on the cork. That looks
 * wrong for exactly one frame and then reads as obviously right — it is what
 * would happen to a line drawn across a photograph lying on a real board.
 *
 * `Ctrl` at the press still forces board space **for the whole gesture** and
 * there is no hand-over then. That is what it is for: a mark you want on the cork
 * *behind* a photograph, which is otherwise unreachable because the photograph is
 * what the cursor is over — and a Ctrl stroke that hopped onto the paper the
 * moment it crossed one would be the opposite of the escape hatch.
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

/** The answer for a pen that is not drawing anything — the same array every
 *  time, so a frame with no ink on it allocates nothing at all. */
const EMPTY_RUNS: readonly WetStroke[] = Object.freeze([]);

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
  /** The live run, in [`space`], oldest first. Empty means no run in progress. */
  private samples: InkSample[] = [];
  /**
   * The surface the live run is glued to, or null for board space.
   *
   * Re-asked on every sample and changed at every edge the hand crosses (T-137),
   * unless [`forced`] — which is `Ctrl` at the press, and means the cork for the
   * whole gesture.
   */
  private space: string | null = null;
  /** `Ctrl` at the press: board space, and no hand-over. Read only on the way
   *  into [`add`], so letting go of `Ctrl` mid-line changes nothing. */
  private forced = false;
  private drawing = false;
  /**
   * The runs of this gesture that are already finished — every surface the hand
   * has crossed off, oldest first, each in its own frame.
   *
   * Kept rather than committed as they end, so that pen-up is one write and
   * therefore one undo entry. Empty for the overwhelmingly common stroke that
   * never leaves the surface it started on.
   */
  private runs: WetStroke[] = [];
  /**
   * The runs handed to the writer whose ink is not on their canvases yet — see
   * the note at the top of the file. Drawn by the overlay exactly like live
   * ones, and cleared by [`dry`].
   */
  private drying: readonly WetStroke[] = EMPTY_RUNS;
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
   * Every run the overlay should draw: the finished pieces of the gesture in
   * progress and the live one, or the drying pieces of the last one.
   *
   * A list because one gesture is not always one mark (T-137), and it is the
   * *whole* gesture: the moment the hand crosses an edge, the piece behind it
   * stops growing but must go on being drawn, or the mark you have already made
   * would vanish for the two or three frames until its record rasters. That flash
   * would land mid-stroke, which is worse than the pen-up blink the drying slot
   * exists to prevent.
   *
   * The live arrays rather than copies. Copying would allocate the whole stroke
   * every frame of every stroke, which on a long one is the largest allocation in
   * the frame — and the renderer only reads them. That is the same bargain
   * `sim/ropes.ts` makes when it hands out its `positions` buffer.
   *
   * Two samples minimum for the live run, *unless* something has already been
   * drawn this gesture. One point is a press that has not moved yet and there is
   * no evidence whether it is a dot or the start of a line, so drawing it would
   * put a blob under every click; but one point that is the first sample past an
   * edge is the continuation of a mark that is plainly already there, and
   * withholding it would open a gap at every crossing.
   *
   * The drying runs win over a live one only because they cannot outlast the
   * press that starts one: [`handle`]'s `down` drops them, so the two are never
   * both here.
   */
  get runsInFlight(): readonly WetStroke[] {
    if (!this.drawing) return this.drying;
    if (this.samples.length >= 2 || this.runs.length > 0) {
      // One array per frame of a stroke and nothing per sample. The common case
      // — a stroke that never crossed anything — allocates a single-entry array,
      // which is the price of not making every caller handle two shapes.
      return this.samples.length === 0 ? this.runs : [...this.runs, this.snapshot()];
    }
    return EMPTY_RUNS;
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
        // handed the previous one and may still be holding it — see
        // [`runsInFlight`].
        this.samples = [];
        this.runs = [];
        // The previous gesture stops being drawn here whether or not its ink has
        // landed. Its records are already written; all that is given up is the
        // overlap, and a stroke that shadowed the one now under the pointer
        // would be the worse bug of the two.
        this.drying = EMPTY_RUNS;
        this.drawing = true;
        // Before the first sample, because the first sample is already converted
        // into it.
        this.forced = input.at.ctrl;
        this.space = this.forced ? null : this.surfaceAt(input.at, ctx);
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
   * round dot. That is the promise [`runsInFlight`] makes when it refuses to draw
   * a one-sample stroke — the blob is withheld until the gesture proves it was a
   * click rather than the start of a line, not withheld forever.
   *
   * Every run of the gesture in one call, which is what makes it one undo entry
   * (T-137). Nothing here asks whether a run is worth keeping: whether it packed
   * to any bytes at all is the document's judgement (`crdt/ops/ink.ts`), which is
   * why [`dry`] is the owner's to call rather than something this file can work
   * out for itself.
   */
  private commit(ctx: ToolContext): void {
    const runs = this.samples.length === 0 ? this.runs : [...this.runs, this.snapshot()];
    this.samples = [];
    this.runs = [];
    this.space = null;
    this.drawing = false;
    if (runs.length === 0) return;
    this.drying = runs;
    ctx.write.commitStrokes(runs);
  }

  /**
   * Stop drawing the committed runs on the overlay — the ink is on their
   * canvases now, or there is no ink coming.
   *
   * Called by whoever owns the writer, because only that side can see either
   * answer: the commit's own verdict on a run it refused, and the re-rasters that
   * phase 6 may not have got to yet. All or nothing rather than one run at a
   * time: they are one mark, and half of it lingering on the overlay while the
   * other half has landed would be a seam that brightens for a frame.
   *
   * Safe to call at any time and twice — it drops a list and touches nothing
   * about a gesture in progress.
   */
  dry(): void {
    this.drying = EMPTY_RUNS;
  }

  /** The live run as the overlay and the writer see it — see [`runsInFlight`] on
   *  why the sample array is shared rather than copied. */
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
   * The surface under a board point — the item there, or null for the cork.
   *
   * The hit test the select tool uses, so "what am I drawing on" and "what would
   * I pick up" can never disagree about where a photograph's edge is.
   */
  private surfaceAt(at: PointerSample, ctx: ToolContext): string | null {
    const board = ctx.camera.screenToBoard(at.x, at.y);
    return ctx.hitTest(board.x, board.y);
  }

  /**
   * One sample, converted out of screen pixels and into the run's space — and
   * the edge, when it has just been crossed.
   *
   * Through the item's *rendered* pose when there is one, which is `itemLocal`'s
   * whole subject: an item hanging on a single pin is drawn at an angle and about
   * a centre that are transient and are in nobody's document, and converting
   * through the stored pose instead would land the ink as far from the cursor as
   * the swing has taken the paper.
   */
  private add(at: PointerSample, ctx: ToolContext): void {
    // A trail is a dozen samples handed over in one call, and the branches below
    // can end the gesture partway down it. Without this the rest of the batch
    // would land in a fresh, spaceless run nobody started.
    if (!this.drawing) return;
    const board = ctx.camera.screenToBoard(at.x, at.y);
    const pressure = this.pressureOf(at);

    // The hand has left the surface it was on (T-137). `Ctrl` at the press opts
    // the whole gesture out — see the note at the top of the file.
    if (!this.forced) {
      const under = this.surfaceAt(at, ctx);
      if (under !== this.space) {
        // This sample first, still in the *old* frame, so the piece behind
        // reaches the edge rather than stopping at the last sample inside it.
        this.place(board.x, board.y, pressure, ctx);
        if (!this.drawing) return;
        this.handOver(under);
      }
    }
    this.place(board.x, board.y, pressure, ctx);
  }

  /**
   * Close the live run and start a new one on `next`, beginning at the sample
   * that has just been laid down.
   *
   * The crossing point ends up in **both** runs, and that is why [`add`] lays it
   * down twice — once either side of this call, from the same board coordinates,
   * converted into a different frame each time. It cannot be copied across: the
   * copy in the old run is in the old item's local units, and board space is the
   * only currency both frames can be reached through.
   *
   * Without it the two marks would be a hand-movement apart — several units at
   * speed, and a visible break in a line the hand drew unbroken. With it they
   * meet, and the overlap is one nib width at the edge of a photograph, where one
   * of the two is clipped away by the paper anyway.
   *
   * A run of one sample is kept rather than dropped. It is a dot at the edge, it
   * is what the hand did, and `crdt/ops/ink.ts` is the thing that decides whether
   * a run packed to anything worth writing.
   */
  private handOver(next: string | null): void {
    if (this.samples.length > 0) this.runs.push(this.snapshot());
    this.space = next;
    // A fresh array, never a clear: the run just pushed is holding this one.
    this.samples = [];
  }

  /**
   * Convert one board point into the live run's frame and keep it.
   *
   * Ends the gesture when the paper has gone while the pointer was down — a peer
   * deleted it, or an undo took it. There is no frame left to hold the samples
   * already collected and no honest place to put this one, so the run goes with
   * it. Runs already finished go too: they are one mark with it.
   */
  private place(bx: number, by: number, pressure: number, ctx: ToolContext): void {
    if (this.space === null) {
      this.samples.push({ x: bx, y: by, pressure });
      return;
    }
    const local = itemLocal(ctx.scene, this.space, bx, by, this.local);
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

  /** The gesture, forgotten — every run of it. Deliberately not [`drying`],
   *  which belongs to the *previous* gesture — see `cancel`. */
  private reset(): void {
    this.samples = [];
    this.runs = [];
    this.space = null;
    this.forced = false;
    this.drawing = false;
  }
}
