/**
 * The camera, and the only conversions between coordinate spaces.
 *
 * Three spaces (docs/DESIGN.md section 2.5):
 *
 *   board   — board units; 1 unit = 1 px at 100% zoom. Item positions, free
 *             pins, board ink, rope particles.
 *   local   — item units, origin at the item centre, un-rotated.
 *   screen  — the viewport.
 *
 * **Screen space here is CSS pixels, not device pixels.** DESIGN says device
 * pixels; CSS pixels is the same thing at dpr 1 and strictly easier to reason
 * about everywhere else, because that is what pointer events, CSS transforms
 * and getBoundingClientRect all speak. Device pixels appear in exactly one
 * place: canvas backing-store sizing, where the context is pre-scaled by dpr
 * so its drawing commands stay in CSS pixels too.
 *
 * The camera is defined by the board point sitting at the viewport's top-left
 * corner, plus a scale:
 *
 *   screen = (board - camera) * zoom
 *   board  = camera + screen / zoom
 *
 * which the world wrapper realises as one CSS transform with origin 0 0:
 *
 *   translate(-camera.x * zoom, -camera.y * zoom) scale(zoom)
 */

/** docs/DESIGN.md section 3.7 — "roughly 5% to 400%". */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export class Camera {
  /** Board coordinate at the viewport's top-left corner. */
  x = 0;
  y = 0;
  zoom = 1;

  /** Viewport size, CSS pixels. */
  width = 0;
  height = 0;

  /**
   * Bumped on every mutation. Render compares against the value it last wrote
   * so the DOM phase can skip untouched frames without reading the DOM back.
   */
  version = 1;

  private touch(): void {
    this.version++;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.touch();
  }

  screenToBoard(sx: number, sy: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    out.x = this.x + sx / this.zoom;
    out.y = this.y + sy / this.zoom;
    return out;
  }

  boardToScreen(bx: number, by: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    out.x = (bx - this.x) * this.zoom;
    out.y = (by - this.y) * this.zoom;
    return out;
  }

  /** Move the camera by a screen-space delta — a drag of the surface itself,
   *  so content follows the cursor and the camera moves the other way. */
  panByScreen(dxScreen: number, dyScreen: number): void {
    if (!Number.isFinite(dxScreen) || !Number.isFinite(dyScreen)) return;
    if (dxScreen === 0 && dyScreen === 0) return;
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.touch();
  }

  panByBoard(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (dx === 0 && dy === 0) return;
    this.x += dx;
    this.y += dy;
    this.touch();
  }

  /**
   * Set the zoom while keeping the board point under (sx, sy) exactly where it
   * is. This is what makes wheel-zoom feel like the board rather than the
   * window is being scaled.
   */
  zoomTo(zoom: number, sx: number, sy: number): void {
    // A single NaN here is unrecoverable and invisible: the transform becomes
    // "translate(NaNpx, NaNpx)", the browser drops it, and the board simply
    // stops responding with nothing in the console. Cheaper to refuse.
    if (!Number.isFinite(zoom) || !Number.isFinite(sx) || !Number.isFinite(sy)) return;
    const next = clampZoom(zoom);
    if (next === this.zoom) return;
    // The board point under the cursor, before the change.
    const bx = this.x + sx / this.zoom;
    const by = this.y + sy / this.zoom;
    this.zoom = next;
    this.x = bx - sx / next;
    this.y = by - sy / next;
    this.touch();
  }

  zoomBy(factor: number, sx: number, sy: number): void {
    this.zoomTo(this.zoom * factor, sx, sy);
  }

  /** Centre the viewport on a board point, leaving zoom alone. */
  centreOn(bx: number, by: number): void {
    this.x = bx - this.width / (2 * this.zoom);
    this.y = by - this.height / (2 * this.zoom);
    this.touch();
  }

  /** Ctrl+1 — actual size, about the viewport centre. */
  resetZoom(): void {
    this.zoomTo(1, this.width / 2, this.height / 2);
  }

  /** Ctrl+0 — frame a board rectangle with a margin, in screen pixels. */
  fit(bounds: Bounds, marginPx = 64): void {
    const bw = Math.max(1e-6, bounds.maxX - bounds.minX);
    const bh = Math.max(1e-6, bounds.maxY - bounds.minY);
    const vw = Math.max(1, this.width - marginPx * 2);
    const vh = Math.max(1, this.height - marginPx * 2);
    this.zoom = clampZoom(Math.min(vw / bw, vh / bh));
    this.centreOn((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2);
  }

  /** Board rectangle currently on screen, optionally grown by a fraction of
   *  itself — culling (DESIGN section 9.1) uses 0.2. */
  visibleBounds(margin = 0, out: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 }): Bounds {
    const w = this.width / this.zoom;
    const h = this.height / this.zoom;
    const mx = w * margin;
    const my = h * margin;
    out.minX = this.x - mx;
    out.minY = this.y - my;
    out.maxX = this.x + w + mx;
    out.maxY = this.y + h + my;
    return out;
  }
}
