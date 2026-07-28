/**
 * What this client connects to.
 *
 * The rest of `app/` is wiring and nothing tests it. This part is not wiring: it
 * reads something a human typed into an address bar, and every one of its
 * failure modes is a board that opens and silently syncs with nobody. So the
 * cases are here, and the rule they all follow is the same one — a query that is
 * wrong falls back to a working local board and says why, and never throws.
 */

import { describe, expect, it } from "vitest";

import { dialAddress, identityFor, planSync } from "@/app/sync";
import { SELECT_STROKE } from "@/render/overlay";
import type { Platform } from "@/platform/types";
import { STRING_COLORS } from "@/lib/palette";

describe("planning a connection", () => {
  it("hosts on loopback when nobody asked for anything", () => {
    expect(planSync("")).toEqual({ config: { mode: "lan", boardId: "board" }, complaint: null });
  });

  it("dials the relay it is given, with the board on the end", () => {
    // `sync_status` hands this exact string back as the one to dial, so the board
    // belongs on the address rather than somewhere else.
    expect(planSync("?relay=ws://192.168.1.9:1234&board=case")).toEqual({
      config: { mode: "relay", url: "ws://192.168.1.9:1234/case", boardId: "case" },
      complaint: null,
    });
  });

  it("takes a bare port, because that is what gets typed into two address bars", () => {
    expect(planSync("?relay=1234").config).toEqual({
      mode: "relay",
      url: "ws://127.0.0.1:1234/board",
      boardId: "board",
    });
  });

  it("keeps a path somebody spelled out rather than appending a default behind it", () => {
    expect(planSync("?relay=ws://127.0.0.1:1234/theirs").config).toEqual({
      mode: "relay",
      url: "ws://127.0.0.1:1234/theirs",
      boardId: "board",
    });
  });

  it("takes wss for a relay that is not on this machine", () => {
    expect(planSync("?relay=wss://relay.example/x").config).toEqual({
      mode: "relay",
      url: "wss://relay.example/x",
      boardId: "board",
    });
  });

  it("refuses a scheme that is not a WebSocket, and says so", () => {
    // `http://` would connect to something, and what it connected to would not be
    // a relay — which is a much more confusing failure than not connecting.
    const plan = planSync("?relay=http://127.0.0.1:1234");
    expect(plan.config.mode).toBe("lan");
    expect(plan.complaint).toContain("ws://");
  });

  it("refuses an address that is not an address at all", () => {
    const plan = planSync("?relay=not a url");
    expect(plan.config.mode).toBe("lan");
    expect(plan.complaint).not.toBeNull();
  });

  it("refuses a board name the relay would refuse, at the point it was chosen", () => {
    // The relay checks this too (`src-tauri/src/sync/mod.rs`, `room_name`). Doing
    // it here as well turns "the socket closed and nobody said why" into a line
    // naming the name.
    const plan = planSync("?board=../etc/passwd");
    expect(plan.config.boardId).toBe("board");
    expect(plan.complaint).toContain("../etc/passwd");
  });

  it("refuses a board name that is too long to be one", () => {
    expect(planSync(`?board=${"a".repeat(65)}`).config.boardId).toBe("board");
    expect(planSync(`?board=${"a".repeat(64)}`).config.boardId).toBe("a".repeat(64));
  });

  it("still complains about the board when the relay was fine", () => {
    const plan = planSync("?relay=1234&board=no/good");
    expect(plan.config).toEqual({
      mode: "relay",
      url: "ws://127.0.0.1:1234/board",
      boardId: "board",
    });
    expect(plan.complaint).toContain("no/good");
  });
});

/** `#rrggbb` or `rgba(r, g, b, a)` to a triple. Enough for the two it is given. */
function rgb(color: string): [number, number, number] {
  if (color.startsWith("#")) {
    return [
      parseInt(color.slice(1, 3), 16),
      parseInt(color.slice(3, 5), 16),
      parseInt(color.slice(5, 7), 16),
    ];
  }
  const parts = color.match(/[\d.]+/g)!;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

describe("who this client says it is", () => {
  it("gives two clients different colours", () => {
    const one = identityFor(1);
    const two = identityFor(2);
    expect(one.color).not.toBe(two.color);
    expect(one.name).not.toBe(two.name);
  });

  it("never picks white, which is not a cursor on a pale note", () => {
    const white = STRING_COLORS.find((entry) => entry.label === "White")!.hex;
    for (let client = 0; client < 60; client += 1) {
      expect(identityFor(client).color).not.toBe(white);
    }
  });

  /**
   * The other exclusion, and the one worth measuring rather than naming.
   *
   * A peer's selection chrome is drawn in their own colour and yours in
   * `SELECT_STROKE`, so a peer colour that lands on that value makes somebody
   * else's outline look like your own — which is what a black peer did, four
   * pixels apart and indistinguishable, until T-152 took Black out.
   *
   * Measured rather than asserted by name because [`NOT_A_PEER`] excludes by
   * *label*: a colour that is renamed would quietly come back, and the whole
   * point of the exclusion is a property of the hex.
   */
  it("never picks a colour the overlay already draws your own chrome in", () => {
    const chrome = rgb(SELECT_STROKE);
    // Plain RGB distance, which is coarse and does not need to be anything
    // else: every colour still in the palette is at least 128 away and the one
    // that was taken out was 26. There is no threshold in that gap to argue
    // about.
    const apart = (hex: string): number => {
      const c = rgb(hex);
      return Math.hypot(c[0] - chrome[0], c[1] - chrome[1], c[2] - chrome[2]);
    };
    for (let client = 0; client < 60; client += 1) {
      expect(apart(identityFor(client).color)).toBeGreaterThan(64);
    }
    // And the claim the exclusion rests on, so the number above is not a
    // threshold nobody can place: the colour that was removed fails it.
    const black = STRING_COLORS.find((entry) => entry.label === "Black")!.hex;
    expect(apart(black)).toBeLessThan(64);
  });

  it("still offers more than one colour after the exclusions", () => {
    const seen = new Set<string>();
    for (let client = 0; client < 60; client += 1) seen.add(identityFor(client).color);
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("survives a client id Yjs picked out of the whole 32-bit range", () => {
    for (const client of [0, 1, 2 ** 31 - 1, -(2 ** 31), 4020615519]) {
      const identity = identityFor(client);
      expect(identity.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(identity.id).toBe(String(client));
      expect(identity.name.length).toBeGreaterThan(0);
    }
  });
});

/** A platform that can host, that cannot, and one whose relay fails to bind. */
function platform(behaviour: "hosts" | "refuses"): Platform {
  return {
    async syncStart() {
      if (behaviour === "refuses") throw new Error("Sync is not available in the browser");
    },
    async syncStatus() {
      return behaviour === "hosts"
        ? { connected: true, peers: [], mode: "lan" as const, url: "ws://127.0.0.1:52341/board" }
        : { connected: false, peers: [], mode: null, url: null };
    },
  } as unknown as Platform;
}

describe("finding the address", () => {
  it("asks the shell where its relay ended up, because only the shell knows", () => {
    // Port zero: the operating system picks and `sync_status` reports back.
    return expect(dialAddress(platform("hosts"), { mode: "lan", boardId: "board" })).resolves.toBe(
      "ws://127.0.0.1:52341/board",
    );
  });

  it("has no address when this process cannot host", () => {
    return expect(
      dialAddress(platform("refuses"), { mode: "lan", boardId: "board" }),
    ).resolves.toBeNull();
  });

  it("dials anyway when the platform refuses, because the address came from outside", () => {
    // The browser is exactly where two windows on one relay is cheap, and
    // `platform/mock.ts` refuses `syncStart` there. Refusing to connect would make
    // `?relay=` useless in the one place it is for.
    return expect(
      dialAddress(platform("refuses"), {
        mode: "relay",
        url: "ws://127.0.0.1:1234/demo",
        boardId: "demo",
      }),
    ).resolves.toBe("ws://127.0.0.1:1234/demo");
  });
});
