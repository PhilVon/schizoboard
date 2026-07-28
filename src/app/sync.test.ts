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
