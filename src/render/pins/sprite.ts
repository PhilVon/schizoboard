/**
 * What a pin looks like.
 *
 * > Pushpins are the default: a coloured spherical head with a specular
 * > highlight positioned per the global light, a visible metal shaft where it
 * > meets the surface, and its own small hard shadow. Thumbtacks and nails are
 * > alternatives. — DESIGN section 4.5
 *
 * Baked to a data URL per kind and colour, cached forever, exactly as
 * `render/items/shadow.ts` bakes the item shadows — and for the same reason.
 * A pin drawn with `box-shadow` and a `radial-gradient` would be three paint
 * layers per pin per frame on a layer that moves with the camera; a bitmap is
 * one. There are hundreds of pins on a full board and every one of them moves
 * on every pan.
 *
 * ## Where the anchor is
 *
 * The centre of the sprite is the pin's board position — the head's centre,
 * not the point where the shaft enters the cork. That is a deliberate reading
 * of AC-59, "string attachment point draws under the pin head": a string ends
 * at the pin's position, the pins layer sits above both rope canvases (DESIGN
 * section 6.2), and an opaque head centred on that position is what makes the
 * string genuinely appear to pass beneath it. Anchoring at the shaft instead
 * would leave every string ending in open cork just below the head.
 *
 * The shaft is therefore drawn *below* the anchor and under the head, as the
 * sliver of metal you see between a pushpin's head and the board. The whole
 * pin is lit from one direction and only one: `LIGHT_ANGLE`, shared with the
 * item shadows, because "nothing breaks it as fast as one element lit from the
 * wrong side" (section 4.1).
 */

import { LIGHT_ANGLE, LIGHT_DX, LIGHT_DY } from "@/render/items/shadow";

export type PinKind = "pushpin" | "thumbtack" | "nail";

/**
 * Sprite resolution, device pixels.
 *
 * Chosen against the ceiling rather than the nominal size: `MAX_PIN_PX` at a
 * device pixel ratio of 2 is 112, so a pin is never scaled up past what it was
 * baked at and never needs re-rastering on zoom the way ink and photographs do.
 * A pin is small; paying for the biggest one it can ever be costs a 128px
 * canvas, once, per colour on the board.
 */
const BAKE = 128;

/** Never black — the same warm brown every other shadow in the board uses. */
const SHADOW_RGB = "38, 24, 12";

/**
 * Head radius as a fraction of the sprite box. A thumbtack is broader and
 * flatter than a pushpin; a nail is a tack you can barely see.
 *
 * Well under a third, and that is the box being sized by what has to fit in
 * it rather than by the head: the shaft runs the better part of two head
 * radii below the centre and the cast shadow the better part of two to the
 * side of it, and either one clipped at the sprite edge is a pin that stops
 * halfway. `PIN_BOARD_SIZE` is scaled to match, so the head comes out the
 * same size on screen as if the box were tight around it.
 */
const HEAD_RADIUS: Record<PinKind, number> = {
  pushpin: 0.26,
  thumbtack: 0.3,
  nail: 0.14,
};

/**
 * The largest head any kind has, as a fraction of the sprite box. The hit
 * radius is derived from this rather than from the kind under the cursor, so
 * that reaching for a nail and reaching for a pushpin take the same aim.
 */
export const HEAD_FRACTION = Math.max(...Object.values(HEAD_RADIUS));

/** Fallback for a colour no version of any client can parse. Matches the
 *  schema's own default, so a malformed pin looks like an ordinary one. */
const DEFAULT_COLOR = { r: 200, g: 53, b: 47 };

/** A nail is steel and stays steel; its `color` field is not a lie, it is
 *  simply not what a nail is made of. */
const STEEL = { r: 176, g: 178, b: 184 };

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseColor(hex: string): Rgb {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) {
    return {
      r: parseInt(short[1]! + short[1]!, 16),
      g: parseInt(short[2]! + short[2]!, 16),
      b: parseInt(short[3]! + short[3]!, 16),
    };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!long) return DEFAULT_COLOR;
  return {
    r: parseInt(long[1]!, 16),
    g: parseInt(long[2]!, 16),
    b: parseInt(long[3]!, 16),
  };
}

/** `t` above zero lifts towards white, below zero sinks towards black. */
function shade({ r, g, b }: Rgb, t: number): string {
  const mix = (c: number): number =>
    Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

export interface PinSprite {
  /** Empty when there is no 2D context — the caller draws nothing rather than
   *  pointing an element at a broken URL. */
  url: string;
}

const cache = new Map<string, PinSprite>();

/**
 * Colours come from a palette in practice, so this is a handful of entries.
 * The cap is a backstop against a peer that writes a fresh colour per pin,
 * which would otherwise grow a data URL per pin and never let one go.
 */
const CACHE_LIMIT = 64;

export function pinSprite(kind: PinKind, color: string): PinSprite {
  const key = `${kind}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const sprite = bake(kind, color);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, sprite);
  return sprite;
}

function bake(kind: PinKind, color: string): PinSprite {
  const canvas = document.createElement("canvas");
  canvas.width = BAKE;
  canvas.height = BAKE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { url: "" };

  const c = BAKE / 2;
  const head = BAKE * HEAD_RADIUS[kind];
  const rgb = kind === "nail" ? STEEL : parseColor(color);

  // 1. The shadow. Hard rather than soft: a pin sits *on* the surface with no
  //    gap under it, so its shadow has a defined edge — which is also what
  //    stops a pin reading as floating above the photograph it holds.
  //
  //    Displaced by most of a head radius, because at rest almost all of it
  //    hides behind the head it belongs to and a pin with no visible shadow
  //    reads as a bead lying on the paper rather than as something pushed
  //    through it. Squashed across the light, the way a shadow on a surface is.
  ctx.save();
  ctx.filter = `blur(${(head * 0.13).toFixed(2)}px)`;
  ctx.fillStyle = `rgba(${SHADOW_RGB}, 0.52)`;
  ctx.beginPath();
  ctx.ellipse(
    c + LIGHT_DX * head * 0.95,
    c + LIGHT_DY * head * 0.95,
    head * 0.85,
    head * 0.6,
    LIGHT_ANGLE,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();

  // 2. The shaft, below the head and covered by it. Straight down rather than
  //    along the light: the pin is vertical in the board, and it is the
  //    *shadow* that tells you where the light is.
  drawShaft(ctx, c, head, kind);

  // 3. The head.
  if (kind === "thumbtack") drawTack(ctx, c, head, rgb);
  else drawDome(ctx, c, head, rgb);

  // 4. The specular, on the side the light comes from — which is the opposite
  //    side from the shadow, and the one line that makes the head read as
  //    round rather than as a circle.
  const sx = c - LIGHT_DX * head * 0.4;
  const sy = c - LIGHT_DY * head * 0.4;
  const spec = ctx.createRadialGradient(sx, sy, 0, sx, sy, head * 0.34);
  spec.addColorStop(0, "rgba(255, 255, 255, 0.85)");
  spec.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = spec;
  ctx.beginPath();
  ctx.arc(sx, sy, head * 0.34, 0, Math.PI * 2);
  ctx.fill();

  return { url: canvas.toDataURL("image/png") };
}

function drawShaft(
  ctx: CanvasRenderingContext2D,
  c: number,
  head: number,
  kind: PinKind,
): void {
  const width = head * (kind === "nail" ? 0.36 : 0.44);
  // Measured from the head's *centre*, so the visible part is whatever is left
  // after a head radius — which is why these are all comfortably over 1. A nail
  // is mostly shaft; a tack is mostly head.
  const length = head * (kind === "nail" ? 2.4 : kind === "thumbtack" ? 1.55 : 1.85);
  const steel = ctx.createLinearGradient(c - width / 2, 0, c + width / 2, 0);
  // Dark on both edges and bright down the middle: a cylinder, and enough
  // contrast to still read as metal against a sheet of cream paper.
  steel.addColorStop(0, "#5c5e63");
  steel.addColorStop(0.36, "#dfe2e7");
  steel.addColorStop(1, "#6a6c71");
  ctx.fillStyle = steel;
  ctx.beginPath();
  // Tapered to a point, because the bottom of it is going into the cork.
  ctx.moveTo(c - width / 2, c);
  ctx.lineTo(c + width / 2, c);
  ctx.lineTo(c + width * 0.16, c + length);
  ctx.lineTo(c - width * 0.16, c + length);
  ctx.closePath();
  ctx.fill();
}

/** A pushpin's or a nail's head: a sphere lit from one side. */
function drawDome(ctx: CanvasRenderingContext2D, c: number, head: number, rgb: Rgb): void {
  const gx = c - LIGHT_DX * head * 0.34;
  const gy = c - LIGHT_DY * head * 0.34;
  const fill = ctx.createRadialGradient(gx, gy, head * 0.05, gx, gy, head * 1.45);
  fill.addColorStop(0, shade(rgb, 0.42));
  fill.addColorStop(0.45, shade(rgb, 0.04));
  fill.addColorStop(1, shade(rgb, -0.45));
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(c, c, head, 0, Math.PI * 2);
  ctx.fill();

  // A dark rim, so the head has an edge against a photograph of any brightness.
  ctx.strokeStyle = `rgba(${SHADOW_RGB}, 0.34)`;
  ctx.lineWidth = Math.max(1, head * 0.07);
  ctx.beginPath();
  ctx.arc(c, c, head - ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();
}

/** A thumbtack: flat top, visible rim, and a dimple where your thumb goes. */
function drawTack(ctx: CanvasRenderingContext2D, c: number, head: number, rgb: Rgb): void {
  const flat = ctx.createLinearGradient(
    c - LIGHT_DX * head,
    c - LIGHT_DY * head,
    c + LIGHT_DX * head,
    c + LIGHT_DY * head,
  );
  flat.addColorStop(0, shade(rgb, 0.3));
  flat.addColorStop(1, shade(rgb, -0.28));
  ctx.fillStyle = flat;
  ctx.beginPath();
  ctx.arc(c, c, head, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = shade(rgb, -0.5);
  ctx.lineWidth = Math.max(1, head * 0.1);
  ctx.beginPath();
  ctx.arc(c, c, head - ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();

  const dimple = ctx.createRadialGradient(c, c, 0, c, c, head * 0.46);
  dimple.addColorStop(0, `rgba(${SHADOW_RGB}, 0.3)`);
  dimple.addColorStop(1, `rgba(${SHADOW_RGB}, 0)`);
  ctx.fillStyle = dimple;
  ctx.beginPath();
  ctx.arc(c, c, head * 0.46, 0, Math.PI * 2);
  ctx.fill();
}

/** Test seam — the cache would otherwise carry a bake between cases. */
export function clearPinSpriteCache(): void {
  cache.clear();
}
