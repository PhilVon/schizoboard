/**
 * Somebody else's pen, mid-stroke.
 *
 * > The receiver keeps everything it has ever seen for that stroke id and
 * > splices. This is self-healing across dropped updates as long as the window
 * > covers the gap. — docs/DATA-MODEL.md section 9.1
 *
 * `state/wetwire.ts` is the sending half and states the rule this file
 * implements: **overwrite from `base`, and drop whatever was past the end of
 * what has just arrived.** The second clause is not tidiness. The last point of
 * a window may be a *tip* — the newest sample, which the sender's decimation
 * has not committed and which is overwritten by the point that takes its index
 * — so a receiver that only ever appended would leave a whisker behind at every
 * one of them, and a stroke would come out with a kink every few points.
 *
 * ## Everything here arrived from another machine
 *
 * So it is validated like the rest of `peers.ts`, and one field is sharper than
 * the others for the same reason the identity colour is: `color` is assigned to
 * `ctx.fillStyle`, and a string the canvas cannot parse is *ignored* rather than
 * rejected — the context quietly keeps whatever colour it had. For an identity
 * that means one peer wearing another's colour, which `peers.ts` answers with a
 * neutral grey because they are still a real person and drawing nothing is
 * certainly wrong. A *mark* is different: it is content, D-29 says it is drawn
 * in the colour the person chose, and a mark in the previous fill's colour is a
 * worse answer than no mark at all. So an unreadable run is dropped.
 *
 * ## The gap, which cannot be repaired
 *
 * `base` counts in the **sender's** numbering. A receiver that missed more than
 * a window has a hole in the middle of a line, and there is no message that can
 * fill it: those points are gone from the sender too, which is what a sliding
 * window means.
 *
 * Three answers, and only one of them is honest. Appending anyway draws a
 * straight line across the hole — a mark nobody made. Freezing stops the ghost
 * following the hand. So: **keep only what is contiguous, and renumber.** Each
 * run remembers the sender index its own first sample stands for
 * ([`RemoteRun.origin`]), and a window that starts past the end restarts the run
 * there. What is drawn is then always a true piece of the real mark, only ever
 * shorter than it — and the same arithmetic covers arriving in the middle of
 * somebody's stroke, which is the same situation seen from the other end.
 */

import type { InkSample, InkTool, WetStroke } from "@/lib/ink";
import { INK_STEPS_PER_UNIT, PRESSURE_STEPS } from "@/lib/strokepack";
import { WET_WINDOW } from "@/state/wetwire";

/**
 * The two marks a peer's pen can make.
 *
 * `"erase"` is a third [`InkTool`] and is deliberately not accepted. The smudge
 * is drawn `destination-out`, and the local overlay does not draw it either —
 * it is already on the ink canvas, and a copy of it up here would punch a hole
 * through every piece of peer chrome underneath. `app/main.ts` never publishes
 * one; this is what makes that a property rather than a promise.
 */
const TOOLS: readonly InkTool[] = ["marker", "highlighter"];

/** Narrowing rather than a bare membership test, so the union is the compiler's
 *  business and not a comment. */
function isDrawnTool(value: unknown): value is InkTool {
  return typeof value === "string" && (TOOLS as readonly string[]).includes(value);
}

/** `#rrggbb`. The same test `peers.ts` applies to an identity colour, and for a
 *  sharper reason — see the note at the top of the file. */
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The longest run this will hold on to.
 *
 * A ghost is only ever up until the document record replaces it (section 9.2),
 * so this is not a budget anybody draws against — it is the ceiling on what one
 * misbehaving peer can make this client keep. Two thousand points at the
 * sender's six-pixel decimation is a line a couple of hundred screen-widths
 * long, which no hand draws without lifting.
 */
const MAX_RUN_POINTS = 2048;

/**
 * How many runs of one peer are kept at once.
 *
 * The sender publishes at most [`WET_MAX_RUNS`] of them, but a receiver holds
 * more than it is being told about: section 9.2 has the ghost staying up until
 * the document holds that id, so the runs of a gesture that crossed a dozen
 * notes are all still on screen while only the newest four are on the wire.
 * Sixteen is well past any real gesture and still a bounded amount of a
 * stranger's data.
 */
const MAX_RUNS = 16;

/** One run as it came off the wire, once it is known to be readable. */
export interface PeerWetRun {
  readonly id: string;
  readonly item: string | null;
  readonly tool: InkTool;
  readonly color: string;
  readonly size: number;
  readonly opacity: number;
  readonly base: number;
  readonly pts: readonly number[];
}

/** Whatever a number has to survive to be worth drawing. */
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * One entry of the `wet` array, validated — or null, which drops that entry and
 * leaves the rest of the peer alone.
 */
function readRun(value: unknown): PeerWetRun | null {
  if (typeof value !== "object" || value === null) return null;
  const run = value as Record<string, unknown>;

  const id = run.id;
  if (typeof id !== "string" || id === "") return null;

  // Null is board space and a real answer; an empty string is neither.
  const item = run.item;
  if (item !== null && (typeof item !== "string" || item === "")) return null;

  const tool = run.tool;
  if (!isDrawnTool(tool)) return null;

  const color = run.color;
  if (typeof color !== "string" || !HEX.test(color)) return null;

  const size = run.size;
  if (!finite(size) || size <= 0) return null;

  const opacity = run.opacity;
  if (!finite(opacity) || opacity <= 0 || opacity > 1) return null;

  // Whole, and not negative: it is an index into a sequence.
  const base = run.base;
  if (!finite(base) || !Number.isInteger(base) || base < 0) return null;

  const pts = run.pts;
  // Three numbers to a point, and never more than the window the protocol
  // allows — a longer one did not come from `state/wetwire.ts`.
  if (!Array.isArray(pts) || pts.length === 0 || pts.length % 3 !== 0) return null;
  if (pts.length > WET_WINDOW * 3) return null;
  for (const n of pts) {
    if (!finite(n)) return null;
  }

  return { id, item, tool, color, size, opacity, base, pts: pts as readonly number[] };
}

/** The same array for every peer holding no pen, which is nearly all of them
 *  nearly all of the time. */
const NO_RUNS: readonly PeerWetRun[] = Object.freeze([]);

/**
 * The `wet` field of one peer's awareness state.
 *
 * Absent, null and malformed all mean the same thing here — nothing to draw —
 * because a peer that is not holding a pen is by far the likeliest reason for
 * each. Entries are dropped one at a time, like `locks`, so one unreadable run
 * costs only itself.
 */
export function readWet(value: unknown): readonly PeerWetRun[] {
  if (!Array.isArray(value) || value.length === 0) return NO_RUNS;
  const out: PeerWetRun[] = [];
  for (const entry of value) {
    const run = readRun(entry);
    if (run !== null) out.push(run);
  }
  return out.length === 0 ? NO_RUNS : out;
}

/**
 * One run of one peer, spliced together out of the windows seen so far and kept
 * in the shape `render/ink/wet.ts` draws.
 *
 * It *is* a [`WetStroke`] — the same object the local pen hands the same painter
 * — because that is D-29 in code: a peer's ink goes through the local path with
 * the run's own tool, colour, size and opacity, and there is no branch anywhere
 * that could give a remote mark a different look.
 */
class RemoteRun implements WetStroke {
  readonly id: string;
  readonly item: string | null;
  readonly tool: InkTool;
  readonly color: string;
  readonly size: number;
  readonly opacity: number;
  /**
   * The sender index that [`samples`]`[0]` stands for.
   *
   * Zero for a run watched from its first point, which is the ordinary case.
   * Non-zero after a gap the window could not cover, or when this client
   * arrived in the middle of somebody's stroke — see the note at the top of the
   * file for why those are the same case.
   */
  origin: number;
  readonly samples: InkSample[] = [];

  constructor(run: PeerWetRun) {
    this.id = run.id;
    this.item = run.item;
    this.tool = run.tool;
    this.color = run.color;
    this.size = run.size;
    this.opacity = run.opacity;
    this.origin = run.base;
  }

  /**
   * Take a window. Returns whether anything a person would see is different.
   *
   * The comparison is per point and exact: the numbers on both sides came off
   * the same integer grid, and a window that repeats what is already held —
   * which is most windows, since only the tail of one moves between two
   * messages — must not cost a redraw of the whole viewport.
   */
  splice(run: PeerWetRun): boolean {
    let at = run.base - this.origin;
    let changed = false;
    if (at > this.samples.length || at < 0) {
      // The gap the window did not cover, or a sender that went backwards.
      // Everything held is now unattached to what has arrived, and joining them
      // would draw a straight line across the part nobody saw.
      this.samples.length = 0;
      this.origin = run.base;
      at = 0;
      changed = true;
    }

    const count = run.pts.length / 3;
    for (let i = 0; i < count; i += 1) {
      const x = run.pts[i * 3]! / INK_STEPS_PER_UNIT;
      const y = run.pts[i * 3 + 1]! / INK_STEPS_PER_UNIT;
      // Clamped, not trusted: it is a 0-to-1 quantity on the way into a nib
      // width, and `perfect-freehand` given a negative one draws a mark that
      // turns itself inside out.
      const pressure = Math.min(1, Math.max(0, run.pts[i * 3 + 2]! / PRESSURE_STEPS));
      const slot = this.samples[at + i];
      if (slot === undefined) {
        this.samples.push({ x, y, pressure });
        changed = true;
      } else if (slot.x !== x || slot.y !== y || slot.pressure !== pressure) {
        this.samples[at + i] = { x, y, pressure };
        changed = true;
      }
    }

    // Anything past the end of what arrived. This is what retires the sender's
    // provisional tip, and it is the whole reason the rule is "overwrite from
    // base" rather than "append what is new".
    const end = at + count;
    if (this.samples.length > end) {
      this.samples.length = end;
      changed = true;
    }

    // A ceiling on what one peer can make this client hold. The oldest points
    // go, and `origin` moves with them so the numbering stays true.
    if (this.samples.length > MAX_RUN_POINTS) {
      const drop = this.samples.length - MAX_RUN_POINTS;
      this.samples.splice(0, drop);
      this.origin += drop;
      changed = true;
    }

    return changed;
  }

  /** Whether there is a line here. One point is a press that has not moved, and
   *  `render/ink/wet.ts` declines to draw it at either end of the wire. */
  get drawable(): boolean {
    return this.samples.length >= 2;
  }
}

/**
 * Every run one peer has in the air.
 *
 * Lives on the peer's record in `peers.ts` rather than being rebuilt per
 * message, which is the whole point: a splice needs what came before, and the
 * sender publishes only its newest few runs while a receiver goes on drawing
 * every one it has seen (DATA-MODEL section 9.2).
 */
export class PeerInk {
  /** Keyed by run id, in the order the runs were first seen — which is the
   *  order the hand made them, and therefore the order to paint them in. */
  private readonly runs = new Map<string, RemoteRun>();

  /**
   * Take this peer's whole `wet` field.
   *
   * Returns whether the drawn result changed, which is what `Peers` turns into
   * a version bump — and without one the overlay never redraws.
   *
   * A run the message does not mention is **kept**, not dropped. The sender
   * caps how many it publishes, and section 9.2 has the ghost staying up until
   * the document holds that id; forgetting a run the moment it fell off the
   * wire would take half of a gesture off the screen while the hand was still
   * moving. [`forget`] is how one goes.
   */
  splice(runs: readonly PeerWetRun[]): boolean {
    let changed = false;
    for (const run of runs) {
      let held = this.runs.get(run.id);
      if (held === undefined) {
        held = new RemoteRun(run);
        this.runs.set(run.id, held);
        changed = true;
      }
      if (held.splice(run)) changed = true;
    }
    // A stranger cannot be allowed to grow this without end. The oldest go, and
    // `Map` iterates in insertion order, so those are the runs whose records
    // are longest overdue anyway.
    while (this.runs.size > MAX_RUNS) {
      const oldest = this.runs.keys().next();
      if (oldest.done === true) break;
      this.runs.delete(oldest.value);
      changed = true;
    }
    return changed;
  }

  /**
   * Stop drawing this run — the document has it now, or the gesture is over.
   *
   * Separate from [`splice`] on purpose. *When* a ghost may go is DATA-MODEL
   * section 9.2's handoff rule and is T-170's to decide; this file only knows
   * how to put one up and take one down, so the policy can change without the
   * splice being touched.
   */
  forget(id: string): boolean {
    return this.runs.delete(id);
  }

  /** Every run with a line in it, oldest first. The live objects, not copies —
   *  the painter only reads them, and a copy would allocate a whole stroke per
   *  peer per frame. */
  *drawable(): Iterable<WetStroke> {
    for (const run of this.runs.values()) {
      if (run.drawable) yield run;
    }
  }

  /** Whether there is anything at all to draw. Cheaper than walking, and it is
   *  asked once a frame per peer. */
  get any(): boolean {
    for (const run of this.runs.values()) {
      if (run.drawable) return true;
    }
    return false;
  }

  /** Every run id being drawn — what section 9.2's handoff has to check against
   *  the document (T-170). */
  ids(): Iterable<string> {
    return this.runs.keys();
  }
}
