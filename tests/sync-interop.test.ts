/**
 * The sync client and the relay, against each other and against the reference.
 *
 * `src/crdt/sync/*.test.ts` prove the client is consistent with itself, and
 * `src-tauri/src/sync/*` prove the relay is consistent with itself. Both are
 * exactly what a hand-written protocol is always consistent with. This file
 * runs the real client over a real socket against **two** servers:
 *
 *   - `y-websocket`'s own, which owns the wire format. Only this can fail
 *     because *we* read the specification wrong.
 *   - our embedded relay (T-69), which has to be indistinguishable from it.
 *
 * The same suite twice is the point. A rule that only one of them follows shows
 * up as one row passing and the other failing, which is a far more useful
 * failure than either implementation testing itself.
 *
 * It has already earned this. Against the reference server it found two bugs
 * that every in-process test was blind to — a refused connection in Node fires
 * `error` and then sits in `CONNECTING` for the rest of the process, and a peer
 * keeps the awareness clock of a client it drops.
 *
 * ## Why this file is not in `src/`
 *
 * It needs `node:child_process`, and `tsconfig.json` keeps Node's types out of
 * `src/` on purpose — "src/ is browser/webview code". Node-side integration
 * tests live here, under `tsconfig.test.json`.
 *
 * The reference server is pinned to `y-websocket@1.5.4`. The 3.x server moved
 * to `@y/websocket-server`, and `0.1.5` of that ships a mix of two Yjs builds:
 * it completes the handshake, accepts an update, and then silently drops it
 * with `store.getClock is not a function` on its own stderr. From the client
 * side that is indistinguishable from a client that cannot send.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { createItems } from "@/crdt/ops";
import { readItem } from "@/crdt/schema";
import { WireProvider } from "@/crdt/sync/provider";

interface Server {
  readonly name: string;
  start(port: number): ChildProcess;
}

const reference: Server = {
  name: "the reference y-websocket server",
  start: (port) =>
    spawn(process.execPath, ["node_modules/y-websocket/bin/server.js"], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
      stdio: "ignore",
    }),
};

/**
 * Build the relay before pointing anything at it.
 *
 * Cargo is close to free when the tree is already fresh, and when it is not,
 * two minutes here is exactly what somebody who just changed the relay wants.
 * A stale binary silently passing would be much worse. Returns `null` — and
 * says why — where there is no Rust toolchain to build with.
 */
function buildRelay(): Server | null {
  try {
    execFileSync("cargo", ["build", "--bin", "relay"], {
      cwd: "src-tauri",
      stdio: "ignore",
      timeout: 15 * 60_000,
    });
  } catch {
    return null;
  }
  const binary = ["src-tauri/target/debug/relay.exe", "src-tauri/target/debug/relay"].find(
    existsSync,
  );
  if (binary === undefined) return null;

  return {
    name: "our embedded relay",
    start: (port) =>
      spawn(binary, [], {
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
        stdio: "ignore",
      }),
  };
}

const embedded = buildRelay();
if (embedded === null) {
  console.warn("[interop] no Rust toolchain — the embedded relay is not under test");
}

const servers: Server[] = embedded === null ? [reference] : [reference, embedded];

/**
 * A port the operating system has just told us is free.
 *
 * Not a fixed number: this runs on a development machine, and colliding with
 * somebody's own dev server would be a baffling way to fail.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the probe reported no port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await pause(25);
  }
}

function polaroid(target: BoardDoc, x: number, y: number): string {
  return createItems(target, [{ type: "polaroid", x, y, w: 300, h: 360 }])[0]!.itemId;
}

function at(target: BoardDoc, id: string): { x: number; y: number } | null {
  const map = target.items.get(id);
  if (map === undefined) return null;
  const item = readItem(id, map);
  return item === null ? null : { x: item.x, y: item.y };
}

/**
 * Present *and* introduced. `Awareness` gives every client an empty object the
 * moment it is constructed, so "is in the room" arrives well before "is Phil".
 */
function named(provider: WireProvider, client: number): boolean {
  return provider.awareness.getStates().get(client)?.["user"] !== undefined;
}

describe.each(servers)("against $name", (server) => {
  let port = 0;
  let process_: ChildProcess | null = null;
  const running: WireProvider[] = [];

  /** Poll until the port is listening, or until it is not. */
  async function portIs(listening: boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const reachable = await new Promise<boolean>((resolve) => {
        const probe = connect({ port, host: "127.0.0.1" });
        probe.once("connect", () => {
          probe.destroy();
          resolve(true);
        });
        probe.once("error", () => resolve(false));
      });
      if (reachable === listening) return;
      if (Date.now() > deadline) {
        throw new Error(`the port never went ${listening ? "up" : "down"}`);
      }
      await pause(50);
    }
  }

  function board(): { board: BoardDoc; provider: WireProvider } {
    const made = openBoardDoc();
    const provider = new WireProvider(made.doc, `ws://127.0.0.1:${port}/board-interop`, {
      baseDelayMs: 100,
      maxDelayMs: 500,
      resyncMs: 2_000,
      healthMs: 5_000,
    });
    running.push(provider);
    return { board: made, provider };
  }

  beforeAll(async () => {
    port = await freePort();
    process_ = server.start(port);
    await portIs(true);
  }, 40_000);

  afterAll(() => {
    for (const provider of running.splice(0)) provider.destroy();
    process_?.kill();
  });

  it("syncs two boards, and their presence, over a real socket", async () => {
    const a = board();
    const b = board();
    await until(() => a.provider.synced && b.provider.synced);

    const fromA = polaroid(a.board, 10, 20);
    await until(() => at(b.board, fromA) !== null);
    expect(at(b.board, fromA)).toEqual({ x: 10, y: 20 });

    const fromB = polaroid(b.board, -5, 7);
    await until(() => at(a.board, fromB) !== null);
    expect(at(a.board, fromB)).toEqual({ x: -5, y: 7 });

    a.provider.awareness.setLocalState({ user: { name: "Phil" }, cam: { x: 0, y: 0, zoom: 1 } });
    await until(() => named(b.provider, a.board.doc.clientID));
    expect(b.provider.awareness.getStates().get(a.board.doc.clientID)).toMatchObject({
      user: { name: "Phil" },
    });
  }, 40_000);

  it("tells the room when a board's socket goes", async () => {
    const a = board();
    const b = board();
    await until(() => a.provider.synced && b.provider.synced);
    a.provider.awareness.setLocalState({ user: { name: "Phil" } });
    await until(() => named(b.provider, a.board.doc.clientID));

    a.provider.disconnect();

    // Nobody sends a goodbye when a network drops, so the server owes the room
    // this one. A cursor left on screen for someone who is not there is worse
    // than showing nobody.
    await until(() => !named(b.provider, a.board.doc.clientID));
  }, 40_000);

  it("survives the server going away and coming back", async () => {
    const a = board();
    const b = board();
    await until(() => a.provider.synced && b.provider.synced);
    a.provider.awareness.setLocalState({ user: { name: "Phil" } });
    await until(() => named(b.provider, a.board.doc.clientID));
    const before = a.board.items.size;

    process_?.kill();
    await portIs(false);
    await until(() => !a.provider.synced && !b.provider.synced);

    // Both edit in the dark, with nothing at all between them.
    const offlineA = polaroid(a.board, 111, 111);
    const offlineB = polaroid(b.board, 222, 222);

    process_ = server.start(port);
    await portIs(true);
    const backAt = Date.now();

    await until(() => at(b.board, offlineA) !== null && at(a.board, offlineB) !== null);

    // Timed, not just awaited. While the server was down every dial was
    // refused, and a refusal in Node reports an error and then never closes —
    // so without `transport.ts` treating that as terminal, the provider sits
    // out its whole silence timer before it will try again. It still recovers
    // either way, which is why only the clock can tell the two apart: about a
    // fifth of a second here, against the five seconds of `healthMs` there.
    expect(Date.now() - backAt).toBeLessThan(2_000);

    expect(at(b.board, offlineA)).toEqual({ x: 111, y: 111 });
    expect(at(a.board, offlineB)).toEqual({ x: 222, y: 222 });

    // The new server is a fresh process holding an empty document, so every
    // item on the board had to be handed back to it by the clients themselves.
    expect(a.board.items.size).toBe(before + 2);
    expect(b.board.items.size).toBe(before + 2);

    // And presence came back without anybody having to move.
    await until(() => named(b.provider, a.board.doc.clientID));
  }, 60_000);
});
