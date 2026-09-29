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
 * The board is unbounded, so almost nothing here is a picture of a board —
 * three of the four surface layers are a tile generated from the board seed and
 * repeated indefinitely. Three tiles at three very different periods is what
 * kills the repeat: you would have to pan several thousand board units to see
 * the same combination of grain, blotch and light twice.
 *
 * The tiled layers keep a small overscan margin during camera movement. Pans
 * translate it without repainting until an edge is reached; zoom changes rebase
 * the original texture at its exact scale. Idle releases the extra surface.
 *
 * **The fourth is the exception and the reason it is worth naming them
 * separately.** Pinholes (T-231) are the one mark on this surface that is
 * somewhere rather than everywhere, so they are a canvas with sprites blitted
 * at pin positions — no period, no background-position, and the one cork layer
 * an export cannot fill with a pattern. See [`pinholeLod`] and [`pinholesFor`].
 */

import { corkColorOf } from "@/lib/palette";
import { mulberry32, valueAt } from "@/lib/seed";
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

/** Three RGBA surfaces, excluding browser tile bookkeeping. Above the budget,
 * use the original viewport-sized painting path rather than add overscan. */
export function corkPanPadding(width: number, height: number, dpr: number): number {
  if (![width, height, dpr].every((n) => Number.isFinite(n) && n > 0)) return 0;
  return (width + 256) * (height + 256) * dpr * dpr * 4 * 3 <= 128 * 1024 * 1024
    ? 128 : 0;
}

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
/**
 * What the surface is currently made of — T-408.
 *
 * A parameter on every generator below rather than a constant, because a tint
 * that reached the flat fill and not the flecks would be a beige board with
 * coloured dust on it.
 *
 * Everything else in this file — the fleck tints, the 0.98 on blue, the pit and
 * dust ratios — was tuned against `natural`, which is what `lib/palette.ts`
 * still holds it as. Those numbers are *ratios* of the base and not absolutes,
 * which is exactly what makes tinting possible at all: multiply the base and
 * the granules, the pale dust and the pits all move with it.
 */
type Base = { readonly r: number; readonly g: number; readonly b: number };

/**
 * Pinholes — DESIGN section 4.2, "faint accumulated pinholes near where pins
 * are", and the one layer here that is a *place* rather than a tile.
 *
 * Everything else on the cork repeats indefinitely because the board is
 * unbounded and there is nothing to anchor a picture to. A pinhole has
 * somewhere to be, so this layer is a canvas the size of the viewport rather
 * than a background-position, and it is the only cork layer an export cannot
 * fill with a pattern.
 *
 * The section used to ask for holes near where pins "are **and have been**",
 * which was struck on Q-178: removing a pin is a hard `Y.Map` delete, there is
 * no `deletedAt` and no tombstone a renderer is allowed to read, and the local
 * mirror drops its empty sets on purpose so that "a board that has had pins
 * added and removed all afternoon does not accumulate empty sets". Nothing on
 * this board remembers a pin that is gone, and the three ways to make it
 * remember were a schema change that only grows, a local record that would
 * make two peers see two different corks, or a hash of position that would not
 * be history anyway.
 */

/** The sprite is baked square at this many pixels. */
const PINHOLE_PX = 32;
/** Board units that square covers when blitted. The pit is about a sixth of it. */
const PINHOLE_UNITS = 9;
/** How far from its pin a hole may sit, in board units. */
const PINHOLE_SPREAD = 20;
/** Holes per pin, inclusive. Two is a pair, five is a patch. */
const PINHOLE_MIN = 2;
const PINHOLE_MAX = 5;
/** Distinct baked sprites. Four is enough that a patch does not read as stamped. */
const PINHOLE_VARIANTS = 4;
/** See [`pinholeLod`] — a later band than the grain's, for a different reason. */
const PINHOLE_FADE_OUT = 0.35;
const PINHOLE_FADE_IN = 0.85;

/**
 * The warm brown every shadow in the application is drawn from, matching
 * `--shadow-warm` in `base.css`. Never black — DESIGN section 4.1.
 */
const SHADOW_WARM = "38, 24, 12";
/**
 * How far the lip of a hole is lifted toward white, per channel — T-408.
 *
 * The lip catches the light: cork, lifted, not white. It was a single baked
 * colour (`232, 208, 172`) until the board could be tinted, at which point a
 * warm cream ring on a slate board gave it away — a hole punched in a surface
 * that was not the surface.
 *
 * Per channel and not one factor, because the original was a *warm* lightening
 * rather than a mix toward white: the blue rises least, which is what makes the
 * lip read as lit bark instead of lit paper. These three numbers reproduce that
 * colour exactly from the natural base, so an unpainted board is unchanged to
 * the byte, and any other base is lifted the same way.
 */
const CORK_LIP_LIFT = { r: 0.72, g: 0.624, b: 0.515 };

/** The lip colour for a given surface, as the `r, g, b` a gradient stop wants. */
function corkLip(base: Base): string {
  const lift = (c: number, t: number): number => Math.round(c + (255 - c) * t);
  return `${lift(base.r, CORK_LIP_LIFT.r)}, ${lift(base.g, CORK_LIP_LIFT.g)}, ${lift(base.b, CORK_LIP_LIFT.b)}`;
}

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

/**
 * Pinhole opacity for a zoom level, and it fades out *later* than the grain.
 *
 * Not the same band, because the two vanish for opposite reasons. Grain goes
 * because its 512-unit tile starts to read as wallpaper — a fact about the
 * repeat, not about the size of a fleck. A pinhole has no repeat and is simply
 * two board units across: at the 29% the board fits to on opening it is six
 * tenths of a pixel, which is not a faint mark but a grey smear over the cork.
 * DESIGN section 6.6's rule, applied to the smallest thing on the board —
 * below a threshold, stop drawing what cannot be seen.
 *
 * So they are a detail you find on the way in rather than one the board wears
 * from across the room, which is also true of the real thing.
 */
export function pinholeLod(zoom: number): number {
  if (zoom >= PINHOLE_FADE_IN) return 1;
  if (zoom <= PINHOLE_FADE_OUT) return 0;
  const t = (zoom - PINHOLE_FADE_OUT) / (PINHOLE_FADE_IN - PINHOLE_FADE_OUT);
  return smoothstep(t);
}

/**
 * Where one pin's holes sit, relative to it, in board units.
 *
 * **Near a pin, not under it.** A hole directly beneath a pin is a hole nobody
 * can see, because the pin is on top of it — so the mark this draws is the
 * scatter of near misses and second thoughts around a pin rather than the one
 * it is standing in. That is what the accumulation in DESIGN section 4.2 looks
 * like on a real board: not one clean puncture, but a patch of them.
 *
 * Deterministic from the board seed and the pin's id, so it is the same patch
 * on every peer and after every reload, and a pin that is dragged carries its
 * patch with it. That last part is a small lie about cork — a real hole stays
 * where the cork was pierced — and it is the lie the alternative costs too
 * much to avoid: a hole that stayed would be a record of where a pin *had
 * been*, and there is nowhere on this board to keep one (Q-178).
 */
export function pinholesFor(seed: number, pinId: string): Pinhole[] {
  const count =
    PINHOLE_MIN + Math.floor(valueAt(seed, `holes:${pinId}`) * (PINHOLE_MAX - PINHOLE_MIN + 1));
  const out: Pinhole[] = [];
  for (let i = 0; i < count; i++) {
    const angle = valueAt(seed, `hole-a:${pinId}`, i) * Math.PI * 2;
    // Square-rooted so the patch is evenly covered rather than crowded at the
    // pin: a uniform radius puts half the holes in the inner quarter of the
    // disc, which reads as a ring of dirt round the pin instead of a scatter.
    const radius = Math.sqrt(valueAt(seed, `hole-r:${pinId}`, i)) * PINHOLE_SPREAD;
    out.push({
      dx: Math.cos(angle) * radius,
      dy: Math.sin(angle) * radius,
      variant: Math.floor(valueAt(seed, `hole-v:${pinId}`, i) * PINHOLE_VARIANTS),
    });
  }
  return out;
}

/** One hole, as an offset from its pin. */
export interface Pinhole {
  readonly dx: number;
  readonly dy: number;
  readonly variant: number;
}

/**
 * One baked hole. DESIGN section 4.2 budgets "one extra sprite layer" and this
 * is the sprite — drawn once at construction and blitted, never a per-frame
 * gradient, which is section 4's governing principle: fidelity comes from
 * baking, not from per-frame effects.
 *
 * ## Which side is lit
 *
 * A pit is not a bump, and getting this backwards is the fastest way to make a
 * surface look wrong (DESIGN section 4.1: "nothing else breaks it as fast as
 * one element lit from the wrong side"). The light is from the upper left,
 * about 30 degrees off vertical. It falls *into* the hole and lands on the
 * inside wall that faces it — which is the **lower-right** wall. The upper-left
 * inside wall is the one in shadow, and it is the one nearest the light.
 *
 * So: the dark is up-left and the lit lip is down-right, which is the mirror
 * image of every item shadow in the application, and correctly so.
 */
function pinholeSprite(seed: number, variant: number, px: number, base: Base): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(px);
  const rng = mulberry32(saltedVariant(seed, variant));
  const c = px / 2;
  // The pit, as a fraction of the sprite. The rest of the sprite is the halo
  // and the margin that keeps a scaled blit off its own edge.
  // About 2.5 board units across, which is a pushpin. Measured back off the
  // screen rather than chosen: at the first pass the pit was half again this
  // and 0.62 dark, and it sampled at luminance 74 against cork at 148 — a hole
  // punched clean through a sheet of cork rather than the *faint* mark the
  // section asks for. These numbers put it near 110, a quarter down on the
  // surface instead of a half.
  const pit = px * (0.12 + rng() * 0.05);
  const offset = pit * 0.45;

  // The bruise: cork compressed around the puncture, wider and much fainter
  // than the hole itself.
  const halo = ctx.createRadialGradient(c, c, pit * 0.5, c, c, pit * 2.6);
  halo.addColorStop(0, `rgba(${SHADOW_WARM}, 0.1)`);
  halo.addColorStop(1, `rgba(${SHADOW_WARM}, 0)`);
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, px, px);

  // The hole. The focus is offset up-left, so the darkest part of the pit is
  // the wall the light cannot reach.
  const hole = ctx.createRadialGradient(c - offset, c - offset, 0, c, c, pit);
  hole.addColorStop(0, `rgba(${SHADOW_WARM}, 0.42)`);
  hole.addColorStop(0.72, `rgba(${SHADOW_WARM}, 0.27)`);
  hole.addColorStop(1, `rgba(${SHADOW_WARM}, 0)`);
  ctx.fillStyle = hole;
  ctx.beginPath();
  ctx.arc(c, c, pit, 0, Math.PI * 2);
  ctx.fill();

  // The lit lip, down-right, inside the rim. A stroke rather than a fill
  // because what catches the light is the wall, and a wall seen from above is
  // an arc. It carries more of the read than its alpha suggests: with the pit
  // softened, this is most of what says pit rather than speck.
  ctx.strokeStyle = `rgba(${corkLip(base)}, 0.34)`;
  ctx.lineWidth = Math.max(0.6, pit * 0.32);
  ctx.beginPath();
  ctx.arc(c, c, pit * 0.86, -0.35, Math.PI * 0.72);
  ctx.stroke();

  return canvas;
}

/** A fourth derived stream, in the convention the three tiles already use. */
function saltedVariant(seed: number, variant: number): number {
  return (seed ^ 0xc2b2ae35 ^ Math.imul(variant + 1, 0x27d4eb2f)) >>> 0;
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
function grainTile(seed: number, size: number, base: Base): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(size);
  const rng = mulberry32(seed);
  const field = fbm(size, 4, 3, rng);
  const image = ctx.createImageData(size, size);
  const data = image.data;

  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    // Quieter local contrast keeps writing ahead of the surface (D-77).
    const region = 0.90 + field[i]! * 0.20;
    const speck = 0.947 + rng() * 0.106;
    const k = region * speck;
    data[p] = Math.min(255, base.r * k);
    data[p + 1] = Math.min(255, base.g * k);
    data[p + 2] = Math.min(255, base.b * k * 0.98);
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
    const alpha = 0.038 + rng() * 0.122;
    ctx.fillStyle = `rgba(${Math.round(base.r * tint)},${Math.round(
      base.g * tint,
    )},${Math.round(base.b * tint)},${alpha.toFixed(3)})`;

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

/**
 * What the pinhole layer needs of a pin, and no more.
 *
 * Structural rather than `PinNode` from `state/scene.ts` deliberately: this
 * file's whole import list is two modules, and a background has no business
 * knowing what a pin *is*. A world position and something stable to seed from
 * is the entire question it asks.
 */
export interface PinPoint {
  readonly id: string;
  /** World position, as the LAYOUT phase resolved it. */
  readonly wx: number;
  readonly wy: number;
}

export class Cork {
  private readonly layers: CorkLayer[];
  private readonly host: HTMLElement;
  private readonly seed: number;
  private readonly holePatterns = new Map<string, readonly Pinhole[]>();
  private writtenVersion = -1;
  private panOrigin: { x: number; y: number; zoom: number; width: number; height: number; dpr: number } | null = null;
  private lastCameraMove = 0;
  private lastZoom = Number.NaN;

  /** The pinhole layer, and the sprites it blits. */
  private readonly holes: HTMLCanvasElement;
  private readonly holeCtx: CanvasRenderingContext2D | null;
  private readonly sprites: HTMLCanvasElement[];
  private readonly pins: () => Iterable<PinPoint>;
  /**
   * What this board is made of — T-408.
   *
   * Held on the instance rather than read from the document on each use, for
   * the reason `pins` is a function and this is not: the pins change constantly
   * and the colour changes when somebody chooses one. `paint` is the only thing
   * that moves it, and it is the only thing that re-generates the tiles.
   */
  private base: Base;

  /** The flat colour under everything, as CSS. The grain fades out at low zoom
   *  (`grainLod`), so this is what the board actually *is* from across the
   *  room — and it is why a tint that only reached the bitmap would vanish
   *  exactly where the board is most visible. */
  /** The pinhole sprites, baked from the surface they are holes in. Cheap
   *  beside the tiles: four small canvases against a million-pixel loop. */
  private bakeSprites(): void {
    this.sprites.length = 0;
    for (let v = 0; v < PINHOLE_VARIANTS; v++) {
      this.sprites.push(pinholeSprite(this.seed, v, PINHOLE_PX, this.base));
    }
  }

  private get flat(): string {
    return `rgb(${this.base.r} ${this.base.g} ${this.base.b})`;
  }

  /**
   * Paint the cork a different colour — T-408.
   *
   * **The one thing that re-generates the tiles after construction**, and the
   * header of `generate` explains why that is a sentence worth being careful
   * about: cork generation is a million-pixel loop and ten thousand ellipse
   * fills, and T-88 caught it hitching the main thread when it was wired to
   * every gesture end. It is safe here because choosing a colour is a thing a
   * person does deliberately and rarely, not something a camera does.
   *
   * A no-op when the colour has not moved, so a `meta` observer firing for the
   * board's title — or for a peer's edit to anything else in that map — costs
   * one comparison rather than a re-raster.
   */
  paint(cork: string | null): void {
    const next = corkColorOf(cork).base;
    if (next.r === this.base.r && next.g === this.base.g && next.b === this.base.b) return;
    this.base = next;
    // The pinholes too, and forgetting them is exactly the bug this feature
    // would otherwise have shipped: the lip of a hole is the surface *lifted*,
    // so a board repainted without re-baking these wears cream rings punched in
    // slate — a hole in a surface that is not the surface.
    this.bakeSprites();
    // The flat fill first and on this very frame: the bitmaps arrive
    // asynchronously through `toBlob`, so without this the board would hold the
    // old colour until the encoder came back — a visible beat between choosing
    // and seeing, on the one action whose whole point is to be seen.
    this.host.style.background = this.flat;
    this.generate();
  }

  /**
   * `pins` is a function rather than a value because the cork outlives every
   * pin on the board and is constructed before most of them exist. It is read
   * on the frames that need it and never held.
   */
  constructor(
    host: HTMLElement,
    seed: number,
    pins: () => Iterable<PinPoint> = () => [],
    cork: string | null = null,
  ) {
    this.host = host;
    this.seed = seed;
    this.pins = pins;
    this.base = corkColorOf(cork).base;

    // The flat cork colour belongs to the container, not to the grain bitmap.
    // The grain fades out at low zoom (see grainLod), and if the base colour
    // faded with it the board would turn into whatever is behind it.
    host.style.background = this.flat;

    const grain = document.createElement("div");
    grain.className = "cork-layer cork-grain";
    const blotch = document.createElement("div");
    blotch.className = "cork-layer cork-blotch";
    const light = document.createElement("div");
    light.className = "cork-layer cork-light";
    // Under the light and over the blotch: a hole is in the surface, so the
    // room's lighting falls across it like it falls across everything else.
    this.holes = document.createElement("canvas");
    this.holes.className = "cork-holes";
    this.holeCtx = this.holes.getContext("2d");
    this.sprites = [];
    this.bakeSprites();

    const vignette = document.createElement("div");
    // Viewport-anchored, so it takes no camera update at all.
    vignette.className = "cork-vignette";

    host.append(grain, blotch, this.holes, light, vignette);

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
   * Panning translates the buffered surface without changing its scale. Every
   * zoom change resets `background-size` to the exact camera scale, so the
   * browser rasterises the original tile at the size it is actually painting. The only thing
   * tile resolution buys is sharpness under upscale, and the spike showed a
   * 512-pixel tile reads correctly as cork at the 400% ceiling — which is
   * unsurprising for a texture whose entire content is noise.
   */
  private generation: Promise<void> = Promise.resolve();
  private generationId = 0;

  private generate(): void {
    const generationId = ++this.generationId;
    const bitmaps = [
      grainTile(this.seed, GRAIN_PX, this.base),
      blotchTile(this.seed, BLOTCH_PX),
      lightTile(this.seed, LIGHT_PX),
    ];
    // An export can be requested before the asynchronous PNG encoders finish.
    // Ignore old colour generations which complete after a newer choice.
    this.generation = Promise.all(this.layers.map((layer, i) => new Promise<void>((resolve) => {
      bitmaps[i]!.toBlob((blob) => {
        if (blob && generationId === this.generationId) {
          const previous = layer.url;
          layer.url = URL.createObjectURL(blob);
          layer.el.style.backgroundImage = "url(" + layer.url + ")";
          if (previous) URL.revokeObjectURL(previous);
        }
        resolve();
      }, "image/png");
    }))).then(() => undefined);
    // Force the position write through on the next apply().
    this.writtenVersion = -1;
  }

  /**
   * DOM phase (5). Anchors every layer to the world.
   *
   * `pinsMoved` is the one thing the tiled layers never needed: they are a
   * function of the camera alone, so a camera version was the whole of their
   * dirty check. A hole is somewhere, so this layer also has to redraw when a
   * pin arrives, is dragged, or is taken out — and when an *item* moves, which
   * carries every pin parented to it. The caller owns that question because
   * the caller is holding the frame's dirty sets.
   */
  apply(camera: Camera, pinsMoved = false): void {
    const dpr = window.devicePixelRatio || 1;
    const origin = this.panOrigin;
    const cameraMoved = camera.version !== this.writtenVersion;
    const surfaceChanged = origin !== null &&
      (origin.width !== camera.width || origin.height !== camera.height || origin.dpr !== dpr);
    if (cameraMoved || surfaceChanged) {
      const force = this.writtenVersion === -1 || surfaceChanged;
      this.writtenVersion = camera.version;
      this.lastCameraMove = performance.now();
      const z = camera.zoom;
      const ox = -camera.x * z;
      const oy = -camera.y * z;
      // A scale change cannot reuse rasterised pixels. Keep zoom painting at
      // viewport size; overscan pays for itself only during translation.
      const zooming = Number.isFinite(this.lastZoom) && this.lastZoom !== z;
      this.lastZoom = z;
      const pad = zooming ? 0 : corkPanPadding(camera.width, camera.height, dpr);
      const rebase = force || origin === null || pad === 0 || origin.zoom !== z ||
        Math.abs(ox - origin.x) > pad || Math.abs(oy - origin.y) > pad;
      if (rebase) {
        this.panOrigin = pad > 0
          ? { x: ox, y: oy, zoom: z, width: camera.width, height: camera.height, dpr }
          : null;
        for (const layer of this.layers) {
          const size = layer.tile * z;
          layer.el.style.inset = pad > 0 ? `-${pad}px` : "";
          layer.el.style.willChange = pad > 0 ? "transform" : "";
          layer.el.style.backgroundSize = `${size}px ${size}px`;
          layer.el.style.backgroundPosition = `${ox + pad}px ${oy + pad}px`;
          if (layer.lod) layer.el.style.opacity = grainLod(z).toFixed(3);
        }
      }
      const anchor = this.panOrigin;
      for (const layer of this.layers) {
        layer.el.style.transform = anchor === null ? "" :
          `translate(${ox - anchor.x}px, ${oy - anchor.y}px)`;
      }
    } else if (origin !== null && performance.now() - this.lastCameraMove >= 120) {
      // Release both the promotion hint and overscan, once, after settling.
      for (const layer of this.layers) {
        layer.el.style.backgroundPosition = `${-camera.x * camera.zoom}px ${-camera.y * camera.zoom}px`;
        layer.el.style.inset = "";
        layer.el.style.transform = "";
        layer.el.style.willChange = "";
      }
      this.panOrigin = null;
    }
    if (cameraMoved || surfaceChanged || pinsMoved) this.paintHoles(camera);
  }

  /** Geometry is stable for this board seed; bound retained patterns even after pin churn. */
  private holesFor(id: string): readonly Pinhole[] {
    const existing = this.holePatterns.get(id);
    if (existing) return existing;
    const pattern = pinholesFor(this.seed, id);
    if (this.holePatterns.size >= 1024) {
      const oldest = this.holePatterns.keys().next().value;
      if (oldest !== undefined) this.holePatterns.delete(oldest);
    }
    this.holePatterns.set(id, pattern);
    return pattern;
  }

  /**
   * Redraw the pinhole canvas for where the camera is now.
   *
   * A clear and a blit per hole. Unlike the repeating textures, holes must
   * follow their individual world positions each frame. Their sprites are
   * baked once, so this loop only copies them.
   *
   * Off-screen holes are skipped rather than clipped. A board can hold any
   * number of pins and only the ones in front of you cost anything.
   */
  private paintHoles(camera: Camera): void {
    const ctx = this.holeCtx;
    if (ctx === null) return;

    // Camera dimensions are already recorded on resize. DOM geometry reads here
    // flush pending item/LOD styles in the middle of the write phase (T-421).
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(camera.width * dpr));
    const h = Math.max(1, Math.round(camera.height * dpr));
    if (this.holes.width !== w || this.holes.height !== h) {
      this.holes.width = w;
      this.holes.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const lod = pinholeLod(camera.zoom);
    if (lod <= 0) return;

    ctx.globalAlpha = lod;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const size = PINHOLE_UNITS * camera.zoom;
    const half = size / 2;
    const width = camera.width;
    const height = camera.height;

    for (const pin of this.pins()) {
      // A patch is at most `PINHOLE_SPREAD` across, so a pin that far outside
      // the viewport has nothing inside it. One comparison rejects the whole
      // patch rather than four per hole.
      const px = (pin.wx - camera.x) * camera.zoom;
      const py = (pin.wy - camera.y) * camera.zoom;
      const reach = (PINHOLE_SPREAD + PINHOLE_UNITS) * camera.zoom;
      if (px < -reach || py < -reach || px > width + reach || py > height + reach) continue;

      for (const hole of this.holesFor(pin.id)) {
        const sprite = this.sprites[hole.variant % this.sprites.length];
        if (sprite === undefined) continue;
        ctx.drawImage(
          sprite,
          px + hole.dx * camera.zoom - half,
          py + hole.dy * camera.zoom - half,
          size,
          size,
        );
      }
    }
    ctx.globalAlpha = 1;
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
    await this.generation;
    const { width, height } = ctx.canvas;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.flat;
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

    // The pinholes, which are the one cork layer that is not a `CorkFill`: a
    // pattern needs a period and a hole has a place instead. Drawn here rather
    // than skipped because a board exported without them is a board with pins
    // standing on unmarked cork, and the whole of the detail is that they are
    // not.
    ctx.globalCompositeOperation = "source-over";
    const lod = pinholeLod(camera.zoom);
    if (lod > 0) {
      ctx.globalAlpha = lod;
      const size = PINHOLE_UNITS * camera.zoom;
      const half = size / 2;
      const reach = (PINHOLE_SPREAD + PINHOLE_UNITS) * camera.zoom;
      for (const pin of this.pins()) {
        const px = (pin.wx - camera.x) * camera.zoom;
        const py = (pin.wy - camera.y) * camera.zoom;
        if (px < -reach || py < -reach || px > width + reach || py > height + reach) continue;
        for (const hole of this.holesFor(pin.id)) {
          const sprite = this.sprites[hole.variant % this.sprites.length];
          if (sprite === undefined) continue;
          ctx.drawImage(
            sprite,
            px + hole.dx * camera.zoom - half,
            py + hole.dy * camera.zoom - half,
            size,
            size,
          );
        }
      }
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
    this.holePatterns.clear();
    this.generationId += 1;
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
