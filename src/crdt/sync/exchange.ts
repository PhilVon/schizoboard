/**
 * Getting the bytes of a photograph from the peer that has them.
 *
 * The document says an item is a 4032x3024 JPEG with a given sha256 (DATA-MODEL
 * section 10); it does not say what the pixels are. So a board can be fully
 * synced and still be a wall of empty frames, and this is what fills them in.
 *
 * ## What it is not allowed to touch
 *
 * Bytes. A chunk comes out of `Platform.assetChunk` and goes into
 * `Platform.assetReceive` without being read, and the hash of what arrived is
 * checked by `assetCommit` in Rust — "Rust does chunking, verification and the
 * store commit. The frontend only orchestrates by hash" (ARCHITECTURE 5.2).
 * That is not tidiness: verifying in JavaScript would mean holding a whole
 * 12 MB original in the renderer's heap to hash it, which is the thing
 * `asset://` exists to avoid.
 *
 * ## The shape of the conversation
 *
 * Everybody announces what they hold as a list of hash prefixes (`HAVE`), so a
 * peer that needs one knows who to ask. A `WANT` then goes to **one** holder,
 * not to the room — the relay routes it point to point (D-28) — and that peer
 * replies with `DATA` chunks and a `DONE`, or with `NACK` if the prefix turned
 * out to be a collision or the asset has since been collected.
 *
 * Everything that can go wrong here ends the same way: mark that peer as tried,
 * and ask the next one. A silent peer, a refusal, a failed verification and a
 * dropped socket are one code path, because there is only one useful response
 * to any of them.
 */

import { CHUNK_BYTES, type Platform } from "../../platform/types";
import {
  decodeAsset,
  encodeData,
  encodeDone,
  encodeHave,
  encodeNack,
  encodeWant,
  isHash,
  prefixOf,
} from "./assets";
import { encodeAsset } from "./protocol";
import type { SyncProvider } from "./provider";

/**
 * How many assets are in flight at once.
 *
 * "Everything else backfills at low priority with bounded concurrency"
 * (ARCHITECTURE 5.2). Three, because the bound that matters is not our
 * bandwidth but the seeding peer's: a board opened cold would otherwise ask one
 * machine for four hundred photographs at the same moment.
 */
const MAX_IN_FLIGHT = 3;

/**
 * How long a transfer may say nothing before we give up on that peer.
 *
 * Generous, because a peer serving three others off a laptop disk is slow
 * rather than gone, and re-asking somebody else costs a whole photograph.
 */
const SILENCE_MS = 15_000;

/** What `want` takes. Higher is sooner; anything on screen outranks anything not. */
export const Priority = {
  /** Backfill: the item exists somewhere on the board. */
  IDLE: 0,
  /** The item is in or near the viewport, so somebody is looking at the hole. */
  VISIBLE: 1,
} as const;

interface Wanted {
  priority: number;
  /** Peers already asked and found wanting. Cleared when a new `HAVE` arrives. */
  tried: Set<number>;
}

interface InFlight {
  peer: number;
  priority: number;
  received: number;
  total: number;
  silence?: ReturnType<typeof setTimeout>;
  /**
   * Every write of a chunk, in order, and the thing `DONE` has to wait behind.
   *
   * `DATA` is handled synchronously — it has to be, it is a socket callback —
   * so the writes it starts are still running when the `DONE` behind the last
   * one arrives. Committing there would verify a file missing its final chunk
   * and fail, once per transfer, on nothing but timing.
   */
  written: Promise<void>;
}

export interface ExchangeOptions {
  /** Told about every transfer's progress, for the per-asset render state (T-95). */
  onProgress?: (sha256: string, received: number, total: number) => void;
  /** A transfer that has run out of peers to ask. Renders as unavailable (T-75). */
  onUnavailable?: (sha256: string) => void;
}

export class AssetExchange {
  private readonly holders = new Map<string, Set<number>>();
  private readonly wanted = new Map<string, Wanted>();
  private readonly inFlight = new Map<string, InFlight>();
  private readonly unlisten: (() => void)[] = [];
  private open = false;
  private destroyed = false;

  constructor(
    private readonly provider: SyncProvider,
    private readonly native: Platform,
    private readonly options: ExchangeOptions = {},
  ) {
    this.unlisten.push(provider.on("asset", ({ from, tail }) => this.receive(from, tail)));
    this.unlisten.push(
      provider.on("status", (status) => {
        // `synced`, not `connected`. The relay stamps the sender's client id
        // into every asset frame from the awareness it has seen, and until the
        // handshake is through it has seen none — so a frame sent any earlier is
        // dropped by the relay with nothing said (D-28).
        if (status === "synced") void this.opened();
        else this.closed();
      }),
    );
    if (provider.synced) void this.opened();
  }

  /**
   * Ask for a hash, or raise the priority of one already asked for.
   *
   * Idempotent and cheap: the renderer calls this for every item it mounts
   * whose bytes are missing, every time the viewport changes.
   */
  want(sha256: string, priority: number = Priority.IDLE): void {
    if (!isHash(sha256)) return;
    const existing = this.wanted.get(sha256);
    if (existing !== undefined) {
      // Raising a want mid-transfer changes nothing about the transfer. It is
      // the queue behind it that reorders.
      if (priority > existing.priority) existing.priority = priority;
      return;
    }
    this.wanted.set(sha256, { priority, tried: new Set() });
    this.pump();
  }

  /** Stop asking. The item was deleted, or its bytes arrived from somewhere else. */
  forget(sha256: string): void {
    this.wanted.delete(sha256);
    const live = this.inFlight.get(sha256);
    if (live === undefined) return;
    clearTimeout(live.silence);
    this.inFlight.delete(sha256);
    this.abort(sha256);
  }

  /**
   * Tell the room what this machine holds.
   *
   * Called on connect with everything, and with a single hash whenever one is
   * ingested — a photograph pasted here is one somebody else is about to want,
   * and waiting for a periodic sweep to mention it would leave their frame empty
   * for no reason.
   */
  announce(hashes: readonly string[]): void {
    if (!this.open || hashes.length === 0) return;
    this.provider.send(encodeAsset(0, encodeHave(hashes)));
  }

  /**
   * What the dev HUD shows. Cheap enough to call at its paint rate.
   *
   * A transfer is otherwise completely unobservable: the item is an empty frame
   * before it and a photograph after it, and every way it can fail — no holder,
   * a silent peer, a hash that did not match — leaves exactly the same empty
   * frame as "still going". These three numbers are the difference between
   * watching it work and guessing.
   */
  stats(): { wanted: number; inFlight: number; percent: number } {
    let received = 0;
    let total = 0;
    for (const live of this.inFlight.values()) {
      received += live.received;
      total += live.total;
    }
    return {
      wanted: this.wanted.size,
      inFlight: this.inFlight.size,
      percent: total === 0 ? 0 : Math.round((received / total) * 100),
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.closed();
    for (const off of this.unlisten) off();
    this.unlisten.length = 0;
  }

  // --- the wire ------------------------------------------------------------

  private async opened(): Promise<void> {
    this.open = true;
    // Everything we hold, so peers can ask us; then re-ask for everything we
    // still want, since a transfer that was in flight when the socket went is
    // not coming back on its own.
    const held = await this.native.peerHaveSummary();
    if (this.destroyed) return;
    this.announce(held);
    for (const want of this.wanted.values()) want.tried.clear();
    this.pump();
  }

  private closed(): void {
    this.open = false;
    // The holders map is knowledge about peers on a connection that has gone,
    // and a client id is not stable across one. Keeping it would send the next
    // session's WANTs to nobody.
    this.holders.clear();
    for (const [sha256, live] of this.inFlight) {
      clearTimeout(live.silence);
      this.abort(sha256);
    }
    this.inFlight.clear();
  }

  private receive(from: number, tail: Uint8Array): void {
    const message = decodeAsset(tail);
    if (message === null) return;

    switch (message.kind) {
      case "have":
        for (const prefix of message.prefixes) {
          let peers = this.holders.get(prefix);
          if (peers === undefined) this.holders.set(prefix, (peers = new Set()));
          peers.add(from);
        }
        // A peer we had already given up on may be advertising exactly what we
        // gave up on, so a new announcement is worth a fresh round of asking.
        for (const want of this.wanted.values()) want.tried.delete(from);
        this.pump();
        return;

      case "want":
        void this.serve(from, message.sha256);
        return;

      case "data": {
        const live = this.inFlight.get(message.sha256);
        // Not asked for, or asked of somebody else. Dropping it is the only
        // safe answer: a chunk from an unexpected peer is either a stale reply
        // to a transfer we already abandoned, or a peer being helpful in a way
        // that would interleave two streams into one file.
        if (live === undefined || live.peer !== from) return;
        this.armSilence(message.sha256, live);
        live.total = message.total;
        live.received += 1;
        this.options.onProgress?.(message.sha256, live.received, message.total);
        const { sha256, index, total, bytes } = message;
        live.written = live.written.then(() =>
          this.native.assetReceive(sha256, index, total, bytes).catch(() => {
            // A write that failed leaves a hole, and a hole is exactly what the
            // hash check at commit is for. Nothing to do here but let it get
            // there and be refused.
          }),
        );
        return;
      }

      case "done": {
        const live = this.inFlight.get(message.sha256);
        if (live === undefined || live.peer !== from) return;
        void this.commit(message.sha256, from);
        return;
      }

      case "nack":
        this.giveUpOn(message.sha256, from);
        return;
    }
  }

  /** Somebody wants a hash. Send it, or say we do not have it. */
  private async serve(to: number, sha256: string): Promise<void> {
    const size = await this.native.assetSize(sha256);
    if (this.destroyed) return;
    if (size <= 0) {
      this.provider.send(encodeAsset(to, encodeNack(sha256)));
      return;
    }

    const total = Math.max(1, Math.ceil(size / CHUNK_BYTES));
    for (let index = 0; index < total; index += 1) {
      const bytes = await this.native.assetChunk(sha256, index);
      if (this.destroyed) return;
      // The socket went, or the asset was collected out from under us. Either
      // way there is no honest way to finish, and the other side's silence
      // timer is what recovers — sending a NACK now would be a lie about the
      // chunks already sent.
      if (bytes.length === 0) return;
      if (!this.provider.send(encodeAsset(to, encodeData(sha256, index, total, bytes)))) return;
    }
    this.provider.send(encodeAsset(to, encodeDone(sha256)));
  }

  private async commit(sha256: string, from: number): Promise<void> {
    await this.inFlight.get(sha256)?.written;
    // Still ours after the wait? A silence timeout or a disconnect could have
    // abandoned this transfer while the last chunk was being written.
    if (this.inFlight.get(sha256)?.peer !== from) return;

    const committed = await this.native.assetCommit(sha256).catch(() => false);
    if (this.destroyed) return;
    if (!committed) {
      // The bytes did not hash to what they were supposed to. Not this peer's
      // asset then, whatever it thought — try somebody else, and do not commit
      // anything, which is the whole point of verifying before the rename.
      this.giveUpOn(sha256, from);
      return;
    }
    const live = this.inFlight.get(sha256);
    if (live !== undefined) clearTimeout(live.silence);
    this.inFlight.delete(sha256);
    this.wanted.delete(sha256);
    // `asset:ready` comes from the platform, not from here: the item is not
    // showable until the store has committed and the variants exist, and only
    // the side that did that knows when.
    this.pump();
  }

  /** That peer is not going to produce this asset. Try the next one. */
  private giveUpOn(sha256: string, peer: number): void {
    const live = this.inFlight.get(sha256);
    if (live !== undefined) {
      clearTimeout(live.silence);
      this.inFlight.delete(sha256);
      this.abort(sha256);
    }
    this.wanted.get(sha256)?.tried.add(peer);
    this.pump();
  }

  /**
   * Throw away a half-received asset.
   *
   * Failures are swallowed on purpose: this is called from a socket closing and
   * from a timer firing, and there is nothing either could usefully do about a
   * partial file that would not delete. Rust sweeps its own leftovers.
   */
  private abort(sha256: string): void {
    void this.native.assetAbort(sha256).catch(() => {});
  }

  private armSilence(sha256: string, live: InFlight): void {
    clearTimeout(live.silence);
    live.silence = setTimeout(() => this.giveUpOn(sha256, live.peer), SILENCE_MS);
  }

  // --- the queue -----------------------------------------------------------

  /**
   * Start whatever transfers there is room for, in priority order.
   *
   * Sorted on every call rather than kept sorted: the queue is at most as long
   * as the board has assets, it only moves when the viewport does, and a
   * priority queue that is wrong is much harder to notice than a sort that is
   * slow.
   */
  private pump(): void {
    if (!this.open) return;

    const ready = [...this.wanted]
      .filter(([sha256]) => !this.inFlight.has(sha256))
      .sort((a, b) => b[1].priority - a[1].priority);

    for (const [sha256, want] of ready) {
      if (this.inFlight.size >= MAX_IN_FLIGHT && !this.displace(want.priority)) return;
      const peer = this.pick(sha256, want.tried);
      // Nobody left who claims to have it. It stays wanted rather than being
      // dropped, because a peer holding it may still connect — but somebody has
      // to be told, or the item shows an empty frame with no explanation.
      if (peer === null) {
        if (want.tried.size > 0) {
          this.wanted.delete(sha256);
          this.options.onUnavailable?.(sha256);
        }
        continue;
      }

      const live: InFlight = {
        peer,
        priority: want.priority,
        received: 0,
        total: 0,
        written: Promise.resolve(),
      };
      if (!this.provider.send(encodeAsset(peer, encodeWant(sha256, want.priority)))) return;
      this.inFlight.set(sha256, live);
      this.armSilence(sha256, live);
    }
  }

  /**
   * Make room for a transfer that matters more, by abandoning one that matters
   * less. Reports whether it managed to.
   *
   * Without this, "an asset whose item is in the viewport is high priority"
   * would only be true of the queue and not of the slots. A board joined cold
   * asks for every photograph on it at idle priority in one pass, three of them
   * start immediately and arbitrarily, and the ones the person is actually
   * looking at then wait behind three they cannot see.
   *
   * Abandoning costs the chunks already received. It cannot cost more than
   * that: they were written at their own offsets in a file named for the hash,
   * so re-asking later overwrites the same offsets with the same bytes, and it
   * is the hash at commit that decides whether any of it was any good.
   *
   * Strictly greater, so equal priorities never displace each other — that
   * would be a queue of transfers taking turns to be cancelled.
   */
  private displace(priority: number): boolean {
    let victim: string | null = null;
    let lowest = priority;
    for (const [sha256, live] of this.inFlight) {
      if (live.priority < lowest) {
        lowest = live.priority;
        victim = sha256;
      }
    }
    if (victim === null) return false;

    const live = this.inFlight.get(victim);
    if (live !== undefined) clearTimeout(live.silence);
    this.inFlight.delete(victim);
    this.abort(victim);
    // Still in `wanted` — nothing removes it there until it is committed — so
    // it comes back round on a later pump.
    return true;
  }

  /** A peer that advertised this hash's prefix and has not already failed us. */
  private pick(sha256: string, tried: ReadonlySet<number>): number | null {
    const peers = this.holders.get(prefixOf(sha256));
    if (peers === undefined) return null;
    for (const peer of peers) if (!tried.has(peer)) return peer;
    return null;
  }
}
