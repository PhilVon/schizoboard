/**
 * The stroke that is still being drawn, on its way to everybody else.
 *
 * > Awareness has no append semantics, so naively sending the whole in-progress
 * > polyline grows without bound.
 * >
 * > Instead send a **sliding window**: a `base` index plus the last 64 points.
 * > The receiver keeps everything it has ever seen for that stroke id and
 * > splices. This is self-healing across dropped updates as long as the window
 * > covers the gap — 64 points at 30 Hz is about two seconds — and the payload
 * > is constant-size.
 * >
 * > Points are decimated to roughly one per six screen pixels before sending.
 * > The remote render is a preview, not an archive; the real stroke arrives on
 * > commit. — docs/DATA-MODEL.md section 9.1
 *
 * This is the sending half of that, kept out of `state/presence.ts` because it
 * is the one field on awareness with an algorithm behind it rather than a
 * rounding rule. Presence owns one of these, feeds it the pen's runs every
 * frame, and asks it for a payload on the frames it publishes.
 *
 * ## An array of runs, where section 9 writes one stroke
 *
 * Section 9's schema has `wet` as a single object and it predates T-137, which
 * made one gesture into several records — a line drawn off the side of a
 * photograph and on across the cork is two marks, each filed separately, and
 * both are on the screen at once while the hand is still moving. So `wet` is a
 * list (Q-81), each entry windowed on its own.
 *
 * ## The decimated sequence is append-only, and that is what `base` means
 *
 * A `base` index is only worth anything if the sender's sequence never changes
 * underneath it: two publishes a second apart have to be talking about the same
 * numbering. So a point that has been *committed* to the sequence is never
 * revisited — not when the zoom changes under the hand, not when the samples
 * arrive in a burst. The decimation only ever decides about the newest sample,
 * and only once.
 *
 * The one exception is deliberate and is the tip: see [`RunWindow.tip`].
 *
 * ## Absolute points, not deltas
 *
 * The document's own packing delta-encodes (`lib/strokepack.ts`) and this does
 * not, on purpose. A delta chain has to be read from a known anchor, and the
 * anchor is exactly what a dropped awareness update takes away — the window
 * would stop being self-healing and become a stream you can fall off. Every
 * point in a window stands on its own, so a receiver that missed five updates
 * is still exactly right on the sixth.
 *
 * ## Integers, on the grid the committed record will land on
 *
 * `pts` is a flat run of integers, three per point: x and y in eighths of a
 * board unit and pressure in 255ths, which are `lib/strokepack.ts`'s
 * [`INK_STEPS_PER_UNIT`] and [`PRESSURE_STEPS`] — the same grid the stroke will
 * sit on once it is in the document.
 *
 * Both halves of that are load-bearing. *Integers*, because awareness is JSON:
 * a pressure quantised to 255ths and then written as a float is
 * `0.5019607843137255`, eighteen characters to say what `128` says in three.
 * And *that* grid, because DATA-MODEL section 9.2 keeps the ghost up until the
 * document holds the same stroke id precisely so that the swap is invisible —
 * a ghost drawn on a finer grid than the record replacing it would shift by up
 * to a sixteenth of a unit at the moment of the handoff, on every point, on
 * every stroke anybody else draws.
 *
 * Flat rather than an array of objects for the same reason as the integers:
 * `[-9873,1204,128]` against `{"x":-1234.125,"y":150.5,"pressure":0.502}`, 64
 * times per run per message, thirty times a second.
 */

import { type InkTool, type WetStroke } from "@/lib/ink";
import { INK_STEPS_PER_UNIT, PRESSURE_STEPS } from "@/lib/strokepack";

/**
 * > a `base` index plus the last 64 points — docs/DATA-MODEL.md section 9.1
 *
 * With the decimation below this is a couple of seconds of drawing, which is
 * what makes the window self-healing: a receiver has to miss two seconds of
 * updates in a row before a gap opens that the next message cannot close.
 */
export const WET_WINDOW = 64;

/**
 * > Points are decimated to roughly one per six screen pixels before sending.
 * > — docs/DATA-MODEL.md section 9.1
 *
 * Screen pixels rather than board units, so it is the zoom the *sender* is
 * looking at that decides — the point of the number is that the discarded
 * samples are ones nobody could have seen, and "nobody" means the person
 * drawing. A receiver zoomed further in sees a slightly coarser preview, which
 * is the trade section 9.1 already made when it called this a preview.
 */
export const WET_SPACING_PX = 6;

/**
 * How many runs of one gesture travel at once.
 *
 * A gesture is usually one run and the cap never comes near. It exists for the
 * scribble that crosses a dozen notes, where the whole gesture is on screen at
 * once and the message would otherwise grow with the number of surfaces the
 * hand happened to touch — which is the same unbounded payload section 9.1
 * rules out for a single stroke's points.
 *
 * Dropping the oldest costs a peer that was here nothing at all: a run is
 * always among the newest four *while it is the live one*, and for the three
 * runs after it, so it has already been sent in full by the time it falls off —
 * and section 9.2's rule is that a receiver keeps drawing what it has seen
 * until the document holds that id, rather than only what the last message
 * mentioned. The one person who loses anything is a peer that connected
 * mid-gesture, and they get the newest four marks instead of all of them.
 */
export const WET_MAX_RUNS = 4;

/**
 * One run of one gesture, as it goes out.
 *
 * > `wet: null | { id, target, tool, color, size, base, pts: [...] }`
 * > — docs/DATA-MODEL.md section 9
 *
 * The schema's `target` is `item` here, matching [`WetStroke.item`] — the field
 * the renderer that draws this actually reads (`render/ink/wet.ts`), and the
 * name the tool that produced it uses.
 *
 * `opacity` is not in the schema and is here because a highlighter has one:
 * D-29 rules that a peer's ink is drawn in the ink's own colour, size and
 * strength rather than tinted by whose it is, so every number the local painter
 * needs has to travel.
 */
export interface PresenceWetRun {
  /**
   * The name this run will be filed under when it lands — minted at pen-down
   * (T-167), not at commit, so that a receiver can match the arriving document
   * record against the ghost it is already drawing (section 9.2).
   */
  readonly id: string;
  /** The item the points are local to, or null for board space. */
  readonly item: string | null;
  /**
   * Which page of `item`'s document the sender is drawing on, or absent for the
   * object itself — T-278.
   *
   * On the wire for the same reason `item` is: without it the receiver cannot
   * know which surface to draw the ghost on. A folder open on the sender's board
   * may be shut on the receiver's, or open at a different page, and a run whose
   * face is not the face they are looking at has to be drawn *nowhere* rather
   * than on whatever is showing. Otherwise a peer redacting page four paints a
   * black bar across the kraft cover of a folder that is lying shut, for as long
   * as their hand is moving.
   *
   * **Optional**, unlike every other field here, which is the one concession to
   * a channel that costs bytes per frame: nearly every stroke anybody draws is
   * on no page at all, and this is four characters of JSON thirty times a second
   * that would say nothing.
   */
  readonly page?: number;
  readonly tool: InkTool;
  readonly color: string;
  /** Board units, and item-local units — the two are the same scale. */
  readonly size: number;
  readonly opacity: number;
  /**
   * Where `pts` starts in the sender's decimated sequence, counted in points.
   *
   * The receiver holds everything it has ever seen for [`id`], overwrites from
   * here, and drops anything past the end of what has just arrived. That last
   * clause is what lets the tip be provisional — see [`RunWindow.tip`].
   *
   * A `base` past the end of what the receiver holds is the gap the window
   * failed to cover. It is the receiving half's business what to do about it,
   * and there is no shape of message that can repair it: the missing points are
   * gone from here too.
   */
  readonly base: number;
  /**
   * `[x, y, pressure, x, y, pressure, …]`, oldest first — x and y in eighths of
   * a unit, pressure in 255ths. See the note at the top of the file.
   */
  readonly pts: readonly number[];
}

/** Quantise a coordinate onto the grid `lib/strokepack.ts` uses, as an integer
 *  count of eighths. */
function quantise(value: number): number {
  return Math.round(value * INK_STEPS_PER_UNIT);
}

/** Pressure as a whole number of 255ths, clamped — it is a 0-to-1 quantity and
 *  a reading outside that would come back out of the receiver as a nib width
 *  nobody asked for. */
function quantisePressure(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * PRESSURE_STEPS);
}

/**
 * One run's accumulated window: what has been committed to the sequence, and
 * how far the raw samples have been read.
 */
class RunWindow {
  /** The run as it was born. None of these change for the life of a run. */
  readonly id: string;
  readonly item: string | null;
  readonly page: number | null;
  readonly tool: InkTool;
  readonly color: string;
  readonly size: number;
  readonly opacity: number;

  /** The decimated sequence, flat and quantised. Append-only. */
  private readonly kept: number[] = [];
  /** How many raw samples have been looked at, so a frame only considers the
   *  ones that have arrived since the last one. */
  private read = 0;
  /**
   * The newest sample, on the frames the decimation has not committed it.
   *
   * A run's last few samples are always within six pixels of the last committed
   * point, so without this the drawn end of the line sits up to six pixels
   * behind the hand for the whole stroke — on the one gesture on this board
   * with a latency budget — and a mark shorter than six pixels never reaches
   * two points and is never drawn at all.
   *
   * It rides at the end of `pts` and is *not* in `kept`, so it occupies the
   * index the next committed point will take and is overwritten by it. That is
   * the one place the sequence is rewritten, and it is why the receiver's rule
   * is "overwrite from `base` and drop the rest" rather than "append what is
   * new". Every commit clears it in the same breath, so a tip is never left
   * trailing behind a point that has since been laid down.
   */
  private tip: readonly [number, number, number] | null = null;

  constructor(run: WetStroke) {
    this.id = run.id;
    this.item = run.item;
    this.page = run.page;
    this.tool = run.tool;
    this.color = run.color;
    this.size = run.size;
    this.opacity = run.opacity;
  }

  /**
   * Take in whatever the hand has added since the last frame.
   *
   * `minStep` is in eighths of a unit, like everything kept here. Returns
   * whether anything a peer would see is different — a frame that added no
   * samples changes nothing, which is what keeps a pen resting on the tablet as
   * silent as one that is not touching it.
   */
  advance(samples: readonly { x: number; y: number; pressure: number }[], minStep: number): boolean {
    const before = this.tip;
    let changed = false;
    const min2 = minStep * minStep;

    for (; this.read < samples.length; this.read += 1) {
      const sample = samples[this.read]!;
      // Dropped rather than sent. `JSON.stringify` turns a NaN into `null`, so
      // an unusable coordinate arrives as a point at the origin and draws a
      // line across the board to it.
      if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
      const x = quantise(sample.x);
      const y = quantise(sample.y);
      const p = quantisePressure(sample.pressure);

      if (this.kept.length === 0) {
        this.kept.push(x, y, p);
        this.tip = null;
        changed = true;
        continue;
      }
      const lastX = this.kept[this.kept.length - 3]!;
      const lastY = this.kept[this.kept.length - 2]!;
      const dx = x - lastX;
      const dy = y - lastY;
      if (dx * dx + dy * dy >= min2) {
        this.kept.push(x, y, p);
        this.tip = null;
        changed = true;
      } else if (x === lastX && y === lastY) {
        // The hand has come back to the point already laid down. No tip, rather
        // than one sitting on top of it: the same point twice tells a receiver
        // the line got longer when it did not.
        this.tip = null;
      } else {
        this.tip = [x, y, p];
      }
    }

    if (!changed && before !== this.tip) {
      changed =
        before === null ||
        this.tip === null ||
        before[0] !== this.tip[0] ||
        before[1] !== this.tip[1] ||
        before[2] !== this.tip[2];
    }
    return changed;
  }

  /** This run, as one entry of the payload. Fresh arrays: `kept` is appended to
   *  every frame and nothing on the wire may be a view of it. */
  payload(): PresenceWetRun {
    const points = this.kept.length / 3;
    // The tip counts against the window, so `pts` is never longer than section
    // 9.1's sixty-four however it is made up.
    const room = this.tip === null ? WET_WINDOW : WET_WINDOW - 1;
    const base = Math.max(0, points - room);
    const pts = this.kept.slice(base * 3);
    if (this.tip !== null) pts.push(this.tip[0], this.tip[1], this.tip[2]);
    return {
      id: this.id,
      item: this.item,
      // Spread rather than written as `page: this.page`, so the key is absent
      // on the overwhelmingly common run rather than present and null — see
      // [`PresenceWetRun.page`].
      ...(this.page === null ? null : { page: this.page }),
      tool: this.tool,
      color: this.color,
      size: this.size,
      opacity: this.opacity,
      base,
      pts,
    };
  }

  /** Whether there is anything a receiver could draw. One point is not a line,
   *  and `render/ink/wet.ts` declines to draw it at either end of the wire. */
  get drawable(): boolean {
    return this.kept.length / 3 + (this.tip === null ? 0 : 1) >= 2;
  }
}

/** The answer for a client not drawing anything, which is nearly all of them
 *  nearly all of the time — the same array every time, so an idle board
 *  allocates nothing at all. */
const NO_RUNS: readonly PresenceWetRun[] = Object.freeze([]);

/**
 * The sliding window over every run of the gesture in progress.
 *
 * Fed every frame by `state/presence.ts` and read on the frames it publishes.
 * The two cadences are different on purpose: the decimation wants every sample
 * the hand produced, and the wire wants a message every other frame at most.
 */
export class WetWire {
  /**
   * Keyed by run id, and iterated for the payload — a `Map` keeps insertion
   * order, which is the order the tool hands the runs over: oldest run of the
   * gesture first, the live one last. Ids are minted per run and never reused,
   * so nothing is ever re-inserted and that order cannot drift.
   */
  private readonly runs = new Map<string, RunWindow>();
  private dirty = false;

  /**
   * What the pen has on the overlay right now, and the zoom it is being drawn
   * at.
   *
   * Called every frame with the pen's own list, live arrays and all — nothing
   * here holds a reference past the call except the numbers it has quantised
   * for itself, which is what keeps section 9.4's rule ("anything durable
   * belongs in the document") a property of this file rather than a promise.
   *
   * The eraser's smudge is not among these and must not be: the overlay does
   * not draw it either, because it is already on the ink canvas.
   */
  update(runs: readonly WetStroke[], zoom: number): void {
    // A zoom of zero or worse would put every sample infinitely far from the
    // last and commit the lot. The camera clamps; this is the belt.
    const step = Number.isFinite(zoom) && zoom > 0 ? (WET_SPACING_PX / zoom) * INK_STEPS_PER_UNIT : 0;

    // The newest, when a gesture has crossed more surfaces than the cap allows.
    // The tool hands them over oldest first with the live one last.
    const live = runs.length > WET_MAX_RUNS ? runs.slice(runs.length - WET_MAX_RUNS) : runs;

    for (const run of live) {
      let window = this.runs.get(run.id);
      if (window === undefined) {
        window = new RunWindow(run);
        this.runs.set(run.id, window);
        this.dirty = true;
      }
      if (window.advance(run.samples, step)) this.dirty = true;
    }

    // Every id here is now in the map, so equal sizes mean equal sets and there
    // is nothing to sweep — which is every frame of every ordinary stroke.
    if (this.runs.size === live.length) return;

    // Whatever is no longer in flight: the gesture ended, or a run fell off the
    // back of the cap. Dropped rather than kept, because a window is the
    // largest thing this client holds about a stroke it has finished with and a
    // session is thousands of strokes long. Deleting while iterating a `Map` is
    // defined, and the keys still to come are unaffected.
    for (const id of this.runs.keys()) {
      let held = false;
      for (const run of live) {
        if (run.id === id) {
          held = true;
          break;
        }
      }
      if (held) continue;
      this.runs.delete(id);
      this.dirty = true;
    }
  }

  /** Whether a peer would see anything different from what was last published.
   *  A hand held still inside a sixth of a screen pixel is not a change. */
  get changed(): boolean {
    return this.dirty;
  }

  /**
   * The runs as they go out, and the last word on what was sent.
   *
   * Built here rather than in `state/presence.ts`'s `publish` because the
   * arrays have to be cut out of the accumulators anyway; the rule that makes
   * that safe is the same one — every field is named, and every number in
   * `pts` was quantised by this file out of a primitive.
   */
  payload(): readonly PresenceWetRun[] {
    this.dirty = false;
    if (this.runs.size === 0) return NO_RUNS;
    const out: PresenceWetRun[] = [];
    for (const window of this.runs.values()) {
      // A run of one point is held back rather than sent: it is not a line, the
      // receiver could not draw it, and next frame it will be two.
      if (window.drawable) out.push(window.payload());
    }
    return out.length === 0 ? NO_RUNS : out;
  }
}
