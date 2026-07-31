/**
 * Paper: the shared texture and the per-sheet variation.
 *
 * > Paper stock varies: white, cream, yellow legal, graph, index card. Each has
 * > its own grain texture at low opacity, its own edge treatment, and its own
 * > slight colour variation across the sheet. — DESIGN section 4.4
 *
 * One grain tile is generated **per stock** and shared by every sheet of it;
 * each sheet samples that tile from a different offset derived from its seed, so
 * no two are identical and the cost is five bitmaps rather than one per item.
 *
 * Five and not one is the sentence above — "each has its own grain texture" —
 * and it is the half this file had wrong until T-222: the tile was memoised
 * into a single module variable, so whichever sheet mounted first decided the
 * fibres for every sheet on the board, and `stock` was not even a parameter.
 * Five and not five hundred is the cost: a 256px tile is a data URL of some tens
 * of kilobytes and a decode, and a board is five hundred sheets. `grainPosition`
 * is what keeps two sheets of the same stock from being the same picture.
 *
 * What is here is stock, tint and grain. The rest of what DESIGN 4.4 makes a
 * property of the stock — its edge treatment, and which side it leaves the pad
 * along — is `edge.ts`, which reads the stock this file names.
 */

import { grainOffset, mulberry32, valueAt } from "@/lib/seed";

export type PaperStock = "white" | "cream" | "legal" | "graph" | "index";

interface Stock {
  /** Base sheet colour. */
  base: string;
  /** Ruling, if any: colour and spacing in board units. */
  rule?: { color: string; spacing: number; margin?: string };
  /** What this stock's pulp looks like. See [`paperGrainUrl`]. */
  grain: Grain;
}

/**
 * The four numbers that separate one stock's fibres from another's.
 *
 * Taste calls, all of them, and they sit around the single set this file used
 * for everything rather than striking out — a machine-made bond is finer and
 * flatter than a legal pad, technical paper is smoother than either, and card
 * is dense with short fibres. Nothing here is measured and nothing can be: the
 * test below pins that the five tiles *differ*, which is the claim DESIGN 4.4
 * makes, and how much they should differ is a judgement to make on a real board.
 */
interface Grain {
  /** Peak-to-peak speckle either side of mid grey, in levels out of 255. */
  swing: number;
  /** Fibres per tile, as a multiple of the tile's width. */
  density: number;
  /** Shortest and longest fibre, in tile pixels. */
  length: readonly [number, number];
  /** How dark one fibre is. Low, always — DESIGN 4.4 says "at low opacity". */
  alpha: number;
}

/** Warm, low-chroma, and none of them pure white — paper never is. */
const STOCKS: Record<PaperStock, Stock> = {
  white: { base: "#f7f4ed", grain: { swing: 20, density: 2.4, length: [3, 11], alpha: 0.04 } },
  cream: { base: "#f2e9d6", grain: { swing: 30, density: 3.8, length: [4, 18], alpha: 0.06 } },
  legal: {
    base: "#f6efb9",
    rule: { color: "rgba(90,120,160,0.35)", spacing: 22 },
    grain: { swing: 34, density: 4.4, length: [5, 20], alpha: 0.055 },
  },
  graph: {
    base: "#f4f2e8",
    rule: { color: "rgba(120,140,120,0.28)", spacing: 14 },
    grain: { swing: 14, density: 1.3, length: [2, 8], alpha: 0.03 },
  },
  index: {
    base: "#f8f5ef",
    rule: { color: "rgba(150,120,120,0.3)", spacing: 20, margin: "rgba(190,110,110,0.5)" },
    grain: { swing: 26, density: 5, length: [2, 9], alpha: 0.05 },
  },
};

const NOTE_STOCKS: PaperStock[] = ["white", "cream", "legal", "graph"];

/**
 * Where the writing sits, so the ruling can be printed under it rather than
 * between the lines (T-182).
 *
 * > the text has to start on a line — DESIGN section 4.4, of the index card
 *
 * It did not. `.paper-text` has 14px of top padding and a 22px line box, and
 * the ruling was drawn at the *bottom* of each 22px band — so the first
 * baseline landed at 32px and the rules at 21, 43, 65, leaving the writing
 * hanging ten pixels under every line for the whole sheet. Nobody writes on a
 * legal pad like that. It predates the handwriting face: Segoe Script at 17px
 * had it too, and a bigger face only made it visible.
 *
 * The 18 is **measured, not derived** — a baseline is a property of the face,
 * and Patrick Hand's sits where it sits. Taken in the shell off an untransformed
 * `.paper-text` with the bundled font confirmed loaded, by reading the top of a
 * zero-height `vertical-align: baseline` span: 32px from the box top, of which
 * 14 is the padding. The second line measured 54, so the advance really is the
 * line box and not something the face negotiates.
 *
 * Nothing enforces the agreement with the stylesheet, and there is no honest way
 * to: these are two numbers in a CSS file that a layout would have to be read to
 * recover. If `.paper-text`'s padding or `line-height` moves, the ruling drifts
 * back out from under the writing — which is exactly T-182, and these names
 * exist so that the next person searching for why finds both ends of it.
 * `app/ingest.ts` mirrors the same two numbers for a third purpose.
 */
const TEXT_PAD_TOP = 14;
const TEXT_BASELINE_IN_LINE = 18;
const FIRST_BASELINE = TEXT_PAD_TOP + TEXT_BASELINE_IN_LINE;

/**
 * How far into a band the rule is drawn, so that a rule lands on a baseline.
 *
 * Modulo, because the band repeats from the top of the sheet: a rule at the
 * first baseline implies one every `spacing` above and below it, and the one
 * that lands in the top padding is what a pad's top rule has always been.
 *
 * Only `legal` gets *every* line on a rule, because only its spacing is the
 * line height. On `index` (20) and `graph` (14) the first line lands and the
 * rest drift, which is inherent to ruling a sheet at a spacing the writing does
 * not share — and is the half of this DESIGN 4.4 actually asks for.
 */
export function rulePhase(spacing: number): number {
  return FIRST_BASELINE % spacing;
}

/** Which stock a sheet gets when nobody has chosen one. */
export function defaultStock(type: string, seed: number): PaperStock {
  if (type === "card") return "index";
  const pick = valueAt(seed, "stock");
  return NOTE_STOCKS[Math.floor(pick * NOTE_STOCKS.length)] ?? "white";
}

export function stockBase(stock: PaperStock): string {
  return (STOCKS[stock] ?? STOCKS.white).base;
}

/**
 * The ruling, as a CSS background. Board units, so it scales with the camera
 * exactly like the sheet it is printed on.
 *
 * The horizontal rules are phased to the writing's baseline — see [`rulePhase`].
 * The vertical ones are not: a column has no baseline to meet, and the graph's
 * squares stay squares whatever their phase.
 */
export function stockRuling(stock: PaperStock): string {
  const rule = (STOCKS[stock] ?? STOCKS.white).rule;
  if (!rule) return "none";
  const at = rulePhase(rule.spacing);
  const lines = `repeating-linear-gradient(to bottom, transparent 0 ${at}px, ${rule.color} ${at}px ${at + 1}px, transparent ${at + 1}px ${rule.spacing}px)`;
  if (stock === "graph") {
    const columns = `repeating-linear-gradient(to right, transparent 0 ${rule.spacing - 1}px, ${rule.color} ${rule.spacing - 1}px ${rule.spacing}px)`;
    return `${lines}, ${columns}`;
  }
  if (rule.margin) {
    const margin = `linear-gradient(to right, transparent 0 30px, ${rule.margin} 30px 31px, transparent 31px)`;
    return `${margin}, ${lines}`;
  }
  return lines;
}

/** One tile per stock, generated on the first sheet of it to mount. */
const grainUrls = new Map<PaperStock, string>();

/**
 * A stable starting point per stock. It has only to differ between stocks —
 * there is no sheet in this, and deliberately: a tile keyed by the first
 * sheet's seed is a tile decided by mount order, which is what T-222 was.
 */
function grainSeed(stock: PaperStock): number {
  let hash = 0x9a3f1c;
  for (let i = 0; i < stock.length; i++) hash = (hash * 31 + stock.charCodeAt(i)) >>> 0;
  return hash;
}

/**
 * Fibrous grain, one tile per stock. Individual sheets shift it
 * ([`grainPosition`]) rather than each generating their own.
 *
 * Cross-hatched rather than isotropic noise, because paper has a direction to
 * it — pure per-pixel speckle reads as television static, not as pulp. What the
 * stock changes is how coarse the speckle is, how many fibres there are, how
 * long they run and how dark each one is; see [`Grain`].
 *
 * A canvas with no 2D context returns the empty string and **caches nothing**.
 * That is a browser that is out of memory or a headless one, and it is a
 * condition that passes — a tile is asked for again on the next mount, and
 * remembering a failure would leave the board with no grain for the session.
 */
export function paperGrainUrl(stock: PaperStock, size = 256): string {
  const cached = grainUrls.get(stock);
  if (cached !== undefined) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const grain = (STOCKS[stock] ?? STOCKS.white).grain;
  const rng = mulberry32(grainSeed(stock));
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    const v = 128 + (rng() - 0.5) * grain.swing;
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  // Fibres: short strokes at two shallow angles.
  const [shortest, longest] = grain.length;
  ctx.lineWidth = 1;
  for (let i = 0; i < size * grain.density; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const length = shortest + rng() * (longest - shortest);
    const angle = (rng() < 0.5 ? 0.1 : Math.PI / 2 - 0.1) + (rng() - 0.5) * 0.35;
    ctx.strokeStyle = `rgba(${rng() < 0.5 ? 90 : 200},${rng() < 0.5 ? 90 : 200},90,${grain.alpha})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }

  const url = canvas.toDataURL("image/png");
  grainUrls.set(stock, url);
  return url;
}

/** Per-sheet grain offset, so no two sheets show the same fibres. */
export function grainPosition(seed: number): string {
  const offset = grainOffset(seed);
  return `${-offset.x.toFixed(1)}px ${-offset.y.toFixed(1)}px`;
}

/**
 * A barely-there tint shift per sheet. DESIGN section 4.4 asks for "slight
 * colour variation across the sheet"; this is the across-sheets half, which
 * is what stops fifty notes reading as fifty copies of one note.
 */
export function seedTint(seed: number): string {
  return tintFilter((valueAt(seed, "tint-h") - 0.5) * 14, (valueAt(seed, "tint-l") - 0.5) * 5);
}

/**
 * A tint as the filter that applies it — hue rotation in degrees, lightness in
 * percent.
 *
 * Split out of [`seedTint`] so a chosen tint and a seeded one are formatted by
 * the same line (T-225). Two formatters would round differently, and a sheet
 * that changes shade very slightly the moment somebody first touches it is a
 * defect nobody would think to look for.
 *
 * Clamped rather than refused, to the range the seed itself draws from. A tint
 * is a *variation on the paper*: past about a half-turn of hue a sheet stops
 * reading as paper at all, and a brightness that can reach zero is a black
 * rectangle you can still select and delete but can no longer see the writing
 * on. `crdt/schema.ts` keeps non-numbers out; the taste is here.
 */
export function tintFilter(hue: number, light: number): string {
  const h = Math.min(TINT_HUE_LIMIT, Math.max(-TINT_HUE_LIMIT, hue));
  const l = Math.min(TINT_LIGHT_LIMIT, Math.max(-TINT_LIGHT_LIMIT, light));
  return `hue-rotate(${h.toFixed(2)}deg) brightness(${(1 + l / 100).toFixed(4)})`;
}

/**
 * How far a tint may go, either way.
 *
 * Four times what the seed spends — the seed draws hue from ±7 and lightness
 * from ±2.5 — so choosing one is meaningfully more than the board does on its
 * own without becoming a colour picker. DESIGN 4.4 asks for "slight colour
 * variation"; this is the ceiling on what "slight" can be stretched to.
 */
export const TINT_HUE_LIMIT = 28;
export const TINT_LIGHT_LIMIT = 10;
