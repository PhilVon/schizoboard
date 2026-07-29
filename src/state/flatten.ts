/**
 * Laying a note flat to be written on, and letting it back down.
 *
 * > Click into a note or a polaroid's caption area to edit. Type. Click away.
 * >
 * > **The note un-rotates to 0° while you edit** — animated over about 120 ms —
 * > and rotates back on blur. This is not a stylistic choice: caret placement,
 * > text selection and IME composition all misbehave inside a CSS-rotated
 * > element, across every engine. It also reads correctly as picking something
 * > up to write on it. — DESIGN section 3.6
 *
 * This owns the *motion*; `Scene.setFlatten` owns the geometry it produces and
 * `state/editor.ts` decides when it should happen. Stepped from phase 3, after
 * `sim/torsion.ts` — the translation that holds the pin still is computed from
 * the settled angle, and a note double-clicked while it is still swinging has
 * a settled angle that is different on every frame.
 *
 * ## Why a clock rather than `approach`
 *
 * The carry lift and the carry lag are exponential approaches with a settled
 * epsilon, because what they model is a thing catching up and there is no
 * moment it is *supposed* to arrive. This is the opposite: DESIGN gives it a
 * duration, and the editor needs to know when the paper is square and when it
 * is all the way back down — an exponential never gets there, so the answer
 * would be a threshold pretending to be an event.
 *
 * Reversing mid-flight runs the same clock backwards from wherever it got to,
 * so a note double-clicked and immediately clicked away does not jump.
 */

import type { DirtySets } from "@/state/dirty";
import type { Scene } from "@/state/scene";

/** DESIGN section 3.6: "animated over about 120 ms". */
export const FLATTEN_MS = 120;

/** Zero velocity at both ends, which is what stops it reading as a snap. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

export class Flatten {
  /** The item the paper motion applies to: still set while it eases back. */
  private subject: string | null = null;
  /** The item being written on, or null while it is being let down. */
  private target: string | null = null;
  /** Linear clock, 0 (as it hangs) to 1 (square to the screen). */
  private t = 0;

  /** The item being written on, or null. */
  get itemId(): string | null {
    return this.target;
  }

  /** True while the paper is still moving, in either direction. */
  get moving(): boolean {
    return this.subject !== null && (this.target === null ? this.t > 0 : this.t < 1);
  }

  /** True once the paper is all the way down and square to the screen. */
  get square(): boolean {
    return this.target !== null && this.t === 1;
  }

  /**
   * Start laying `itemId` flat.
   *
   * Switching straight from one note to another puts the first one back
   * instantly rather than easing it: there is one caret, the editor closes the
   * old note before it opens the new one, and a frame of overlap is not worth a
   * second clock.
   */
  open(itemId: string): void {
    if (this.subject !== itemId) {
      this.subject = itemId;
      this.t = 0;
    }
    this.target = itemId;
  }

  /** Let it back down. The subject survives until the clock reaches zero. */
  close(): void {
    this.target = null;
  }

  /** Nothing is being written on and nothing is moving. */
  get idle(): boolean {
    return this.subject === null;
  }

  step(scene: Scene, dirty: DirtySets, dtMs: number): void {
    const id = this.subject;
    if (id === null) return;

    const rising = this.target === id;
    const step = dtMs / FLATTEN_MS;
    this.t = rising ? Math.min(1, this.t + step) : Math.max(0, this.t - step);

    if (!rising && this.t === 0) {
      if (scene.setFlatten(null, 0)) dirty.item(id);
      this.subject = null;
      return;
    }

    // An item deleted underneath the editor — by a peer, or by an undo —
    // leaves nothing to lay flat. `Scene.removeItem` has already cleared its
    // side; this is the clock catching up.
    if (!scene.has(id)) {
      scene.setFlatten(null, 0);
      this.subject = null;
      this.target = null;
      this.t = 0;
      return;
    }

    if (scene.setFlatten(id, ease(this.t))) dirty.item(id);
  }
}
