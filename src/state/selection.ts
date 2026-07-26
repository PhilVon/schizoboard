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
 * ## Two sets, not one
 *
 * Items and strings are both selectable and they are kept apart. One set with
 * both kinds of id in it would be shorter to write and wrong at every point it
 * was read: `Delete` would hand a string to the item delete, `prune` would drop
 * it for not being an item, and the overlay would look up a slot it does not
 * have. They are reached by different gestures and every verb that follows —
 * delete, rotate, resize, slack, tuck — applies to one kind and not the other.
 * So each method below says which of the two it means.
 */

export class Selection {
  /** Bumped whenever the membership changes, and only then. */
  version = 1;

  private readonly ids = new Set<string>();
  private readonly stringIds = new Set<string>();

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
    const set = next instanceof Set ? (next as ReadonlySet<string>) : new Set(next);
    if (this.stringIds.size === 0 && set.size === this.ids.size) {
      let same = true;
      for (const id of set) {
        if (!this.ids.has(id)) {
          same = false;
          break;
        }
      }
      // Also the identity case: replacing the set with itself.
      if (same) return;
    }
    this.stringIds.clear();
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
    const set = next instanceof Set ? (next as ReadonlySet<string>) : new Set(next);
    if (this.ids.size === 0 && set.size === this.stringIds.size) {
      let same = true;
      for (const id of set) {
        if (!this.stringIds.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.ids.clear();
    this.stringIds.clear();
    for (const id of set) this.stringIds.add(id);
    this.version++;
  }

  clear(): void {
    if (this.ids.size === 0 && this.stringIds.size === 0) return;
    this.ids.clear();
    this.stringIds.clear();
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
  prune(exists: (id: string) => boolean, stringExists?: (id: string) => boolean): void {
    for (const id of this.ids) if (!exists(id)) this.remove(id);
    if (!stringExists) return;
    for (const id of this.stringIds) {
      if (!stringExists(id) && this.stringIds.delete(id)) this.version++;
    }
  }
}
