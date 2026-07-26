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

/** Strictly positive, and never `NaN` — a slack that fails every comparison
 *  would reach a rest length, a particle position, and every peer. */
export function clamp(slack: number): number {
  return Number.isFinite(slack) && slack > MIN_SLACK ? slack : MIN_SLACK;
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
