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
import { assetKind, readAsset, SCHEMA_VERSION } from "@/crdt/schema";

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

/**
 * T-261. The asset record is the only thing about a file that reaches a peer
 * ahead of the file, so what it can and cannot say is what decides whether an
 * item arrives at all.
 *
 * The stake is `readAsset` answering null. Absent from there is absent from
 * `referencedAssets`, which is absent from the keep set, which is bytes the
 * boot sweep is free to collect — so a record that reads as missing is not a
 * cosmetic problem, it is the file going away thirty days later.
 */
describe("an asset that is not a photograph", () => {
  const record = (doc: ReturnType<typeof board>, sha256: string, fields: Record<string, unknown>) => {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(fields)) map.set(key, value);
    doc.assets.set(sha256, map);
    return map;
  };

  /** AC-653. A cassette has no pixel box, and never will have one. */
  it("round-trips through the document with no pixel box at all", () => {
    const doc = board();
    record(doc, PHOTO, { w: 0, h: 0, mime: "audio/mpeg", size: 4_000_000, duration: 1606.139 });

    const asset = readAsset(PHOTO, doc.assets.get(PHOTO)!);
    expect(asset).not.toBeNull();
    expect(asset!.kind).toBe("audio");
    expect(asset!.w).toBe(0);
    expect(asset!.duration).toBeCloseTo(1606.139, 3);
  });

  /**
   * A film has a frame size, but the object hanging on the wall is a VHS
   * cassette and its shape is the cassette's — so nothing measures the frame
   * and the record has no box either.
   */
  it("is a cassette and a case file too, not only a sound recording", () => {
    const doc = board();
    record(doc, PHOTO, { w: 0, h: 0, mime: "video/mp4", size: 9, duration: 12 });
    record(doc, OTHER, { w: 0, h: 0, mime: "application/pdf", size: 9, pages: 200 });

    expect(readAsset(PHOTO, doc.assets.get(PHOTO)!)!.kind).toBe("video");
    expect(readAsset(OTHER, doc.assets.get(OTHER)!)!.kind).toBe("document");
    expect(readAsset(OTHER, doc.assets.get(OTHER)!)!.pages).toBe(200);
  });

  /**
   * AC-656. The guard that made this safe for photographs is still doing its
   * job, and this is the fixture that separates the two readings: same absent
   * box, opposite answers, decided by the one thing the record still says.
   */
  it("still reads as absent when nothing about it is usable", () => {
    const doc = board();
    record(doc, PHOTO, { w: 0, h: 0, mime: "image/png", size: 9 });
    record(doc, OTHER, { w: 0, h: 0, size: 9 });

    expect(readAsset(PHOTO, doc.assets.get(PHOTO)!)).toBeNull();
    expect(readAsset(OTHER, doc.assets.get(OTHER)!)).toBeNull();
  });

  it("reads as absent when a photograph has half a box", () => {
    const doc = board();
    record(doc, PHOTO, { w: 100, h: 0, mime: "image/jpeg", size: 9 });
    expect(readAsset(PHOTO, doc.assets.get(PHOTO)!)).toBeNull();
  });

  /**
   * The reason this matters at all, in one assertion: a cassette that read as
   * absent would be in no keep set, and the sweep would take the interview.
   */
  it("is in the keep set, where a record that will not read is not", () => {
    const doc = board();
    createItems(doc, [
      {
        type: "polaroid" as const,
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        assetId: PHOTO,
        asset: { w: 0, h: 0, mime: "audio/mpeg", size: 9, duration: 30 },
      },
    ]);
    expect(referencedAssets(doc)).toEqual([PHOTO]);
  });
});

describe("what a mime says a file is", () => {
  it("puts every face on the wall that D-46 names, and refuses to guess at the rest", () => {
    expect(assetKind("image/jpeg")).toBe("image");
    expect(assetKind("video/x-matroska")).toBe("video");
    expect(assetKind("audio/flac")).toBe("audio");
    expect(assetKind("application/pdf")).toBe("document");
    expect(assetKind("application/octet-stream")).toBe("unknown");
    expect(assetKind("")).toBe("unknown");
  });
});

describe("a duration in the document", () => {
  const withDuration = (value: unknown) => {
    const doc = board();
    const map = new Y.Map<unknown>();
    map.set("w", 0);
    map.set("h", 0);
    map.set("mime", "audio/mpeg");
    map.set("duration", value);
    doc.assets.set(PHOTO, map);
    return readAsset(PHOTO, doc.assets.get(PHOTO)!)!;
  };

  /**
   * The whole argument of T-300 arriving in the schema. A J-card with nothing
   * written on it is a tape nobody measured; one reading 0:00 is a tape with
   * nothing on it, and the file behind it is a 400 MB interview.
   */
  it("is null rather than zero when nobody measured it", () => {
    const doc = board();
    const map = new Y.Map<unknown>();
    map.set("w", 0);
    map.set("h", 0);
    map.set("mime", "audio/mpeg");
    doc.assets.set(PHOTO, map);
    expect(readAsset(PHOTO, doc.assets.get(PHOTO)!)!.duration).toBeNull();
  });

  it("refuses the values a hostile or older peer can put in a map", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "12", null, {}]) {
      expect(withDuration(value).duration).toBeNull();
    }
    expect(withDuration(12.5).duration).toBe(12.5);
  });

  /** AC-654. It is written by whoever ingested, and it is on the record. */
  it("is on the record the moment the item is created", () => {
    const doc = board();
    createItems(doc, [
      {
        type: "polaroid" as const,
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        assetId: PHOTO,
        asset: { w: 0, h: 0, mime: "video/mp4", size: 9, duration: 42.5, pages: null },
      },
    ]);
    const asset = readAsset(PHOTO, doc.assets.get(PHOTO)!)!;
    expect(asset.duration).toBe(42.5);
    expect(asset.pages).toBeNull();
    // And nothing was written for the thing nobody measured, rather than a
    // null being spent on the wire to say so.
    expect(doc.assets.get(PHOTO)!.has("pages")).toBe(false);
  });

  it("counts a case file's pages by the same rule", () => {
    const doc = board();
    createItems(doc, [
      {
        type: "polaroid" as const,
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        assetId: OTHER,
        asset: { w: 0, h: 0, mime: "application/pdf", size: 9, pages: 200 },
      },
    ]);
    const asset = readAsset(OTHER, doc.assets.get(OTHER)!)!;
    expect(asset.pages).toBe(200);
    expect(asset.duration).toBeNull();
    expect(doc.assets.get(OTHER)!.has("duration")).toBe(false);
  });

  /**
   * Two people pasting the same photograph produce the same hash, so the second
   * write would be byte-identical to the first — churn on the wire for no
   * change. It is not only churn: `addedBy` and `addedAt` say who first brought
   * the file to the board, and rewriting them would make the newest paste look
   * like the original.
   */
  it("is written once, and a second paste of the same hash does not rewrite it", () => {
    const doc = board();
    const item = (origName: string) => ({
      type: "polaroid" as const,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      assetId: PHOTO,
      asset: { w: 10, h: 10, mime: "image/png", size: 100, origName },
    });
    createItems(doc, [item("first.png")]);
    const addedAt = doc.assets.get(PHOTO)!.get("addedAt");
    createItems(doc, [item("second.png")]);

    const asset = readAsset(PHOTO, doc.assets.get(PHOTO)!)!;
    expect(asset.origName).toBe("first.png");
    expect(doc.assets.get(PHOTO)!.get("addedAt")).toBe(addedAt);
  });
});

/**
 * AC-655. `Y.Map` is per-property last-write-wins, which is the argument
 * `readStyle` already makes for the style map — a build that has never heard of
 * a key reads the ones it knows and ignores the rest.
 */
describe("a record written by a build that knows more than this one", () => {
  it("is read for what this build understands and is not refused for the rest", () => {
    const doc = board();
    const map = new Y.Map<unknown>();
    map.set("w", 800);
    map.set("h", 600);
    map.set("mime", "image/png");
    map.set("size", 1234);
    map.set("origName", "holiday.png");
    // Four keys from a build that measures more than this one does.
    map.set("poster", "c".repeat(64));
    map.set("chapters", 12);
    map.set("transcript", "d".repeat(64));
    map.set("kind", "photograph-of-a-kind-we-do-not-have");
    doc.assets.set(PHOTO, map);

    const asset = readAsset(PHOTO, doc.assets.get(PHOTO)!);
    expect(asset).not.toBeNull();
    expect(asset!.w).toBe(800);
    expect(asset!.origName).toBe("holiday.png");
    // And the kind is still the one the mime says, not the one the newer build
    // wrote down — which is what "derived rather than stored" means when the
    // two would disagree.
    expect(asset!.kind).toBe("image");
  });

  /**
   * The other direction, and the one that actually happens: this build reading
   * every record written before any of these keys existed.
   */
  it("reads a record from before any of this as the photograph it is", () => {
    const doc = board();
    const map = new Y.Map<unknown>();
    map.set("w", 800);
    map.set("h", 600);
    map.set("mime", "image/jpeg");
    map.set("size", 1234);
    map.set("origName", "holiday.jpg");
    map.set("addedBy", 7);
    map.set("addedAt", 1234);
    doc.assets.set(PHOTO, map);

    expect(readAsset(PHOTO, doc.assets.get(PHOTO)!)).toEqual({
      sha256: PHOTO,
      w: 800,
      h: 600,
      mime: "image/jpeg",
      size: 1234,
      origName: "holiday.jpg",
      addedBy: 7,
      addedAt: 1234,
      kind: "image",
      duration: null,
      pages: null,
    });
  });
});
