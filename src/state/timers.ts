/**
 * The tick, and the going off.
 *
 * A timer on the board is a device that has to keep saying a different thing as
 * time passes, and has to go off at a moment nobody is necessarily watching.
 * This is the whole of both, and it holds no clock, draws nothing and writes
 * nothing to the document.
 *
 * Stepped from the SIM phase (`app/main.ts`), beside `torsion.step`,
 * `flatten.step` and `opening.step` — because SIM is where everything that moves
 * on its own is stepped, and because it is upstream of the DOM phase, so an item
 * dirtied here is written on the same frame. Not `sim/` proper: that directory is
 * solvers, this is not one, and `sim/` may not reach the flash line.
 *
 * ## Ungated by the viewport, unlike everything beside it
 *
 * `torsion` and `ropes` take a `simView` and step only what is near the screen.
 * This does not, and must not. A kitchen timer put on the far side of the board
 * and then panned away from is exactly the timer somebody is waiting on, and a
 * device that only goes off while you are looking at it is not a timer.
 *
 * That is the entire answer to how a culled timer still fires: this module reads
 * the scene mirror, and culling is a decision `render/cull.ts` makes about which
 * DOM nodes exist. The renderer never enters here, so no exemption of the kind
 * the audio deck needs is required, and none should be added.
 *
 * The cost of being ungated is paid at the door instead: `scene.timers` is the
 * mirror's index of which items are timers (T-393), so a board with no clock on
 * it — which is very nearly all of them — pays one `size` test per frame.
 *
 * ## Nothing is written per second, and almost nothing is *dirtied* per second
 *
 * D-73's rule is about the document, and `crdt/ops/timers.ts` keeps it: six
 * writes in a timer's whole life, and expiry writes nothing at all. This file is
 * the same rule one layer out, because a document nobody writes to is no use if
 * the frame loop repaints five hundred items sixty times a second anyway.
 *
 * So the reading is **quantised** to what the face can actually show, and an item
 * is dirtied only when the quantised value moves:
 *
 *   - A **clock** shows `hh:mm` and never seconds — this device has no sweep
 *     hand — so one dirty per clock per minute, at any zoom. That is what makes a
 *     wall of clocks free.
 *   - A running **countdown** or **stopwatch** quantises to one second while its
 *     figures are large enough on screen to read, and to one minute when they
 *     are not. That used to be the board's LOD tier — one boolean, `card` below
 *     35% zoom — and it was wrong for any timer somebody had made large: a
 *     wall-sized countdown at 32% held the same digits for forty-eight seconds
 *     and then jumped a minute (T-405). The tier is a function of camera zoom
 *     alone; legibility is camera zoom *times item size*. So the caller answers
 *     it per timer, and `render/items/dom.ts` owns the arithmetic, because the
 *     numbers that decide it are the ones that size the type.
 *
 *     What the coarse answer is for is unchanged and still the point: five
 *     hundred faces dirtied once a second at the zoom D-33 measured as the
 *     expensive one is the frame that must not exist. It is simply asked about
 *     the right thing now — and a wall of *clocks*, which is the case that
 *     motivated it, is untouched either way, because a clock shows `hh:mm` and
 *     quantises to the minute at every zoom.
 *   - A **paused or unstarted** countdown or stopwatch dirties nothing at all,
 *     ever, and needs no special case to do it: its reading is constant, so the
 *     quantised value never moves.
 *
 * **Expiry is checked exactly and never quantised.** The display quantum and the
 * fire threshold are two different questions, and answering the second with the
 * first would make a countdown at the card tier go off up to a minute late.
 */

import { elapsedOf, readingQuantum, type TimerFields } from "@/lib/timer";
import type { DirtySets } from "@/state/dirty";
import type { Scene } from "@/state/scene";

/** What a countdown that has gone off says about itself. */
export interface Expiry {
  /** The timer. */
  readonly id: string;
  /**
   * What is written on it, trimmed — which is the message, because a caption
   * already *is* what a timer is for (D-73). Empty when nobody wrote anything,
   * and it is the caller's business what to say instead.
   */
  readonly caption: string;
  /**
   * The item this timer lights amber, or null. May dangle: `Flashes.raise`
   * already guards on the scene holding the id, so a target a peer deleted is a
   * timer that lights nothing rather than an error.
   */
  readonly lights: string | null;
}

export type ExpiryListener = (expiry: Expiry) => void;

/**
 * A run, named so that the edge can be re-armed.
 *
 * `runFrom` and `runsFor` and nothing else. Restart it and `runFrom` changes;
 * change its length and `runsFor` does; either is a *different run* and should be
 * able to go off again. `banked` is deliberately absent — it moves on every pause
 * and a pause is not a new run.
 *
 * A string rather than a pair, because it is only ever compared for equality and
 * one map is cheaper than two.
 */
function runSignature(fields: TimerFields): string {
  return `${fields.runFrom ?? "-"}/${fields.runsFor}`;
}

export class Timers {
  /**
   * The quantised reading last published for each timer — an integer whose
   * meaning depends on the mode and the tier, and which is compared for equality
   * and nothing else.
   *
   * Keyed by item id. Entries are dropped when a timer leaves the board, in the
   * same pass that reads them, so a session that has had clocks put up and taken
   * down all afternoon does not accumulate.
   */
  private readonly shown = new Map<string, number>();

  /**
   * The run that has already gone off, per timer.
   *
   * Local, per-window and never written down. That is not a shortcut: an expired
   * countdown stays expired *by arithmetic* (`lib/timer.ts`), so there is no
   * fired flag in the document for two peers to converge on, no race to set it,
   * and no undo entry for a thing nobody did. What is held here is the *edge* —
   * "have I already said this out loud" — which is a fact about this window and
   * nothing else.
   *
   * The consequence is deliberate and worth stating: a second window on the same
   * board hears its own announcement, because both people are in the room and
   * both should be told.
   */
  private readonly fired = new Map<string, string>();

  private readonly listeners = new Set<ExpiryListener>();

  /** Announce every expiry to `listener`, until the returned function is
   *  called — `state/assets.ts`'s shape. */
  onExpire(listener: ExpiryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * One frame.
   *
   * `now` is **epoch milliseconds** and arrives as an argument, never from a
   * clock read in here — which is what makes every rule above testable as a
   * table, and what keeps the promise in ARCHITECTURE section 3 that nothing
   * animates on its own. Note that it is not `frame.now`: that is the rAF
   * timestamp, and `runFrom` is a `Date.now()` written by whichever machine
   * pressed start. The two are different clocks and subtracting one from the
   * other would put decades on a face.
   *
   * `aheadFor` answers how far this machine's clock is ahead of the one a given
   * timer's start was written by — T-410. A function of the *writer* and not one
   * number, because a discovered-peer mesh has no single base to be ahead of:
   * every peer measures every other directly, and each timer is read in the
   * frame it was written in. `state/clock.ts` holds the table and falls back to
   * this machine's base where there is no direct link, which is the topology
   * T-404 fixed.
   *
   * `detailedFor` answers, for one timer, whether its seconds can be read where
   * it is drawn — T-405. A function rather than the camera itself, for exactly
   * the reason `simView` is a plain rectangle and for the reason the boolean it
   * replaced was one: this module holds no camera, and what it needs is the
   * answer rather than the means to work one out. The caller must hand the
   * *same* function to the face, or the digits and the dirty flag part company.
   */
  step(
    scene: Scene,
    dirty: DirtySets,
    now: number,
    detailedFor: (id: string) => boolean,
    aheadFor: (writer: number | null) => number,
  ): void {
    const timers = scene.timers;
    if (timers.size === 0) {
      // Nothing to step, and nothing to remember about nothing. A board whose
      // last clock was just taken down passes through here once.
      //
      // Stated rather than depended on: the ordinary path below reaches exactly
      // this state anyway — an empty loop, then two prunes that empty both maps
      // — so this branch is the cost model written down, not a behaviour. It was
      // mutated away deliberately and no test moved, which is the honest way to
      // find that out. Keep it for what it says about a board with no clock on
      // it, and do not hang anything on it.
      if (this.shown.size > 0) this.shown.clear();
      if (this.fired.size > 0) this.fired.clear();
      return;
    }

    for (const id of timers) {
      const cold = scene.cold(id);
      const fields = cold?.timer;
      // Indexed but not readable is not a state the mirror can be in; the guard
      // is here because this loop is the one place that would turn it into a
      // thrown error rather than a skipped item.
      if (cold === null || cold === undefined || fields === null || fields === undefined) continue;

      const first = !this.shown.has(id);
      // `lib/timer.ts`'s, and shared with the face rather than restated here.
      // The face writes its digits when this moves and this module dirties the
      // item when it moves, so two definitions would be a digit written on a
      // frame nothing dirtied — a clock that never updates — or an item dirtied
      // every frame for a face that will not change.
      // Asked per timer rather than once for the board — T-405. A face's
      // resolution is a question about how large *this* clock is drawn, and the
      // camera alone cannot answer it: a timer somebody made wall-sized is
      // legible at a zoom where an ordinary one is a smudge. The caller decides
      // and the face asks the same function, which is what keeps the digits and
      // the dirty flag on one frame.
      const ahead = aheadFor(fields.runBy);
      const reading = readingQuantum(fields, now, detailedFor(id), ahead);
      if (this.shown.get(id) !== reading) {
        this.shown.set(id, reading);
        // Not on the first sight: the item is already dirty from the binding
        // that put it there, and this would be a second dirty for the same
        // frame's paint. It is *set* above rather than skipped, because what the
        // next frame compares against has to be this frame's answer.
        //
        // A tier change is the other frame this fires on for every running
        // timer at once, because the quantum it is measured in has changed under
        // it. That is a frame the whole board is being rebuilt on anyway
        // (`render/lod.ts` — a fall is paid for with the re-raster), so it costs
        // nothing, and the alternative — remembering which tier the number was
        // taken in — is state kept to avoid a dirty flag on a frame that is
        // already a full repaint.
        if (!first) dirty.item(id);
      }

      this.check(id, fields, cold.text, now, ahead, first);
    }

    // Timers that have left the board, dropped from both maps. Walked over the
    // maps rather than over the scene, so the common frame — nothing removed —
    // costs one size comparison and no iteration at all.
    //
    // **Leak guards, not correctness**, and the distinction is worth having
    // rather than blurring — `crdt/binding.ts` makes the same one about
    // `stringsByPin` on a resync. A stale entry here cannot produce a wrong
    // answer: the two maps are only ever read for an id the scene still holds,
    // and an id that came back would be re-read on the very frame it returned.
    // What it produces is a session that has had clocks put up and taken down
    // all afternoon carrying every one of them until the window closes. Both
    // lines were mutated away and no test moved, which is the truthful result
    // and is recorded here rather than papered over with a test that reaches
    // into a private map to find something the board cannot see.
    if (this.shown.size !== timers.size) prune(this.shown, timers);
    if (this.fired.size > timers.size) prune(this.fired, timers);
  }

  /**
   * Has this countdown just run out, and if so, say so once.
   *
   * Only a countdown expires. A clock has nothing to run out of and a stopwatch
   * counts up forever, so neither is asked.
   */
  private check(
    id: string,
    fields: TimerFields,
    text: string,
    now: number,
    ahead: number,
    first: boolean,
  ): void {
    if (fields.mode !== "countdown") {
      // A countdown switched to another mode gives its edge back, so switching
      // away and back is a timer that can go off again rather than one that has
      // silently used up its one announcement.
      this.fired.delete(id);
      return;
    }
    // Exact, and never the quantised reading — see the file header. A `runsFor`
    // of zero is a countdown nobody set rather than one that finished instantly,
    // and firing on it would go off the moment the mode chip was pressed. The
    // guard also covers a length that is not a number, which is what a peer's
    // nonsense arrives as — `Number.isFinite` fails and it reads as unset.
    const runsFor = Number.isFinite(fields.runsFor) && fields.runsFor > 0 ? fields.runsFor : 0;
    if (runsFor === 0 || elapsedOf(fields, now, ahead) < runsFor) {
      // Not expired, so there is nothing to have already said: a reset, a longer
      // length or a fresh start all arrive here and all give the edge back.
      this.fired.delete(id);
      return;
    }
    const run = runSignature(fields);
    if (this.fired.get(id) === run) return;
    this.fired.set(id, run);
    // A countdown that had already run out on the first frame this session saw
    // it is recorded as fired and announced to nobody. It went off while this
    // window was closed, or on somebody else's machine an hour ago; saying so
    // now would make opening a board a recital of every timer anybody ever set
    // on it. The renderer's `FirstSight` is the same shape and the same
    // argument, and — quite correctly — a second window on the same board is
    // still to hear its own.
    if (first) return;
    // Trimmed here rather than by every listener: a caption of three spaces is
    // nothing written on it, and the caller decides what to say instead.
    const caption = text.trim();
    for (const listener of this.listeners) listener({ id, caption, lights: fields.lights });
  }
}

function prune(map: Map<string, unknown>, live: ReadonlySet<string>): void {
  for (const id of map.keys()) if (!live.has(id)) map.delete(id);
}
