/**
 * Two boards, one relay, and everything that can go wrong between them.
 *
 * The relay here is a double, not a mock: it holds a document, handshakes with
 * each connection and fans out what changed, because that is what the protocol
 * expects on the other end and a dumb broadcaster would let a bug through. It
 * fits in a page because `readMessage` already implements the answering half —
 * and that page is also the shape T-69 has to build in Rust.
 *
 * Everything is in-process and on microtasks, so the whole file runs in
 * milliseconds and the reconnect tests can fast-forward half a minute.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import { openBoardDoc, type BoardDoc } from "@/crdt/doc";
import { createItems, setItemPoses } from "@/crdt/ops";
import { isLocalOrigin, isTracked } from "@/crdt/origins";
import { readItem } from "@/crdt/schema";
import {
  encodeAwareness,
  encodePermissionDenied,
  encodeSyncStep1,
  encodeUpdate,
  readMessage,
} from "@/crdt/sync/protocol";
import {
  WireProvider,
  type ConnectionState,
  type WireProviderOptions,
} from "@/crdt/sync/provider";
import type { TransportFactory, TransportHandlers } from "@/crdt/sync/transport";

// --- the relay double ------------------------------------------------------

class Connection {
  private closed = false;
  /** Awareness clients this connection has spoken for, as y-websocket tracks. */
  readonly controls = new Set<number>();

  constructor(
    private readonly relay: Relay,
    private readonly handlers: TransportHandlers,
  ) {}

  /**
   * Client to relay. Deferred, because a transport never re-enters its caller.
   *
   * Closing does not cancel what was already handed over — a real socket
   * transmits queued data before its close frame, and a double that dropped it
   * would make a goodbye sent on the way out untestable.
   */
  send(bytes: Uint8Array): void {
    if (this.closed) return;
    queueMicrotask(() => this.relay.receive(this, bytes));
  }

  /** Relay to client. */
  push(bytes: Uint8Array): void {
    if (this.closed) return;
    queueMicrotask(() => {
      if (!this.closed) this.handlers.onMessage(bytes);
    });
  }

  close(clean = true): void {
    if (this.closed) return;
    this.closed = true;
    this.relay.forget(this);
    if (this.relay.cleansUpOnClose && this.controls.size > 0) {
      removeAwarenessStates(this.relay.awareness, [...this.controls], null);
    }
    queueMicrotask(() => this.handlers.onClose({ code: clean ? 1000 : 1006, reason: "", clean }));
  }

  opened(): void {
    queueMicrotask(() => {
      if (this.closed) return;
      this.handlers.onOpen();
      // What a y-websocket server says first: its own state vector, and who
      // else is in the room. The state vector is the half that matters — it is
      // how a client that edited while offline gets asked for the difference.
      this.push(encodeSyncStep1(this.relay.doc));
      if (!this.relay.pushesStatesOnConnect) return;
      const states = [...this.relay.awareness.getStates().keys()];
      if (states.length > 0) this.push(encodeAwareness(this.relay.awareness, states));
    });
  }
}

class Relay {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly connections = new Set<Connection>();

  online = true;
  /** Set to refuse every connection, with this reason. */
  refuse: string | null = null;
  /**
   * A real y-websocket server drops a connection's awareness states when the
   * socket goes. Turn it off to stand in for a peer that does not tidy up —
   * which is the only thing the client's own goodbye insures against.
   */
  cleansUpOnClose = true;
  /**
   * A y-websocket server volunteers who is in the room the moment you connect.
   * Turn it off to stand in for a relay that only answers what it is asked.
   */
  pushesStatesOnConnect = true;
  /** Every URL a client has dialled, in order. */
  readonly dialled: string[] = [];
  /** When each of those dials happened, for measuring the backoff. */
  readonly dialledAt: number[] = [];
  /** Frames arriving from clients, which is how an echo would show up. */
  received = 0;

  constructor() {
    this.doc.on("update", (update, origin) =>
      this.broadcast(encodeUpdate(update), origin as Connection | null),
    );
    this.awareness.on(
      "update",
      (
        changed: { added: number[]; updated: number[]; removed: number[] },
        origin: Connection | null,
      ) => {
        // Which socket speaks for which client, so a dropped connection takes
        // its presence with it.
        if (origin instanceof Connection) {
          for (const id of [...changed.added, ...changed.updated]) origin.controls.add(id);
          for (const id of changed.removed) origin.controls.delete(id);
        }
        const clients = [...changed.added, ...changed.updated, ...changed.removed];
        if (clients.length > 0) this.broadcast(encodeAwareness(this.awareness, clients), origin);
      },
    );
  }

  readonly transport: TransportFactory = (url, handlers) => {
    this.dialled.push(url);
    this.dialledAt.push(Date.now());
    const connection = new Connection(this, handlers);
    if (this.online) {
      this.connections.add(connection);
      connection.opened();
    } else {
      connection.close(false);
    }
    return { send: (bytes) => connection.send(bytes), close: () => connection.close() };
  };

  receive(from: Connection, bytes: Uint8Array): void {
    this.received += 1;
    if (this.refuse !== null) {
      from.push(encodePermissionDenied(this.refuse));
      return;
    }
    const reply = readMessage(bytes, {
      doc: this.doc,
      awareness: this.awareness,
      origin: from,
    });
    if (reply !== null) from.push(reply);
  }

  forget(connection: Connection): void {
    this.connections.delete(connection);
  }

  broadcast(bytes: Uint8Array, except: Connection | null): void {
    for (const connection of this.connections) {
      if (connection !== except) connection.push(bytes);
    }
  }

  /** Every client loses its connection, as if the relay's host went away. */
  drop(): void {
    this.online = false;
    for (const connection of [...this.connections]) connection.close(false);
  }

  up(): void {
    this.online = true;
  }
}

// --- a client --------------------------------------------------------------

interface Client {
  board: BoardDoc;
  provider: WireProvider;
  statuses: ConnectionState[];
}

const opened: WireProvider[] = [];

function client(relay: Relay, options: WireProviderOptions = {}): Client {
  const board = openBoardDoc();
  const provider = new WireProvider(board.doc, "ws://relay/board-1", {
    transport: relay.transport,
    baseDelayMs: 100,
    maxDelayMs: 1600,
    ...options,
    // Subscribed before the first status change, then connected by hand, so a
    // test can watch the whole walk rather than joining it after "connecting".
    connect: false,
  });
  opened.push(provider);

  const statuses: ConnectionState[] = [];
  provider.on("status", (status) => statuses.push(status));
  if (options.connect !== false) provider.connect();

  return { board, provider, statuses };
}

/** Let every queued microtask run. Nothing here takes more than a few hops. */
async function settle(turns = 24): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

/** Advance fake timers, then drain the microtasks the timers set going. */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

function polaroid(board: BoardDoc, x: number, y: number): string {
  return createItems(board, [{ type: "polaroid", x, y, w: 300, h: 360 }])[0]!.itemId;
}

function itemAt(board: BoardDoc, id: string): { x: number; y: number } | null {
  const map = board.items.get(id);
  if (map === undefined) return null;
  const item = readItem(id, map);
  return item === null ? null : { x: item.x, y: item.y };
}

function moveTo(board: BoardDoc, id: string, x: number, y: number): void {
  setItemPoses(board, new Map([[id, { x, y }]]));
}

/** The delay before each dial made after `from`, in order. */
function gapsBetweenDials(relay: Relay, from: number): number[] {
  const after = relay.dialledAt.filter((at) => at >= from);
  return after.map((at, index) => at - (index === 0 ? from : after[index - 1]!));
}

beforeEach(() => {
  // The backoff jitter is ±25%; pinned to dead centre so a test can name the
  // delay it is waiting for.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  for (const provider of opened.splice(0)) provider.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// --- the tests -------------------------------------------------------------

describe("two boards on one relay", () => {
  it("carries an edit in both directions", async () => {
    const relay = new Relay();
    const a = client(relay);
    const b = client(relay);
    await settle();

    const fromA = polaroid(a.board, 10, 20);
    await settle();
    expect(itemAt(b.board, fromA)).toEqual({ x: 10, y: 20 });

    const fromB = polaroid(b.board, -5, 7);
    await settle();
    expect(itemAt(a.board, fromB)).toEqual({ x: -5, y: 7 });
  });

  it("hands a board that joins late everything it missed", async () => {
    const relay = new Relay();
    const a = client(relay);
    await settle();
    const ids = [polaroid(a.board, 0, 0), polaroid(a.board, 1, 1), polaroid(a.board, 2, 2)];
    await settle();

    const b = client(relay);
    await settle();

    expect(b.board.items.size).toBe(3);
    for (const id of ids) expect(itemAt(b.board, id)).not.toBeNull();
    expect(b.provider.synced).toBe(true);
  });

  it("converges when both boards move one item at once", async () => {
    const relay = new Relay();
    const a = client(relay);
    const b = client(relay);
    await settle();
    const id = polaroid(a.board, 0, 0);
    await settle();

    // Neither has heard about the other's move when it makes its own.
    moveTo(a.board, id, 100, 100);
    moveTo(b.board, id, 200, 200);
    await settle();

    expect(itemAt(a.board, id)).toEqual(itemAt(b.board, id));
  });

  it("walks the status from offline to synced", async () => {
    const relay = new Relay();
    const a = client(relay);

    expect(a.provider.status).toBe("connecting");
    await settle();

    expect(a.statuses).toEqual(["connecting", "connected", "synced"]);
    expect(a.provider.synced).toBe(true);
  });
});

describe("what a remote edit is allowed to be", () => {
  it("arrives under an origin that undo and echo suppression already ignore", async () => {
    const relay = new Relay();
    const a = client(relay);
    const b = client(relay);
    await settle();

    const origins: unknown[] = [];
    b.board.doc.on("update", (_update, origin) => origins.push(origin));
    polaroid(a.board, 3, 4);
    await settle();

    expect(origins).toHaveLength(1);
    // Not a `schizo/` string, so both the "did this client write it" test and
    // the undo manager's tracked-origin set say no without being told to.
    expect(isLocalOrigin(origins[0])).toBe(false);
    expect(isTracked(origins[0])).toBe(false);
  });

  it("is announced as an update event, with the bytes", async () => {
    const relay = new Relay();
    const a = client(relay);
    const b = client(relay);
    await settle();

    const seen: Uint8Array[] = [];
    b.provider.on("update", (bytes) => seen.push(bytes));
    polaroid(a.board, 0, 0);
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.byteLength).toBeGreaterThan(0);
  });

  it("is not sent back down the connection it came from", async () => {
    const relay = new Relay();
    const a = client(relay);
    client(relay);
    await settle();

    relay.received = 0;
    polaroid(a.board, 0, 0);
    await settle();

    // One frame: A's update. B applied it and said nothing. An echo here would
    // loop forever through a relay that fans out what it is told.
    expect(relay.received).toBe(1);
  });
});

describe("when the connection goes", () => {
  it("reconnects and carries what was written while it was down", async () => {
    vi.useFakeTimers();
    const relay = new Relay();
    const a = client(relay);
    const b = client(relay);
    await tick(1);

    relay.drop();
    await tick(1);
    expect(a.provider.status).toBe("offline");

    // Both edit in the dark. There is no outbound queue; the state-vector
    // handshake on reconnect is what carries these.
    const fromA = polaroid(a.board, 11, 11);
    const fromB = polaroid(b.board, 22, 22);
    relay.up();

    await tick(5_000);

    expect(a.provider.synced).toBe(true);
    expect(itemAt(b.board, fromA)).toEqual({ x: 11, y: 11 });
    expect(itemAt(a.board, fromB)).toEqual({ x: 22, y: 22 });
  });

  it("backs off, doubling, and levels out at the ceiling", async () => {
    vi.useFakeTimers();
    const relay = new Relay();
    const a = client(relay, { baseDelayMs: 100, maxDelayMs: 400 });
    await tick(1);

    relay.drop();
    // No time passes here: the close lands as a microtask, so the first retry
    // is scheduled from exactly this instant. The jitter is pinned to 1.0.
    await settle();
    const from = Date.now();
    await tick(3_000);

    expect(gapsBetweenDials(relay, from).slice(0, 5)).toEqual([100, 200, 400, 400, 400]);
    // Not "connecting" the whole time — each failed attempt reports offline and
    // then waits, which is what a status line should be able to say.
    expect(a.provider.status).toBe("offline");
  });

  it("starts over from the first delay once a connection syncs", async () => {
    vi.useFakeTimers();
    const relay = new Relay();
    const a = client(relay);
    await tick(1);

    relay.drop();
    await tick(700);
    relay.up();
    await tick(1_000);
    expect(a.provider.synced).toBe(true);

    relay.drop();
    await settle();
    const from = Date.now();
    await tick(150);

    // Back to 100ms, not still climbing towards the ceiling.
    expect(gapsBetweenDials(relay, from)).toEqual([100]);
  });

  it("closes a connection that has gone silent, and dials again", async () => {
    vi.useFakeTimers();
    const relay = new Relay();
    const a = client(relay, { healthMs: 5_000, resyncMs: 60_000 });
    await tick(1);
    expect(a.provider.synced).toBe(true);
    const before = relay.dialled.length;

    // A half-open connection says nothing and looks fine from this side. Only
    // the silence gives it away.
    await tick(5_001);
    expect(a.provider.status).not.toBe("synced");

    await tick(200);
    expect(relay.dialled.length).toBeGreaterThan(before);
  });

  it("keeps the line warm with a state vector", async () => {
    vi.useFakeTimers();
    const relay = new Relay();
    const a = client(relay, { resyncMs: 1_000, healthMs: 3_000 });
    await tick(1);
    const before = relay.dialled.length;

    // Three health windows' worth of a connection nobody is using. The resync
    // is the only thing keeping it from being declared dead.
    await tick(10_000);

    expect(a.provider.status).toBe("synced");
    expect(relay.dialled.length).toBe(before);
  });

  it("gives up when the peer refuses, rather than retrying a no", async () => {
    vi.useFakeTimers();
    const relay = new Relay();
    relay.refuse = "this board is not shared with you";
    const reasons: string[] = [];
    const a = client(relay, { connect: false });
    a.provider.on("denied", (reason) => reasons.push(reason));
    a.provider.connect();

    await tick(1);
    const dialled = relay.dialled.length;
    await tick(60_000);

    expect(reasons).toEqual(["this board is not shared with you"]);
    expect(relay.dialled.length).toBe(dialled);
    expect(a.provider.status).toBe("offline");
  });

  it("stays stopped after disconnect, and starts again on connect", async () => {
    vi.useFakeTimers();
    const relay = new Relay();
    const a = client(relay);
    await tick(1);

    a.provider.disconnect();
    await tick(10_000);
    expect(a.provider.status).toBe("offline");
    const dialled = relay.dialled.length;

    a.provider.connect();
    await tick(1);

    expect(relay.dialled.length).toBe(dialled + 1);
    expect(a.provider.synced).toBe(true);
  });
});

describe("a transport that does not play by the rules", () => {
  /** Accepts the dial, and then says nothing at all. Ever. */
  function silent(record: { dials: number; handlers: TransportHandlers[] }): TransportFactory {
    return (_url, handlers) => {
      record.dials += 1;
      record.handlers.push(handlers);
      return { send: () => {}, close: () => {} };
    };
  }

  function provider(record: { dials: number; handlers: TransportHandlers[] }, options = {}) {
    const board = openBoardDoc();
    const made = new WireProvider(board.doc, "ws://nowhere/board-1", {
      transport: silent(record),
      baseDelayMs: 100,
      healthMs: 1_000,
      ...options,
    });
    opened.push(made);
    return made;
  }

  it("gives up on a dial that never opens, and tries again", async () => {
    vi.useFakeTimers();
    const record = { dials: 0, handlers: [] as TransportHandlers[] };
    const made = provider(record);

    // A host that accepts the packet and then says nothing would otherwise
    // leave this in "connecting" for as long as the application runs.
    await tick(1);
    expect(record.dials).toBe(1);
    expect(made.status).toBe("connecting");

    // Past the silence timer, before the retry it schedules.
    await tick(1_050);
    expect(made.status).toBe("offline");

    await tick(150);
    expect(record.dials).toBe(2);
  });

  it("does not wedge when a socket errors and then never closes", async () => {
    vi.useFakeTimers();
    const record = { dials: 0, handlers: [] as TransportHandlers[] };
    const made = provider(record);
    const errors: unknown[] = [];
    made.on("error", (error) => errors.push(error));

    record.handlers[0]!.onError(new Error("connection refused"));
    await tick(1_200);

    expect(errors).toHaveLength(1);
    await tick(150);
    expect(record.dials).toBe(2);
  });

  it("ignores a close from an attempt it has already given up on", async () => {
    vi.useFakeTimers();
    const record = { dials: 0, handlers: [] as TransportHandlers[] };
    provider(record);

    await tick(1_100);
    await tick(150);
    expect(record.dials).toBe(2);

    // The first socket finally reports its close, long after we moved on. It
    // must not tear down the connection that replaced it.
    record.handlers[0]!.onClose({ code: 1006, reason: "", clean: false });
    await tick(150);

    expect(record.dials).toBe(2);
  });
});

describe("presence", () => {
  it("reaches the other board", async () => {
    const relay = new Relay();
    const a = client(relay);
    const b = client(relay);
    await settle();

    a.provider.awareness.setLocalState({ user: { name: "Phil" }, cam: { x: 0, y: 0, zoom: 1 } });
    await settle();

    expect(b.provider.awareness.getStates().get(a.board.doc.clientID)).toMatchObject({
      user: { name: "Phil" },
    });
  });

  it("is sent on connect, so a board that joins late is not invisible", async () => {
    const relay = new Relay();
    const a = client(relay);
    await settle();
    a.provider.awareness.setLocalState({ user: { name: "Phil" } });
    await settle();

    const b = client(relay);
    await settle();

    expect(b.provider.awareness.getStates().has(a.board.doc.clientID)).toBe(true);
  });

  it("disappears when its board's connection does", async () => {
    const relay = new Relay();
    const a = client(relay);
    const b = client(relay);
    await settle();
    a.provider.awareness.setLocalState({ user: { name: "Phil" } });
    await settle();
    expect(b.provider.awareness.getStates().has(a.board.doc.clientID)).toBe(true);

    b.provider.disconnect();
    await settle();

    // Everything B knew, it knew through that connection. A cursor left on
    // screen for someone who is not there is worse than showing nobody.
    expect(b.provider.awareness.getStates().has(a.board.doc.clientID)).toBe(false);
    expect(b.provider.awareness.getStates().has(b.board.doc.clientID)).toBe(true);
  });

  it("asks who is in the room, in case the peer does not volunteer it", async () => {
    const relay = new Relay();
    relay.pushesStatesOnConnect = false;
    const a = client(relay);
    await settle();
    a.provider.awareness.setLocalState({ user: { name: "Phil" } });
    await settle();

    const b = client(relay);
    await settle();

    // Nobody will re-send A's cursor just because B turned up. Without the
    // question, B sees an empty room until somebody moves.
    expect(b.provider.awareness.getStates().has(a.board.doc.clientID)).toBe(true);
  });

  it("announces itself again after a reconnect", async () => {
    vi.useFakeTimers();
    const relay = new Relay();
    const a = client(relay);
    const b = client(relay);
    await tick(1);
    a.provider.awareness.setLocalState({ user: { name: "Phil" } });
    await tick(1);

    relay.drop();
    await tick(1);
    relay.up();
    await tick(2_000);

    // The relay forgot everyone the moment their sockets went. Being visible
    // again cannot wait for the next time somebody happens to move the mouse.
    expect(b.provider.awareness.getStates().has(a.board.doc.clientID)).toBe(true);
  });

  it("says goodbye on destroy instead of leaving a ghost", async () => {
    const relay = new Relay();
    // A peer that does not tidy up after a closed socket. Against one that
    // does, the goodbye is belt and braces and proves nothing.
    relay.cleansUpOnClose = false;
    const a = client(relay);
    const b = client(relay);
    await settle();
    a.provider.awareness.setLocalState({ user: { name: "Phil" } });
    await settle();
    expect(b.provider.awareness.getStates().has(a.board.doc.clientID)).toBe(true);

    a.provider.destroy();
    await settle();

    expect(b.provider.awareness.getStates().has(a.board.doc.clientID)).toBe(false);
  });
});

describe("two providers, one document", () => {
  it("bridges what arrives on one connection to the other", async () => {
    const lan = new Relay();
    const hosted = new Relay();

    const bridge = openBoardDoc();
    const shared = new Awareness(bridge.doc);
    opened.push(
      new WireProvider(bridge.doc, "ws://lan/board-1", {
        transport: lan.transport,
        awareness: shared,
      }),
      new WireProvider(bridge.doc, "ws://hosted/board-1", {
        transport: hosted.transport,
        awareness: shared,
      }),
    );

    const onLan = client(lan);
    const onHosted = client(hosted);
    await settle();

    const id = polaroid(onLan.board, 9, 9);
    await settle();

    // The two relays were never connected, and neither client was told the
    // other existed.
    expect(itemAt(onHosted.board, id)).toEqual({ x: 9, y: 9 });
  });
});
