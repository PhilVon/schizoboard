/**
 * The layer stack and the one camera transform.
 *
 * docs/DESIGN.md section 6.2, bottom to top:
 *
 *   cork background            (DOM)
 *   ropes-under canvas         (screen space)
 *   world wrapper              (DOM)  <- ONE camera transform lives here
 *     item nodes: image, paper texture, ink canvas, all inside the rotation
 *   ropes-over canvas          (screen space)
 *   overlay canvas             (cursors, ghosts, wet ink)
 *   pins                       (DOM, hit targets)
 *   ui chrome                  (DOM)
 *
 * Items position themselves inside the wrapper in board coordinates and never
 * know about the camera. The canvases are full-viewport and apply the camera
 * per-point at draw time, which is what keeps line widths crisp at every zoom.
 *
 * ## The will-change rule
 *
 * A DOM subtree under a CSS scale() rasterises at its pre-scale resolution.
 * `will-change: transform` pins that cached layer at whatever scale it was
 * promoted at — so the property everyone reaches for to make zoom smooth is
 * also the one that makes zoomed-in content permanently blurry.
 *
 * The rule (DESIGN section 6.6) is hard: **will-change goes on at gesture
 * start and comes off on a debounced gesture end**, at which point the world
 * layer re-rasterises and everything holding its own bitmap is told to
 * re-raster at devicePixelRatio * zoom. Never leave it on at steady state.
 */

import type { Camera } from "@/state/camera";

/** How long after the last gesture event we drop will-change and re-raster. */
const GESTURE_END_MS = 180;

export type RasterizeListener = (scale: number) => void;

export interface Layers {
  readonly cork: HTMLDivElement;
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
  private readonly rasterizeListeners: RasterizeListener[] = [];
  /** Scale the promoted layers were last rasterised at. */
  private rasterScale = 0;

  constructor(host: HTMLElement) {
    this.host = host;

    const cork = div("layer layer-cork");
    const ropesUnder = canvas("layer layer-ropes-under");
    const world = div("layer layer-world");
    const ropesOver = canvas("layer layer-ropes-over");
    const overlay = canvas("layer layer-overlay");
    const pins = div("layer layer-pins");
    const ui = div("layer layer-ui");

    world.style.transformOrigin = "0 0";

    host.append(cork, ropesUnder, world, ropesOver, overlay, pins, ui);
    this.layers = { cork, ropesUnder, world, ropesOver, overlay, pins, ui };
  }

  /**
   * DOM phase (5). Writes the camera transform, and only if it changed —
   * an untouched camera costs one integer comparison.
   */
  applyCamera(camera: Camera): boolean {
    if (camera.version === this.writtenVersion) return false;
    this.writtenVersion = camera.version;
    const z = camera.zoom;
    this.layers.world.style.transform =
      `translate(${-camera.x * z}px, ${-camera.y * z}px) scale(${z})`;
    return true;
  }

  /**
   * Call on every frame in which a pan or zoom gesture produced input. Promotes
   * the world layer for the duration of the gesture and schedules the
   * re-raster that ends it.
   */
  gestureTick(scale: number): void {
    if (!this.gesturing) {
      this.gesturing = true;
      this.layers.world.style.willChange = "transform";
    }
    if (this.gestureTimer !== 0) clearTimeout(this.gestureTimer);
    this.gestureTimer = window.setTimeout(() => this.endGesture(scale), GESTURE_END_MS);
  }

  private endGesture(scale: number): void {
    this.gestureTimer = 0;
    this.gesturing = false;
    // Dropping will-change discards the cached layer, so the browser repaints
    // the world subtree at the scale it is actually being displayed at.
    this.layers.world.style.willChange = "";

    const target = scale * devicePixelRatio;
    // Re-rastering for a hair of scale change is pure waste; a 1.25x swing is
    // where a stretched bitmap starts being visible.
    if (this.rasterScale === 0 || target / this.rasterScale > 1.25 || this.rasterScale / target > 1.25) {
      this.rasterScale = target;
      for (const fn of this.rasterizeListeners) fn(target);
    }
  }

  /** Notified with dpr * zoom whenever bitmaps should be regenerated. */
  onRasterize(fn: RasterizeListener): () => void {
    this.rasterizeListeners.push(fn);
    return () => {
      const i = this.rasterizeListeners.indexOf(fn);
      if (i >= 0) this.rasterizeListeners.splice(i, 1);
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
    this.host.replaceChildren();
    this.rasterizeListeners.length = 0;
  }
}
