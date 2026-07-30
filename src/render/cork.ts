/**
 * The cork.
 *
 * docs/DESIGN.md section 4.2: a seamless cork texture, tiled, with a
 * large-scale low-frequency noise overlay at low opacity to break up the
 * repeat — "tiling artefacts on a background are the single most common way
 * this kind of app announces that it's cheap". Over the top, a slight vignette
 * anchored to the *viewport* and a broad soft light gradient anchored to the
 * *world*, so panning moves across a surface that isn't uniformly lit.
 *
 * The board is unbounded, so nothing here is a picture of a board — every
 * layer is a tile generated from the board seed and repeated indefinitely.
 * Three tiles at three very different periods is what kills the repeat: you
 * would have to pan several thousand board units to see the same combination
 * of grain, blotch and light twice.
 *
 * Layers are viewport-sized divs whose background-position tracks the camera.
 * That repaints the full viewport on any camera change, which is a real cost
 * and deliberately not optimised yet: the phase-0 fidelity spike (T-16) is the
 * thing that decides whether it needs to become a transform-only trick, and
 * guessing before measuring is how renderers end up complicated for nothing.
 */

import { mulberry32 } from "@/lib/seed";
import type { Camera } from "@/state/camera";

/**
 * Tile periods in board units. Deliberately co-prime-ish: the combination of
 * all three only repeats every 512 * 3251 * 7919 units, which is further than
 * anyone will ever pan. Two layers at 1024 and 2048 would repeat together
 * every 2048 units and read instantly as wallpaper.
 */
const GRAIN_TILE = 512;
const BLOTCH_TILE = 3251;
const LIGHT_TILE = 7919;

/**
 * Bitmap resolution each tile is generated at, before any zoom re-raster.
 * The grain is 1 texel per board unit so its speckle renders 1:1 at 100% zoom
 * — generate it denser than that and the browser's downsample averages the
 * granules into a smooth blur, which is precisely how cork stops looking like
 * cork. The other two are pure low frequency and cost nothing to upscale.
 */
const GRAIN_PX = 512;
const BLOTCH_PX = 256;
const LIGHT_PX = 128;

/** Granule flecks per grain tile. Cork is mostly flecks. */
const GRANULES = 2600;

/**
 * Zoom band over which the grain fades out.
 *
 * Grain is the finest layer and therefore the one whose repeat period shrinks
 * to eye-catching size first: at 12% zoom a 512-unit tile lands every 61
 * screen pixels, and a regular 61-pixel motif is unmistakably wallpaper no
 * matter how good the texture is. It is also, at that scale, detail nobody
 * could resolve on a real board from across the room. So it fades out, and the
 * two much longer-period layers carry the surface on their own.
 *
 * Same LOD reasoning as DESIGN section 6.6, applied to the background: below a
 * threshold, stop drawing what cannot be seen.
 */
const GRAIN_FADE_OUT = 0.18;
const GRAIN_FADE_IN = 0.45;

/** Cork is warm, mid-brown and fairly desaturated. Shadows elsewhere in the
 *  app are drawn from this, never from black (DESIGN section 4.1). */
const CORK_BASE = { r: 173, g: 130, b: 84 };

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Seamless value noise over a `size`x`size` bitmap, built from a `cells`x`cells`
 * lattice that wraps. Wrapping the lattice is the whole trick — the tile's
 * right edge interpolates back to its left edge by construction, so there is
 * no seam to hide.
 */
function valueNoise(size: number, cells: number, rng: () => number): Float32Array {
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();

  const out = new Float32Array(size * size);
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * scale;
    const y0 = Math.floor(fy);
    const ty = smoothstep(fy - y0);
    const ry0 = (y0 % cells) * cells;
    const ry1 = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const fx = x * scale;
      const x0 = Math.floor(fx);
      const tx = smoothstep(fx - x0);
      const rx0 = x0 % cells;
      const rx1 = (x0 + 1) % cells;
      const a = lattice[ry0 + rx0]!;
      const b = lattice[ry0 + rx1]!;
      const c = lattice[ry1 + rx0]!;
      const d = lattice[ry1 + rx1]!;
      const top = a + (b - a) * tx;
      const bottom = c + (d - c) * tx;
      out[y * size + x] = top + (bottom - top) * ty;
    }
  }
  return out;
}

/** Sum of octaves, each seamless in its own right, so the sum is too. */
function fbm(size: number, cells: number, octaves: number, rng: () => number): Float32Array {
  const out = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const layer = valueNoise(size, cells << o, rng);
    for (let i = 0; i < out.length; i++) out[i]! += layer[i]! * amplitude;
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}

/** Grain opacity for a zoom level. Exported so the LOD band is testable. */
export function grainLod(zoom: number): number {
  if (zoom >= GRAIN_FADE_IN) return 1;
  if (zoom <= GRAIN_FADE_OUT) return 0;
  const t = (zoom - GRAIN_FADE_OUT) / (GRAIN_FADE_IN - GRAIN_FADE_OUT);
  return smoothstep(t);
}

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  return { canvas, ctx };
}

/**
 * Cork grain, in two passes.
 *
 * The base pass is the cork colour modulated by a three-octave field, plus
 * per-pixel speckle for the fine tooth of the surface. That alone reads as
 * beige suede, because real cork is not noise — it is *granules*, thousands of
 * compressed bark flecks with edges, at a range of sizes. So the second pass
 * scatters ellipses over it, and that is the pass that makes it cork.
 *
 * Everything wraps: the field is a wrapping lattice, per-pixel speckle has no
 * spatial correlation to break, and flecks near an edge are drawn again on the
 * opposite side.
 */
function grainTile(seed: number, size: number): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(size);
  const rng = mulberry32(seed);
  const field = fbm(size, 4, 3, rng);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    const region = 0.87 + field[i]! * 0.26;
    const speck = 0.93 + rng() * 0.14;
    const k = region * speck;
    data[p] = Math.min(255, CORK_BASE.r * k);
    data[p + 1] = Math.min(255, CORK_BASE.g * k);
    data[p + 2] = Math.min(255, CORK_BASE.b * k * 0.98);
    data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  // Flecks. Scaled with the bitmap so a re-rastered tile looks identical
  // rather than gaining twice as many granules at half the size.
  const unit = size / GRAIN_PX;
  const count = Math.round(GRANULES * unit * unit);
  const margin = 12 * unit;

  for (let i = 0; i < count; i++) {
    const x = rng() * size;
    const y = rng() * size;
    // Cubed so most flecks are small and a few are properly chunky.
    const r = (1.1 + Math.pow(rng(), 3) * 8) * unit;
    const rx = r;
    const ry = r * (0.55 + rng() * 0.75);
    const rot = rng() * Math.PI;
    const dark = rng();
    // Two thirds of flecks are darker than the base, a third are lighter —
    // cork has pale dust in it as well as pits.
    const tint = dark < 0.66 ? 0.55 + dark * 0.35 : 1.06 + (dark - 0.66) * 0.28;
    const alpha = 0.05 + rng() * 0.16;
    ctx.fillStyle = `rgba(${Math.round(CORK_BASE.r * tint)},${Math.round(
      CORK_BASE.g * tint,
    )},${Math.round(CORK_BASE.b * tint)},${alpha.toFixed(3)})`;

    for (const dx of x < margin ? [0, size] : x > size - margin ? [0, -size] : [0]) {
      for (const dy of y < margin ? [0, size] : y > size - margin ? [0, -size] : [0]) {
        ctx.beginPath();
        ctx.ellipse(x + dx, y + dy, rx, ry, rot, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  return canvas;
}

/**
 * The repeat-breaker. Very low frequency, alpha-only, multiplied over the
 * grain at a period four times longer, so the eye never locks onto either.
 */
function blotchTile(seed: number, size: number): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(size);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const field = fbm(size, 2, 3, rng);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    const v = field[i]!;
    // Signed around mid grey so `overlay` blending darkens and lightens.
    const g = Math.round(128 + (v - 0.5) * 118);
    data[p] = g;
    data[p + 1] = g;
    data[p + 2] = g;
    data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * The world-anchored light. One octave only — this is a room's worth of
 * lighting falling across the board, not texture.
 */
function lightTile(seed: number, size: number): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(size);
  const rng = mulberry32(seed ^ 0x85ebca6b);
  const field = valueNoise(size, 2, rng);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    const g = Math.round(128 + (field[i]! - 0.5) * 120);
    data[p] = g;
    data[p + 1] = g;
    data[p + 2] = g;
    data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

interface CorkLayer {
  el: HTMLDivElement;
  /** Period in board units. */
  tile: number;
  url: string;
  /** Fades with zoom rather than sitting at a constant opacity. */
  lod?: boolean;
}

export class Cork {
  private readonly layers: CorkLayer[];
  private readonly host: HTMLElement;
  private readonly seed: number;
  private writtenVersion = -1;

  constructor(host: HTMLElement, seed: number) {
    this.host = host;
    this.seed = seed;

    // The flat cork colour belongs to the container, not to the grain bitmap.
    // The grain fades out at low zoom (see grainLod), and if the base colour
    // faded with it the board would turn into whatever is behind it.
    host.style.background = `rgb(${CORK_BASE.r} ${CORK_BASE.g} ${CORK_BASE.b})`;

    const grain = document.createElement("div");
    grain.className = "cork-layer cork-grain";
    const blotch = document.createElement("div");
    blotch.className = "cork-layer cork-blotch";
    const light = document.createElement("div");
    light.className = "cork-layer cork-light";
    const vignette = document.createElement("div");
    // Viewport-anchored, so it takes no camera update at all.
    vignette.className = "cork-vignette";

    host.append(grain, blotch, light, vignette);

    this.layers = [
      { el: grain, tile: GRAIN_TILE, url: "", lod: true },
      { el: blotch, tile: BLOTCH_TILE, url: "" },
      { el: light, tile: LIGHT_TILE, url: "" },
    ];

    this.generate();
  }

  /**
   * Generate the tiles. **Once, at construction, and never again.**
   *
   * Cork was originally wired to the world's debounced gesture end, on the
   * assumption that it needed the same re-raster discipline as item ink. It
   * does not, and the phase-0 spike (D-11, T-88) caught the mistake: three
   * separate 250 ms frames, every one of them this function running a
   * million-pixel loop and ten thousand ellipse fills on the main thread the
   * instant a zoom gesture ended.
   *
   * The reason it does not need it is structural. These layers are never
   * transformed — they are viewport-sized divs whose `background-size` tracks
   * the camera, so the browser rasterises the background afresh at the size it
   * is actually painting. There is no cached layer to go stale. The only thing
   * tile resolution buys is sharpness under upscale, and the spike showed a
   * 512-pixel tile reads correctly as cork at the 400% ceiling — which is
   * unsurprising for a texture whose entire content is noise.
   */
  private generate(): void {
    const bitmaps = [
      grainTile(this.seed, GRAIN_PX),
      blotchTile(this.seed, BLOTCH_PX),
      lightTile(this.seed, LIGHT_PX),
    ];
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i]!;
      const previous = layer.url;
      // Blob URLs, not data URLs: a 1024-square PNG is megabytes of base64,
      // and the string would be retained in the style attribute.
      bitmaps[i]!.toBlob((blob) => {
        if (!blob) return;
        layer.url = URL.createObjectURL(blob);
        layer.el.style.backgroundImage = `url(${layer.url})`;
        if (previous) URL.revokeObjectURL(previous);
      }, "image/png");
    }
    // Force the position write through on the next apply().
    this.writtenVersion = -1;
  }

  /** DOM phase (5). Anchors every layer to the world. */
  apply(camera: Camera): void {
    if (camera.version === this.writtenVersion) return;
    this.writtenVersion = camera.version;
    const z = camera.zoom;
    const ox = -camera.x * z;
    const oy = -camera.y * z;
    for (const layer of this.layers) {
      const size = layer.tile * z;
      layer.el.style.backgroundSize = `${size}px ${size}px`;
      layer.el.style.backgroundPosition = `${ox}px ${oy}px`;
      if (layer.lod) layer.el.style.opacity = grainLod(z).toFixed(3);
    }
  }

  /**
   * EXPORT. The same cork, drawn into a canvas at an export camera (T-206).
   *
   * The cork is the one board layer that is DOM rather than a painter — three
   * tiled backgrounds over a flat colour — so an export either repaints it here
   * or hands over a board with nothing behind it. Repainting is a handful of
   * pattern fills, and it is the difference between a picture of a corkboard
   * and a picture of some photographs floating on nothing.
   *
   * **The alpha and the blend are read off the live elements**, not written down
   * again. `mix-blend-mode: overlay` at 0.4 and `soft-light` at 0.55 live in
   * `base.css`, and a copy of them here would be a copy that goes stale the
   * first time somebody tunes the cork — silently, in a file nobody opens
   * beside the stylesheet. `getComputedStyle` costs three reads once per export
   * and cannot disagree.
   *
   * The vignette is deliberately not drawn. It is anchored to the viewport
   * rather than to the board — a lens on the window, not a mark on the cork —
   * and an export has no viewport. T-208 makes the same call for the print.
   */
  async paintInto(ctx: CanvasRenderingContext2D, camera: CameraPose): Promise<void> {
    const { width, height } = ctx.canvas;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgb(${CORK_BASE.r} ${CORK_BASE.g} ${CORK_BASE.b})`;
    ctx.fillRect(0, 0, width, height);

    for (const step of this.exportLayers(camera)) {
      const image = await loadImage(step.url);
      if (image === null) continue;
      const pattern = ctx.createPattern(image, "repeat");
      if (pattern === null) continue;
      // The tile is drawn at `size` board-units-worth of pixels wherever the
      // camera has put the world origin — the same two numbers `apply` writes
      // as `background-size` and `background-position`, because it is the same
      // picture and they must not be able to disagree.
      pattern.setTransform(
        new DOMMatrix().translateSelf(step.offsetX, step.offsetY).scaleSelf(step.size / image.width),
      );
      ctx.globalAlpha = step.alpha;
      ctx.globalCompositeOperation = step.blend;
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.restore();
  }

  /**
   * What each tiled layer becomes on an export canvas — separated from the
   * drawing because this half is arithmetic and the other half needs a browser.
   */
  exportLayers(camera: CameraPose): CorkFill[] {
    const zoom = camera.zoom;
    return this.layers
      .filter((layer) => layer.url !== "")
      .map((layer) => {
        const style = getComputedStyle(layer.el);
        const declared = Number(style.opacity);
        return {
          url: layer.url,
          size: layer.tile * zoom,
          offsetX: -camera.x * zoom,
          offsetY: -camera.y * zoom,
          // The grain's own fade is written by `apply` as an inline opacity, so
          // the computed value already has it; anything else falls back to the
          // stylesheet's.
          alpha: (Number.isFinite(declared) ? declared : 1) * (layer.lod ? grainLod(zoom) : 1),
          blend: blendOf(style.mixBlendMode),
        };
      });
  }

  destroy(): void {
    for (const layer of this.layers) {
      if (layer.url) URL.revokeObjectURL(layer.url);
    }
    this.host.replaceChildren();
  }
}

/** One tiled cork layer, as an export canvas has to fill it. */
export interface CorkFill {
  readonly url: string;
  /** Board-units-worth of pixels one tile covers. */
  readonly size: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly alpha: number;
  readonly blend: GlobalCompositeOperation;
}

/** Just the pose — `Camera` itself is more than an export needs and carries a
 *  viewport an export does not have. */
export interface CameraPose {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/**
 * A CSS blend mode as a canvas one.
 *
 * The two vocabularies agree on every mode the cork uses, and `normal` is the
 * name CSS gives to what canvas calls `source-over` — the one place they differ
 * and the only one that has to be translated. Anything unrecognised composites
 * normally rather than throwing: a cork layer that lands in the export
 * un-blended is a slightly flatter board, and that is a better outcome than an
 * export that refuses.
 */
function blendOf(cssBlendMode: string): GlobalCompositeOperation {
  const mode = cssBlendMode.trim();
  if (mode === "" || mode === "normal") return "source-over";
  return CANVAS_BLENDS.has(mode) ? (mode as GlobalCompositeOperation) : "source-over";
}

const CANVAS_BLENDS = new Set([
  "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color",
  "luminosity",
]);

/** `null` rather than a throw: a cork layer that will not load is a flatter
 *  board, not a failed export. */
async function loadImage(url: string): Promise<HTMLImageElement | null> {
  const image = new Image();
  return new Promise((resolve) => {
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
