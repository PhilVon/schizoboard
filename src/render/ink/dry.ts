/**
 * Dry ink — the committed strokes, and the region of an item they need.
 *
 * > Each item has its own canvas, sized to the item's **ink bounding box**
 * > rather than the item, growing in power-of-two steps. Most items have no ink
 * > and therefore no canvas at all. — DESIGN section 6.5
 *
 * The other half of `render/ink/wet.ts`, and the shapes of the two are opposite
 * in the way the split intends. Wet ink is one stroke, in screen space, redrawn
 * every frame while a pointer is down. Dry ink is every stroke, in the item's
 * own space, redrawn only when something changed — and because the canvas is a
 * child of the item's rotated node, "the item moved" is not one of the things
 * that can change it. That is DESIGN section 6.2's "ink follows the item through
 * every move and rotation with no maths at all", and this file is where the
 * absence of that maths lives.
 *
 * No DOM here. The canvas element, its lifetime and its eviction are
 * `render/ink/canvas.ts`; this is the arithmetic and the fill, which is what
 * makes the interesting half testable without a browser that can rasterise.
 */

import { outlineStroke, strokeOptions, strokeReach, traceOutline } from "@/render/ink/geometry";
import type { InkTool } from "@/lib/ink";
import type { SceneStroke } from "@/state/scene";

/** A box in an item's local space. Mutable: the callers keep one and refill it,
 *  because this is asked per inked item per re-raster. */
export interface InkBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The area of item-local space a canvas covers, and how many device pixels it
 * spends on it.
 *
 * The backing store is a power of two per axis and the ink is drawn at exactly
 * `scale` — never stretched to fit the box. That is the way round it has to be:
 * sizing the *CSS* box to the ink and the backing store to the next power of two
 * would make the effective resolution change every time the box grew by a unit,
 * so every new stroke would visibly re-sample the ones already there, and the
 * power-of-two step would buy nothing. This way the extra pixels are slack at
 * the edges — which is what makes the growth free until it is not.
 */
export interface InkRegion {
  /** Top-left corner in item-local units. */
  readonly ox: number;
  readonly oy: number;
  /** Backing store, device pixels. Powers of two. */
  readonly px: number;
  readonly py: number;
  /** Device pixels per item-local unit — `devicePixelRatio * zoom`. */
  readonly scale: number;
}

/**
 * The ceiling on one axis of a backing store.
 *
 * A stroke three hundred units across at four times zoom on a 2x display asks
 * for 2400 device pixels, which rounds up to 4096 — 67 MB for one item. Past
 * this the region gives up resolution rather than area: soft ink beats missing
 * ink, and it is the same bounded, safe-direction degradation `render/cull.ts`
 * makes with `MAX_CELLS_PER_ITEM`. It is also the backstop against a peer whose
 * stroke claims a bounding box the size of a country.
 */
export const MAX_INK_PX = 4096;

/**
 * The box round an item's ink, each stroke padded by **its own** nib.
 *
 * Per stroke rather than one pad for the lot, because the two tools are very
 * different widths: a 20-unit highlighter beside a 6-unit marker would otherwise
 * push the marker's edge of the canvas out by fourteen units of nothing, on
 * every axis, forever — the region is grow-only.
 *
 * Null when there is no ink, which is the answer for most items.
 */
export function inkBounds(strokes: readonly SceneStroke[], out: InkBox): InkBox | null {
  let found = false;
  out.minX = Infinity;
  out.minY = Infinity;
  out.maxX = -Infinity;
  out.maxY = -Infinity;

  for (const stroke of strokes) {
    if (stroke.samples.length === 0) continue;
    const pad = strokeReach(toolOf(stroke), stroke.size);
    const [x0, y0, x1, y1] = stroke.bbox;
    if (x0 - pad < out.minX) out.minX = x0 - pad;
    if (y0 - pad < out.minY) out.minY = y0 - pad;
    if (x1 + pad > out.maxX) out.maxX = x1 + pad;
    if (y1 + pad > out.maxY) out.maxY = y1 + pad;
    found = true;
  }

  return found ? out : null;
}

/**
 * The region a canvas needs to cover `box` at `scale`.
 *
 * **Returns `previous` by identity** when the one it already has still covers
 * the box at the same scale. That is the whole calling convention: `===` at the
 * call site is what tells `render/ink/canvas.ts` whether it has to write
 * `canvas.width` — and writing that clears the backing store even when the value
 * is unchanged, so a repaint that did it anyway would clear twice and re-upload
 * a texture for nothing.
 *
 * Grow-only while the region survives. A stroke added at the far corner of a
 * photograph and then erased leaves the canvas the size it grew to, and that is
 * deliberate: shrinking would re-sample every remaining stroke to save memory
 * that eviction will reclaim anyway the moment the item leaves the viewport.
 *
 * The origin is snapped **down** to a whole device pixel. Without it a region
 * that grows by half a pixel re-rasters every stroke at a new subpixel phase,
 * and the whole mark shimmers by a fraction of a pixel for a change at its far
 * edge.
 */
export function regionFor(
  box: InkBox,
  scale: number,
  previous: InkRegion | null,
): InkRegion {
  if (
    previous !== null &&
    previous.scale === scale &&
    box.minX >= previous.ox &&
    box.minY >= previous.oy &&
    box.maxX <= previous.ox + previous.px / scale &&
    box.maxY <= previous.oy + previous.py / scale
  ) {
    return previous;
  }

  // Union with what is already covered, so growth never drops ink that is
  // already on the canvas off the far side.
  const minX = previous !== null && previous.scale === scale ? Math.min(box.minX, previous.ox) : box.minX;
  const minY = previous !== null && previous.scale === scale ? Math.min(box.minY, previous.oy) : box.minY;
  const maxX =
    previous !== null && previous.scale === scale
      ? Math.max(box.maxX, previous.ox + previous.px / scale)
      : box.maxX;
  const maxY =
    previous !== null && previous.scale === scale
      ? Math.max(box.maxY, previous.oy + previous.py / scale)
      : box.maxY;

  const ox = Math.floor(minX * scale) / scale;
  const oy = Math.floor(minY * scale) / scale;
  const px = pow2(Math.ceil((maxX - ox) * scale));
  const py = pow2(Math.ceil((maxY - oy) * scale));

  const over = Math.max(px, py) / MAX_INK_PX;
  if (over <= 1) return { ox, oy, px, py, scale };

  // Out of pixels: keep the area, drop the resolution. Both axes by the same
  // factor, so the ink stays the shape it was drawn.
  const soft = scale / over;
  return {
    ox: Math.floor(minX * soft) / soft,
    oy: Math.floor(minY * soft) / soft,
    px: Math.min(px, MAX_INK_PX),
    py: Math.min(py, MAX_INK_PX),
    scale: soft,
  };
}

/**
 * Clear the canvas and lay every stroke down again, in paint order.
 *
 * A full repaint rather than drawing the newly-committed stroke on top of what
 * is there. Incremental is tempting and buys a correctness special case for
 * every other edit: an erase and an undo both *remove* a stroke from the middle
 * of the stack, and there is no way to un-draw one from a flattened bitmap. Ink
 * is never rasterised and flattened (DATA-MODEL section 6.2) — the strokes are
 * the truth and this is a cache of them, so the cache is rebuilt whole.
 *
 * `last: true` to `strokeOptions`, which is the one substantive difference from
 * `render/ink/wet.ts`. A committed stroke is finished, so the tail finally gets
 * the end cap and the taper the wet path could not commit to while more samples
 * were still arriving.
 *
 * Returns false when nothing was drawn.
 */
export function paintStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: readonly SceneStroke[],
  region: InkRegion,
  paper: InkBox,
): boolean {
  // Identity for the clear, because the transform below is in item-local units
  // and the backing store is in device pixels.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, region.px, region.py);
  ctx.setTransform(
    region.scale,
    0,
    0,
    region.scale,
    -region.ox * region.scale,
    -region.oy * region.scale,
  );

  // The paper, and the pen stops at the edge of it (T-136). A mark that ran off
  // the side of a photograph used to be drawn in full, hanging over the cork and
  // travelling with the paper — which reads as a mark stuck to the air rather
  // than to anything.
  //
  // Clipped here as well as by sizing the canvas to the overlap in
  // `render/ink/canvas.ts`, and the two are not the same guard: the region is
  // grow-only, so a canvas that was once bigger than the paper it belongs to
  // still covers cork after a resize, and the clip is what stops ink from being
  // drawn there.
  ctx.save();
  ctx.beginPath();
  ctx.rect(paper.minX, paper.minY, paper.maxX - paper.minX, paper.maxY - paper.minY);
  ctx.clip();

  let drew = false;
  for (const stroke of strokes) {
    if (stroke.samples.length === 0) continue;
    const outline = outlineStroke(
      stroke.samples,
      // No zoom multiplier here, unlike the wet path: these samples are already
      // in the space the context is scaled to, so the width is the stored one.
      strokeOptions(toolOf(stroke), stroke.size, true),
    );
    const path = new Path2D();
    if (!traceOutline(outline, path)) continue;

    ctx.save();
    ctx.globalAlpha = stroke.opacity;
    ctx.fillStyle = stroke.color;
    // > highlighter uses near-zero thinning, a flat cap and `multiply`
    // > composition — DESIGN section 6.5
    //
    // One fill, and that is what makes a stroke composite "as a unit": a
    // self-crossing stroke is a single outline polygon filled once under the
    // non-zero winding rule, so the crossing is inside the same region as the
    // rest of it and is composited exactly once. Drawing the outline in pieces —
    // or filling it twice for any reason — is what would darken it, which is the
    // failure DESIGN section 6.5 names and AC-23 tests.
    //
    // Against the strokes already on this canvas, not against the photograph
    // underneath: the canvas element composites over the paper normally. So two
    // *different* highlighter passes deepen where they cross, which is what a
    // highlighter does, and one pass over a dark photograph tints rather than
    // fogs only as far as its own alpha allows.
    //
    // The eraser's `destination-out` belongs here too, and does not exist yet —
    // T-62.
    ctx.globalCompositeOperation = toolOf(stroke) === "highlighter" ? "multiply" : "source-over";
    ctx.fill(path);
    ctx.restore();
    drew = true;
  }
  ctx.restore();
  return drew;
}

/**
 * The item's own box, in its local frame — the surface a pen can mark.
 *
 * Half-extents about the centre, because that is where an item's local origin is
 * (DESIGN section 2.5) and it is what both callers already hold: the renderer
 * has `scene.w`/`scene.h`, and the overlay has the same numbers for the rotated
 * rect it clips the wet stroke to.
 */
export function paperBox(w: number, h: number, out: InkBox): InkBox {
  out.minX = -w / 2;
  out.minY = -h / 2;
  out.maxX = w / 2;
  out.maxY = h / 2;
  return out;
}

/**
 * The part of the ink that is actually on the paper, or null when none of it is.
 *
 * Null is a real case and not a degenerate one: undo an item's resize with ink
 * drawn near its old edge and every stroke can end up off the paper, at which
 * point the canvas should go rather than be a blank bitmap kept alive by strokes
 * nobody can see.
 */
export function clipToPaper(box: InkBox, paper: InkBox): InkBox | null {
  const minX = Math.max(box.minX, paper.minX);
  const minY = Math.max(box.minY, paper.minY);
  const maxX = Math.min(box.maxX, paper.maxX);
  const maxY = Math.min(box.maxY, paper.maxY);
  if (minX >= maxX || minY >= maxY) return null;
  box.minX = minX;
  box.minY = minY;
  box.maxX = maxX;
  box.maxY = maxY;
  return box;
}

/**
 * `SceneStroke.tool` is a plain string by the scene's convention — a type
 * imported across the one-way boundary is a dependency imported across it — so
 * it is narrowed here, the way `render/items/dom.ts` narrows an item's type.
 *
 * `"erase"` falls through to the marker's geometry until T-62 gives it
 * `destination-out`, which draws it as an opaque mark rather than as nothing.
 * Visibly wrong beats invisibly missing: the stroke is in the document either
 * way, and a smudge that shows up as a black line is a bug somebody reports.
 */
function toolOf(stroke: SceneStroke): InkTool {
  return stroke.tool === "highlighter" ? "highlighter" : "marker";
}

/** The next power of two at or above `n`, and never below 1. */
function pow2(n: number): number {
  if (!Number.isFinite(n) || n <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(n));
}
