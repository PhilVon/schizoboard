/**
 * The exchange, against peers that misbehave.
 *
 * The happy path is not tested here. It is tested in `tests/sync-interop.ts`,
 * where two real exchanges move a real payload through the real Rust relay over
 * two real sockets — because a transfer that only ever works against a double
 * of my own writing proves that I am consistent with myself, and this project
 * has already been bitten by exactly that (the reference server found two live
 * bugs the in-process suite was blind to).
 *
 * What is here is everything that double is *good* at: a peer that claims an
 * asset it does not have, one that sends bytes that are not it, one that stops
 * answering, and a queue asked for more than it can carry at once. Those are
 * hard to stage over a socket and trivial to stage in a script — so the peers
 * below are scripted, and the only real thing in the file is the exchange.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHUNK_BYTES, type Platform } from "../../platform/types";
import { decodeAsset, encodeData, encodeDone, encodeHave, encodeNack } from "./assets";
import { AssetExchange, Priority } from "./exchange";
import { MessageType } from "./protocol";
import type { ConnectionState, SyncEvents, SyncProvider } from "./provider";

const PEER_A = 10;
const PEER_B = 20;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The relay, as a script.
 *
 * Reads the frame the same way `room.rs` does — sender id discarded, `to`
 * routed — and hands the tail to the test instead of to a socket.
 */
class Wire implements Pick<SyncProvider, "send" | "on" | "synced"> {
  synced = true;
  /** Just enough awareness to notice somebody arriving. */
  readonly awareness = {
    clientID: 1,
    on: (_event: string, listener: (change: { added: number[] }) => void) => {
      this.arrivals.push(listener);
    },
    off: () => {},
  };
  private readonly arrivals: ((change: { added: number[] }) => void)[] = [];
  /** Everything the exchange has said, in order, already decoded. */
  readonly sent: { to: number; message: NonNullable<ReturnType<typeof decodeAsset>> }[] = [];
  private readonly listeners = new Map<string, ((value: never) => void)[]>();

  send(frame: Uint8Array): boolean {
    // Hand-decoded rather than via a helper, so that a change to the frame
    // layout in `protocol.ts` shows up here as a failing test rather than as
    // two files quietly agreeing on something new.
    let at = 0;
    const varUint = (): number => {
      let value = 0;
      let shift = 0;
      for (;;) {
        const byte = frame[at++]!;
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return value;
        shift += 7;
      }
    };
    expect(varUint()).toBe(MessageType.ASSET);
    expect(varUint()).toBe(0); // never fills in its own id: the relay does that
    const to = varUint();
    const message = decodeAsset(frame.subarray(at));
    expect(message).not.toBeNull();
    this.sent.push({ to, message: message! });
    return true;
  }

  on<K extends keyof SyncEvents>(event: K, listener: (value: SyncEvents[K]) => void): () => void {
    const set = this.listeners.get(event) ?? [];
    set.push(listener as (value: never) => void);
    this.listeners.set(event, set);
    return () => {};
  }

  /** A peer says something to us. */
  hear(from: number, tail: Uint8Array): void {
    for (const listener of this.listeners.get("asset") ?? []) {
      (listener as unknown as (value: SyncEvents["asset"]) => void)({ from, tail });
    }
  }

  status(state: ConnectionState): void {
    this.synced = state === "synced";
    for (const listener of this.listeners.get("status") ?? []) {
      (listener as unknown as (value: ConnectionState) => void)(state);
    }
  }

  /** Somebody joins the board. */
  joins(client: number): void {
    for (const listener of this.arrivals) listener({ added: [client] });
  }

  /** What was asked of whom, which is the whole observable behaviour. */
  wants(): { to: number; sha256: string }[] {
    return this.sent
      .filter((f) => f.message.kind === "want")
      .map((f) => ({ to: f.to, sha256: (f.message as { sha256: string }).sha256 }));
  }
}

/**
 * A store that can be told to lie.
 *
 * `hold` takes the name to file bytes under *separately* from the bytes, which
 * a content-addressed store cannot do and which is precisely how a peer serving
 * the wrong photograph is staged.
 */
class Store implements Pick<Platform, "peerHaveSummary" | "assetSize" | "assetChunk"> {
  private readonly held = new Map<string, Uint8Array>();
  private readonly partials = new Map<string, Map<number, Uint8Array>>();
  committed: string[] = [];

  hold(name: string, bytes: Uint8Array): void {
    this.held.set(name, bytes);
  }

  async peerHaveSummary(): Promise<string[]> {
    return [...this.held.keys()];
  }

  async assetSize(sha256: string): Promise<number> {
    return this.held.get(sha256)?.length ?? 0;
  }

  async assetChunk(sha256: string, index: number): Promise<Uint8Array> {
    const bytes = this.held.get(sha256);
    if (bytes === undefined) return new Uint8Array(0);
    return bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
  }

  async assetReceive(sha256: string, index: number, _total: number, bytes: Uint8Array): Promise<void> {
    let partial = this.partials.get(sha256);
    if (partial === undefined) this.partials.set(sha256, (partial = new Map()));
    partial.set(index, bytes.slice());
  }

  async assetCommit(sha256: string): Promise<boolean> {
    const partial = this.partials.get(sha256);
    this.partials.delete(sha256);
    if (partial === undefined) return false;

    const parts = [...partial.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (whole.set(p, at), at + p.length), 0);
    if ((await sha256Hex(whole)) !== sha256) return false;

    this.held.set(sha256, whole);
    this.committed.push(sha256);
    return true;
  }

  async assetAbort(sha256: string): Promise<void> {
    this.partials.delete(sha256);
  }
}

/** Feed a whole asset to the exchange the way a well-behaved peer would. */
function deliver(wire: Wire, from: number, sha256: string, bytes: Uint8Array): void {
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
  for (let i = 0; i < total; i += 1) {
    wire.hear(
      from,
      encodeData(sha256, i, total, bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)),
    );
  }
  wire.hear(from, encodeDone(sha256));
  // Nothing is awaited here on purpose. The commit deliberately waits behind
  // the chunk writes, so what follows a `DONE` is asynchronous and every caller
  // has to wait for the outcome it actually cares about.
}

/** Something to announce, so that "we are open" is observable at all. */
const UNRELATED = "f".repeat(64);

describe("the asset exchange", () => {
  let wire: Wire;
  let store: Store;
  let unavailable: string[];
  let exchange: AssetExchange;
  let hash: string;
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  beforeEach(async () => {
    hash = await sha256Hex(bytes);
    wire = new Wire();
    store = new Store();
    store.hold(UNRELATED, new Uint8Array([0]));
    unavailable = [];
    exchange = new AssetExchange(wire as unknown as SyncProvider, store as unknown as Platform, {
      onUnavailable: (sha256) => unavailable.push(sha256),
    });

    // Opening reads the store, so it is asynchronous, and everything below
    // depends on it having finished. The announcement is the signal that it has.
    await vi.waitFor(() => expect(wire.sent).toHaveLength(1));
    expect(wire.sent[0]).toMatchObject({ to: 0, message: { kind: "have" } });
    wire.sent.length = 0;
  });

  it("asks nobody until somebody says they have it", () => {
    exchange.want(hash);

    expect(wire.wants()).toEqual([]);
    expect(unavailable).toEqual([]);
    // Not given up on, either: a peer holding it may still be about to connect.
    expect(exchange.stats().wanted).toBe(1);
  });

  it("asks one holder, not the room", async () => {
    wire.hear(PEER_A, encodeHave([hash]));
    wire.hear(PEER_B, encodeHave([hash]));
    exchange.want(hash);

    expect(wire.wants()).toHaveLength(1);
    expect([PEER_A, PEER_B]).toContain(wire.wants()[0]!.to);
  });

  it("tries the next holder when the first says it has not got it", async () => {
    wire.hear(PEER_A, encodeHave([hash]));
    wire.hear(PEER_B, encodeHave([hash]));
    exchange.want(hash);
    const first = wire.wants()[0]!.to;

    wire.hear(first, encodeNack(hash));

    const asked = wire.wants();
    expect(asked).toHaveLength(2);
    expect(asked[1]!.to).not.toBe(first);
  });

  it("refuses bytes that are not the asset, and asks somebody else", async () => {
    // The case the whole verify-before-commit rule exists for: a prefix
    // collision, or a peer whose store has rotted. Nothing may be committed.
    wire.hear(PEER_A, encodeHave([hash]));
    wire.hear(PEER_B, encodeHave([hash]));
    exchange.want(hash);
    const first = wire.wants()[0]!.to;

    deliver(wire, first, hash, new Uint8Array([9, 9, 9]));

    await vi.waitFor(() => expect(wire.wants()).toHaveLength(2));
    expect(store.committed).toEqual([]);
    expect(wire.wants()[1]!.to).not.toBe(first);
  });

  it("commits what does hash to the name it came under", async () => {
    wire.hear(PEER_A, encodeHave([hash]));
    exchange.want(hash);

    deliver(wire, PEER_A, hash, bytes);

    await vi.waitFor(() => expect(store.committed).toEqual([hash]));
    expect(exchange.stats().wanted).toBe(0);
  });

  it("says so when every holder has failed", async () => {
    wire.hear(PEER_A, encodeHave([hash]));
    exchange.want(hash);
    wire.hear(PEER_A, encodeNack(hash));

    // An empty frame is worse than a missing one: the item shows the same
    // nothing either way, and only this says which.
    expect(unavailable).toEqual([hash]);
    expect(exchange.stats().wanted).toBe(0);
  });

  it("asks again after a peer that failed re-announces", async () => {
    wire.hear(PEER_A, encodeHave([hash]));
    exchange.want(hash);
    wire.hear(PEER_A, encodeNack(hash));
    expect(unavailable).toEqual([hash]);

    // A peer that has since fetched the asset itself, and is now a holder. The
    // want is gone, so this is the renderer asking again — which it does every
    // time the item is drawn.
    wire.hear(PEER_A, encodeHave([hash]));
    exchange.want(hash);

    expect(wire.wants().filter((w) => w.to === PEER_A)).toHaveLength(2);
  });

  it("gives up on a peer that goes quiet", async () => {
    vi.useFakeTimers();
    try {
      wire.hear(PEER_A, encodeHave([hash]));
      wire.hear(PEER_B, encodeHave([hash]));
      exchange.want(hash);
      const first = wire.wants()[0]!.to;

      // A peer that accepted the WANT and then stopped. Nothing about the
      // socket says anything is wrong; only the clock does.
      vi.advanceTimersByTime(20_000);

      expect(wire.wants()).toHaveLength(2);
      expect(wire.wants()[1]!.to).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a backfill to make room for what somebody is looking at", async () => {
    const backfill = ["a", "b", "c", "d"].map((c) => c.repeat(64));
    wire.hear(PEER_A, encodeHave([...backfill, hash]));
    for (const sha256 of backfill) exchange.want(sha256);

    // Three slots, four wants: the fourth is queued behind them.
    expect(exchange.stats().inFlight).toBe(3);
    expect(wire.wants()).toHaveLength(3);

    // Now an item comes on screen. Its photograph must not wait behind three
    // it is not possible to see.
    exchange.want(hash, Priority.VISIBLE);

    expect(exchange.stats().inFlight).toBe(3);
    expect(wire.wants().map((w) => w.sha256)).toContain(hash);
  });

  it("does not let two backfills take turns displacing each other", async () => {
    const backfill = ["a", "b", "c", "d", "e"].map((c) => c.repeat(64));
    wire.hear(PEER_A, encodeHave(backfill));
    for (const sha256 of backfill) exchange.want(sha256);

    // Equal priorities never displace, so five wants at one priority is three
    // transfers and two waiting — not five transfers cancelling one another.
    expect(wire.wants()).toHaveLength(3);
    expect(exchange.stats().wanted).toBe(5);
  });

  it("tells a peer that arrives late what it holds", async () => {
    // `HAVE` is a broadcast with no history, so everything said before somebody
    // joined was said to a room they were not in. A window reloaded an hour
    // into a session would otherwise want every photograph on the board and
    // wait forever for an announcement nobody was going to repeat.
    //
    // Found by driving two browser windows, not by this suite — every test in
    // it had both peers present before the first announcement, which is exactly
    // the case that works.
    wire.joins(PEER_A);

    await vi.waitFor(() => expect(wire.sent).toHaveLength(1));
    expect(wire.sent[0]).toMatchObject({ to: 0, message: { kind: "have" } });
  });

  it("does not announce to itself arriving", async () => {
    wire.joins(wire.awareness.clientID);

    await vi.waitFor(() => expect(true).toBe(true));
    expect(wire.sent).toEqual([]);
  });

  it("forgets everything about a connection that has gone", async () => {
    wire.hear(PEER_A, encodeHave([hash]));
    exchange.want(hash);
    expect(exchange.stats().inFlight).toBe(1);

    wire.status("offline");

    // Client ids are not stable across a connection, so a holder learned on the
    // old one is not a holder — asking it again would be asking nobody.
    expect(exchange.stats().inFlight).toBe(0);
    wire.sent.length = 0;
    exchange.want(hash);
    expect(wire.wants()).toEqual([]);
  });
});
