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
  assetKindsOf,
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
import { attachPoster, attachTranscript, createItems, deleteItems } from "@/crdt/ops/items";
import { readAsset, SCHEMA_VERSION } from "@/crdt/schema";
import { assetKind } from "@/lib/objects";

const PHOTO = "a".repeat(64);
const OTHER = "b".repeat(64);
/** A film's poster frame — an asset of its own, hashed like any other picture. */
const STILL = "c".repeat(64);
/** The sidecar transcript beside a recording — an asset of its own too (T-287). */
const WORDS = "e".repeat(64);

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

describe("what a board's assets are, for a sentence about a set of them", () => {
  /** An item wearing a file of a given kind, so a board can be mixed. */
  const wearing = (assetId: string, mime: string) => ({
    type: "polaroid" as const,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    assetId,
    asset: { ...meta(assetId), mime },
  });

  it("reads each hash's kind off the document", () => {
    const doc = board();
    createItems(doc, [wearing(PHOTO, "image/png"), wearing(OTHER, "video/mp4")]);
    expect(assetKindsOf(doc, [PHOTO, OTHER])).toEqual(["image", "video"]);
  });

  it("answers for a photograph whose bytes this machine does not hold", () => {
    // The half the missing sentence is about. The record is written when the
    // item is created and the file may still be arriving from a peer — or may
    // never arrive — and the document can say what it is either way.
    const doc = board();
    createItems(doc, [wearing(PHOTO, "audio/mpeg")]);
    expect(assetKindsOf(doc, [PHOTO])).toEqual(["audio"]);
  });

  it("says unknown for a hash it has no record of, rather than dropping it", () => {
    // A list that silently lost an entry would make a mixed board read as a
    // board of one kind, which is exactly the wrong answer for the sentence
    // this feeds.
    const doc = board();
    createItems(doc, [wearing(PHOTO, "image/png")]);
    expect(assetKindsOf(doc, [PHOTO, STILL])).toEqual(["image", "unknown"]);
    expect(assetKindsOf(doc, [])).toEqual([]);
  });

  it("keeps one entry per hash asked about, in the order asked", () => {
    // The count comes from the shell and the kinds from here, so this list is
    // read positionally by nothing — but a caller passing the same hash twice
    // is asking about two files as far as it knows.
    const doc = board();
    createItems(doc, [wearing(PHOTO, "application/pdf")]);
    expect(assetKindsOf(doc, [PHOTO, PHOTO])).toEqual(["document", "document"]);
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

  /**
   * The hazard I-72 saw coming, arriving with the first poster rather than with
   * T-292, which is the task meant to generalise it.
   *
   * A film's still is a picture **no item on this board wears**. It hangs off
   * the film's asset record and nothing else points at it, so a keep-set read
   * off item hashes alone is one hash short — and one hash short is silent,
   * permanent, and on the wrong side of this function's own contract that what
   * survives collection is what a bundle embeds. Every tape on the board would
   * lose its still the first time the sweep ran.
   */
  it("names the still a film points at, which no item wears", () => {
    const doc = board();
    const [item] = createItems(doc, [polaroid(PHOTO)]);
    expect(item).toBeDefined();
    attachPoster(doc, PHOTO, STILL, meta(STILL));
    expect(referencedAssets(doc).sort()).toEqual([PHOTO, STILL].sort());
  });

  it("forgets a still as soon as the film wearing it goes", () => {
    // Both halves in one step, because the poster is reached *through* the
    // item's own asset. Nothing has to know that a poster is a poster.
    const doc = board();
    const [item] = createItems(doc, [polaroid(PHOTO)]);
    attachPoster(doc, PHOTO, STILL, meta(STILL));
    deleteItems(doc, [item!.itemId]);
    expect(referencedAssets(doc)).toEqual([]);
  });

  /**
   * The same hazard as the still above, and the worse half of it.
   *
   * A collected poster is a still that can be grabbed again off a film this
   * machine is still holding. A collected transcript is gone: nothing derives it
   * from the recording's bytes, and re-dropping the tape will not bring it back
   * unless the `.srt` still happens to be sitting beside it on that disk.
   */
  it("names the transcript a recording points at, which no item wears", () => {
    const doc = board();
    const [item] = createItems(doc, [polaroid(PHOTO)]);
    expect(item).toBeDefined();
    attachTranscript(doc, PHOTO, WORDS, meta(WORDS));
    expect(referencedAssets(doc).sort()).toEqual([PHOTO, WORDS].sort());
  });

  /** Both at once, because a film with a still and a transcript is the ordinary
   *  interview and the two are read off one record. */
  it("names a still and a transcript together", () => {
    const doc = board();
    createItems(doc, [polaroid(PHOTO)]);
    attachPoster(doc, PHOTO, STILL, meta(STILL));
    attachTranscript(doc, PHOTO, WORDS, meta(WORDS));
    expect(referencedAssets(doc).sort()).toEqual([PHOTO, STILL, WORDS].sort());
  });

  it("forgets a transcript as soon as the recording wearing it goes", () => {
    const doc = board();
    const [item] = createItems(doc, [polaroid(PHOTO)]);
    attachTranscript(doc, PHOTO, WORDS, meta(WORDS));
    deleteItems(doc, [item!.itemId]);
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
    // Four keys from a build that measures more than this one does. `poster`
    // was one of them until T-270 and `transcript` until T-287; neither is one
    // now, because a key this build has learned proves nothing about the ones
    // it has not — which is the second time that sentence has had to be acted
    // on rather than only written down.
    map.set("chapters", 12);
    map.set("speakers", 3);
    map.set("loudness", -14.2);
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
   * The still, which is the first field of an asset record that is also a
   * *reference* — and so the first one a peer can use to point this machine at
   * something.
   *
   * What it becomes on this side is a path in the content store and a key in
   * the exchange, which is `isHash`'s whole argument one layer further in. A
   * poster naming `../../etc` is the one thing an asset record can carry that
   * is worse than a wrong number.
   */
  it("refuses a still that is not a hash, and one a film names as itself", () => {
    const doc = board();
    const map = new Y.Map<unknown>();
    map.set("w", 800);
    map.set("h", 600);
    map.set("mime", "video/mp4");
    doc.assets.set(PHOTO, map);
    const poster = (): string | null => readAsset(PHOTO, doc.assets.get(PHOTO)!)!.poster;

    map.set("poster", "c".repeat(64));
    expect(poster()).toBe("c".repeat(64));

    for (const bad of ["../../etc/passwd", "C".repeat(64), "c".repeat(63), "", 7, null]) {
      map.set("poster", bad);
      expect(poster(), String(bad)).toBeNull();
    }

    // A film naming itself is a loop nothing here writes and nothing outside
    // would spot: the resolver would raise a want on the film's own bytes and
    // hand an `<img>` a video to decode.
    map.set("poster", PHOTO);
    expect(poster()).toBeNull();
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
      poster: null,
      transcript: null,
    });
  });
});
