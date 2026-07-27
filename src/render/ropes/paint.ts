/**
 * The rope painter — phase 7, and the most important surface in the
 * application.
 *
 * > Rendered as a three-pass stroke along the simulated polyline:
 * >
 * > 1. **Shadow** — offset along the light direction, dark, low alpha, wider
 * >    than the string.
 * > 2. **Body** — the main colour, full width, round joins and caps.
 * > 3. **Highlight** — a brighter tint at reduced width, offset perpendicular
 * >    to the light by about a pixel.
 * >
 * > Three `stroke()` calls, and it reads as a lit cylinder.
 * > — DESIGN section 4.6
 *
 * Three strokes of the *same path*, which is what makes it three and not
 * three-per-string: the offsets are applied by translating the context between
 * passes, so a batch of forty red strings is one `Path2D` and three `stroke()`
 * calls in total.
 *
 * ## Screen space, and why the widths are constant (AC-70)
 *
 * > Rope particles simulate in board space and are transformed to screen space
 * > at draw time — two multiplies and two adds each. Drawing in screen space
 * > means line widths are absolute and crisp at every zoom, with no scaling and
 * > no compensation. — DESIGN section 6.4
 *
 * So `lineWidth` is set from the string's thickness and nothing else. Not
 * multiplied by zoom, not divided by it, not compensated anywhere. Zoom out to
 * 15% and the string stays a crisp three pixels rather than fading to a
 * sub-pixel smear; zoom in to 400% and it does not become a rope-coloured
 * ribbon. The camera reaches the drawing only through the *points*.
 *
 * The corollary is that a cached path is only good while the camera is still,
 * because the cache holds screen coordinates. That is the right trade: a
 * camera move already means every layer on the board redraws.
 *
 * ## Never `shadowBlur` (AC-69)
 *
 * > The string's shadow is a **second offset pass at lower alpha** — never
 * > `shadowBlur`, which is brutally slow on canvas and would dominate the frame
 * > on its own. — DESIGN section 6.4
 *
 * Nothing in this file touches `shadowBlur`, `shadowColor` or `filter`, and
 * `paint.test.ts` asserts it against a recording context rather than trusting
 * anybody to remember.
 *
 * ## Two canvases, one painter
 *
 * ARCHITECTURE lists `ropes/under.ts` and `ropes/over.ts`. They would be the
 * same file twice: the layer stack needs two canvases because a photograph can
 * be pinned on top of string that was already there (DESIGN section 6.2), but
 * *painting* does not change between them. So this is one class, instantiated
 * once per canvas with the layer it draws, and `over` is the one that will
 * grow the lifted shadow when draping lands (T-66).
 */

import { fibre } from "@/lib/material";
import { LIGHT_DX, LIGHT_DY } from "@/render/items/shadow";
import type { RopeSet } from "@/sim/ropes";
import type { Camera } from "@/state/camera";
import type { DirtySets } from "@/state/dirty";
import type { Bounds, Scene } from "@/state/scene";

/**
 * How far the shadow sits from the string, in screen pixels, and how much
 * wider and darker it is.
 *
 * Screen pixels rather than board units, like everything else here — a string
 * lying on cork is a fixed small distance off it, and the shadow of a real one
 * does not grow when you lean in. Where the string crosses an *item* it is
 * genuinely lifted and the offset widens; that is T-66, and this is the number
 * it will start from.
 */
const SHADOW_OFFSET = 2.2;
const SHADOW_WIDEN = 1.45;
const SHADOW_ALPHA = 0.26;

/**
 * The highlight rides the lit side, a fraction of the body's width — but never
 * thinner than `HIGHLIGHT_MIN`.
 *
 * The floor is not a nicety. A default string is three pixels, and a plain
 * fraction of that is a stroke of about one, which the rasteriser spreads
 * across two pixels at half opacity and the eye reads as nothing: the string
 * comes out flat, and only a deliberately thick one looks like a cylinder.
 * Seen immediately on a real board and invisible in every unit test.
 */
const HIGHLIGHT_OFFSET = 0.9;
const HIGHLIGHT_WIDTH = 0.38;
const HIGHLIGHT_MIN = 1.25;
/** How far toward white the body colour is pushed for the highlight. */
const HIGHLIGHT_LIFT = 0.42;
/**
 * Ceiling on that lift once a material's `sheen` has multiplied it.
 *
 * Wire's whole character is a bright specular, and the number that gives it is
 * comfortably over 1 — which would blend the body colour all the way to white
 * and lose the difference between a red wire and a blue one. Metal reflects a
 * lot of the light and still has a colour.
 */
const HIGHLIGHT_LIFT_MAX = 0.82;

/**
 * The floor on a body stroke, in screen pixels.
 *
 * `palette.ts` starts its thickness ladder at 2 rather than 1 because a 1 px
 * body rasterises to a smear the eye reads as nothing, and notes that unlike
 * the highlight it has "no floor to save it". A material weight is exactly the
 * thing that can push it back under: wire at the thinnest rung is 1.6. So it
 * gets a floor after all, at the bottom of what the same argument says is
 * legible. A wire is meant to be the thinnest thing on the board — it is not
 * meant to be an invisible one.
 */
const BODY_MIN = 1.75;

/**
 * How wide a string is actually drawn: what the user asked for, through what
 * it is made of.
 *
 * Exported because the *chrome* has to agree with it. `render/overlay.ts` draws
 * the selection halo as a fringe a couple of pixels either side of the string
 * and the hover glow as a wash exactly the string's own width — both of which
 * are questions about the drawn width and neither of which is the authored
 * thickness once a material is involved. A yarn halo sized off the thickness
 * would sit *inside* the strand and disappear, which is the selection quietly
 * failing rather than looking wrong.
 */
export function bodyWidth(thickness: number, material: string): number {
  return Math.max(BODY_MIN, thickness * fibre(material).weight);
}

/** How much wider than the body the fuzz halo is drawn. Wide enough to read as
 *  a fringe of loose fibre and not as a second, blurrier string. */
const HALO_WIDEN = 2.1;

/**
 * How far outside the viewport a string still counts as visible, in board
 * units. A string whose bounding box is just off-screen can still have a
 * *stroke* on screen once the shadow and half the line width are added, and a
 * rope that popped in at the edge of the viewport would be worse than the
 * handful of extra paths this costs.
 */
const CULL_MARGIN = 64;

/**
 * One stroke set: everything that can be drawn in the same few `stroke()`
 * calls.
 *
 * Keyed on colour, thickness *and* material, because all three change what the
 * context is set to between passes. That is a third dimension on the batch
 * key and it costs nothing worth counting: material is three values and the
 * realistic board uses one of them, so the batch count is unchanged on every
 * board that exists and at worst triples on one that has gone out of its way.
 */
interface Batch {
  path: Path2D;
  color: string;
  /** The authored thickness and material — the batch *key*, alongside colour.
   *  Keyed on the inputs rather than on the widths they resolve to, because
   *  two different materials can land on the same body width off different
   *  rungs of the ladder and still want different highlights. */
  thickness: number;
  material: string;
  highlight: string;
  /** The body width the material actually draws at — thickness × weight, floored. */
  width: number;
  /** Highlight width, already through the material's gloss and the floor. */
  highlightWidth: number;
  /** Alpha of the fuzz pass, or zero for a fibre that has none. */
  halo: number;
}

export class RopeLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly layer: string;

  /**
   * One `Path2D` per string, in screen space.
   *
   * > Sleeping ropes keep a cached `Path2D`, so an idle board of 500 strings is
   * > a handful of path fills. — DESIGN section 6.4
   *
   * Per string rather than per batch, because a batch is where the drawing is
   * cheap and a string is where the *walk* is: rebuilding one moving string's
   * path and re-assembling the batch from cached ones costs a few hundred
   * `addPath` calls, against ten thousand `lineTo`s to rebuild the board.
   */
  private readonly paths = new Map<string, Path2D>();
  /** Camera pose the cached paths were built at. */
  private cachedX = Number.NaN;
  private cachedY = Number.NaN;
  private cachedZoom = Number.NaN;
  /** Whether the canvas currently has anything on it. */
  private inked = false;

  private readonly view: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly batches: Batch[] = [];
  private readonly visible: string[] = [];

  constructor(canvas: HTMLCanvasElement, layer: "over" | "under") {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.layer = layer;
  }

  /**
   * ROPES phase (7).
   *
   * Returns whether it drew, which is what the dev HUD wants and what makes
   * "an idle board costs nothing" checkable rather than asserted.
   */
  draw(scene: Scene, ropes: RopeSet, camera: Camera, dirty: DirtySets): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;

    const moved = camera.x !== this.cachedX || camera.y !== this.cachedY || camera.zoom !== this.cachedZoom;
    if (moved || dirty.all) this.paths.clear();
    else {
      // Only what actually changed loses its cached walk.
      for (const id of dirty.ropes) this.paths.delete(id);
      for (const id of dirty.strings) this.paths.delete(id);
    }

    // A frame where the camera is still and no rope moved is a frame where the
    // canvas already holds the right picture. This is the whole reason a board
    // of five hundred sleeping strings is free.
    if (!moved && !dirty.all && dirty.ropes.size === 0 && dirty.strings.size === 0) {
      return false;
    }

    this.cachedX = camera.x;
    this.cachedY = camera.y;
    this.cachedZoom = camera.zoom;

    camera.visibleBounds(CULL_MARGIN, this.view);
    this.visible.length = 0;
    ropes.stringsIn(this.view, this.visible);

    this.batches.length = 0;
    for (const id of this.visible) {
      const style = scene.strings.get(id);
      if (style === undefined || style.layer !== this.layer) continue;
      const path = this.pathFor(id, ropes, camera);
      if (path === null) continue;
      this.batchFor(style.color, style.thickness, style.material).path.addPath(path);
    }

    if (this.batches.length === 0) {
      // Nothing to draw. Clearing a canvas that is already blank is a full
      // backing-store write for no reason, and on the `under` layer of a board
      // where every string is over the items, that would be every frame.
      if (!this.inked) return false;
      this.clear(ctx);
      this.inked = false;
      return true;
    }

    this.clear(ctx);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const batch of this.batches) this.strokeBatch(ctx, batch);
    this.inked = true;
    return true;
  }

  /** Drop every cached path. For a resize, which invalidates the canvas, and
   *  for teardown. */
  invalidate(): void {
    this.paths.clear();
    this.cachedZoom = Number.NaN;
    this.inked = false;
  }

  /**
   * The three passes, on one path.
   *
   * The translations are what put the shadow and the highlight where they
   * belong — the same geometry, moved — so the offsets cost a transform rather
   * than a second walk of the points.
   */
  private strokeBatch(ctx: CanvasRenderingContext2D, batch: Batch): void {
    // 1. Shadow: down-light, wider, dark and faint. An offset pass, never
    //    `shadowBlur` (AC-69).
    ctx.save();
    ctx.translate(LIGHT_DX * SHADOW_OFFSET, LIGHT_DY * SHADOW_OFFSET);
    ctx.strokeStyle = `rgba(0, 0, 0, ${SHADOW_ALPHA})`;
    ctx.lineWidth = batch.width * SHADOW_WIDEN;
    ctx.stroke(batch.path);
    ctx.restore();

    /**
     * 1a. Fuzz, for a fibre that has any — a wide, faint pass of the body
     * colour, sitting exactly under the body rather than offset from it.
     *
     * This is the fourth stroke DESIGN section 4.6 does not list, and it is
     * here because "yarn" has to be *visibly* yarn from across the board and
     * three strokes of a lit cylinder is precisely what yarn is not. Loose
     * fibre standing off the strand is a soft edge of the strand's own colour;
     * one wide low-alpha stroke is what that looks like at any zoom the board
     * is ever at, and it stays inside the batch — no per-string cost, and the
     * whole thing costs nothing at all on a board with no yarn on it.
     */
    if (batch.halo > 0) {
      ctx.save();
      ctx.globalAlpha = batch.halo;
      ctx.strokeStyle = batch.color;
      ctx.lineWidth = batch.width * HALO_WIDEN;
      ctx.stroke(batch.path);
      ctx.restore();
    }

    // 2. Body: the string's own colour, at its own width, in screen pixels.
    ctx.strokeStyle = batch.color;
    ctx.lineWidth = batch.width;
    ctx.stroke(batch.path);

    // 3. Highlight: perpendicular to the light, toward the lit side. How bright
    //    and how tight is the material's doing — see `lib/material.ts`.
    ctx.save();
    ctx.translate(-LIGHT_DY * HIGHLIGHT_OFFSET, LIGHT_DX * HIGHLIGHT_OFFSET);
    ctx.strokeStyle = batch.highlight;
    ctx.lineWidth = batch.highlightWidth;
    ctx.stroke(batch.path);
    ctx.restore();
  }

  private batchFor(color: string, thickness: number, material: string): Batch {
    for (const batch of this.batches) {
      if (
        batch.color === color &&
        batch.thickness === thickness &&
        batch.material === material
      ) {
        return batch;
      }
    }
    const fib = fibre(material);
    const width = bodyWidth(thickness, material);
    const batch: Batch = {
      path: new Path2D(),
      color,
      thickness,
      material,
      highlight: lighten(color, Math.min(HIGHLIGHT_LIFT_MAX, HIGHLIGHT_LIFT * fib.sheen)),
      width,
      highlightWidth: Math.max(HIGHLIGHT_MIN, width * HIGHLIGHT_WIDTH * fib.gloss),
      halo: fib.halo,
    };
    this.batches.push(batch);
    return batch;
  }

  /**
   * One string's polyline in screen space, cached.
   *
   * Each segment is its own subpath — a `moveTo` and then a run of `lineTo` —
   * so a multi-pin run draws as one continuous string and a segment whose pin
   * has gone missing simply leaves a gap rather than a straight line across
   * the board to wherever the next one starts.
   */
  private pathFor(id: string, ropes: RopeSet, camera: Camera): Path2D | null {
    const cached = this.paths.get(id);
    if (cached !== undefined) return cached;

    const pool = ropes.positions;
    const zoom = camera.zoom;
    const camX = camera.x;
    const camY = camera.y;
    const path = new Path2D();
    let drew = false;

    ropes.visit(id, (at, count) => {
      path.moveTo((pool[at]! - camX) * zoom, (pool[at + 1]! - camY) * zoom);
      for (let i = 1; i < count; i++) {
        const j = at + i * 2;
        path.lineTo((pool[j]! - camX) * zoom, (pool[j + 1]! - camY) * zoom);
      }
      drew = true;
    });

    if (!drew) return null;
    this.paths.set(id, path);
    return path;
  }

  /**
   * The context is pre-scaled by devicePixelRatio (`world.resizeCanvases`), so
   * clearing has to step outside that transform to reach the backing store.
   */
  private clear(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }
}

/**
 * Push a hex colour toward white, for the highlight.
 *
 * Blending toward white rather than scaling the channels, because scaling a
 * dark red gives a slightly *less* dark red and reads as a smudge; the
 * highlight has to look like light landing on a fibre. Anything that is not a
 * six-digit hex comes back unchanged, which draws a string with no highlight
 * rather than throwing inside the paint path.
 */
export function lighten(hex: string, amount: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const value = Number.parseInt(hex.slice(1), 16);
  const mix = (channel: number): number =>
    Math.round(channel + (255 - channel) * amount);
  const r = mix((value >> 16) & 0xff);
  const g = mix((value >> 8) & 0xff);
  const b = mix(value & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
