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
   * The scale board content is drawn at, `devicePixelRatio * zoom`, so the layer
   * can ask for a stored variant that suits the size rather than the source. The
   * one value here that cannot come through the scene: the scene knows board
   * units and has never heard of the camera.
   *
   * Selection chrome used to be the other one. It is not a layer concern at all
   * any more — `render/overlay.ts` strokes it in screen space, which is what
   * makes it the same width at 5% zoom as at 400% (T-91).
   */
  setRasterScale(scale: number): void;

  /**
   * INK phase (6). Re-raster the committed ink of the items that need it.
   *
   * Its own phase and its own method rather than part of `sync`, because the two
   * are woken by different things and cost differently: the DOM phase writes
   * transforms for everything that moved, and this fills bitmaps for the few
   * items that were drawn on. A board where somebody is dragging a photograph
   * runs `sync` every frame and this one never.
   *
   * Still no element crosses this interface. An ink canvas has to live inside
   * the item's rotated node — that is what makes ink follow a move and a
   * rotation for free (DESIGN section 6.2) — so the layer that owns the node
   * owns the canvas, and a Pixi implementation would satisfy this with a render
   * texture in the same place.
   */
  paintInk(scene: Scene, dirty: DirtySets): void;

  /** How many item presentations currently exist — for the dev HUD. */
  readonly mounted: number;

  /**
   * How many ink canvases exist right now, and how many device pixels they hold
   * between them — both for the dev HUD.
   *
   * `inked` is the one observable that shows off-screen eviction actually
   * happening: pan an inked item away and it falls. `inkPixels` is the memory
   * this task's power-of-two sizing can run up, made watchable rather than
   * argued about — the same move the document made with its byte count.
   */
  readonly inked: number;
  readonly inkPixels: number;

  destroy(): void;
}
