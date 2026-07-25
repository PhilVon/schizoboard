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
  /** Items whose ink canvas needs re-rastering. */
  readonly ink = new Set<string>();
  /** Ropes whose geometry changed. */
  readonly ropes = new Set<string>();

  /** The camera moved, so every screen-space layer must redraw. */
  camera = false;
  /** Something entered or left the viewport; culling must re-run. */
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
      this.ink.size === 0 &&
      this.ropes.size === 0
    );
  }

  item(id: string): void {
    this.items.add(id);
  }

  inkFor(id: string): void {
    this.ink.add(id);
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
    this.ink.clear();
    this.ropes.clear();
    this.camera = false;
    this.culling = false;
    this.all = false;
  }
}
