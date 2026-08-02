/**
 * @vitest-environment happy-dom
 */

import { beforeAll, describe, expect, it } from "vitest";

import { MockPlatform } from "@/platform/mock";

beforeAll(() => {
  // happy-dom has no image decoder. The mock's job here is to put the decoded
  // dimensions into the meta, so stub the decode rather than skip the
  // assertion — dimensions in the document are what let an item be usable
  // before its bytes arrive (DESIGN section 7.5).
  globalThis.createImageBitmap = (async () => ({
    width: 1,
    height: 1,
    close: () => {},
  })) as unknown as typeof createImageBitmap;
});

/** A real 1x1 PNG, so the hash and the decode are both doing actual work. */
const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

describe("MockPlatform", () => {
  it("content-addresses, so the same bytes ingest once", async () => {
    const platform = new MockPlatform();
    const first = await platform.assetIngestBytes(PNG_1X1);
    const second = await platform.assetIngestBytes(PNG_1X1.slice());

    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.sha256).toBe(first.sha256);
    expect(platform.assetUrl(first.sha256)).toBe(platform.assetUrl(second.sha256));
  });

  it("sniffs the mime type and reports the real size", async () => {
    const platform = new MockPlatform();
    const meta = await platform.assetIngestBytes(PNG_1X1);
    expect(meta.mime).toBe("image/png");
    expect(meta.size).toBe(PNG_1X1.byteLength);
    expect([meta.w, meta.h]).toEqual([1, 1]);
  });

  it("returns an empty url for an asset it has never seen", () => {
    const platform = new MockPlatform();
    expect(platform.assetUrl("0".repeat(64))).toBe("");
  });

  it("answers assetHas per hash", async () => {
    const platform = new MockPlatform();
    const { sha256 } = await platform.assetIngestBytes(PNG_1X1);
    expect(await platform.assetHas([sha256, "0".repeat(64)])).toEqual([true, false]);
  });

  it("keeps the document log append-only until a compaction replaces it", async () => {
    const platform = new MockPlatform();
    await platform.docAppendUpdate(Uint8Array.of(1, 2));
    await platform.docAppendUpdate(Uint8Array.of(3));
    expect(await platform.docLoad()).toEqual({
      snapshot: null,
      updates: [Uint8Array.of(1, 2), Uint8Array.of(3)],
    });

    await platform.docCompact(Uint8Array.of(9, 9));
    expect(await platform.docLoad()).toEqual({
      snapshot: Uint8Array.of(9, 9),
      updates: [],
    });
  });

  it("frees everything outside the keep set", async () => {
    const platform = new MockPlatform();
    const a = await platform.assetIngestBytes(PNG_1X1);
    const b = await platform.assetIngestBytes(Uint8Array.of(1, 2, 3, 4, 5, 6));
    const { freedBytes } = await platform.assetGc([a.sha256]);
    expect(freedBytes).toBe(b.size);
    expect(await platform.assetHas([a.sha256, b.sha256])).toEqual([true, false]);
  });

  it("recognises text last, and never at the expense of a signature", async () => {
    const platform = new MockPlatform();
    const bytes = (text: string) => new TextEncoder().encode(text);

    const memo = await platform.assetIngestBytes(bytes("A memo, and then a list.\n"));
    expect(memo.mime).toBe("text/plain");
    // No page count, deliberately: paginating here would put a second
    // implementation of `text.rs`'s rule in a second language, and which of
    // them ingested a file would then decide what its page references mean.
    expect(memo.pages).toBeNull();

    // A file that reads as text and is something else is still that thing —
    // the arm is last, so every signature above it has already answered.
    expect((await platform.assetIngestBytes(bytes("%PDF-1.7\ntrailer\n"))).mime).toBe(
      "application/pdf",
    );
    // And bytes that place nowhere still place nowhere.
    expect((await platform.assetIngestBytes(Uint8Array.of(0, 1, 2, 3))).mime).toBe(
      "application/octet-stream",
    );
    expect((await platform.assetIngestBytes(new Uint8Array())).mime).toBe(
      "application/octet-stream",
    );
  });

  it("says what it cannot do instead of pretending", async () => {
    const platform = new MockPlatform();
    await expect(platform.assetIngestPath()).rejects.toThrow(/native shell/);
    await expect(platform.assetIngestUrl()).rejects.toThrow(/native shell/);
    await expect(platform.syncStart({ mode: "lan", boardId: "x" })).rejects.toThrow(
      /native shell/,
    );
  });

  /**
   * A text file's pagination is a *rule* rather than a parse (T-298), so unlike
   * everything else in the test above it could genuinely be answered here — and
   * that is exactly why it must not be. Two implementations in two languages and
   * a stored page reference would depend on which of them read the file. One
   * writer, in `text.rs`, and this is the assertion that keeps it one.
   */
  it("refuses to read a page rather than inventing a second pagination", async () => {
    const platform = new MockPlatform();
    const text = new TextEncoder().encode("the fourth witness statement\n".repeat(400));
    const meta = await platform.assetIngestBytes(text, "text/plain");

    expect(meta.pages).toBeNull();
    await expect(platform.documentPageCount(meta.sha256)).rejects.toThrow(/native shell/);
    await expect(platform.documentPage(meta.sha256, 1)).rejects.toThrow(/native shell/);
    await expect(platform.documentPageImage(meta.sha256, 1)).rejects.toThrow(/native shell/);

    // The exception, and it is deliberate: nothing is held open here, so there
    // is nothing to let go of. A caller that had to ask which platform it was on
    // before it could say it had finished reading is a worse boundary than one
    // that can always say so.
    await expect(platform.documentClose(meta.sha256)).resolves.toBeUndefined();
  });

  it("delivers Rust-side events to listeners and stops on unlisten", async () => {
    const platform = new MockPlatform();
    const seen: string[] = [];
    const unlisten = await platform.on("asset:ready", (p) => seen.push(p.sha256));
    platform.emit("asset:ready", { sha256: "abc" });
    unlisten();
    platform.emit("asset:ready", { sha256: "def" });
    expect(seen).toEqual(["abc"]);
  });
});
