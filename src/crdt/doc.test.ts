/**
 * The document's readers — the small answers something outside the CRDT needs
 * about a board, and that only this side can give.
 *
 * All three exist for T-84: a bundle's manifest is a title, a schema version
 * and a list of hashes, and Rust owns bytes and no schema, so every one of them
 * has to be read here and handed over.
 */

import { describe, expect, it } from "vitest";

import {
  boardSchemaVersion,
  boardTitle,
  initialiseBoard,
  openBoardDoc,
  referencedAssets,
} from "@/crdt/doc";
import { createItems, deleteItems } from "@/crdt/ops/items";
import { SCHEMA_VERSION } from "@/crdt/schema";

const PHOTO = "a".repeat(64);
const OTHER = "b".repeat(64);

const meta = (sha256: string) => ({
  w: 10,
  h: 10,
  mime: "image/png",
  size: 100,
  origName: "holiday.png",
  sha256,
});

const board = (title?: string) => {
  const doc = openBoardDoc();
  initialiseBoard(doc, title);
  return doc;
};

const polaroid = (assetId: string | null) => ({
  type: "polaroid" as const,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  assetId,
  ...(assetId ? { asset: meta(assetId) } : {}),
});

describe("what a board is called", () => {
  it("is what it was opened with", () => {
    expect(boardTitle(board("Murder wall"))).toBe("Murder wall");
  });

  it("falls back rather than handing back nothing", () => {
    // `meta.title` is last-write-wins and a peer on an older schema could leave
    // it as anything. Every caller wants a string to put somewhere — a bundle's
    // manifest, and the filename its dialog suggests.
    const doc = board();
    expect(boardTitle(doc)).toBe("Untitled board");
    doc.meta.set("title", "   ");
    expect(boardTitle(doc)).toBe("Untitled board");
    doc.meta.set("title", 7);
    expect(boardTitle(doc)).toBe("Untitled board");
  });

  it("reports the schema version, and this build's when there is not one", () => {
    const doc = board();
    expect(boardSchemaVersion(doc)).toBe(SCHEMA_VERSION);
    doc.meta.set("schemaVersion", 99);
    expect(boardSchemaVersion(doc)).toBe(99);
    doc.meta.set("schemaVersion", "next");
    expect(boardSchemaVersion(doc)).toBe(SCHEMA_VERSION);
  });
});

describe("which photographs a board references", () => {
  it("names the ones its items are actually using", () => {
    const doc = board();
    createItems(doc, [polaroid(PHOTO), polaroid(OTHER)]);
    expect(referencedAssets(doc).sort()).toEqual([PHOTO, OTHER].sort());
  });

  it("counts a photograph on two items once", () => {
    const doc = board();
    createItems(doc, [polaroid(PHOTO), polaroid(PHOTO)]);
    expect(referencedAssets(doc)).toEqual([PHOTO]);
  });

  it("ignores items that are not photographs", () => {
    const doc = board();
    createItems(doc, [polaroid(null), polaroid(PHOTO)]);
    expect(referencedAssets(doc)).toEqual([PHOTO]);
  });

  /**
   * The invariant this function exists for, and the reason it reads `items`
   * rather than `assets`.
   *
   * `assets` keeps metadata for everything ever added until the janitor
   * collects it, so a board that had a photograph deleted an hour ago still has
   * its row. A bundle built from `assets` would embed the photograph of an item
   * nobody can see, and hand somebody a picture they never agreed to send.
   *
   * The same set `asset_gc` is told to spare, deliberately: what survives
   * collection is what a bundle embeds, and the two questions have one answer.
   */
  it("does not name a photograph whose item has gone, though its metadata has not", () => {
    const doc = board();
    const [item] = createItems(doc, [polaroid(PHOTO)]);
    expect(doc.assets.has(PHOTO)).toBe(true);

    deleteItems(doc, [item!.itemId]);
    // The metadata is still there — collection is the janitor's, on its own
    // clock, and this must be right before it runs.
    expect(doc.assets.has(PHOTO)).toBe(true);
    expect(referencedAssets(doc)).toEqual([]);
  });

  it("is empty on a board with nothing on it", () => {
    expect(referencedAssets(board())).toEqual([]);
  });
});
