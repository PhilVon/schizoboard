import { describe, expect, it } from "vitest";

import { compareOrder, keyAbove, keyBelow, keyBetween } from "@/crdt/zindex";

describe("z-order keys", () => {
  it("puts a key strictly between its neighbours", () => {
    const a = keyBetween(null, null);
    const c = keyAbove(a);
    const b = keyBetween(a, c);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("jitters, so two concurrent bring-to-fronts do not collide", () => {
    const base = keyBetween(null, null);
    const keys = new Set(Array.from({ length: 200 }, () => keyAbove(base)));
    // Without the suffix every one of these would be the same string.
    expect(keys.size).toBe(200);
  });

  it("generates keys that are themselves valid bounds", () => {
    // The jitter is appended to a key the library generated, so it has to
    // respect the library's own rules — notably that a key may not end in the
    // smallest digit. Getting this wrong does not fail at generation; it fails
    // later, the first time someone inserts next to that item.
    let key = keyBetween(null, null);
    for (let i = 0; i < 400; i++) {
      expect(key.endsWith("0")).toBe(false);
      const next = keyAbove(key);
      keyBetween(key, next);
      keyBelow(key);
      key = next;
    }
  });

  it("never lets the jitter cross a neighbour", () => {
    // The hazard, confirmed against the library rather than assumed:
    // generateKeyBetween("a0V", "a0W5") is "a0W", a proper *prefix* of the
    // upper bound. A naive `base + suffix` gives "a0Wq3x", which sorts above
    // "a0W5" — the item silently ends up on the wrong side of its neighbour.
    for (const [low, high] of [
      ["a0V", "a0W5"],
      ["a01", "a025"],
      ["a0zy", "a0zz5"],
    ]) {
      for (let i = 0; i < 800; i++) {
        const key = keyBetween(low!, high!);
        expect(key > low!).toBe(true);
        expect(key < high!).toBe(true);
      }
    }
  });

  it("holds strict betweenness across a randomised insertion walk", () => {
    let keys = [keyBetween(null, null)];
    keys.push(keyAbove(keys[0]!));
    for (let i = 0; i < 4000; i++) {
      keys.sort();
      const j = Math.floor(Math.random() * (keys.length - 1));
      const low = keys[j]!;
      const high = keys[j + 1]!;
      const mid = keyBetween(low, high);
      expect(mid > low).toBe(true);
      expect(mid < high).toBe(true);
      keys.push(mid);
      // Keep the working set small so fractions actually grow deep, which is
      // where the prefix hazard lives.
      if (keys.length > 40) keys = keys.slice(0, 40);
    }
  });

  it("survives repeated insertion in the middle without losing order", () => {
    let low = keyBetween(null, null);
    let high = keyAbove(low);
    const keys = [low, high];
    for (let i = 0; i < 500; i++) {
      const mid = keyBetween(low, high);
      expect(mid > low).toBe(true);
      expect(mid < high).toBe(true);
      keys.push(mid);
      // Alternate which side we subdivide, so both directions get exercised.
      if (i % 2 === 0) high = mid;
      else low = mid;
    }
    const sorted = [...keys].sort();
    expect(new Set(sorted).size).toBe(keys.length);
  });

  it("keeps keys short under repeated bring-to-front", () => {
    let top = keyBetween(null, null);
    for (let i = 0; i < 1000; i++) top = keyAbove(top);
    // The hazard in DATA-MODEL section 7 is unbounded growth. The integer part
    // absorbs repeated appends, so this stays a short key, not a novel.
    expect(top.length).toBeLessThan(16);
  });

  it("stacks send-to-back the other way", () => {
    let bottom = keyBetween(null, null);
    const seen: string[] = [];
    for (let i = 0; i < 50; i++) {
      bottom = keyBelow(bottom);
      seen.push(bottom);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]! < seen[i - 1]!).toBe(true);
    }
  });
});

describe("compareOrder", () => {
  const item = (z: string, clientId: number, id: string) => ({ z, clientId, id });

  it("orders by key first", () => {
    expect(compareOrder(item("a0", 9, "z"), item("a1", 1, "a"))).toBeLessThan(0);
  });

  it("breaks an equal key by client id, then item id", () => {
    expect(compareOrder(item("a0", 1, "b"), item("a0", 2, "a"))).toBeLessThan(0);
    expect(compareOrder(item("a0", 1, "a"), item("a0", 1, "b"))).toBeLessThan(0);
    expect(compareOrder(item("a0", 1, "a"), item("a0", 1, "a"))).toBe(0);
  });

  it("sorts identically whatever order two peers happen to see items in", () => {
    const items = [
      item("a1", 7, "kk"),
      item("a0", 3, "bb"),
      item("a0", 3, "aa"),
      item("a0", 1, "zz"),
      item("a2", 2, "cc"),
    ];
    const peerA = [...items].sort(compareOrder);
    const peerB = [...items].reverse().sort(compareOrder);
    expect(peerA.map((i) => i.id)).toEqual(peerB.map((i) => i.id));
    expect(peerA.map((i) => i.id)).toEqual(["zz", "aa", "bb", "kk", "cc"]);
  });
});
