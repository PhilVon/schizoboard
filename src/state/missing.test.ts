import { describe, expect, it } from "vitest";

import { MissingAssets, noticeText, type MissingNotice } from "@/state/missing";

const say = (notice: MissingNotice | null): string =>
  notice === null ? "" : noticeText(notice);

describe("who to ask about a photograph nobody here has", () => {
  it("says nothing at all while every photograph is present", () => {
    const missing = new MissingAssets();
    missing.seen(7, "Ada", "#c33");
    expect(missing.notice()).toBeNull();
  });

  it("names the peer that claimed it, after they have gone", () => {
    // The case DESIGN 7.5 is actually about. The exchange asks everyone who
    // advertised the hash before it gives up, so by the time anything is
    // unavailable the holder has almost always left — and awareness drops a
    // peer's state on disconnect, so the name has to have been kept.
    const missing = new MissingAssets();
    missing.seen(7, "Ada", "#c33");
    missing.unavailable("abc", [7]);
    missing.left(7);
    expect(say(missing.notice())).toBe("A photograph nobody here has — Ada had them, and left");
  });

  it("asks a peer who is still in the room", () => {
    const missing = new MissingAssets();
    missing.seen(7, "Ada", "#c33");
    missing.unavailable("abc", [7]);
    missing.unavailable("def", [7]);
    expect(say(missing.notice())).toBe("2 photographs nobody here has — ask Ada");
  });

  it("asks only the peers who could actually answer", () => {
    // Two claimed it, one is still here. Telling somebody to ask an empty chair
    // alongside a real name is worse than naming the one who can be asked.
    const missing = new MissingAssets();
    missing.seen(7, "Ada", "#c33");
    missing.seen(8, "Bo", "#3c3");
    missing.unavailable("abc", [7, 8]);
    missing.left(8);
    expect(say(missing.notice())).toBe("A photograph nobody here has — ask Ada");
  });

  it("puts the peers who are here first", () => {
    const missing = new MissingAssets();
    missing.seen(7, "Ada", "#c33");
    missing.seen(8, "Bo", "#3c3");
    missing.unavailable("abc", [7, 8]);
    missing.left(7);
    const notice = missing.notice()!;
    expect(notice.holders.map((h) => [h.name, h.present])).toEqual([
      ["Bo", true],
      ["Ada", false],
    ]);
  });

  it("counts photographs rather than the items wearing them", () => {
    // Several items can wear one hash — duplicate paste is the ordinary way
    // that happens — and one photograph missing is one photograph missing.
    const missing = new MissingAssets();
    missing.seen(7, "Ada", "#c33");
    missing.unavailable("abc", [7]);
    missing.unavailable("abc", [7]);
    expect(missing.count).toBe(1);
  });

  it("has a notice with no name in it on a board with nobody to ask", () => {
    // A board with no wire: `reconcileAssets` calls this with nothing tried,
    // because there was nobody to try. The photograph is still missing and the
    // count is still worth saying.
    const missing = new MissingAssets();
    missing.unavailable("abc");
    expect(say(missing.notice())).toBe("A photograph nobody here has");
  });

  it("skips a peer whose name was never published", () => {
    const missing = new MissingAssets();
    missing.unavailable("abc", [7]);
    const notice = missing.notice()!;
    expect(notice.count).toBe(1);
    expect(notice.holders).toEqual([]);
  });

  it("goes quiet the moment bytes start moving, not when they finish", () => {
    // Same rule as `state/assets.ts` clearing its sticky `unavailable` on
    // `transferring`: a peer who holds it has turned up, and that is the news.
    const missing = new MissingAssets();
    missing.seen(7, "Ada", "#c33");
    missing.unavailable("abc", [7]);
    missing.arrived("abc");
    expect(missing.notice()).toBeNull();
  });

  it("stops counting a photograph whose item was deleted", () => {
    const missing = new MissingAssets();
    missing.seen(7, "Ada", "#c33");
    missing.unavailable("abc", [7]);
    missing.unavailable("def", [7]);
    missing.retain(new Set(["def"]));
    expect(missing.count).toBe(1);
    expect(say(missing.notice())).toBe("A photograph nobody here has — ask Ada");
  });

  it("says nothing once the last missing item is deleted", () => {
    const missing = new MissingAssets();
    missing.seen(7, "Ada", "#c33");
    missing.unavailable("abc", [7]);
    missing.retain(new Set());
    expect(missing.notice()).toBeNull();
  });

  it("keeps a renamed peer's current name", () => {
    const missing = new MissingAssets();
    missing.seen(7, "Ada", "#c33");
    missing.unavailable("abc", [7]);
    missing.seen(7, "Ada Lovelace", "#c33");
    expect(say(missing.notice())).toBe("A photograph nobody here has — ask Ada Lovelace");
  });

  it("lists at most three names, because more is a list and not a sentence", () => {
    const missing = new MissingAssets();
    for (let i = 1; i <= 5; i++) missing.seen(i, `P${i}`, "#c33");
    missing.unavailable("abc", [1, 2, 3, 4, 5]);
    expect(missing.notice()!.holders).toHaveLength(3);
    expect(say(missing.notice())).toBe("A photograph nobody here has — ask P1, P2 or P3");
  });
});
