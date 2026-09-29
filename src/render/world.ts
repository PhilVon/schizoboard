/**
 * The layer stack and its shared camera transform.
 * Item promotion is owned by DomItemLayer: releasing one promoted world
 * subtree forces hundreds of photos to rasterise in a single frame (T-420).
 * Board ink keeps its gesture cache; item caches drain in bounded batches.
 */

import type { Camera } from "@/state/camera";

/** How long after the last gesture event we drop will-change and re-raster. */
const GESTURE_END_MS = 180;

export type RasterizeListener = (scale: number) => void;

/**
 * Told the zoom the camera came to rest at, on every gesture end.
 *
 * The sibling of [`RasterizeListener`], and separate from it because the two
 * have opposite tolerances. A bitmap survives being stretched, so a re-raster
 * is gated on a 1.25x swing and skipping one costs nothing anybody can see. A
 * threshold does not survive anything: 0.36 to 0.34 crosses DESIGN section
 * 6.6's 35% boundary and is a swing of 1.06, so a listener that shared the
 * raster gate would silently never fire at the one zoom it exists for.
 *
 * The value is the **zoom**, not `devicePixelRatio * zoom` — see `render/lod.ts`
 * for why a tier is not a fact about device pixels.
 */
export type SettleListener = (zoom: number) => void;

export interface Layers {
  readonly cork: HTMLDivElement;
  /** Board-ink tile canvases, in the camera transform — `render/ink/board.ts`. */
  readonly boardInk: HTMLDivElement;
  readonly ropesUnder: HTMLCanvasElement;
  readonly world: HTMLDivElement;
  readonly ropesOver: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly pins: HTMLDivElement;
  readonly ui: HTMLDivElement;
}

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

function canvas(className: string): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.className = className;
  return el;
}

export class World {
  readonly layers: Layers;

  private readonly host: HTMLElement;
  private writtenVersion = -1;
  private gestureTimer = 0;
  private gesturing = false;

  /** True until the gesture's final DOM writes have landed. */
  get moving(): boolean {
    return this.gesturing || this.demotePending;
  }
  private readonly rasterizeListeners: RasterizeListener[] = [];
  private readonly settleListeners: SettleListener[] = [];
  /** Scale the promoted layers were last rasterised at. */
  private rasterScale = 0;

  constructor(host: HTMLElement) {
    this.host = host;

    const cork = div("layer layer-cork");
    const boardInk = div("layer layer-board-ink");
    const ropesUnder = canvas("layer layer-ropes-under");
    const world = div("layer layer-world");
    const ropesOver = canvas("layer layer-ropes-over");
    const overlay = canvas("layer layer-overlay");
    const pins = div("layer layer-pins");
    const ui = div("layer layer-ui");

    world.style.transformOrigin = "0 0";
    boardInk.style.transformOrigin = "0 0";

    host.append(cork, boardInk, ropesUnder, world, ropesOver, overlay, pins, ui);
    this.layers = { cork, boardInk, ropesUnder, world, ropesOver, overlay, pins, ui };
  }

  /**
   * DOM phase (5). Writes the camera transform, and only if it changed —
   * an untouched camera costs one integer comparison.
   */
  applyCamera(camera: Camera): boolean {
    if (camera.version === this.writtenVersion) return false;
    this.writtenVersion = camera.version;
    const z = camera.zoom;
    const transform = `translate(${-camera.x * z}px, ${-camera.y * z}px) scale(${z})`;
    this.layers.world.style.transform = transform;
    // The same string, not the same numbers computed twice: the two layers are
    // one camera seen at two depths of the stack, and a board-ink tile that
    // disagreed with the items by a rounding error would slide under them.
    this.layers.boardInk.style.transform = transform;
    return true;
  }

  /**
   * Call on every frame in which a pan or zoom gesture produced input. Promotes
   * board ink for the duration of the gesture and schedules the
   * re-raster that ends it.
   */
  gestureTick(scale: number): void {
    if (!this.gesturing) {
      this.gesturing = true;
      // Board ink is under a scale() too, so it goes blurry in exactly the same
      // way and is promoted and demoted on exactly the same schedule.
      this.layers.boardInk.style.willChange = "transform";
    }
    if (this.gestureTimer !== 0) clearTimeout(this.gestureTimer);
    this.gestureTimer = window.setTimeout(() => this.endGesture(scale), GESTURE_END_MS);
  }

  /**
   * The camera is at this zoom and is not moving — re-raster now, without the
   * debounce.
   *
   * For the settled camera nobody gestured into: the opening `camera.fit`, which
   * is where the board's zoom comes from before anything is touched. Without it
   * every bitmap on the board — an item's ink canvas, and which stored variant a
   * photograph points at — is built for a scale of 1 until the first pan or zoom
   * *gesture* ends, which on a board somebody only reads may be never.
   *
   * Straight through `endGesture` rather than beside it, so the 1.25x threshold
   * and the notification are the ones every other re-raster goes through. It
   * cancels a pending debounce for the same reason: this is a statement about
   * where the camera has ended up, and a timer from a gesture that got here is
   * about to say the same thing more slowly.
   */
  settle(zoom: number): void {
    if (this.gestureTimer !== 0) clearTimeout(this.gestureTimer);
    this.endGesture(zoom);
  }

  /**
   * The debounce has expired, so the layer should come down — but not yet.
   *
   * Set here and cleared by [`flushDemote`] in the DOM phase (T-201). See there
   * for why one frame of extra promotion is worth a great deal.
   */
  private demotePending = false;


  private endGesture(scale: number): void {
    this.gestureTimer = 0;
    this.gesturing = false;


    // Outside the raster gate: even a small change can cross a tier boundary.
    for (const fn of this.settleListeners) fn(scale);

    // Queued rather than written. `flushDemote` says why.
    this.demotePending = true;

    const target = scale * devicePixelRatio;
    // Re-rastering for a hair of scale change is pure waste; a 1.25x swing is
    // where a stretched bitmap starts being visible.
    if (this.rasterScale === 0 || target / this.rasterScale > 1.25 || this.rasterScale / target > 1.25) {
      this.rasterScale = target;
      for (const fn of this.rasterizeListeners) fn(target);
    }
  }


  /** Finish the gesture after its DOM writes, then release the board-ink cache. */
  flushDemote(): void {
    if (!this.demotePending) return;
    this.demotePending = false;
    // A gesture that started again while this was queued keeps its promotion:
    // demoting mid-gesture is the blur trap DESIGN section 6.6 is about, and the
    // new gesture has its own debounce which will queue its own demote.
    if (this.gesturing) return;
    this.layers.boardInk.style.willChange = "";
  }

  /** Notified with dpr * zoom whenever bitmaps should be regenerated. */
  onRasterize(fn: RasterizeListener): () => void {
    this.rasterizeListeners.push(fn);
    return () => {
      const i = this.rasterizeListeners.indexOf(fn);
      if (i >= 0) this.rasterizeListeners.splice(i, 1);
    };
  }

  /** Notified with the zoom the camera settled at, on every gesture end. */
  onSettle(fn: SettleListener): () => void {
    this.settleListeners.push(fn);
    return () => {
      const i = this.settleListeners.indexOf(fn);
      if (i >= 0) this.settleListeners.splice(i, 1);
    };
  }

  /** Size the screen-space canvases. Called on resize, never inside the loop. */
  resizeCanvases(width: number, height: number, dpr = devicePixelRatio): void {
    for (const c of [this.layers.ropesUnder, this.layers.ropesOver, this.layers.overlay]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
      // Draw commands stay in CSS pixels; dpr is a backing-store detail.
      c.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  destroy(): void {
    if (this.gestureTimer !== 0) clearTimeout(this.gestureTimer);
    // A queued demote that never flushed would otherwise be a promoted layer
    // left behind, which is the one state DESIGN section 6.6 calls a hard rule.
    this.demotePending = false;
    this.gesturing = false;
    this.host.replaceChildren();
    this.rasterizeListeners.length = 0;
    this.settleListeners.length = 0;
  }
}
