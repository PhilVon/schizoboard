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

import { freshBoardId, planSync } from "@/app/sync";
import { openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { createItems } from "@/crdt/ops";
import { readItem } from "@/crdt/schema";
import { AssetExchange } from "@/crdt/sync/exchange";
import { WireProvider } from "@/crdt/sync/provider";
import { CHUNK_BYTES } from "@/platform/types";
import { MockPlatform } from "@/platform/mock";

interface Server {
  readonly name: string;
  start(port: number): ChildProcess;
  /**
   * Whether it forwards the asset message type (T-74).
   *
   * Ours does; the reference server drops a type it does not know, silently and
   * without hurting the connection. That difference is *specified* rather than
   * tolerated — D-28 chose message type 4 precisely so that a board hosted on a
   * stock server keeps syncing its document and simply never trades bytes — so
   * both halves of it are asserted below rather than one being skipped.
   */
  readonly routesAssets: boolean;
}

const reference: Server = {
  name: "the reference y-websocket server",
  start: (port) =>
    spawn(process.execPath, ["node_modules/y-websocket/bin/server.js"], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
      stdio: "ignore",
    }),
  routesAssets: false,
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
    routesAssets: true,
  };
}

const embedded = buildRelay();
if (embedded === null) {
  console.warn("[interop] no Rust toolchain — the embedded relay is not under test");
}

/** The path `buildRelay` found, for the tests below that spawn it themselves. */
const relayBinary = ["src-tauri/target/debug/relay.exe", "src-tauri/target/debug/relay"].find(
  existsSync,
);

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
 * Bytes standing in for a photograph, big enough to take several chunks.
 *
 * Not a real image, and deliberately not compressible: the transfer under test
 * is a byte pipe, and the one property that matters is that it is longer than
 * one `CHUNK_BYTES` so the chunk loop is actually a loop. A run of zeroes would
 * still be several chunks but would hide an off-by-one in the offsets, since
 * every chunk would be identical.
 */
function photograph(): Uint8Array {
  const bytes = new Uint8Array(CHUNK_BYTES * 2 + 4_321);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  return bytes;
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
  const exchanges: AssetExchange[] = [];

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

  /**
   * A client in a room. `room` is a parameter because one test is *about* which
   * room a window comes back to (T-195) — everything else shares one board, and
   * counts items on the assumption that it does.
   */
  function board(room = "board-interop"): { board: BoardDoc; provider: WireProvider } {
    const made = openBoardDoc();
    const provider = new WireProvider(made.doc, `ws://127.0.0.1:${port}/${room}`, {
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
    for (const exchange of exchanges.splice(0)) exchange.destroy();
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

  it("carries a photograph between two peers, or says nothing at all", async () => {
    const a = board();
    const b = board();
    const holder = new MockPlatform();
    const seeker = new MockPlatform();
    const bytes = photograph();
    const { sha256 } = await holder.assetIngestBytes(bytes);

    const seeding = new AssetExchange(a.provider, holder);
    const fetching = new AssetExchange(b.provider, seeker);
    exchanges.push(seeding, fetching);
    await until(() => a.provider.synced && b.provider.synced);

    // The order a real board does it in: the item exists, and its bytes are
    // asked for afterwards by whatever tries to draw it.
    const item = polaroid(a.board, 40, 50);
    await until(() => at(b.board, item) !== null);
    fetching.want(sha256);

    if (!server.routesAssets) {
      // The documented degradation (D-28), asserted rather than assumed: a
      // stock server drops message type 4 and the *rest* of the board carries
      // on. If that ever stops being true this row fails, which is the only
      // warning there would be.
      await pause(2_000);
      expect(await seeker.assetHas([sha256])).toEqual([false]);
      const after = polaroid(a.board, 60, 70);
      await until(() => at(b.board, after) !== null);
      return;
    }

    await until(() => fetching.stats().wanted === 0, 30_000);
    expect(await seeker.assetHas([sha256])).toEqual([true]);

    // Byte for byte, read back the way a third peer would read it — which also
    // means the receiver can now seed it onwards.
    const chunks: Uint8Array[] = [];
    for (let index = 0; ; index += 1) {
      const chunk = await seeker.assetChunk(sha256, index);
      if (chunk.length === 0) break;
      chunks.push(chunk);
    }
    const received = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    chunks.reduce((at, chunk) => (received.set(chunk, at), at + chunk.length), 0);
    expect(chunks.length).toBe(3);
    expect(received).toEqual(bytes);
    expect(await seeker.peerHaveSummary()).toContain(sha256);

    // And now somebody who was not in the room when either of the other two
    // announced anything. `HAVE` has no history behind it, so without the two
    // holders saying it again on arrival this peer waits forever — which is
    // what a reloaded window is, and what a driven session found.
    const latecomer = board();
    const late = new MockPlatform();
    const catching = new AssetExchange(latecomer.provider, late);
    exchanges.push(catching);
    await until(() => latecomer.provider.synced);
    catching.want(sha256);

    await until(() => catching.stats().wanted === 0, 30_000);
    expect(await late.assetHas([sha256])).toEqual([true]);
  }, 60_000);

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

  /**
   * A board replaced out of a bundle, with somebody still on the old one
   * (T-195, Q-114).
   *
   * This is the one test here that is about a *product* decision rather than
   * about the protocol, and it is here because nowhere else can hold it: the
   * hazard is that **the relay holds a document** (`sync/room.rs`), so a room
   * outlives the socket that was in it, and a client that comes back is answered
   * with the difference between its state vector and everything the room knows.
   * A double would have agreed with whatever I assumed about that.
   *
   * Both servers, deliberately. This is not a rule ours invented — it is what a
   * y-websocket room *is* — so a fix that only worked against ours would be a
   * fix resting on an accident.
   */
  it("does not hand a replaced board back to the window that replaced it", async () => {
    // The room a window plans on an installation nobody has ever moved — asked
    // rather than named, so that the two halves of this test are the two answers
    // `planSync` really gives, and dropping the second argument below is exactly
    // the code that was there before this task.
    const OLD = planSync("").config.boardId;
    const ours = board(OLD);
    // The peer, who never leaves. Nothing about a replace is their business, and
    // the room living on inside them is precisely what makes this reachable —
    // solo, `sync/mod.rs` drops a room the moment it is empty, which is why T-84
    // never saw this.
    const peer = board(OLD);
    await until(() => ours.provider.synced && peer.provider.synced);
    const discarded = polaroid(ours.board, 10, 20);
    await until(() => at(peer.board, discarded) !== null);

    // The bundle open. `persistence.replaceWith` writes the bundle's document
    // over this one's and the window reloads, so what arrives next is a new
    // document on a new socket — and the room it asks for is whatever `planSync`
    // names once the shell has been told this installation was moved.
    ours.provider.destroy();
    const reloaded = board(planSync("", freshBoardId()).config.boardId);
    const fromTheBundle = polaroid(reloaded.board, 300, 400);

    // The control, and the reason this cannot pass vacuously: a window that came
    // back to the *same* room is handed the board it discarded — by this server,
    // over a socket opened at the same moment as the one above. So "the merge
    // simply had not happened yet" is not available as an explanation for the
    // assertions below. Without the fix, `reloaded` *is* this.
    const control = board(OLD);
    await until(() => at(control.board, discarded) !== null);
    await until(() => reloaded.provider.synced);

    expect(at(reloaded.board, discarded)).toBeNull();
    expect(reloaded.board.items.size).toBe(1);
    // And the other direction: nobody left on the old board is quietly given a
    // board they never opened.
    expect(at(peer.board, fromTheBundle)).toBeNull();
  }, 60_000);
});

/**
 * The secret, against the real relay over a real socket (T-70).
 *
 * The unit tests in `sync/mod.rs` prove `secret_matches` and `query_token` in
 * isolation, which is exactly the shape of proof that is worth least here: the
 * question is not whether the comparison is right, it is whether anything calls
 * it before a socket is in a room. That can only be asked from outside the
 * process, which is what this file is for.
 *
 * It matters more than most of what is tested here, because the check is the
 * only thing standing between `0.0.0.0` and a read-write corkboard offered to
 * whatever network the machine is on.
 */
describe.skipIf(relayBinary === undefined)("the relay's secret", () => {
  const SECRET = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  let port = 0;
  let process_: ChildProcess | null = null;
  const running: WireProvider[] = [];

  /** A client dialling the guarded relay with whatever token it was given. */
  function dial(token: string | null): { board: BoardDoc; provider: WireProvider } {
    const made = openBoardDoc();
    const query = token === null ? "" : `?token=${token}`;
    const provider = new WireProvider(made.doc, `ws://127.0.0.1:${port}/guarded${query}`, {
      baseDelayMs: 100,
      maxDelayMs: 500,
      resyncMs: 2_000,
      healthMs: 5_000,
    });
    running.push(provider);
    return { board: made, provider };
  }

  /** The refusal, or null if the peer never said one. */
  function refusal(provider: WireProvider): Promise<string | null> {
    return new Promise((resolve) => {
      const unlisten = provider.on("denied", (reason) => {
        unlisten();
        resolve(reason);
      });
      setTimeout(() => {
        unlisten();
        resolve(null);
      }, 5_000);
    });
  }

  beforeAll(async () => {
    port = await freePort();
    process_ = spawn(relayBinary!, [], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", RELAY_SECRET: SECRET },
      stdio: "ignore",
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const up = await new Promise<boolean>((resolve) => {
        const probe = connect({ port, host: "127.0.0.1" });
        probe.once("connect", () => {
          probe.destroy();
          resolve(true);
        });
        probe.once("error", () => resolve(false));
      });
      if (up) break;
      if (Date.now() > deadline) throw new Error("the guarded relay never came up");
      await pause(50);
    }
  }, 40_000);

  afterAll(() => {
    for (const provider of running.splice(0)) provider.destroy();
    process_?.kill();
  });

  it("lets in a peer that presents the secret", async () => {
    const a = dial(SECRET);
    const b = dial(SECRET);
    await until(() => a.provider.synced && b.provider.synced);

    const made = polaroid(a.board, 42, 43);
    await until(() => at(b.board, made) !== null);
    expect(at(b.board, made)).toEqual({ x: 42, y: 43 });
  }, 40_000);

  it("refuses a peer with no secret at all, in words", async () => {
    const stranger = dial(null);
    expect(await refusal(stranger.provider)).toBeTruthy();
    expect(stranger.provider.synced).toBe(false);
  }, 20_000);

  it("refuses a peer with the wrong secret", async () => {
    const stranger = dial("0f1e2d3c4b5a69788796a5b4c3d2e1f1");
    expect(await refusal(stranger.provider)).toBeTruthy();
    expect(stranger.provider.synced).toBe(false);
  }, 20_000);

  it("refuses a secret that is merely a prefix of the real one", async () => {
    // The case a length check has to catch before the comparison loop does,
    // and the one an over-clever `starts_with` would wave through.
    const stranger = dial(SECRET.slice(0, 16));
    expect(await refusal(stranger.provider)).toBeTruthy();
    expect(stranger.provider.synced).toBe(false);
  }, 20_000);

  it("does not let a refused peer see the board", async () => {
    // The refusal is only worth anything if it happens before the socket is in
    // a room: a client that is denied and *then* handed the document has been
    // told no and given the thing anyway.
    const member = dial(SECRET);
    await until(() => member.provider.synced);
    const secretItem = polaroid(member.board, 999, 999);

    const stranger = dial("ffffffffffffffffffffffffffffffff");
    await refusal(stranger.provider);
    await pause(500);
    expect(at(stranger.board, secretItem)).toBeNull();
    expect(stranger.board.items.size).toBe(0);
  }, 30_000);
});

/**
 * The invariant the whole of the above exists to protect: **a relay reachable
 * from another machine must have a secret.**
 *
 * Asserted on the process rather than on a function, because the thing that
 * must never happen is a *running* relay bound wide and open — and a unit test
 * of `guard` would still pass if somebody stopped calling it.
 */
describe.skipIf(relayBinary === undefined)("binding beyond loopback", () => {
  function run(env: Record<string, string>): Promise<number | null> {
    return new Promise((resolve) => {
      const child = spawn(relayBinary!, [], {
        env: { ...process.env, ...env },
        stdio: "ignore",
      });
      child.once("exit", (code) => resolve(code));
      // A relay that started is a relay that did not refuse, which is the
      // failure this is looking for. Kill it and report that it lived.
      setTimeout(() => {
        child.kill();
        resolve(null);
      }, 3_000);
    });
  }

  it("refuses a wide bind with no secret, rather than quietly narrowing it", async () => {
    const port = await freePort();
    expect(await run({ HOST: "0.0.0.0", PORT: String(port) })).toBe(2);
  }, 20_000);

  it("allows a wide bind once there is a secret", async () => {
    const port = await freePort();
    expect(await run({ HOST: "0.0.0.0", PORT: String(port), RELAY_SECRET: "a".repeat(32) })).toBe(
      null,
    );
  }, 20_000);

  it("allows loopback with no secret, which is every developer's relay", async () => {
    const port = await freePort();
    expect(await run({ HOST: "127.0.0.1", PORT: String(port) })).toBe(null);
  }, 20_000);
});
