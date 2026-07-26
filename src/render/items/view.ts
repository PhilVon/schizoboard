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
   * `visible` is the culled set — `render/cull.ts` owns it and hands over the
   * live object rather than a copy, so the layer must not retain or mutate it.
   * Null means "everything", which is what a caller with no culler wired in
   * gets. There is deliberately no size threshold below which culling is skipped:
   * a board small enough not to need it costs nothing to cull, and a threshold
   * would mean the culling path went untested on every board anyone develops on.
   */
  sync(scene: Scene, dirty: DirtySets, visible: ReadonlySet<string> | null): void;

  /** Topmost item at a board point, or null. Hit-testing never reads the DOM. */
  hitTest(scene: Scene, boardX: number, boardY: number): string | null;

  /**
   * Selection chrome. A set of ids and nothing else — no rectangle, no
   * handles, no element. Selection is per-person and lives outside the
   * document, so unlike every other value the layer renders it cannot arrive
   * through the scene.
   */
  setSelected(ids: ReadonlySet<string>): void;

  /** How many item presentations currently exist — for the dev HUD. */
  readonly mounted: number;

  destroy(): void;
}
