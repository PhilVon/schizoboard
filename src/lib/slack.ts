/**
 * Splitting and merging the slack of a string, so the sag never jumps.
 *
 * > The critical detail: when the string splits at that point, **the slack
 * > must split proportionally** so the two new segments together sag exactly
 * > as the original did. Get this wrong and the string visibly jumps at the
 * > moment of insertion, which reads unmistakably as a bug.
 * > — DESIGN section 3.4
 *
 * That is AC-73, and it is the whole of this file. The headline gesture of the
 * application — grab a string in the middle and pull a new pin out of it — is
 * a gesture whose *only* visible failure mode is the string flinching at the
 * instant it succeeds.
 *
 * ## Why it is arithmetic rather than a special case
 *
 * Slack is a ratio against the chord, not a length (DATA-MODEL section 5.2),
 * and that is what makes this tractable:
 *
 * ```
 * restLength = chord * (1 + slackAfter)
 * ```
 *
 * A segment's *rest length* is the quantity that has to be conserved — it is
 * how much string there physically is between two pins, and inserting a pin
 * does not add or remove any. So the split converts to rest length, divides it
 * where the user grabbed, and converts each half back against its own new
 * chord. The ratios that come out are not the parent's ratio, and they are not
 * equal to each other; a pin pulled out to one side makes one chord long and
 * taut and the other short and slack, which is exactly what a real string
 * does.
 *
 * ## Units
 *
 * These are pure numbers in, pure numbers out — chords in board units, slack
 * as a ratio, `t` as an arc-length fraction. No scene, no document, no pins.
 * `lib/` is dependency-free (see `lib/seed.ts`), and this belongs here because
 * both the tool that previews a split and the op that writes it need the same
 * answer, and a second copy is a second chance to make the string flinch.
 */

/**
 * Invariant 2 — `slackAfter` is strictly greater than zero, clamped to a small
 * minimum (DATA-MODEL section 5.2, AC-74).
 *
 * > At rest length equal to the chord the solver has no slack to absorb error
 * > and the rope jitters visibly.
 *
 * Duplicated deliberately from `crdt/schema.ts`'s `MIN_SLACK` rather than
 * imported: `lib/` may not depend on `crdt/`, and this is the reason that rule
 * exists rather than an exception to it. The two are checked against each
 * other in `slack.test.ts`, so they cannot drift apart in silence.
 */
export const MIN_SLACK = 0.01;

/**
 * The slack a string gets when nobody has said otherwise, and the far end of
 * the taut toggle.
 *
 * > Typical range is 0.05 to 0.3. — DATA-MODEL section 5.2
 *
 * Near the bottom of that: a new string should read as a line drawn between
 * two things with a little weight in it, and the drape is something you add.
 *
 * Unlike `MIN_SLACK` above this is *not* duplicated from `crdt/`. It lives
 * here and `crdt/ops/strings.ts` imports it, because the two constants are
 * different kinds of thing. `MIN_SLACK` is a schema invariant, enforced by
 * `crdt/schema.ts`'s reader on every node that arrives from a peer, so its home
 * is the schema and this file mirrors it under test. This one is *policy* about
 * what an untouched string looks like — which the ops need in order to create
 * one and the select tool needs in order to snap one back to it (DESIGN section
 * 3.4's "snaps between taut and default slack"), and a tool may not import
 * `crdt/` at all.
 */
export const DEFAULT_SLACK = 0.12;

/**
 * The far end of the `1`-`9` ladder — "heavily draped" (DESIGN section 3.4).
 *
 * A rest length twice the chord: string that doubles back on itself and hangs
 * in a deep loop. D-16's seeding table already treats "100% slack" as the
 * extreme worth measuring, so this is the top of the range the solver has been
 * shown to hold rather than a number picked for looking big.
 */
export const MAX_PRESET_SLACK = 1;

/** Strictly positive, and never `NaN` — a slack that fails every comparison
 *  would reach a rest length, a particle position, and every peer. */
export function clamp(slack: number): number {
  return Number.isFinite(slack) && slack > MIN_SLACK ? slack : MIN_SLACK;
}

/**
 * The `1`-`9` presets.
 *
 * > | Slack presets | `1`-`9` with a string selected | Taut through to heavily
 * > draped | — DESIGN section 3.4
 *
 * **Geometric, not linear**, and that is the whole content of this function.
 * Slack is a ratio, so what the eye reads as one step of drape is a constant
 * *multiple* rather than a constant difference: linear steps from taut to a
 * doubled-back loop would put seven of the nine presets in territory nobody
 * calls anything but "very slack", and crowd the entire useful range — DATA-
 * MODEL's 0.05 to 0.3 — into the gap between `1` and `2`.
 *
 * Anchored at both ends rather than through the middle: `1` is exactly
 * `MIN_SLACK`, which is exactly what the taut toggle means by taut, and `9` is
 * `MAX_PRESET_SLACK`. What falls out is a `5` of almost exactly `DEFAULT_SLACK`
 * and a `4`-to-`7` that spans the typical range, neither of which was arranged.
 *
 * Anything outside `1`-`9` is clamped into it rather than extrapolated, so a
 * caller that hands this a key code it has not checked gets an end of the
 * ladder instead of a rope on the far side of the board.
 */
export function presetSlack(preset: number): number {
  if (!Number.isFinite(preset)) return DEFAULT_SLACK;
  const step = Math.min(8, Math.max(0, Math.round(preset) - 1)) / 8;
  return clamp(MIN_SLACK * (MAX_PRESET_SLACK / MIN_SLACK) ** step);
}

/**
 * What a double-click on a segment makes its slack.
 *
 * > | Toggle taut | Double-click a segment | Snaps between taut and default
 * > slack | — DESIGN section 3.4
 *
 * The test for "is it taut already" is deliberately loose. Taut is a place the
 * user can only arrive at through this toggle or preset `1`, both of which land
 * exactly on `MIN_SLACK` — but the wheel can leave a segment a hair above it,
 * and a double-click there that pulled it *tighter* by half a percent and
 * called that a toggle would read as the gesture having failed. Anything the
 * eye would call taut goes back to the default.
 *
 * The predicate is its own function rather than an inline comparison because
 * "what counts as taut" is a rule about the board and not about this toggle.
 * It had a second caller until T-148 took the pluck out — that one was offered
 * on a taut string and not on a draped one, and the two gestures had to agree
 * about the same segment. Anything that asks the question next should ask it
 * here for the same reason.
 */
export function isTaut(slack: number): boolean {
  return clamp(slack) <= MIN_SLACK * 2;
}

/** The toggle itself. Taut goes to the default; anything else goes taut. */
export function toggleTaut(slack: number): number {
  return isTaut(slack) ? DEFAULT_SLACK : MIN_SLACK;
}

/**
 * Split one segment's slack in two, at arc-length fraction `t`.
 *
 * `chord` is the distance between the two pins that were there; `first` and
 * `second` are the distances from each of them to the new pin. `t` is where
 * along the *string* the split happened — 0 at the near pin, 1 at the far one
 * — which is not the same as where along the chord, and it is the string the
 * user grabbed.
 *
 * The returned pair conserves rest length exactly: `first * (1 + a)` plus
 * `second * (1 + b)` equals `chord * (1 + slack)`, up to the clamp. That is
 * AC-73, and `slack.test.ts` asserts it directly rather than by proxy.
 *
 * The clamp is the one thing that can break the conservation, and it does so
 * in the only safe direction: a child that would have needed *negative* slack
 * — because the user pulled the new pin further out than the string can reach
 * — gets the minimum instead, which lengthens the string rather than making a
 * segment the solver cannot hold. DESIGN section 5.4 says exactly this about a
 * string pulled taut: "don't let the solver fight it".
 */
export function splitSlack(
  chord: number,
  slack: number,
  first: number,
  second: number,
  t: number,
): [number, number] {
  const rest = chord * (1 + clamp(slack));
  const at = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.5;
  // A degenerate chord carries no information about where the split fell, so
  // the fraction is all there is to go on.
  const a = first > 0 ? (rest * at) / first - 1 : Infinity;
  const b = second > 0 ? (rest * (1 - at)) / second - 1 : Infinity;
  return [clamp(a), clamp(b)];
}

/**
 * Merge two segments back into one when the pin between them goes.
 *
 * > the neighbouring segments merge, with rest lengths summed and converted
 * > back to a ratio against the new chord — DATA-MODEL section 5.3
 *
 * The exact inverse of the split, and deliberately written as its own function
 * rather than as `splitSlack` run backwards: removal is reached from three
 * places that insertion is not — a pin deleted, an item deleted taking its
 * pins with it, and a node dropped from a run — and none of them knows what
 * `t` was.
 */
export function mergeSlack(
  firstChord: number,
  firstSlack: number,
  secondChord: number,
  secondSlack: number,
  chord: number,
): number {
  const rest =
    firstChord * (1 + clamp(firstSlack)) + secondChord * (1 + clamp(secondSlack));
  return chord > 0 ? clamp(rest / chord - 1) : MIN_SLACK;
}
