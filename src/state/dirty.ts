/**
 * What changed since the last frame.
 *
 * The frame loop's write phase touches only what is in here (ARCHITECTURE
 * section 3, phase 5: "write transforms for dirty items only"). An idle board
 * therefore costs a handful of empty-set checks, which is the entire reason a
 * board at rest is free.
 *
 * Sets are keyed by document id rather than by scene slot. Slots are reused
 * when an item is deleted, so a stale slot number in a dirty set would
 * silently redraw whichever item inherited it.
 */

export class DirtySets {
  /** Items whose transform needs writing. */
  readonly items = new Set<string>();
  /**
   * Pins whose position, kind or colour changed.
   *
   * Separate from `items` because a pin is not an item and most pin movement
   * is not its own: a parented pin moves when its item does, and the item is
   * what is dirty then. This set is for the rest — a free pin dragged across
   * bare cork, a pin re-coloured, a pin created — none of which touches an
   * item at all, and every one of which the pin layer has to redraw.
   */
  readonly pins = new Set<string>();
  /** Items whose ink canvas needs re-rastering. */
  readonly ink = new Set<string>();
  /**
   * Strings whose *topology or style* changed — a run edited, a slack
   * adjusted, a colour picked, a string cut.
   *
   * Deliberately not `ropes`, which is the same distinction as `pins` against
   * `items`: this set is written by the binding and read by `sim/ropes.ts`,
   * which rebuilds the segments; `ropes` below is written by `sim/ropes.ts`
   * and read by the renderer. One is "the document says this string is
   * different now", the other is "this rope has moved". A string being
   * dragged around the board produces the second every frame and the first
   * never, and a rope set that rebuilt itself on every frame of a drag would
   * re-seed the pose it was in the middle of simulating.
   */
  readonly strings = new Set<string>();
  /** Ropes whose geometry changed. */
  readonly ropes = new Set<string>();

  /** The camera moved, so every screen-space layer must redraw. */
  camera = false;
  /**
   * Re-run culling even though neither the camera nor any item moved.
   *
   * A force flag, not a report: `render/cull.ts` re-culls on its own whenever
   * the camera or an item is dirty, and this is for the cases where something
   * else changed the answer. `everything()` sets it; nothing else needs to yet.
   */
  culling = false;
  /**
   * Coarse escape hatch: rebuild everything next frame. Set on document load
   * and on undo, where working out the precise delta costs more than redrawing.
   */
  all = false;

  get isClean(): boolean {
    return (
      !this.all &&
      !this.camera &&
      !this.culling &&
      this.items.size === 0 &&
      this.pins.size === 0 &&
      this.ink.size === 0 &&
      this.strings.size === 0 &&
      this.ropes.size === 0
    );
  }

  item(id: string): void {
    this.items.add(id);
  }

  pin(id: string): void {
    this.pins.add(id);
  }

  inkFor(id: string): void {
    this.ink.add(id);
  }

  string(id: string): void {
    this.strings.add(id);
  }

  rope(id: string): void {
    this.ropes.add(id);
  }

  everything(): void {
    this.all = true;
    this.camera = true;
    this.culling = true;
  }

  /** Called at the end of the frame, after the write phases have consumed it. */
  clear(): void {
    this.items.clear();
    this.pins.clear();
    this.ink.clear();
    this.strings.clear();
    this.ropes.clear();
    this.camera = false;
    this.culling = false;
    this.all = false;
  }
}
