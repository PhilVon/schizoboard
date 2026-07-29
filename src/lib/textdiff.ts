/**
 * The smallest single edit that turns one string into another.
 *
 * Not a general diff, and deliberately not one. What this is for is a caret in
 * a text field: between two `input` events a person has typed a character,
 * deleted one, pasted a run, or replaced a selection — every one of which is a
 * single contiguous splice, and the common prefix and suffix find it exactly.
 * A general diff would find a *smaller* edit for something like `"aba"` to
 * `"aa"`, and finding it would be wrong: the two answers are indistinguishable
 * in the text and distinguishable in a `Y.Text`, where they decide which
 * character a concurrent edit ends up beside.
 *
 * `lib/` because both sides want it. `crdt/ops/items.ts` turns the splice into
 * a `Y.Text` delete-and-insert so a peer's concurrent typing merges instead of
 * being overwritten wholesale; `render/items/editor.ts` runs it the other way
 * to move the caret over a change that arrived from somebody else.
 */

/** A splice: remove `remove` characters at `at`, then insert `insert`. */
export interface TextEdit {
  readonly at: number;
  readonly remove: number;
  readonly insert: string;
}

/** Null when the strings are already equal — the common case, every frame. */
export function diffText(before: string, after: string): TextEdit | null {
  if (before === after) return null;

  const max = Math.min(before.length, after.length);
  let head = 0;
  while (head < max && before.charCodeAt(head) === after.charCodeAt(head)) head++;

  // The suffix may not reach back past the prefix, or a pure insertion of a
  // character that already sits either side of the caret would be counted twice.
  let tail = 0;
  const limit = max - head;
  while (
    tail < limit &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail++;
  }

  return {
    at: head,
    remove: before.length - head - tail,
    insert: after.slice(head, after.length - tail),
  };
}

/**
 * Where a caret at `caret` ends up after `edit` is applied.
 *
 * Three cases, and the third is the one worth stating: a caret *inside* the
 * removed run has nowhere of its own to go, so it collapses to the end of what
 * replaced it. That is what every text field does, and it is what stops a
 * remote edit that swallowed the word you were in from leaving the caret
 * stranded in the middle of somebody else's sentence.
 */
export function mapCaret(caret: number, edit: TextEdit): number {
  if (caret <= edit.at) return caret;
  if (caret >= edit.at + edit.remove) return caret + edit.insert.length - edit.remove;
  return edit.at + edit.insert.length;
}
