/**
 * The board's clock, as distinct from this machine's — T-404.
 *
 * One number and two conversions. `ahead` is how far this machine's wall clock
 * runs ahead of the base every peer measures against; `shared` and `local`
 * carry an instant between the two. That is the whole module, and its smallness
 * is the point: the fix for a timer that will not run on a second machine is
 * *where the instants are measured*, not what is done with them.
 *
 * ## What went wrong without it
 *
 * `runFrom` was `Date.now()` on the machine that pressed start, and
 * `elapsedOf` subtracted it from the *reading* machine's own clock. Two
 * machines whose clocks disagree therefore disagree about a running timer by
 * exactly the amount their clocks do — and not gently. `elapsedOf` clamps at
 * `max(0, now - runFrom)`, so a peer whose clock is behind does not read the
 * countdown slightly early, it reads it as **not started at all**, and the face
 * sits frozen on its opening digits until the skew has elapsed. A peer whose
 * clock is ahead begins part-way through, and past `runsFor` fires the expiry
 * the instant the start arrives.
 *
 * Measured, not reasoned: with one peer's clock put ninety seconds behind the
 * other's, a stopwatch started on the first read `0:15` while the second read
 * `0:00`, and a five-minute countdown read `4:45` against `5:00`. Both peers
 * held a byte-identical `runFrom` throughout. The document was never the
 * problem — D-74 has the runs.
 *
 * ## Why a base rather than a correction
 *
 * The tempting shape is to fix up `runFrom` on arrival — adjust the number in
 * the document to what this machine would have written. It is wrong twice: it
 * is a write per peer per timer for a thing nobody did, which is the write
 * storm DATA-MODEL section 8.1 refuses on read, and the corrected value is then
 * *another* peer's problem when it syncs. The instant in the document has to
 * mean one thing to everybody, so it is written in the shared base and read in
 * it, and each machine converts only its own `now` on the way in.
 *
 * The arithmetic in `lib/timer.ts` is untouched by this and must stay so. It
 * takes a `now`; this decides which `now` that is.
 *
 * ## The clock face is deliberately exempt
 *
 * A countdown and a stopwatch are *durations against an instant somebody else
 * may have written*, so both are measured in the shared base. A clock is not:
 * it shows what time it is here, on the same wall as the taskbar, and a wall
 * clock disagreeing with the machine it hangs on would be a second bug wearing
 * the first one's clothes. So `clockLabel` keeps the raw local reading, and the
 * two derived modes do not. That split is in `app/main.ts`, where both clocks
 * are read.
 *
 * ## No clock is read in here
 *
 * `shared` and `local` take their instant as an argument, like every other
 * derivation in this application and for the same reason: it is what makes the
 * whole thing testable as a table, and what keeps the promise in ARCHITECTURE
 * section 3 that nothing moves on its own.
 *
 * ## Where `ahead` comes from is not settled here
 *
 * Deliberately. Whoever learns the offset — a clock exchange the relay answers,
 * or a base elected among peers — hands it to [`SharedClock.learn`], and this
 * module never asks. Until something does, `ahead` is zero and every reading is
 * exactly what this build produced before: a board with no wire has nobody to
 * disagree with, and is right to trust its own clock completely.
 */

/**
 * The furthest two clocks may disagree before we stop believing the number.
 *
 * Twelve hours. Past that the likelier story is a machine set to the wrong day
 * or a timezone written into a wall clock by mistake, and correcting a timer by
 * half a day would take a countdown somebody is watching and either expire it
 * on the spot or park it out of reach. A skew this large is not a skew; it is a
 * broken clock, and the honest response to one is to go on showing what this
 * machine believes rather than to invent a confident correction from it.
 */
const MAX_SKEW_MS = 12 * 60 * 60 * 1000;

export class SharedClock {
  /**
   * How far this machine's wall clock runs ahead of the shared base, in
   * milliseconds. Negative when it runs behind.
   *
   * Zero until somebody teaches it otherwise, which is both the honest default
   * and the whole of the compatibility story: an unteachable board — no relay,
   * a stock `y-websocket` server that does not answer, a board with nobody else
   * on it — behaves exactly as this application did before T-404.
   */
  private skew = 0;

  /** How far this machine is ahead of the board, in milliseconds. Read by the
   *  HUD, which is the only readout that two peers disagree at all. */
  get ahead(): number {
    return this.skew;
  }

  /**
   * Take an offset from whoever measured one.
   *
   * Refused rather than clamped when it is not a believable number.
   * `Number.isFinite` covers the arithmetic that produced it going wrong — a
   * subtraction against a missing timestamp arrives here as `NaN`, and a `NaN`
   * skew would put `NaN` on every face on the board through one addition. A
   * clamp would be worse than a refusal here and not better: silently
   * substituting twelve hours for a nonsense reading is a confident answer
   * invented out of a broken one, where keeping the last good offset at least
   * remains a number somebody measured.
   *
   * Returns whether it was taken, so a caller that wants to say so can.
   */
  learn(ahead: number): boolean {
    if (!Number.isFinite(ahead) || Math.abs(ahead) > MAX_SKEW_MS) return false;
    this.skew = ahead;
    return true;
  }

  /** Back to trusting this machine — a board that has lost its wire, or one
   *  that never had one. */
  forget(): void {
    this.skew = 0;
  }

  /**
   * A local instant, in the base every peer measures against.
   *
   * A non-finite `local` passes straight through rather than becoming a
   * different kind of nonsense: `lib/timer.ts` already reads a `NaN` now as "no
   * reading" and shows the banked total, and turning it into `NaN - 90000`
   * would change nothing except which module the value was spoiled in.
   */
  shared(local: number): number {
    return Number.isFinite(local) ? local - this.skew : local;
  }

  /** The reverse, for anything that has to say a shared instant in this
   *  machine's own terms. */
  local(shared: number): number {
    return Number.isFinite(shared) ? shared + this.skew : shared;
  }
}
