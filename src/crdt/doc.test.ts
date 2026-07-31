/**
 * The document's readers — the small answers something outside the CRDT needs
 * about a board, and that only this side can give.
 *
 * All three exist for T-84: a bundle's manifest is a title, a schema version
 * and a list of hashes, and Rust owns bytes and no schema, so every one of them
 * has to be read here and handed over.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  assetOrigName,
  boardSchemaVersion,
  boardSealed,
  boardTitle,
  futureSchema,
  initialiseBoard,
  openBoardDoc,
  referencedAssets,
  sealBoard,
  SealedBoardError,
} from "@/crdt/doc";
import { applyPersisted } from "@/crdt/ops/load";
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

/**
 * T-101, and the whole of AC-189. The name is a *suggestion* the save dialog
 * puts in its filename box, so the only thing that matters is that a user
 * recognises it - and that nothing recognisable is handed over as an empty
 * string, which would put an empty box on screen.
 */
describe("the name a photograph came in under", () => {
  it("is the one the item was pasted with", () => {
    const doc = board();
    createItems(doc, [polaroid(PHOTO)]);
    expect(assetOrigName(doc, PHOTO)).toBe("holiday.png");
  });

  /**
   * A screenshot, or a drag out of another window - `app/paste.ts` has no
   * filename to take, `crdt/ops/items.ts` writes it as null and `readAsset`
   * hands it back as "". Passing that through would be a dialog with an empty
   * filename box, which is worse than letting Rust name the file after the hash.
   */
  it("is undefined rather than empty when the photograph arrived without one", () => {
    const doc = board();
    createItems(doc, [polaroid(PHOTO)]);
    doc.assets.get(PHOTO)!.set("origName", "");
    expect(assetOrigName(doc, PHOTO)).toBeUndefined();
    doc.assets.get(PHOTO)!.set("origName", 7);
    expect(assetOrigName(doc, PHOTO)).toBeUndefined();
  });

  /**
   * The record is unreadable, not merely nameless: `readAsset` answers null for
   * an asset with no usable size, and a caller asking for a name gets the same
   * nothing as one asking about a hash the board has never heard of.
   */
  it("is undefined for a hash with no record, and for one that will not read", () => {
    const doc = board();
    createItems(doc, [polaroid(PHOTO)]);
    expect(assetOrigName(doc, OTHER)).toBeUndefined();
    doc.assets.get(PHOTO)!.set("w", 0);
    expect(assetOrigName(doc, PHOTO)).toBeUndefined();
  });
});

/**
 * A document from a build newer than this one — T-224, Q-170's "read-only and
 * say so".
 *
 * The stake is not the banner. `referencedAssets` above builds the asset
 * keep-set through `readItem`, so an item shape this build cannot read is in no
 * keep-set and the collector is free to reclaim its photograph. These are the
 * teeth: the seal stops the writing, and everything the application does about
 * it is downstream of one predicate and one `mutate`.
 */
describe("a board written by a newer build", () => {
  const future = () => {
    const doc = board();
    doc.meta.set("schemaVersion", SCHEMA_VERSION + 1);
    return doc;
  };

  it("is recognised, and an equal or older one is not", () => {
    expect(futureSchema(future())).toBe(true);
    expect(futureSchema(board())).toBe(false);

    // Below is what section 12 already specifies — a migration, not a refusal.
    const old = board();
    old.meta.set("schemaVersion", SCHEMA_VERSION - 1);
    expect(futureSchema(old)).toBe(false);
  });

  /**
   * A board written before the field existed reads as this build's own. It is
   * not from the future; it is from before anybody was counting.
   */
  it("is not what a board with no version at all is", () => {
    const doc = openBoardDoc();
    expect(futureSchema(doc)).toBe(false);
    doc.meta.set("schemaVersion", "2");
    expect(futureSchema(doc)).toBe(false);
  });

  it("refuses every op once it is sealed", () => {
    const doc = future();
    expect(boardSealed(doc)).toBe(false);
    createItems(doc, [polaroid(null)]);
    expect(doc.items.size).toBe(1);

    sealBoard(doc);
    expect(boardSealed(doc)).toBe(true);
    expect(() => createItems(doc, [polaroid(null)])).toThrow(SealedBoardError);
    expect(() => deleteItems(doc, [...doc.items.keys()])).toThrow(SealedBoardError);
    // Nothing half-happened: the throw is before the transaction opens.
    expect(doc.items.size).toBe(1);
  });

  /**
   * The half that must keep working, and the reason the seal is at `mutate`
   * rather than on the `Y.Doc` itself: a read-only board is one that goes on
   * *receiving* the newer document. Remote updates arrive through y-protocols
   * and never touch `mutate`; this is the same thing one hop lower down.
   */
  it("still takes what arrives from somewhere else", () => {
    const peer = board();
    createItems(peer, [polaroid(PHOTO)]);

    const doc = future();
    sealBoard(doc);
    Y.applyUpdate(doc.doc, Y.encodeStateAsUpdate(peer.doc));

    expect(doc.items.size).toBe(1);
    expect(referencedAssets(doc)).toEqual([PHOTO]);
  });

  /** And the replay of what is already on the disk, which is not an edit. */
  it("still loads from disk", () => {
    const written = board();
    createItems(written, [polaroid(null)]);
    const frames = [Y.encodeStateAsUpdate(written.doc)];

    const doc = future();
    sealBoard(doc);
    expect(() => applyPersisted(doc, frames)).not.toThrow();
    expect(doc.items.size).toBe(1);
  });

  /** One way only. There is no build in which the condition goes away. */
  it("cannot be unsealed, and sealing twice is sealing once", () => {
    const doc = future();
    sealBoard(doc);
    sealBoard(doc);
    expect(boardSealed(doc)).toBe(true);
    expect(() => createItems(doc, [polaroid(null)])).toThrow(SealedBoardError);
  });

  /** Sealing one board says nothing about another open in the same window. */
  it("is a fact about one document", () => {
    const sealedOne = future();
    const other = board();
    sealBoard(sealedOne);
    expect(boardSealed(other)).toBe(false);
    createItems(other, [polaroid(null)]);
    expect(other.items.size).toBe(1);
  });
});
