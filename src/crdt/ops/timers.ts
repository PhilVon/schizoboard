/**
 * Timer operations — the six writes in a timer's whole life.
 *
 * Set the mode, set the length, start it, pause it, reset it, and choose what it
 * lights. That is the complete list, and its shortness is the feature: D-73's
 * load-bearing rule is that **nothing is written to the document per second**.
 * What a face shows is derived per frame from these five plain values and a
 * `now` that is never stored (`lib/timer.ts`), so a running timer is a document
 * nobody is writing to.
 *
 * **Expiry writes nothing at all.** There is no op below for it and there must
 * never be one. An expired countdown stays expired by arithmetic, so there is no
 * fired flag for two peers to converge on, no race to set it, and no undo entry
 * for a thing nobody did.
 *
 * ## Absent is the default, on every one of the five
 *
 * `sourceAbout`'s convention in `items.ts`, applied five times: a key holding
 * the default on every timer ever made is a key nobody can read anything from,
 * and `readTimer` gives the same answer for an absent key and a written default.
 * So each op below *deletes* when it is told the default and writes otherwise.
 * A timer at rest is `{type, ...geometry}` and nothing else — which is also what
 * makes "put a clock up" cost no more on the wire than a blank note.
 *
 * ## Silent on an item that is not a timer
 *
 * Every op takes ids from a selection, and a selection is whatever the person
 * had highlighted — usually not five timers. Skipping is right rather than
 * throwing: starting a selection of two timers and a photograph should start the
 * two timers.
 */

import { mutate, noteSchemaNeeds, type BoardDoc } from "@/crdt/doc";
import { Origin } from "@/crdt/origins";
import { SCHEMA_VERSION, type YMap } from "@/crdt/schema";
import { type TimerMode } from "@/lib/timer";

/**
 * Put the settable fields on a brand-new timer, and seal the board behind it.
 *
 * **The one place a timer enters a document**, called by `createItems` and by
 * `pasteClip`, which are the only two things that write an item map. That is
 * deliberate rather than tidy: the version raise and the item have to be in one
 * transaction, and a second creation path that forgot the raise would put a
 * timer on a board that still claims to be readable by 1.0.2 — the exact silent
 * state D-73 spent a schema version abolishing.
 *
 * `noteSchemaNeeds` is a no-op once the board says 2, so the first timer raises
 * the version and the second puts nothing on the wire.
 *
 * The caller is already inside a transaction. This does not open one, because
 * opening a second would be the split.
 */
export function writeNewTimer(board: BoardDoc, item: YMap, input: TimerInput | undefined): void {
  if (input?.mode !== undefined && input.mode !== "clock") item.set("mode", input.mode);
  const length = input?.runsFor === undefined ? null : duration(input.runsFor);
  if (length !== null && length > 0) item.set("runsFor", length);
  if (typeof input?.lights === "string") item.set("lights", input.lights);
  noteSchemaNeeds(board, SCHEMA_VERSION);
}

/** The settable part of a new timer. Never `runFrom` or `banked` — see
 *  `CreateItemInput.timer`. */
export interface TimerInput {
  mode?: TimerMode;
  runsFor?: number;
  lights?: string | null;
}

/** The item's map, if it is a timer and it exists. Null otherwise, which is
 *  every skip in this file. */
function timerMap(board: BoardDoc, id: string): YMap | null {
  const map = board.items.get(id);
  if (map === undefined) return null;
  return map.get("type") === "timer" ? map : null;
}

/**
 * Write a value, or delete the key when it is the default.
 *
 * The one place the rule at the top of this file is implemented, so there is one
 * place to be wrong about it.
 */
function setOrClear(map: YMap, key: string, value: unknown, fallback: unknown): void {
  if (value === fallback) map.delete(key);
  else map.set(key, value);
}

/**
 * Invariant 1 — every number in the document is finite — is a property of these
 * ops and not of everybody who calls them, which is the T-155 note in
 * `items.ts`. A duration is additionally never negative: there is no such thing
 * as a countdown of minus a minute, and `max(0, runsFor - elapsed)` would read
 * one as already expired.
 */
function duration(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Which of the three this device is — the right-click strip's job (T-397).
 *
 * The *mode* is mutable and the *type* is not, which is the asymmetry D-73 spent
 * a schema version on: one device with a mode, not three objects.
 *
 * The clock left over from a countdown keeps its `runsFor`, deliberately. Coming
 * back to countdown should find the length you set, the way turning a real
 * travel clock's dial back does — and clearing it would be a second write to
 * destroy something nobody asked to lose.
 */
export function setTimerMode(board: BoardDoc, ids: readonly string[], mode: TimerMode): void {
  mutate(board, Origin.LOCAL_USER, () => {
    for (const id of ids) {
      const map = timerMap(board, id);
      if (map === null) continue;
      setOrClear(map, "mode", mode, "clock");
    }
  });
}

/** How long a countdown runs for, in milliseconds. Refused rather than clamped
 *  when it is not a duration — see `duration`. */
export function setTimerLength(board: BoardDoc, ids: readonly string[], runsFor: number): void {
  const length = duration(runsFor);
  if (length === null) return;
  mutate(board, Origin.LOCAL_USER, () => {
    for (const id of ids) {
      const map = timerMap(board, id);
      if (map === null) continue;
      setOrClear(map, "runsFor", length, 0);
    }
  });
}

/**
 * Start, or resume — one op, because they are one gesture and one document
 * change.
 *
 * `now` is threaded in rather than read here, so a caller can be tested and so
 * that one press starting three timers gives all three the same instant. It is
 * `Date.now()` on *this* machine and the subtraction happens on whichever
 * machine is reading, which is the clock skew D-73 accepts on `wear.ts`'s
 * precedent.
 *
 * **Already running is a no-op.** Writing `runFrom` again would silently discard
 * the run so far — the elapsed of a running timer is `banked + (now - runFrom)`,
 * so moving the start forward moves the reading backwards. A double press must
 * not rewind a stopwatch.
 */
export function startTimer(board: BoardDoc, ids: readonly string[], now: number): void {
  if (!Number.isFinite(now) || now <= 0) return;
  mutate(board, Origin.LOCAL_USER, () => {
    for (const id of ids) {
      const map = timerMap(board, id);
      if (map === null) continue;
      if (typeof map.get("runFrom") === "number") continue;
      map.set("runFrom", now);
    }
  });
}

/**
 * Stop the clock and keep what is on it.
 *
 * Two writes in one transaction and they are inseparable: the run is added to
 * `banked` and `runFrom` is cleared, because absence of `runFrom` *is* the
 * paused state. Either write alone loses or duplicates the run, and a peer that
 * saw only one of them would read a timer that had jumped.
 *
 * Not running is a no-op, so pausing a paused timer does not re-bank anything.
 */
export function pauseTimer(board: BoardDoc, ids: readonly string[], now: number): void {
  mutate(board, Origin.LOCAL_USER, () => {
    for (const id of ids) {
      const map = timerMap(board, id);
      if (map === null) continue;
      const from = map.get("runFrom");
      if (typeof from !== "number" || !Number.isFinite(from) || from <= 0) {
        // A start this build cannot believe — `readTimer` reads it as paused
        // already, so the honest thing is to make the document say what the face
        // says rather than bank a run off a nonsense instant.
        map.delete("runFrom");
        continue;
      }
      const banked = map.get("banked");
      const held = typeof banked === "number" && Number.isFinite(banked) && banked > 0 ? banked : 0;
      // The same clamp `elapsedOf` makes, for the same reason: a `runFrom` from
      // a peer whose clock is ahead must not bank a negative run.
      const run = Number.isFinite(now) ? Math.max(0, now - from) : 0;
      setOrClear(map, "banked", held + run, 0);
      map.delete("runFrom");
    }
  });
}

/**
 * Put it back to nothing — both duration fields gone, the mode and the length
 * kept.
 *
 * Resetting a countdown gives you the same countdown ready to run again, which
 * is what the button on a kitchen timer does. Resetting is not un-choosing.
 */
export function resetTimer(board: BoardDoc, ids: readonly string[]): void {
  mutate(board, Origin.LOCAL_USER, () => {
    for (const id of ids) {
      const map = timerMap(board, id);
      if (map === null) continue;
      map.delete("runFrom");
      map.delete("banked");
    }
  });
}

/**
 * What this timer lights amber when it goes off, or `null` for nothing.
 *
 * The pointer may dangle and is never repaired — DATA-MODEL section 8.1, and
 * `Flashes.raise` already guards on the scene holding the id, so a timer whose
 * target a peer deleted lights nothing rather than failing.
 *
 * A timer is not allowed to light *itself*. It is already the thing that went
 * off and is already saying so, and the amber is there to point somewhere else;
 * pointing it home would be a second announcement of the same fact in the one
 * place nobody needs it.
 */
export function setTimerLights(board: BoardDoc, id: string, target: string | null): void {
  mutate(board, Origin.LOCAL_USER, () => {
    const map = timerMap(board, id);
    if (map === null) return;
    setOrClear(map, "lights", target === id ? null : target, null);
  });
}
