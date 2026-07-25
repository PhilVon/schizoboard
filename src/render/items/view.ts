/**
 * The renderer seam.
 *
 * > `render/items/` sits behind an interface specifically so the PixiJS
 * > escalation stays contained. — docs/DESIGN.md section 8.3
 *
 * The spike (D-12) says DOM holds, so the DOM implementation is the one that
 * ships. This interface exists anyway, and it is deliberately narrow: it
 * exposes no DOM node, no CSS, no element type. Everything outside this
 * directory can do exactly two things — hand it a scene and ask it to catch
 * up, or ask what is under a point. A Pixi implementation would satisfy the
 * same two methods.
 *
 * If it ever leaks an `HTMLElement`, the escalation stops being one directory.
 */

import type { DirtySets } from "@/state/dirty";
import type { Scene } from "@/state/scene";

export interface ItemLayer {
  /**
   * DOM phase (5). Bring the presentation in line with the scene, touching
   * only what the dirty sets name.
   *
   * `visible` is the culled set (T-27). Null means "everything", which is what
   * a board smaller than the culling threshold uses.
   */
  sync(scene: Scene, dirty: DirtySets, visible: ReadonlySet<string> | null): void;

  /** Topmost item at a board point, or null. Hit-testing never reads the DOM. */
  hitTest(scene: Scene, boardX: number, boardY: number): string | null;

  /** How many item presentations currently exist — for the dev HUD. */
  readonly mounted: number;

  destroy(): void;
}
