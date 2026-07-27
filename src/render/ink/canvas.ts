/**
 * One item's ink canvas — the element, its size, and its eviction.
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
 * the paper, which reads as a mark stuck to the air. What happens to the part
 * that fell off — lost today, ink on whatever is underneath once board ink
 * exists — is T-137.
 *
 * Being inside the root also means being inside the item's `rotate()` and its
 * carry `scale()`, which is DESIGN section 6.2's whole claim: the ink follows a
 * move and a rotation with no maths at all, because the browser is already doing
 * that maths for the paper.
 */

import {
  clipToPaper,
  inkBounds,
  paintStrokes,
  paperBox,
  regionFor,
  type InkBox,
  type InkRegion,
} from "@/render/ink/dry";
import type { SceneStroke } from "@/state/scene";

/**
 * Reused across every item on the board: `inkBounds` fills it and `regionFor`
 * reads it, both within one synchronous call, so a second one would be an
 * allocation per inked item per re-raster for no gain.
 */
const box: InkBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

export class ItemInk {
  private readonly host: HTMLElement;
  /** Created on first ink and never before — "most items have no ink and
   *  therefore no canvas at all". */
  private el: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private region: InkRegion | null = null;
  /** The paper this canvas was last clipped to — its own, not shared, because
   *  it outlives the call. */
  private readonly paper: InkBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private boxW = 0;
  private boxH = 0;

  constructor(host: HTMLElement) {
    this.host = host;
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
   * Bring the bitmap in line with the strokes: create it, grow it, repaint it,
   * or drop it.
   *
   * Dropping is the erase and the undo-of-a-commit case, and it has to be here
   * rather than only in `release`: an item that stays mounted and loses its last
   * stroke would otherwise keep showing it.
   */
  update(strokes: readonly SceneStroke[], scale: number, w: number, h: number): void {
    // Remembered so that a resize re-rasters: the clip below is a function of
    // the item's size, and a note dragged wider has to give back the ink its old
    // edge was hiding. `render/items/dom.ts` asks with [`staleBox`].
    this.boxW = w;
    this.boxH = h;
    const paper = paperBox(w, h, this.paper);
    const inked = strokes.length === 0 ? null : inkBounds(strokes, box);
    // The overlap, not the ink: the pen stops at the edge of the paper (T-136),
    // so anything past it is neither drawn nor worth a pixel of backing store.
    const bounds = inked === null ? null : clipToPaper(inked, paper);
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
      // CSS box in item-local units, which are the units the item's node is
      // laid out in. The margins place the region's top-left corner relative to
      // the item's centre, which `.item-ink`'s `left: 50%; top: 50%` puts us at
      // — so nothing here has to know how big the item is, and a resize never
      // touches the ink.
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
    paintStrokes(this.ctx, strokes, region, paper);
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
    return this.el !== null && (w !== this.boxW || h !== this.boxH);
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
    canvas.className = "item-ink";
    // Last, so DOM order alone paints it over the photograph or the text. No
    // child of an item sets a `z-index`; only the item root does, for the
    // board's paint order.
    this.host.append(canvas);
    this.el = canvas;
    this.ctx = null;
    return canvas;
  }
}
