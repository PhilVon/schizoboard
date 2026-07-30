/**
 * An ink canvas — the element, its size, and its eviction. One per inked item,
 * and one per inked board tile.
 *
 * > Ink canvases are sized to the ink, not the item, and most items have none.
 * > Off-screen canvases are evicted — strokes are the truth and canvases are a
 * > cache, so returning to an item just re-rasters. — DESIGN section 9.3
 *
 * Everything here follows from that last clause. This object owns a bitmap and
 * nothing else: there is no state in it that could not be rebuilt from
 * `scene.strokesOf`, which is what makes throwing it away at the edge of the
 * viewport a cheap thing to do rather than a decision.
 *
 * The arithmetic is `render/ink/dry.ts`. This is the DOM half, and it is
 * separate for a reason that is not tidiness: happy-dom gives a real
 * `HTMLCanvasElement` with real `width`, `height` and `style` but returns `null`
 * from `getContext("2d")`, so sizing and eviction are testable and painting is
 * not. Splitting them on that line is what puts the region maths — the part that
 * can be wrong by a rounding error and still look right — under test.
 *
 * ## It is a child of the item's *root*
 *
 * Not of `.pol-window` or `.paper-surface`: both are `overflow: hidden` and both
 * are *smaller than the item*. A polaroid's white border is part of the card and
 * is a perfectly good thing to write on, and clipping to the photograph's window
 * would swallow a caption scrawled underneath it.
 *
 * The item's own edge is a different matter, and the pen does stop there: the
 * canvas is sized to the overlap of the ink and the paper, and `paintStrokes`
 * clips to the paper as well (T-136). A stroke that runs off the side of a
 * photograph used to be drawn in full, hanging over the cork and travelling with
 * the paper, which reads as a mark stuck to the air.
 *
 * The clip is now belt as well as braces: the marker breaks a stroke at the edge
 * and gives the part past it to the surface underneath (T-137), so a record on
 * this item should not reach outside this item's paper in the first place. It
 * still can — a resize moves the edge under ink that was inside it when it was
 * drawn — which is exactly the case the clip is here for.
 *
 * Being inside the root also means being inside the item's `rotate()` and its
 * carry `scale()`, which is DESIGN section 6.2's whole claim: the ink follows a
 * move and a rotation with no maths at all, because the browser is already doing
 * that maths for the paper.
 *
 * ## The tile is the same object with no paper (T-61)
 *
 * Board ink hangs off `render/ink/board.ts` instead, one canvas per 2048-unit
 * tile, inside the board-ink layer's camera transform rather than an item's
 * node. Everything below is shared and only two things differ: the host, and
 * that a tile passes `null` for the paper — the cork has no edge for a pen to
 * stop at, and a tile is a bucket rather than a frame.
 *
 * That is why the machinery is [`InkCanvas`] and [`ItemInk`] is a shell over it
 * holding the one thing the cork does not have: a `w`/`h` that a resize can
 * change out from under the bitmap.
 */

import type { InkSample } from "@/lib/ink";
import {
  clipToPaper,
  clipToSheet,
  COMPOSITE,
  inkBounds,
  paintStrokes,
  paperBox,
  regionFor,
  type InkBox,
  type InkRegion,
  type SheetOutline,
} from "@/render/ink/dry";
import { outlineStroke, strokeOptions, traceOutline } from "@/render/ink/geometry";
import type { SceneStroke } from "@/state/scene";

/**
 * Reused across every item on the board: `inkBounds` fills it and `regionFor`
 * reads it, both within one synchronous call, so a second one would be an
 * allocation per inked item per re-raster for no gain.
 */
const box: InkBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

export class InkCanvas {
  private readonly host: HTMLElement;
  private readonly className: string;
  /** Created on first ink and never before — "most items have no ink and
   *  therefore no canvas at all". */
  private el: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private region: InkRegion | null = null;

  constructor(host: HTMLElement, className: string) {
    this.host = host;
    this.className = className;
  }

  /** Is there a bitmap right now? The dev HUD counts these, and it is the one
   *  observable that shows eviction actually happening. */
  get live(): boolean {
    return this.el !== null;
  }

  /** Device pixels currently held, for the same HUD — the memory risk made
   *  watchable rather than argued about. */
  get pixels(): number {
    return this.region === null ? 0 : this.region.px * this.region.py;
  }

  /**
   * EXPORT. Where this bitmap sits in its host's own units, or null when there
   * is no bitmap (T-206).
   *
   * The same four numbers `update` writes as the CSS box, handed out rather
   * than recomputed — an export that derived them again could derive them
   * differently, and ink half a unit out of place is the sort of thing nobody
   * sees and everybody feels.
   *
   * **In the host's units, not the board's.** The stylesheet decides where a
   * canvas's origin is — `.board-ink` puts it at the board origin and
   * `.item-ink` at the item's centre — so turning this into a board coordinate
   * is the caller's job, and only the caller knows which of the two it is.
   */
  get placed(): InkPlacement | null {
    const region = this.region;
    if (this.el === null || region === null) return null;
    return {
      canvas: this.el,
      x: region.ox,
      y: region.oy,
      w: region.px / region.scale,
      h: region.py / region.scale,
    };
  }

  /**
   * Bring the bitmap in line with the strokes: create it, grow it, repaint it,
   * or drop it.
   *
   * Dropping is the erase and the undo-of-a-commit case, and it has to be here
   * rather than only in `release`: a surface that stays mounted and loses its
   * last stroke would otherwise keep showing it.
   *
   * `paper` is the surface the pen stops at, or null for a surface with no edge
   * — see the note at the top of the file and `paintStrokes`.
   */
  update(
    strokes: readonly SceneStroke[],
    scale: number,
    paper: InkBox | null,
    edge: SheetOutline | null = null,
  ): void {
    const inked = strokes.length === 0 ? null : inkBounds(strokes, box);
    // The overlap, not the ink: the pen stops at the edge of the paper (T-136),
    // so anything past it is neither drawn nor worth a pixel of backing store.
    const bounds = inked === null || paper === null ? inked : clipToPaper(inked, paper);
    if (bounds === null) {
      this.release();
      return;
    }

    const region = regionFor(bounds, scale, this.region);
    const canvas = this.el ?? this.create();
    // Identity, not equality — see `regionFor`. Writing `width` clears the
    // backing store even when the value is unchanged, so doing it every repaint
    // would clear twice and re-upload a texture for nothing.
    if (region !== this.region) {
      this.region = region;
      canvas.width = region.px;
      canvas.height = region.py;
      // CSS box in the host's own units — item-local for an item, board units
      // for a tile, and the two are the same scale. The margins place the
      // region's top-left corner relative to wherever the stylesheet has put
      // this canvas's origin: `.item-ink`'s `left: 50%; top: 50%` is the item's
      // centre, `.board-ink`'s `left: 0; top: 0` is the board origin. So nothing
      // here has to know how big the item is, and a resize never touches the ink.
      canvas.style.width = `${region.px / region.scale}px`;
      canvas.style.height = `${region.py / region.scale}px`;
      canvas.style.marginLeft = `${region.ox}px`;
      canvas.style.marginTop = `${region.oy}px`;
    }

    // Not an error, and not a throw: happy-dom has no 2D context, and a real
    // browser out of GPU memory returns null too. The element is sized and
    // placed either way; phase 6 is not a place to raise.
    if (this.ctx === null) this.ctx = canvas.getContext("2d");
    if (this.ctx === null) return;
    paintStrokes(this.ctx, strokes, region, paper, edge);
  }

  /**
   * The live smudge, rubbed straight into this bitmap.
   *
   * The one place on this board where the wet path writes to the dry surface,
   * and it is not a shortcut — it is the only truthful option. A smudge is
   * `destination-out`, and `destination-out` on the wet overlay would punch a
   * hole in the *chrome* (cursors, ghosts, selection) and do nothing whatever to
   * the ink, which is on this canvas. So the choice was between showing a
   * pale ghost of where you are rubbing, showing nothing until pen-up, and
   * rubbing the real thing. This is the third.
   *
   * It costs nothing to be wrong about, because the bitmap is a cache: every
   * repaint rebuilds it from the records, so the worst a stray rub can do is
   * survive until the next re-raster. Which is also why it must be called on
   * **every** frame of the gesture rather than once — a re-raster for any other
   * reason wipes the hole, and the next frame draws it again.
   *
   * False when there is no bitmap to rub, which is a surface with no ink on it:
   * nothing to erase, and nothing to show for trying.
   */
  rub(
    samples: readonly InkSample[],
    size: number,
    paper: InkBox | null,
    edge: SheetOutline | null = null,
  ): boolean {
    const region = this.region;
    if (this.ctx === null || region === null || samples.length === 0) return false;
    const outline = outlineStroke(samples, strokeOptions("erase", size, false));
    const path = new Path2D();
    if (!traceOutline(outline, path)) return false;

    // The region's transform explicitly rather than whatever the last paint left
    // behind: this can run on a frame where nothing repainted at all.
    this.ctx.setTransform(
      region.scale,
      0,
      0,
      region.scale,
      -region.ox * region.scale,
      -region.oy * region.scale,
    );
    this.ctx.save();
    if (paper !== null) {
      this.ctx.beginPath();
      clipToSheet(this.ctx, paper, edge);
      this.ctx.clip();
    }
    this.ctx.globalCompositeOperation = COMPOSITE.erase;
    this.ctx.fill(path);
    this.ctx.restore();
    return true;
  }

  /**
   * Evict.
   *
   * Called when the node is being recycled, and the three ways that happens —
   * culled out of the viewport, deleted, swapped to the other archetype — all
   * want the same answer, because the canvas is a cache and the strokes are the
   * truth. Not being able to tell them apart is a property of the pooling, and
   * here it costs nothing.
   *
   * `width = 0` before dropping the reference, so the backing store goes now
   * rather than whenever the collector gets round to it. Without it the HUD's
   * count would fall while the memory did not, which is a lie told by the one
   * number that exists to measure this.
   */
  release(): void {
    const canvas = this.el;
    if (canvas === null) return;
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
    this.el = null;
    this.ctx = null;
    this.region = null;
  }

  private create(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.className = this.className;
    // Last, so DOM order alone paints it over the photograph or the text. No
    // child of an item sets a `z-index`; only the item root does, for the
    // board's paint order.
    this.host.append(canvas);
    this.el = canvas;
    this.ctx = null;
    return canvas;
  }
}

/**
 * One item's ink canvas: an [`InkCanvas`] plus the paper it is clipped to.
 *
 * The whole of what an item adds is a size that can change under the bitmap. A
 * tile cannot be resized — the cork is not a thing you drag an edge of — so
 * [`staleBox`] and the paper box live here rather than in the shared machinery.
 */
export class ItemInk {
  private readonly canvas: InkCanvas;
  /** The paper this canvas was last clipped to — its own, not shared, because
   *  it outlives the call. */
  private readonly paper: InkBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private boxW = 0;
  private boxH = 0;
  /**
   * The silhouette the last raster was clipped to, so the rubber stops exactly
   * where the ink it is taking away stops (T-186).
   *
   * Held rather than re-asked: `rub` runs on a pointer that is down and has no
   * scene to ask, and a rubber clipped to a different polygon from the ink
   * would leave a rind of mark it could not reach.
   */
  private edge: SheetOutline | null = null;

  constructor(host: HTMLElement) {
    this.canvas = new InkCanvas(host, "item-ink");
  }

  get live(): boolean {
    return this.canvas.live;
  }

  get pixels(): number {
    return this.canvas.pixels;
  }

  update(
    strokes: readonly SceneStroke[],
    scale: number,
    w: number,
    h: number,
    edge: SheetOutline | null = null,
  ): void {
    // Remembered so that a resize re-rasters: the clip is a function of the
    // item's size, and a note dragged wider has to give back the ink its old
    // edge was hiding. `render/items/dom.ts` asks with [`staleBox`].
    this.boxW = w;
    this.boxH = h;
    this.edge = edge;
    this.canvas.update(strokes, scale, paperBox(w, h, this.paper), edge);
  }

  /** The live smudge, clipped to this item's paper — the pen stops at the edge
   *  (T-136) and so does the rubber. */
  rub(samples: readonly InkSample[], size: number): boolean {
    // The outline the last raster used, so the rubber stops exactly where the
    // ink it is taking away stops.
    return this.canvas.rub(samples, size, paperBox(this.boxW, this.boxH, this.paper), this.edge);
  }

  /**
   * Is the bitmap clipped to a size the item no longer is?
   *
   * Asked of every mounted, inked item that changed this frame, which is few:
   * ink is rare and a change to an inked item is rarer. A drag answers false —
   * it moves the paper without resizing it — which is what keeps the INK phase
   * asleep while a photograph is being carried.
   */
  staleBox(w: number, h: number): boolean {
    return this.canvas.live && (w !== this.boxW || h !== this.boxH);
  }

  release(): void {
    this.canvas.release();
  }
}

/** A live ink bitmap and the box it occupies in its host's units. */
export interface InkPlacement {
  readonly canvas: HTMLCanvasElement;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
