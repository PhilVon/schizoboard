/**
 * Paper: the shared texture and the per-sheet variation.
 *
 * > Paper stock varies: white, cream, yellow legal, graph, index card. Each has
 * > its own grain texture at low opacity, its own edge treatment, and its own
 * > slight colour variation across the sheet. — DESIGN section 4.4
 *
 * One grain tile is generated for the whole board and shared by every sheet;
 * each sheet samples it from a different offset derived from its seed, so no
 * two are identical and the cost is one bitmap rather than one per item.
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
}

/** Warm, low-chroma, and none of them pure white — paper never is. */
const STOCKS: Record<PaperStock, Stock> = {
  white: { base: "#f7f4ed" },
  cream: { base: "#f2e9d6" },
  legal: { base: "#f6efb9", rule: { color: "rgba(90,120,160,0.35)", spacing: 22 } },
  graph: { base: "#f4f2e8", rule: { color: "rgba(120,140,120,0.28)", spacing: 14 } },
  index: { base: "#f8f5ef", rule: { color: "rgba(150,120,120,0.3)", spacing: 20, margin: "rgba(190,110,110,0.5)" } },
};

const NOTE_STOCKS: PaperStock[] = ["white", "cream", "legal", "graph"];

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
 */
export function stockRuling(stock: PaperStock): string {
  const rule = (STOCKS[stock] ?? STOCKS.white).rule;
  if (!rule) return "none";
  const lines = `repeating-linear-gradient(to bottom, transparent 0 ${rule.spacing - 1}px, ${rule.color} ${rule.spacing - 1}px ${rule.spacing}px)`;
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

/**
 * Fibrous grain. Generated once and shared; individual sheets shift it.
 *
 * Cross-hatched rather than isotropic noise, because paper has a direction to
 * it — pure per-pixel speckle reads as television static, not as pulp.
 */
let grainUrl: string | null = null;

export function paperGrainUrl(seed: number, size = 256): string {
  if (grainUrl) return grainUrl;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const rng = mulberry32(seed ^ 0x9a3f1c);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    const v = 128 + (rng() - 0.5) * 26;
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  // Fibres: short strokes at two shallow angles.
  ctx.lineWidth = 1;
  for (let i = 0; i < size * 3; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const length = 3 + rng() * 14;
    const angle = (rng() < 0.5 ? 0.1 : Math.PI / 2 - 0.1) + (rng() - 0.5) * 0.35;
    ctx.strokeStyle = `rgba(${rng() < 0.5 ? 90 : 200},${rng() < 0.5 ? 90 : 200},90,0.05)`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }

  grainUrl = canvas.toDataURL("image/png");
  return grainUrl;
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
export function sheetTint(seed: number): string {
  const hue = (valueAt(seed, "tint-h") - 0.5) * 14;
  const light = (valueAt(seed, "tint-l") - 0.5) * 5;
  return `hue-rotate(${hue.toFixed(2)}deg) brightness(${(1 + light / 100).toFixed(4)})`;
}
