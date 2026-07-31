/**
 * What a sheet actually looks like, once the seed and the override have both
 * had their say (T-225, DATA-MODEL section 3).
 *
 * Every appearance on this board is a function of `item.seed`. This file is
 * the one place that knows a person can have overruled one, and it exists as a
 * file rather than as five `??`s scattered through `dom.ts` for the reason the
 * `??`s would have been wrong: **the two paths are not the same shape**. A
 * stock is a straight substitution; a tint is two numbers that have to be
 * formatted the same way whichever they came from; tape is a mask whose seed
 * path has a rule the override deliberately does not inherit; and `torn` is a
 * *boolean* in the document standing in for a *side* in the renderer. Four
 * different reconciliations, and each one is a decision rather than a fallback.
 *
 * `lib/style.ts` has the vocabulary and the argument for absence meaning "ask
 * the seed". This is where that argument is carried out.
 */

import { dogEarOf } from "@/render/items/wear";
import { defaultStock, seedTint, tintFilter, type PaperStock } from "@/render/items/paper";
import { sheetEdge, tearEdge, type SheetEdge, type TornEdge } from "@/render/items/edge";
import { tapedCorners } from "@/render/items/tape";
import { valueAt } from "@/lib/seed";
import type { ItemFace } from "@/lib/style";
import type { ItemCold } from "@/state/scene";

/** Which paper this sheet is on. */
export function stockOf(cold: ItemCold): PaperStock {
  return cold.style.paperStock ?? defaultStock(cold.type, cold.seed);
}

/**
 * The CSS filter that tints this sheet.
 *
 * Both paths go through `tintFilter` rather than the override producing a
 * string of its own, so that a chosen tint and a seeded one are the same kind
 * of thing and cannot drift into rounding differently — which would show as a
 * sheet changing shade very slightly at the moment somebody first touched it.
 */
export function tintOf(cold: ItemCold): string {
  const tint = cold.style.tint;
  return tint === undefined ? seedTint(cold.seed) : tintFilter(tint.hue, tint.light);
}

/**
 * Which corners carry tape.
 *
 * The seed path refuses to tape anything that is pinned — a sheet held by a pin
 * does not need holding by tape, and `tape.ts` argues it. **The override is not
 * subject to that**, and that is the decision here rather than an oversight: a
 * mask in the document is somebody having asked for tape on this sheet, and a
 * renderer that quietly ignored it the moment a pin went in would be a choice
 * that silently stops meaning anything. Belt and braces is a thing hands do to
 * paper, and `TAPE_NONE` is how you say no.
 */
export function tapeOf(cold: ItemCold, pinCount: number): number {
  return cold.style.tapeStyle ?? tapedCorners(cold.seed, pinCount);
}

/**
 * Which side this sheet was torn along, or null for one that was cut.
 *
 * The awkward one, because the document holds a **boolean** and the renderer
 * needs a **side**. DATA-MODEL section 3 says `torn`, and it is right to: which
 * edge a legal pad tears along is a fact about legal pads and not a thing worth
 * choosing per sheet. So:
 *
 * - absent — the stock decides, which is what has always happened;
 * - `false` — cut, whatever the stock is;
 * - `true` — torn, and if the stock has no side of its own the seed picks one,
 *   so that saying "torn" twice on two white sheets does not tear both of them
 *   along the same edge and give the pair away as a setting rather than paper.
 */
export function tornOf(cold: ItemCold): TornEdge | null {
  const stock = stockOf(cold);
  const torn = cold.style.torn;
  if (torn === undefined) return tearEdge(stock);
  if (!torn) return null;
  return tearEdge(stock) ?? (valueAt(cold.seed, "tear-side") < 0.5 ? "top" : "left");
}

/**
 * The face this item's writing is set in.
 *
 * `hand` is the board's own and is what every item has had until now, so the
 * absent case is "the way this board writes" rather than a default anybody
 * chose. What the two names *are* in fonts is `render/items/items.css`'s.
 */
export function faceOf(cold: ItemCold): ItemFace {
  return cold.style.fontFamily ?? "hand";
}

/**
 * The sheet's silhouette — its outline, its corners, and where a dog-ear turns
 * over — with the stock and the tear resolved.
 *
 * Here rather than in `dom.ts` because two callers need the same polygon and
 * "what is cut" and "what the pen stops at" must never be two answers (T-186).
 */
export function sheetEdgeOf(cold: ItemCold, wear: number): SheetEdge {
  const worn = Math.round(wear * 100) / 100;
  const ear = dogEarOf(cold.seed, worn);
  const fold =
    ear.amount > 0 ? { corner: ear.corner, depth: Math.round(ear.depth * 10) / 10 } : null;
  return sheetEdge(stockOf(cold), cold.seed, fold);
}
