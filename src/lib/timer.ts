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
 * ## Clock skew is accepted, on a precedent already in the building
 *
 * `runFrom` is `Date.now()` on the writing machine and the subtraction happens
 * on the reading one, so a peer whose clock is fast sees a countdown further
 * along. `render/items/wear.ts` already ages every item from `Date.now()` on
 * each machine with no correction (DESIGN section 4.7, Q-105), and awareness
 * carries no clock and must not learn one — T-226 took the camera off it. Two
 * real clocks on two real walls disagree, and this board has already decided
 * that is fine. What is refused is *nonsense* rather than skew: a `runFrom` from
 * the future clamps to "just started" rather than running the elapsed negative.
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
export function elapsedOf(fields: TimerFields, now: number): number {
  const banked = ms(fields.banked);
  const from = fields.runFrom;
  if (from === null || !Number.isFinite(from) || from <= 0) return banked;
  if (!Number.isFinite(now)) return banked;
  return banked + Math.max(0, now - from);
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
export function timerReading(fields: TimerFields, now: number): TimerReading {
  const elapsed = elapsedOf(fields, now);
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
      // that has not happened.
      label: runtimeLabel(Math.floor(elapsed / 1000)),
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
    label: runtimeLabel(Math.ceil(remaining / 1000)),
  };
}

/** One minute. The clock face's resolution, and the coarse tier's. */
const MINUTE_MS = 60_000;

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
export function readingQuantum(fields: TimerFields, now: number, detailed: boolean): number {
  if (fields.mode === "clock") {
    // The minute of the epoch, which is the minute of the day anywhere with a
    // whole-minute offset from it — which is everywhere.
    return Number.isFinite(now) ? Math.floor(now / MINUTE_MS) : 0;
  }
  const step = detailed ? 1000 : MINUTE_MS;
  const elapsed = elapsedOf(fields, now);
  // Floored for a stopwatch and ceiled for a countdown, which is `timerReading`'s
  // split and has to stay it: a quantum that rounded the other way from the label
  // would move on the frame *beside* the one the digits change on.
  if (fields.mode === "stopwatch") return Math.floor(elapsed / step);
  return Math.ceil(Math.max(0, ms(fields.runsFor) - elapsed) / step);
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
export function timerFace(fields: TimerFields, now: number, detailed: boolean): TimerFace {
  const reading = timerReading(fields, now);
  const quantum = readingQuantum(fields, now, detailed);
  // A clock is already at minute resolution and a full-tier face is already at
  // the second, so in both of those the label `timerReading` built is the one to
  // print and nothing is rebuilt.
  if (detailed || reading.mode === "clock") return { ...reading, quantum };
  return { ...reading, quantum, label: runtimeLabel(quantum * 60) };
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
