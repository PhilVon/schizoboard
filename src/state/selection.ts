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
 */

export class Selection {
  /** Bumped whenever the membership changes, and only then. */
  version = 1;

  private readonly ids = new Set<string>();

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

  /** Replace the whole set. Silent if the membership is unchanged — which is
   *  the common case while a marquee is being dragged across empty cork. */
  replace(next: Iterable<string>): void {
    const set = next instanceof Set ? (next as ReadonlySet<string>) : new Set(next);
    if (set.size === this.ids.size) {
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
    this.ids.clear();
    for (const id of set) this.ids.add(id);
    this.version++;
  }

  clear(): void {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.version++;
  }

  /**
   * Drop anything that is no longer on the board.
   *
   * Needed because a collaborator can delete an item you have selected, and a
   * selection holding a ghost would then delete "it" again on the next
   * `Delete` — an op that quietly does nothing, which is the confusing kind of
   * nothing.
   */
  prune(exists: (id: string) => boolean): void {
    for (const id of this.ids) if (!exists(id)) this.remove(id);
  }
}
