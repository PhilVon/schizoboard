/**
 * What a timer *is*, and what its face says at a given instant.
 *
 * The five fields D-73 puts on the fifth item type, the arithmetic that turns
 * them into a reading, and the two formatters that write that reading down.
 * Nothing here touches a document, a DOM node or a clock of its own: `now` is
 * always an argument, which is the whole reason the rule below is enforceable.
 *
 * ## Nothing is written per second
 *
 * The load-bearing rule of the whole feature. The document holds `mode`,
 * `runsFor`, `runFrom`, `banked` and `lights`, and every one of them changes
 * only when somebody does something. What a face shows is *derived* from those
 * five and a `now` that is never stored:
 *
 * ```
 * elapsed(now) = banked + (runFrom === null ? 0 : max(0, now - runFrom))
 * ```
 *
 * Six writes over a timer's whole life. **Expiry writes nothing at all** — an
 * expired countdown stays expired by arithmetic, so there is no fired flag for
 * two peers to converge on, no race to set it, and no undo entry for a thing
 * nobody did. Absence of `runFrom` *is* the paused state, so there is no second
 * flag able to contradict the first, and no way to store "running" with no
 * start.
 *
 * ## Why none of the five is a CRDT type
 *
 * DATA-MODEL section 1 makes a field a CRDT type when two people can
 * meaningfully edit different parts of it at once. Not one of these qualifies:
 * two people setting a countdown to five minutes and to ten must land on one of
 * the two, never on a merged seven and a half. They are plain values and
 * last-write-wins is the right answer for all of them.
 *
 * The message on expiry is deliberately **not** a sixth field. A caption already
 * is what a timer is for, it is already a `Y.Text` two people can type into, and
 * it is already reachable through the caret path.
 *
 * ## Clock skew was accepted, and it should not have been — T-404
 *
 * This file used to argue that `runFrom` being `Date.now()` on the writing
 * machine, subtracted on the reading one, was a tolerable inaccuracy — on the
 * precedent of `render/items/wear.ts`, which ages every item from each
 * machine's own clock with no correction (DESIGN section 4.7, Q-105). The
 * precedent was borrowed from a domain where the error is invisible into the
 * one domain where it is the entire feature. A ninety-second error in how brown
 * a note has gone is not noticeable; a ninety-second error in a stopwatch is
 * the stopwatch.
 *
 * And it did not degrade gently. The clamp below reads a negative elapsed as
 * zero, so a peer whose clock is *behind* the one that pressed start did not
 * see the countdown slightly early — it saw it as never started, frozen on its
 * opening digits until the skew ran out. Measured on two real peers, with one
 * clock put ninety seconds back: a stopwatch reading `0:15` on one machine and
 * `0:00` on the other, both holding a byte-identical `runFrom`. D-74 has the
 * runs.
 *
 * So `runFrom` is now an instant in a base every peer measures against, and
 * `ahead` is how far this machine's wall clock runs ahead of that base
 * (`state/clock.ts`). Zero — the default on every function here — is a board
 * with nobody to disagree with, and is exactly this build's old behaviour.
 *
 * **A clock face is exempt and takes the raw `now`.** It shows what time it is
 * here, on the same wall as the taskbar; a countdown and a stopwatch measure a
 * duration against an instant somebody else may have written, and only those
 * two are corrected.
 *
 * What is still refused is *nonsense* rather than skew: a `runFrom` from the
 * future clamps to "just started" rather than running the elapsed negative.
 *
 * One correction while here, because the sentence this replaces cited it: it
 * said awareness "carries no clock and must not learn one — T-226 took the
 * camera off it". T-226 did no such thing. `cam` came off the wire because it
 * was published every other frame and *read by nobody* (`state/presence.ts`),
 * and that note says in as many words that putting it back belongs to whichever
 * task builds a consumer. The precedent is against an unconsumed field, not
 * against a clock.
 *
 * ## Why here
 *
 * `lib/style.ts`'s argument, word for word, with a fourth reader. This
 * vocabulary is needed by `crdt/` to validate what arrives in a document, by
 * `state/` to derive from it, by `render/` to draw it and by `ui/` to draw a row
 * of chips of it — and those four may not import each other. `lib/` is
 * dependency-free and importable by anyone (there is a lint rule,
 * `LIB_IMPORTS_NOTHING`).
 */

import { runtimeLabel } from "@/lib/objects";

/**
 * The three the mode strip offers.
 *
 * One device with a mode, not three objects. The mode is chosen from the
 * right-click menu and is therefore mutable, unlike the *type* — which is the
 * asymmetry D-73 spent a schema version on.
 *
 * As a list as well as a union, for the reason `PIN_KIND_NAMES` gives next door:
 * `render/` does not import from `crdt/`, so a mode added to one union and not
 * the other draws nothing and says nothing about it.
 */
export type TimerMode = "clock" | "countdown" | "stopwatch";
export const TIMER_MODES: readonly TimerMode[] = ["clock", "countdown", "stopwatch"];

/**
 * `clock` is absent from the map, the way `sourceAbout: "page"` is.
 *
 * A key holding the default on every object that has one is a key nobody can
 * read anything from, and most timers are the thing you put on a wall to know
 * what time it is. So only these two are ever written, and every other answer —
 * absent, a mode a later build invented, a peer's nonsense — reads as `clock`.
 *
 * This is the reason the mode strip drops the "As it was" chip that
 * `appearanceRows` leads every other strip with. A `style` property is a veto
 * over the seed, so its absence is meaningful and needs a chip to get back to. A
 * mode has no seed behind it: absent *means* `clock`, and `clock` is itself a
 * real choice, so a strip carrying both chips would show two meaning one thing.
 */
export const WRITTEN_TIMER_MODES: readonly TimerMode[] = ["countdown", "stopwatch"];

export function isTimerMode(value: unknown): value is TimerMode {
  return typeof value === "string" && (TIMER_MODES as readonly string[]).includes(value);
}

/** The five. Milliseconds throughout, because `Date.now` is milliseconds and
 *  every derivation here is a subtraction of two of them. */
export interface TimerFields {
  /** Never absent to a reader — see `WRITTEN_TIMER_MODES`. */
  mode: TimerMode;
  /**
   * How long a countdown runs for, in milliseconds.
   *
   * Named away from `AssetFields.duration`, which is *seconds* off a container
   * header. One word, one unit: a file has a duration, a timer has a length it
   * was set to, and the two are never the same number.
   */
  runsFor: number;
  /**
   * When the current run began, epoch milliseconds — or `null`, which is the
   * paused state and the only paused state.
   */
  runFrom: number | null;
  /**
   * How much was already on the clock before this run, in milliseconds.
   *
   * `banked` and not `elapsed` on purpose. `elapsed` reads as the total, it is
   * not the total, and that misreading is the bug that would otherwise ship —
   * every reader who wanted the total would take this field and be quietly
   * wrong by the length of the current run.
   */
  banked: number;
  /**
   * The Yjs client id whose clock `runFrom` is written in — T-410, or `null`.
   *
   * A timer's only *instant* is `runFrom` (`banked` is a duration and needs no
   * clock at all), and it has exactly one writer at a time — so naming that
   * writer is enough to read every timer in the frame it was written in.
   *
   * That is what lets a discovered-peer mesh work without electing anybody.
   * `app/mesh.ts` refuses an election for three stated reasons, all of them
   * problems about a *shared base*: who won, what happens when they close their
   * laptop, and telling that apart from the network going. Per-writer offsets
   * have no shared base, so none of the three arises.
   *
   * Null on every timer started before this existed, and by any build that does
   * not write it — which reads as "use whatever base this machine has", and is
   * exactly right in the topology T-404 fixed, where there is one base for
   * everybody.
   */
  runBy: number | null;
  /**
   * The item this timer lights amber when it expires, or `null`.
   *
   * May dangle. DATA-MODEL section 8.1 tolerates a dangling reference and never
   * repairs one on read, and `Flashes.raise` already guards on the scene holding
   * the id — so an id whose item was deleted is a timer that lights nothing,
   * not an error.
   */
  lights: string | null;
}

/** A timer nobody has set or started: a clock. The reset state, and what a
 *  fresh one is made as. */
export const NO_TIMER: TimerFields = Object.freeze({
  mode: "clock",
  runsFor: 0,
  runFrom: null,
  runBy: null,
  banked: 0,
  lights: null,
});

/**
 * A duration off a document, made safe to do arithmetic with.
 *
 * Zero rather than a rejection, for the reason `readItem` clamps a nonsense size
 * rather than dropping the item: a timer with a corrupt `banked` should still be
 * a timer you can grab, reset and delete, not a face reading `NaN:NaN`. An older
 * or hostile peer can put anything in a `Y.Map`, and `crdt/ops` refusing
 * non-finite numbers at the writer (invariant 1, the T-155 note in `items.ts`)
 * is what stops *this* build writing one — not what stops one arriving.
 */
function ms(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * How long this timer has been running, in milliseconds, at `now`.
 *
 * The clamp is `max(0, now - runFrom)` and it is the one piece of repair in the
 * file: a `runFrom` in the future is a peer whose clock is ahead, and the honest
 * reading of "it starts in four seconds" on a wall clock is that it has just
 * started. Skew is accepted; a negative elapsed is not, because it would run a
 * countdown *backwards* past its own length and light nothing.
 *
 * A `runFrom` that is not a real instant contributes nothing rather than
 * poisoning the sum, and a non-finite `now` does the same — the face then shows
 * the banked total, which is what a paused one shows. Note that a nonsense
 * `runFrom` cannot be sent through `ms` like the durations above: zero is a
 * perfectly good duration and a catastrophic instant, and reading a `NaN` start
 * as the epoch would put fifty-six years on the face.
 */
export function elapsedOf(fields: TimerFields, now: number, ahead = 0): number {
  const banked = ms(fields.banked);
  const from = fields.runFrom;
  if (from === null || !Number.isFinite(from) || from <= 0) return banked;
  if (!Number.isFinite(now)) return banked;
  // `runFrom` is an instant in the base every peer measures against, and `now`
  // is this machine's wall clock — so the clock comes to the instant rather
  // than the instant being rewritten to the clock. See `state/clock.ts` for why
  // that direction and not the other.
  const since = Number.isFinite(ahead) ? now - ahead : now;
  return banked + Math.max(0, since - from);
}

/** What a face needs, and nothing a face does not. */
export interface TimerReading {
  mode: TimerMode;
  /**
   * The document's answer — `runFrom !== null` — and not "still counting".
   *
   * An expired countdown is still running by this reading, and deliberately:
   * stopping it would be a write, and expiry writes nothing at all. Somebody has
   * to pick it up and stop it, which is exactly what happens to a kitchen timer.
   */
  running: boolean;
  /** Milliseconds since the whole thing started, banked runs included. */
  elapsed: number;
  /** Milliseconds a countdown has left, floored at zero. Zero for the other two
   *  modes, which have nothing to run out of. */
  remaining: number;
  /**
   * A countdown that has run out. Never true for the other two modes, and never
   * true for a countdown of no length.
   *
   * A `runsFor` of zero is a countdown nobody set rather than one that finished
   * instantly, and raising the flash line for it would go off the moment the
   * mode chip was pressed.
   */
  expired: boolean;
  /** What is printed on the face. */
  label: string;
}

/**
 * The reading, from the five fields and an instant.
 *
 * Pure and total: same arguments, same answer, no clock read, no DOM, no
 * document. That is what makes the whole feature testable as a table.
 */
/**
 * A duration rounded to its own step and written out — the full-resolution
 * reading's label, in one place instead of two.
 *
 * `round` is `Math.floor` for a stopwatch and `Math.ceil` for a countdown,
 * which is the split `timerReading` has always made and the reason this takes
 * the function rather than a flag: the two callers differ in exactly that and
 * in nothing else.
 */
function quantised(value: number, round: (n: number) => number): string {
  const step = stepFor(value, true);
  return dialLabel(round(value / step) * step, step);
}

export function timerReading(fields: TimerFields, now: number, ahead = 0): TimerReading {
  const elapsed = elapsedOf(fields, now, ahead);
  const running = fields.runFrom !== null;
  if (fields.mode === "clock") {
    return { mode: "clock", running, elapsed, remaining: 0, expired: false, label: clockLabel(now) };
  }
  if (fields.mode === "stopwatch") {
    return {
      mode: "stopwatch",
      running,
      elapsed,
      remaining: 0,
      expired: false,
      // Floored, not rounded. A stopwatch half a second in reads `0:00`,
      // because it has not been running for a second yet — the same correction
      // `timeReference` makes before handing a transcript offset to the same
      // formatter, and for the same reason: the label must never claim a moment
      // that has not happened. Floored *by its own step*, so a stopwatch that
      // has been running for days says `2d 07h` rather than `55:14:09`.
      label: quantised(elapsed, Math.floor),
    };
  }
  const runsFor = ms(fields.runsFor);
  const remaining = Math.max(0, runsFor - elapsed);
  return {
    mode: "countdown",
    running,
    elapsed,
    remaining,
    expired: runsFor > 0 && remaining === 0,
    // Ceiled, which is the opposite correction and the same principle. A
    // countdown showing `0:00` with half a second left has already lied; a
    // kitchen timer holds `0:01` until the second is actually gone. Exactly
    // zero ceils to zero, so the face reads `0:00` at the instant it expires
    // and not before.
    label: quantised(remaining, Math.ceil),
  };
}

/** One minute. The clock face's resolution, and the coarse tier's. */
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The longest a countdown may be set to — a week, Q-368.
 *
 * Enforced at the *writer* (`crdt/ops/timers.ts`) and deliberately not at the
 * reader. A peer running a later build may set something longer, and the honest
 * response to that is a face that says what the document says rather than a
 * timer this build silently shortens. DATA-MODEL section 8.1's rule, which is
 * the same one `readTimer` follows for every other field.
 *
 * A week reverses a stated position — the preset list argued that past an hour
 * a countdown stops being a thing you watch and becomes a calendar, which
 * DESIGN 1.4 lists as a non-goal — and that reversal is Q-368's answer rather
 * than an oversight.
 */
export const MAX_COUNTDOWN_MS = 7 * DAY_MS;

/**
 * Where a bezel wound `turns` of a full turn lands, in milliseconds — T-407,
 * T-411.
 *
 * ## One turn is the whole scale, because that is what a dial is
 *
 * A real kitchen timer covers nought to an hour in a single turn, and the
 * reason is not economy: a dial you have to wind round fourteen times is a
 * dial whose position tells you nothing. The scale is *readable off the
 * pointer*, and that only works if there is one revolution of it. So a week is
 * one turn here too, and the range is bought with a curve rather than with
 * more turns.
 *
 * ## Cubic, so the short end is where the resolution is
 *
 * Most timers anybody sets are minutes, and a linear turn would put five
 * minutes inside the first half-degree. At `curve` 3 the first thirty degrees
 * are the first six minutes, a quarter turn is about two and a half hours, half
 * a turn is most of a day, and the last quarter carries three days to seven:
 *
 * ```
 *    30deg ->  6 min      90deg -> 2h 35m
 *   180deg -> 21h        270deg -> 2d 23h       360deg -> 7d
 * ```
 *
 * `curve` is an argument and not a constant because it is a *feel* parameter,
 * and DESIGN section 5.8's rule is that feel is found by fiddling rather than
 * derived. It arrives from `sim/tuning.ts` so the panel can turn it while the
 * hand is on the bezel; `lib/` may not import that, and should not — this is
 * the arithmetic, not the taste.
 *
 * Clamped at both ends. Winding backwards past nothing is a countdown of no
 * length rather than a negative one, and past a full turn is a week rather than
 * a fortnight — a dial has a stop, and running off the end of one silently is
 * how you set a timer you did not mean.
 */
/**
 * The shape of the wind, as a mutable binding — T-411.
 *
 * A `let` and not a `const`, on `sim/tuning.ts`'s pattern rather than in it.
 * DESIGN section 5.8's rule is that feel is found by fiddling and the fiddling
 * has to be fast, and this exponent is precisely that kind of number — but
 * `sim/tuning.ts` says in its own header that it holds the *physics* constants,
 * and a gesture curve is not one. Putting it there would also make
 * `state/tools/` import `sim/`, which nothing does today.
 *
 * So it lives beside the arithmetic it shapes, and `app/main.ts` puts
 * `setWindCurve` on the debug handle in a dev build — which is the same fast
 * loop the panel offers, without stretching a module or crossing a layer to get
 * it. Three is where it was left; see [`windTo`] for what that buys.
 */
let WIND_CURVE = 3;

/** What the bezel is currently shaped like. */
export function windCurve(): number {
  return WIND_CURVE;
}

/** Turn the dial's feel, for a dev build with a hand on the bezel. Refused
 *  rather than clamped when it is not a shape, so a slip cannot flatten it. */
export function setWindCurve(curve: number): void {
  if (Number.isFinite(curve) && curve > 0 && curve <= 12) WIND_CURVE = curve;
}

export function windTo(turns: number, curve: number = WIND_CURVE): number {
  if (!Number.isFinite(turns) || turns <= 0) return 0;
  const at = Math.min(1, turns);
  const shaped = Number.isFinite(curve) && curve > 0 ? Math.pow(at, curve) : at;
  return snapWind(shaped * MAX_COUNTDOWN_MS);
}

/**
 * The detent a wound value falls on.
 *
 * A dial has stops, and these grow with the reading for the same reason the
 * *face* does (`stepFor`): a countdown of four days set to the nearest minute
 * is a precision nobody asked for and nobody can hold their hand still enough
 * to hit. The two ladders are deliberately not the same one — a face under an
 * hour shows seconds and nobody winds in seconds — so this is its own function
 * rather than a second caller of that one.
 */
export function snapWind(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const step =
    value < HOUR_MS ? MINUTE_MS
    : value < 6 * HOUR_MS ? 5 * MINUTE_MS
    : value < DAY_MS ? 15 * MINUTE_MS
    : HOUR_MS;
  return Math.min(MAX_COUNTDOWN_MS, Math.round(value / step) * step);
}

/**
 * The turn a length is already wound to — [`windTo`] backwards.
 *
 * A wind has to start from where the dial *is*, or every grab of the bezel
 * would snap the countdown to wherever the pointer happened to be. This is what
 * makes the gesture relative rather than absolute.
 */
export function windOf(value: number, curve: number = WIND_CURVE): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const at = Math.min(1, value / MAX_COUNTDOWN_MS);
  return Number.isFinite(curve) && curve > 0 ? Math.pow(at, 1 / curve) : at;
}

/**
 * The resolution a duration of this size is worth printing at — T-407.
 *
 * The second half of the same idea T-405 established: a face should be written
 * only as often as it actually changes. That was about how large the figures
 * are on screen; this is about how large the *number* is. Nobody watches the
 * seconds of a countdown with four days left, and printing them would dirty the
 * item eighty-six thousand times a day for a face that changes hourly.
 *
 * `detailed` is T-405's answer — whether the figures can be read where they are
 * drawn — and the two compose by taking the coarser: a four-day countdown too
 * small to read is still hourly, and a four-day countdown drawn large is hourly
 * too, because the hours are all it says.
 *
 * The switchover is a whole day and there is one of it, so a reading crosses at
 * exactly the point its format changes. `1d 00h` becomes `23:59:59` and the
 * step goes from an hour to a second in the same instant — which is a jump in
 * what the dial says, and the right one: a countdown coming under a day is a
 * countdown that has become watchable.
 */
export function stepFor(value: number, detailed: boolean): number {
  if (Number.isFinite(value) && value >= DAY_MS) return HOUR_MS;
  return detailed ? 1000 : MINUTE_MS;
}

/**
 * A duration as a dial says it, at the step it is being compared at — T-407.
 *
 * **The only place a timer's figures are composed**, and it takes the step
 * rather than deciding one, because the caller has already quantised by it.
 * That is what makes the label and the dirty flag incapable of disagreeing:
 * `timerFace` builds this out of the quantum itself, so the digits are by
 * construction the number the tick compared.
 *
 * Past a day the dial gives up its seconds and says days and hours, because
 * `runtimeLabel` would print a week as `168:00:00` — correct, and useless. Two
 * digits on the hours so `6d 03h` and `6d 23h` are the same width, which is the
 * same courtesy `tabular-nums` does for the figures either side of a colon.
 */
export function dialLabel(value: number, step: number): string {
  if (!Number.isFinite(value) || value < 0) return runtimeLabel(0);
  if (step >= HOUR_MS) {
    const hours = Math.round(value / HOUR_MS);
    return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`;
  }
  return runtimeLabel(Math.round(value / 1000));
}

/**
 * A reading with the number that decides whether it has *moved* — T-394, T-395.
 *
 * `quantum` is compared and never shown. It exists because two things have to
 * agree about when a face changes and they sit in different layers: the tick
 * (`state/timers.ts`) dirties an item when it moves, and the face
 * (`render/items/dom.ts`) writes its digits when it moves. Two answers to that
 * one question is a digit written on a frame nothing dirtied — which is a face
 * that never updates — or an item dirtied every frame for a face that will not
 * change. So there is one function and they both call it.
 */
export interface TimerFace extends TimerReading {
  readonly quantum: number;
}

/**
 * The integer a face would print, at this instant and this tier.
 *
 * **Its own function, and cheap on purpose.** The tick asks this of every timer
 * on the board on every frame and must allocate nothing to do it, which is why
 * this is not simply `timerFace(...).quantum` — that mints an object per timer
 * per frame, which on a wall of clocks is thirty thousand a second and is the
 * exact cost the whole feature exists to avoid.
 *
 * The tier is the second argument because a face's resolution is not fixed: at
 * the `card` tier nobody can read a seconds digit, so a countdown quantises to
 * the minute and the item is dirtied sixty times less often. A clock takes no
 * notice of the tier — it shows `hh:mm` at every zoom, since this device has no
 * sweep hand.
 */
export function readingQuantum(
  fields: TimerFields,
  now: number,
  detailed: boolean,
  ahead = 0,
): number {
  if (fields.mode === "clock") {
    // The minute of the epoch, which is the minute of the day anywhere with a
    // whole-minute offset from it — which is everywhere.
    return Number.isFinite(now) ? Math.floor(now / MINUTE_MS) : 0;
  }
  const elapsed = elapsedOf(fields, now, ahead);
  // Floored for a stopwatch and ceiled for a countdown, which is `timerReading`'s
  // split and has to stay it: a quantum that rounded the other way from the label
  // would move on the frame *beside* the one the digits change on.
  //
  // The step is taken from the value being *shown* rather than from the tier
  // alone (T-407), so a countdown with four days left is compared hourly — the
  // hours are all its face says, and dirtying it once a second for them would
  // be eighty-six thousand writes a day for twenty-four changes.
  if (fields.mode === "stopwatch") return Math.floor(elapsed / stepFor(elapsed, detailed));
  const remaining = Math.max(0, ms(fields.runsFor) - elapsed);
  return Math.ceil(remaining / stepFor(remaining, detailed));
}

/**
 * The reading, plus the number that says whether it moved — and, below the full
 * tier, printed at the resolution it is actually being compared at.
 *
 * That last clause is the whole reason this is not `timerReading` with a field
 * bolted on. At the `card` tier the tick dirties a running countdown once a
 * minute; if the label were still built to the second, the face would show
 * whatever second happened to be current on the one frame a minute it was
 * allowed to write, and a stopwatch would read `4:17`, then `5:09`, then `6:02`.
 * The digits have to be quantised by the same step that decides when they are
 * written, or the coarse tier is not coarse — it is wrong.
 */
export function timerFace(
  fields: TimerFields,
  now: number,
  detailed: boolean,
  ahead = 0,
): TimerFace {
  const reading = timerReading(fields, now, ahead);
  const quantum = readingQuantum(fields, now, detailed, ahead);
  // A clock is at minute resolution and says the time of day rather than a
  // duration, so its label is not a quantised span and is not rebuilt.
  if (reading.mode === "clock") return { ...reading, quantum };
  // **Built out of the quantum, always** — T-407, AC-1167. Not "rebuilt when
  // coarse", which is what this was: two expressions for one number, agreeing
  // by inspection. The digits are now by construction the value the tick
  // compared, so a face that changed on a frame nothing dirtied would have to
  // be two different quanta rather than two different formatters.
  const step = stepFor(reading.mode === "stopwatch" ? reading.elapsed : reading.remaining, detailed);
  return { ...reading, quantum, label: dialLabel(quantum * step, step) };
}

/**
 * The time of day, as a small travel clock says it — `09:05`.
 *
 * Its own formatter, because `runtimeLabel` is a *duration* and drops the
 * leading unit when it is empty: an hour is nine o'clock and never `9`, and
 * midnight past five is `00:05` rather than the `0:05` a spine would print for
 * five seconds. Two things that look alike and mean nothing like each other, so
 * they do not share a function.
 *
 * Hours and minutes, not seconds: this is a clock on a wall, and the seconds on
 * one are a hand rather than a number.
 *
 * Local time, off `now`, with no timezone of its own — the clock on the wall
 * says what time it is *here*, and a peer in another country reading the same
 * document should see their own afternoon. Nothing about the timezone is
 * therefore in the document, and there is nothing to converge.
 */
export function clockLabel(now: number): string {
  // A flat battery. Unreachable from the frame clock, and cheaper to answer than
  // to prove impossible from every caller.
  if (!Number.isFinite(now)) return "--:--";
  const at = new Date(now);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
