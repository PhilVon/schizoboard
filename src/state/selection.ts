/**
 * What is selected.
 *
 * A set of item ids and a version counter, and deliberately nothing else. It
 * holds no geometry, no DOM, no tool state — the select tool decides *what*
 * goes in, the renderer reads *what is* in, and neither knows about the other.
 *
 * ## Why the version counter
 *
 * Selection chrome is written by walking every mounted view and toggling a
 * class. That is cheap but not free, and an idle board must cost nothing, so
 * the DOM phase compares this number against the one it last wrote — the same
 * trick `Camera.version` plays for the world transform. Mutating methods bump
 * it only when the set actually changed, so a click that re-selects the item
 * already selected costs one integer comparison a frame later.
 *
 * ## Not in the document
 *
 * Selection is per-person. It travels over awareness so collaborators can see
 * what you have hold of (DATA-MODEL section 9), and it is stashed alongside
 * undo entries so "undo takes me back to where I was" works (DESIGN section
 * 7.6) — but it is never written to the document.
 *
 * ## Three sets, not one
 *
 * Items, strings and pins are all selectable and they are kept apart. One set
 * with every kind of id in it would be shorter to write and wrong at every
 * point it was read: `Delete` would hand a string to the item delete, `prune`
 * would drop it for not being an item, and the overlay would look up a slot it
 * does not have. They are reached by different gestures and most verbs that
 * follow — delete, rotate, resize, slack, tuck — apply to one kind and not the
 * others. So each method below says which of the three it means.
 *
 * ## Why pins joined them
 *
 * Nothing selects a pin on its own; the pin branch of a press deliberately
 * leaves the selection where it found it. Pins are here for follow-the-thread
 * (DESIGN section 3.3), which selects "the entire connected component of pins,
 * strings and items" in one gesture — the one selection that is genuinely all
 * three kinds at once, and the reason `replaceThread` exists alongside the two
 * single-kind replacements.
 *
 * They earn their place by moving. DESIGN section 3.8: "free pins inside the
 * selection have their board coordinates transformed as leaves of the same
 * transform. Miss that and rotating a selection visibly shears the string web."
 * A thread you can select and cannot move is the gesture failing at its stated
 * purpose.
 */

export class Selection {
  /** Bumped whenever the membership changes, and only then. */
  version = 1;

  private readonly ids = new Set<string>();
  private readonly stringIds = new Set<string>();
  private readonly pinIds = new Set<string>();

  /** Items. A selected string is not one — see `strings`. */
  get size(): number {
    return this.ids.size;
  }

  get isEmpty(): boolean {
    return this.ids.size === 0;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Live view. Callers must not hold it across a mutation. */
  get members(): ReadonlySet<string> {
    return this.ids;
  }

  /** The selected strings, which are never also in `members`. */
  get strings(): ReadonlySet<string> {
    return this.stringIds;
  }

  hasString(id: string): boolean {
    return this.stringIds.has(id);
  }

  /** The selected pins, which are never also in `members` or `strings`. */
  get pins(): ReadonlySet<string> {
    return this.pinIds;
  }

  hasPin(id: string): boolean {
    return this.pinIds.has(id);
  }

  /**
   * True when nothing at all is selected — of any kind.
   *
   * `isEmpty` is deliberately not this: it means "no items", which is the
   * question every item verb asks, and widening it would quietly change what
   * `Delete` and the rotation handle do. This is the question the overlay asks,
   * which is whether there is any chrome to draw.
   */
  get isBare(): boolean {
    return this.ids.size === 0 && this.stringIds.size === 0 && this.pinIds.size === 0;
  }

  toArray(): string[] {
    return [...this.ids];
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.version++;
  }

  remove(id: string): void {
    if (this.ids.delete(id)) this.version++;
  }

  toggle(id: string): void {
    if (this.ids.has(id)) this.remove(id);
    else this.add(id);
  }

  /**
   * Replace the whole selection with these **items**, strings included in what
   * goes: this is what a click, a marquee and `Ctrl+A` all mean, and leaving a
   * string selected behind a click on a photograph would mean the next slack
   * nudge landed on something the user stopped pointing at.
   *
   * Silent if nothing changed — which is the common case while a marquee is
   * being dragged across empty cork.
   */
  replace(next: Iterable<string>): void {
    const set = asSet(next);
    if (this.stringIds.size === 0 && this.pinIds.size === 0 && same(this.ids, set)) return;
    this.stringIds.clear();
    this.pinIds.clear();
    this.ids.clear();
    for (const id of set) this.ids.add(id);
    this.version++;
  }

  /**
   * The mirror image: the whole selection becomes these strings.
   *
   * > A plain click without dragging selects the string instead.
   * > — DESIGN section 3.4
   */
  replaceStrings(next: Iterable<string>): void {
    const set = asSet(next);
    if (this.ids.size === 0 && this.pinIds.size === 0 && same(this.stringIds, set)) return;
    this.ids.clear();
    this.pinIds.clear();
    this.stringIds.clear();
    for (const id of set) this.stringIds.add(id);
    this.version++;
  }

  /**
   * All three at once — follow the thread.
   *
   * > Double-click | Selects the entire connected component of pins, strings
   * > and items — DESIGN section 3.3
   *
   * The one gesture that produces a selection of every kind at once, and the
   * reason this is a method rather than three calls: three separate
   * replacements would each wipe the previous one, and doing them in the right
   * order to avoid that would leave the version counter bumped three times for
   * one gesture — so the overlay would restroke twice for nothing and the
   * transitional states would be briefly, wrongly, on screen.
   */
  replaceThread(
    items: Iterable<string>,
    strings: Iterable<string>,
    pins: Iterable<string>,
  ): void {
    const nextItems = asSet(items);
    const nextStrings = asSet(strings);
    const nextPins = asSet(pins);
    if (
      same(this.ids, nextItems) &&
      same(this.stringIds, nextStrings) &&
      same(this.pinIds, nextPins)
    ) {
      return;
    }
    this.ids.clear();
    this.stringIds.clear();
    this.pinIds.clear();
    for (const id of nextItems) this.ids.add(id);
    for (const id of nextStrings) this.stringIds.add(id);
    for (const id of nextPins) this.pinIds.add(id);
    this.version++;
  }

  clear(): void {
    if (this.isBare) return;
    this.ids.clear();
    this.stringIds.clear();
    this.pinIds.clear();
    this.version++;
  }

  /**
   * Drop anything that is no longer on the board.
   *
   * Needed because a collaborator can delete an item you have selected, and a
   * selection holding a ghost would then delete "it" again on the next
   * `Delete` — an op that quietly does nothing, which is the confusing kind of
   * nothing.
   *
   * A string goes the same way, and by its own predicate: a string id is not an
   * item id and asking the item question about it would prune every selected
   * string on the first press.
   */
  prune(
    exists: (id: string) => boolean,
    stringExists?: (id: string) => boolean,
    pinExists?: (id: string) => boolean,
  ): void {
    for (const id of this.ids) if (!exists(id)) this.remove(id);
    if (stringExists) {
      for (const id of this.stringIds) {
        if (!stringExists(id) && this.stringIds.delete(id)) this.version++;
      }
    }
    if (!pinExists) return;
    for (const id of this.pinIds) {
      if (!pinExists(id) && this.pinIds.delete(id)) this.version++;
    }
  }
}

function asSet(next: Iterable<string>): ReadonlySet<string> {
  return next instanceof Set ? (next as ReadonlySet<string>) : new Set(next);
}

/** Whether a set already holds exactly these ids, which is what every replace
 *  asks before touching anything — a marquee dragged across empty cork asks it
 *  sixty times a second and must answer "unchanged" without a version bump. */
function same(current: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  if (current.size !== next.size) return false;
  for (const id of next) if (!current.has(id)) return false;
  return true;
}
