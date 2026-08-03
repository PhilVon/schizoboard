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

/**
 * How far out the board lets you go, and it is a performance decision as much as
 * a product one (T-204, Q-117).
 *
 * DESIGN 3.7 said "roughly 5% to 400%" and the floor was 0.05. What that bought
 * was a zoom at which every item on a five-hundred-item board is on screen at
 * once, and D-33 measured what having them all mounted costs: the frame in which
 * the culler brings them in, and the frame in which the tier lets them go, were
 * the two most expensive frames this application had.
 *
 * Raising the floor caps how many can ever be mounted — 370 rather than 500 on
 * the bench board — and it is the lever that finally puts **every** stage where
 * the camera is holding still inside frame budget, at every zoom. Measured with
 * the LOD tiers and the coarse-mount sweep already in place:
 *
 *     floor   mounted   hold-there worst   frames over, zooming back in to 35%
 *     0.05        500            131.9ms                                   49
 *     0.10        500             20.9ms                                   32
 *     0.15        370             13.9ms                                    3
 *
 * The 0.10 row is why this is 0.15 and not something gentler: capping the *count*
 * is only half of it, and the other half is that a shorter zoom range means fewer
 * items crossing the viewport edge per frame on the way back in.
 *
 * ## What it costs, and it is exactly one thing
 *
 * [`Camera.fit`] clamps, so `Ctrl+0` and `F` on a board larger than this floor can
 * frame will centre it and show most of it rather than all of it. At 0.15 that is
 * a board over roughly 8,500 by 5,700 units — about 28 by 19 pasted photographs.
 */
export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 4;

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * A box on the **screen**, in the coordinates `getBoundingClientRect` speaks.
 *
 * Here beside {@link Vec2} and {@link Bounds} rather than where it is produced,
 * because two layers that never import each other both need to say it:
 * `app/clipping.ts` measures figures and words in these, and `render/overlay.ts`
 * draws the words it is handed. This module is the geometry both already
 * depend on, and a second declaration of four numbers is the shape of mistake
 * `tests/pin-kinds.test.ts` exists to catch elsewhere.
 *
 * Deliberately not `Bounds`: that is board space with `minX`/`minY`, and the
 * whole hazard these two types guard against is one being passed where the
 * other is wanted.
 */
export interface ScreenBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
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

/**
 * Breathing room around a fitted board, screen pixels.
 *
 * One number because it answers one question — "how much cork do you leave
 * round the edge when you frame the whole board?" — and it is asked from two
 * places that must agree: `Ctrl+0` and the fit a board boots on.
 *
 * `state/navigation.ts` keeps a separate, larger `FRAME_MARGIN_PX` for `F`.
 * That is deliberate rather than an oversight: framing a *selection* is asking
 * to look at one thing among its surroundings, so it wants more room round it
 * than framing everything there is does.
 */
export const FIT_MARGIN_PX = 120;

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

  /**
   * Put the camera exactly here.
   *
   * The one setter that takes raw camera state, and it exists for one caller:
   * undo stashes the camera in each entry's metadata and restores it on the
   * way back (DATA-MODEL section 11). That is not a pan, a zoom or a fit — it
   * is a saved position being reinstated — and expressing it as a pan would
   * mean deriving a delta from a state we already have.
   */
  setView(x: number, y: number, zoom: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return;
    const next = clampZoom(zoom);
    if (x === this.x && y === this.y && next === this.zoom) return;
    this.x = x;
    this.y = y;
    this.zoom = next;
    this.touch();
  }

  /** Ctrl+1 — actual size, about the viewport centre. */
  resetZoom(): void {
    this.zoomTo(1, this.width / 2, this.height / 2);
  }

  /**
   * `Ctrl+0`, and the view a board opens on — frame a board rectangle with a
   * margin, in screen pixels.
   *
   * The default is the whole point of `FIT_MARGIN_PX`: those two are the same
   * view and have to come out identical. `app/main.ts` passed 120 and the
   * shortcut took this default, which was 64, so pressing the key that says
   * "fit" moved the camera off the view the board had just opened on — and it
   * did it every time, which reads as the shortcut being slightly wrong rather
   * than as two constants disagreeing (T-135).
   */
  fit(bounds: Bounds, marginPx = FIT_MARGIN_PX): void {
    this.zoom = this.zoomToFit(bounds, marginPx);
    this.centreOn((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2);
  }

  /**
   * The zoom [`fit`] would choose, without going there.
   *
   * Split out for `state/flight.ts`, which needs the destination before it
   * starts easing toward it. A second copy of this arithmetic would be a second
   * opinion about `FIT_MARGIN_PX` and about the clamp, and T-135 is the whole
   * story of what two opinions about that margin cost: the shortcut that says
   * "fit" framed a different view from the one the board had just opened on, and
   * it read as the key being slightly wrong rather than as two constants
   * disagreeing.
   */
  zoomToFit(bounds: Bounds, marginPx = FIT_MARGIN_PX): number {
    const bw = Math.max(1e-6, bounds.maxX - bounds.minX);
    const bh = Math.max(1e-6, bounds.maxY - bounds.minY);
    const vw = Math.max(1, this.width - marginPx * 2);
    const vh = Math.max(1, this.height - marginPx * 2);
    return clampZoom(Math.min(vw / bw, vh / bh));
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
