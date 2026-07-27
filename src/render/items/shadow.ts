/**
 * Item shadows, and the one light.
 *
 * > One global light direction, roughly from the upper left, about 30° off
 * > vertical. Every shadow in the application agrees with it — items, pins,
 * > string, the cork's own surface variation. Nothing else creates a sense of
 * > a real surface as cheaply, and nothing else breaks it as fast as one
 * > element lit from the wrong side. — DESIGN section 4.1
 *
 * So the light lives here, exported, and pins (T-34), string (T-46) and the
 * cork all take it from this module rather than each choosing their own.
 *
 * ## Why a sprite and not a shadow property
 *
 * > **No `box-shadow` or `filter: drop-shadow` on items.** `drop-shadow` is
 * > CPU-rasterised and catastrophic across hundreds of nodes; `box-shadow` is
 * > acceptable when static but interacts badly with rotation and can't be
 * > animated. Everything uses pre-baked nine-slice shadow sprites per
 * > archetype and elevation. — DESIGN section 9.4
 *
 * A nine-slice is exactly what CSS `border-image` does, so a single generated
 * bitmap stretches to any item size with no per-item cost and no filter in the
 * paint path. Two sprites are baked for the whole board — resting and lifted —
 * and every item on the cork shares them.
 */

import { rotateIn, type Point } from "@/lib/rotate";

/** Radians, measured from straight down, leaning to the right. */
export const LIGHT_ANGLE = (30 * Math.PI) / 180;

/** Unit vector from an object toward its shadow. */
export const LIGHT_DX = Math.sin(LIGHT_ANGLE);
export const LIGHT_DY = Math.cos(LIGHT_ANGLE);

export type Elevation = "rest" | "lift";

interface Recipe {
  /** Gaussian radius, board units. */
  blur: number;
  /** How far the shadow is displaced along the light, board units. */
  offset: number;
  alpha: number;
}

/**
 * Lifting widens and softens the shadow and drops its alpha — the item is
 * being carried, not teleported (DESIGN section 3.2).
 */
const RECIPES: Record<Elevation, Recipe> = {
  rest: { blur: 5, offset: 3.5, alpha: 0.34 },
  lift: { blur: 16, offset: 12, alpha: 0.22 },
};

/**
 * How far an item lying on the cork is off it, board units.
 *
 * Exported because a string draped over a photograph is lifted by the thickness
 * of that photograph, and `render/ropes/paint.ts` has to displace its shadow by
 * the same amount or the two disagree — a string whose shadow says it is
 * further off the cork than the paper it is lying on.
 */
export const RESTING_LIFT = RECIPES.rest.offset;

/**
 * Never black. "Shadow colour is never black. It's a desaturated warm brown
 * drawn from the cork, at low alpha." (DESIGN section 4.1)
 */
const SHADOW_RGB = "38, 24, 12";

/** Stretchable middle of the nine-slice, in sprite pixels. */
const CENTRE = 24;

/**
 * How far past its own rectangle an item's shadow reaches, in board units:
 * the widest sprite's visible blur plus its displacement along the light.
 *
 * Culling pads item bounds by this — DESIGN section 9.1 asks for bounds that are
 * "rotation-expanded and shadow-padded". An item whose own rectangle has just
 * left the screen can still be casting a shadow onto it, and unmounting it would
 * pop that shadow out of existence at the viewport edge.
 *
 * Derived from the recipes rather than written down, so a softer `lift` bake
 * cannot silently outgrow the padding that hides it.
 */
export const SHADOW_PAD = Math.max(
  ...Object.values(RECIPES).map((recipe) => Math.ceil(recipe.blur * 3) + recipe.offset),
);

export interface ShadowSprite {
  url: string;
  /** Border width and slice, in board units. */
  slice: number;
  offsetX: number;
  offsetY: number;
}

const cache = new Map<Elevation, ShadowSprite>();

export function shadowSprite(elevation: Elevation): ShadowSprite {
  const cached = cache.get(elevation);
  if (cached) return cached;

  const recipe = RECIPES[elevation];
  // Three sigma covers the visible extent of a Gaussian; past that the sprite
  // is transparent pixels nobody sees.
  const slice = Math.ceil(recipe.blur * 3);
  const size = slice * 2 + CENTRE;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { url: "", slice, offsetX: 0, offsetY: 0 };

  ctx.filter = `blur(${recipe.blur}px)`;
  ctx.fillStyle = `rgba(${SHADOW_RGB}, ${recipe.alpha})`;
  // Inset by a hair so the blur has somewhere to fall inside the sprite.
  ctx.fillRect(slice, slice, CENTRE, CENTRE);

  const sprite: ShadowSprite = {
    url: canvas.toDataURL("image/png"),
    slice,
    offsetX: LIGHT_DX * recipe.offset,
    offsetY: LIGHT_DY * recipe.offset,
  };
  cache.set(elevation, sprite);
  return sprite;
}

/**
 * The shadow element lives *inside* the item, so its silhouette rotates with
 * the item — the shadow of a tilted card is a tilted card. But the
 * displacement must not rotate, or each item would appear lit from its own
 * private direction. So the offset is counter-rotated out of the item's frame
 * before it is written.
 */
export function counterRotate(dx: number, dy: number, rot: number): Point {
  // The same inverse rotation the hit test uses, about the origin rather than
  // about an item's centre — a direction has no centre.
  return rotateIn(dx, dy, 0, 0, Math.cos(rot), Math.sin(rot));
}
