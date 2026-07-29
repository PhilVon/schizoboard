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

import type { AgeClock } from "@/render/items/wear";
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
   * Put a caret in an item's text, or take it out (DESIGN section 3.6).
   *
   * `text` is what is already on the paper; the layer reports what it becomes
   * through the hooks it was built with. Null closes whatever was open.
   *
   * On this side of the seam because a caret is presentation, and because the
   * alternative leaks an element: a caller that made its own field would have
   * to be handed a node to park it in, and the header above says what that
   * costs. A Pixi implementation satisfies this by overlaying a field of its
   * own — WebGL has no caret either, so the problem does not go away, it just
   * stops being everybody's.
   *
   * Idempotent. Opening the item that is already open does nothing, which is
   * what lets the DOM phase call it every frame.
   */
  edit(itemId: string | null, text: string): void;

  /** The item being written on, or null. */
  readonly editing: string | null;

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
   * How old the board considers each item to be, in board days (`wear.ts`).
   *
   * The second value the scene cannot supply, and for a reason of the same kind:
   * the scene knows when an item was written and has never heard of a *clock*.
   * Which one ageing runs on — wall-clock, days the board was opened, open time
   * accumulated — is a decision that belongs above the renderer, and so is DESIGN
   * 4.7's switch for turning ageing off, which is this seam being handed
   * `NO_AGEING`.
   *
   * Changing it does not repaint by itself. The caller raises a full dirty pass,
   * exactly as it would for any other change to everything at once.
   */
  setAgeClock(clock: AgeClock): void;

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
