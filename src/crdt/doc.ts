/**
 * The document: root types, and the only sanctioned way to write to it.
 *
 * docs/DATA-MODEL.md section 2. Five keyed maps plus `meta` — keyed rather
 * than arrays for constant-time lookup, no index churn on delete, and because
 * concurrent creation then never contends over positions. Ordering is an
 * explicit `z` field, never array position.
 */

import * as Y from "yjs";

import { newId } from "@/lib/ids";
import { Origin, type OriginTag } from "@/crdt/origins";
import { SCHEMA_VERSION, readAsset, readItem, type YMap } from "@/crdt/schema";

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
 * The whole document as one update — what compaction writes to disk.
 *
 * A read, not a mutation, which is why it is here rather than in `crdt/ops/`.
 * It costs the same as `encodedSize` and for the same reason: measure it at
 * human speed, never per frame.
 */
export function snapshot(board: BoardDoc): Uint8Array {
  return Y.encodeStateAsUpdate(board.doc);
}

/**
 * What the board is called, for anything outside the document that has to name
 * it — a bundle's manifest and the filename it suggests (T-84).
 *
 * Falls back rather than returning null. Every caller so far wants a string to
 * put somewhere, and `meta.title` is a last-write-wins field that a peer on an
 * older schema could leave as anything.
 */
export function boardTitle(board: BoardDoc): string {
  const title = board.meta.get("title");
  return typeof title === "string" && title.trim().length > 0 ? title : "Untitled board";
}

export function boardSchemaVersion(board: BoardDoc): number {
  const version = board.meta.get("schemaVersion");
  return typeof version === "number" && Number.isFinite(version) ? version : SCHEMA_VERSION;
}

/**
 * Every asset hash an item on this board is currently using.
 *
 * The same set the janitor keeps and `asset_gc` is told to spare — what the
 * board *references*, not everything `assets` still holds metadata for. A
 * bundle carrying the photograph of an item that was deleted an hour ago would
 * be handing over something that is not on the board, and the two questions
 * having one answer is the point: what survives collection is what a bundle
 * embeds.
 *
 * Read off `items` rather than off the scene mirror, because a bundle is
 * written from the document and the scene is a projection of it that a
 * mid-frame caller could catch between updates.
 */
export function referencedAssets(board: BoardDoc): string[] {
  const referenced = new Set<string>();
  for (const [id, map] of board.items) {
    const asset = readItem(id, map)?.assetId;
    if (asset) referenced.add(asset);
  }
  return [...referenced];
}

/**
 * The name a photograph arrived under, for a save dialog to offer back (T-101).
 *
 * `undefined` rather than `""` when there is nothing to offer, because that is
 * what `assetExport(sha256, origName?)` reads as "no suggestion" — and the two
 * ways of having none arrive differently. A board that never learned the name
 * has no `origName` key at all; one written by `crdt/ops/items.ts` from a paste
 * with no filename in it (a screenshot, a drag out of another window) stores an
 * empty string, which `readAsset` hands back verbatim. Passing that `""` through
 * would put a dialog on screen with an empty filename box, which is strictly
 * worse than letting Rust name the file after the hash.
 *
 * Here rather than in `app/main.ts`, which is where the call is made, because
 * that module is wiring and nothing tests it — and this is the whole of AC-189.
 * It is also `readAsset`'s first caller: the reader has existed since the schema
 * did and nothing had yet needed a field off an asset record.
 */
export function assetOrigName(board: BoardDoc, sha256: string): string | undefined {
  const map = board.assets.get(sha256);
  if (map === undefined) return undefined;
  const name = readAsset(sha256, map)?.origName ?? "";
  return name.length > 0 ? name : undefined;
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
