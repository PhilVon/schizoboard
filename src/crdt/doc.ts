/**
 * The document: root types, and the only sanctioned way to write to it.
 *
 * docs/DATA-MODEL.md section 2. Five keyed maps plus `meta` — keyed rather
 * than arrays for constant-time lookup, no index churn on delete, and because
 * concurrent creation then never contends over positions. Ordering is an
 * explicit `z` field, never array position.
 */

import * as Y from "yjs";

import { newId } from "@/crdt/ids";
import { Origin, type OriginTag } from "@/crdt/origins";
import { SCHEMA_VERSION, type YMap } from "@/crdt/schema";

export interface BoardDoc {
  readonly doc: Y.Doc;
  readonly items: Y.Map<YMap>;
  readonly pins: Y.Map<YMap>;
  readonly strings: Y.Map<YMap>;
  readonly assets: Y.Map<YMap>;
  /** Tiled into 2048-unit cells, keyed by stroke bbox centre. */
  readonly boardInk: Y.Map<Y.Map<YMap>>;
  readonly meta: YMap;
}

/** DATA-MODEL section 2 — board ink tiles are 2048 units square. */
export const INK_TILE_SIZE = 2048;

export function inkTileKey(x: number, y: number): string {
  return `${Math.floor(x / INK_TILE_SIZE)},${Math.floor(y / INK_TILE_SIZE)}`;
}

export function openBoardDoc(doc: Y.Doc = new Y.Doc()): BoardDoc {
  return {
    doc,
    items: doc.getMap<YMap>("items"),
    pins: doc.getMap<YMap>("pins"),
    strings: doc.getMap<YMap>("strings"),
    assets: doc.getMap<YMap>("assets"),
    boardInk: doc.getMap<Y.Map<YMap>>("boardInk"),
    meta: doc.getMap<unknown>("meta"),
  };
}

/**
 * Fill in `meta` for a board that has never been opened before.
 *
 * Guarded on `schemaVersion` rather than on emptiness, because two peers
 * opening a fresh board at the same time both see it empty. Writing the same
 * values twice merges to the same result, except `corkSeed` — so whichever
 * write lands second wins and both peers converge on one cork. That is
 * last-write-wins doing exactly what it should.
 */
export function initialiseBoard(board: BoardDoc, title = "Untitled board"): void {
  if (typeof board.meta.get("schemaVersion") === "number") return;
  board.doc.transact(() => {
    board.meta.set("schemaVersion", SCHEMA_VERSION);
    board.meta.set("title", title);
    board.meta.set("corkSeed", newSeedValue());
    board.meta.set("createdAt", Date.now());
    board.meta.set("boardEpoch", Date.now());
  }, Origin.MIGRATION);
}

function newSeedValue(): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0]!;
}

export function boardSeed(board: BoardDoc): number {
  const seed = board.meta.get("corkSeed");
  return typeof seed === "number" && Number.isFinite(seed) ? seed >>> 0 : 0;
}

export function boardEpoch(board: BoardDoc): number {
  const epoch = board.meta.get("boardEpoch");
  return typeof epoch === "number" && Number.isFinite(epoch) ? epoch : Date.now();
}

/**
 * **The only way anything in this application writes to the document.**
 *
 * Rule 1 of ARCHITECTURE section 1: every mutation goes through `crdt/ops/`,
 * and every op wraps a transaction with an explicit origin. That is what makes
 * undo scoping, echo suppression and write batching possible at all — none of
 * the three can be retrofitted onto scattered `map.set()` calls.
 *
 * Ops in `crdt/ops/` call this. Nothing else does, and T-87 adds the lint rule
 * that says so mechanically.
 */
export function mutate<T>(board: BoardDoc, origin: OriginTag, fn: () => T): T {
  return board.doc.transact(fn, origin);
}

/**
 * Encoded size of the whole document, in bytes.
 *
 * The dev HUD alerts past 25 MB (DESIGN section 9.5), and ink-heavy boards are
 * the growth risk (risk 5). Not free on a large document, so callers should
 * measure at human speed rather than per frame.
 */
export function encodedSize(board: BoardDoc): number {
  return Y.encodeStateAsUpdate(board.doc).byteLength;
}

/**
 * A new id that is not already present in `map`.
 *
 * Generic in the map's value type on purpose: `Y.Map<T>` is invariant in `T`,
 * so a `Y.Map<YMap>` is not assignable to a `Y.Map<unknown>` parameter.
 */
export function freshId<T>(map: Y.Map<T>): string {
  let id = newId();
  // 71 bits — this loop is a formality, but a formality that costs nothing.
  while (map.has(id)) id = newId();
  return id;
}
