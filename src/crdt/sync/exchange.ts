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
 *
 * ## One exchange, several wires (T-388)
 *
 * On a real network there is no room both peers' own providers are in. Each
 * machine hosts its own relay and dials it over loopback; the connections that
 * actually cross the network are the ones `app/mesh.ts` opens to the relays
 * discovery found. So an exchange listening to one provider hears no `HAVE`
 * that matters and speaks into a room where nobody who wants anything can hear
 * it — the document syncs, and every photograph stays blank film, forever.
 *
 * Hence `attach`: every provider on the board is a wire this one conversation
 * runs over. A peer is reachable down whichever wire it was last heard on
 * (`routes`), a `HAVE` is announced down all of them, and a wire that closes
 * takes exactly the peers heard through it — not the ones the other wires can
 * still reach.
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
  /**
   * A transfer that has run out of peers to ask. Renders as unavailable (T-75).
   *
   * `tried` is every peer that advertised the hash and then failed to produce
   * it, and this call is the only place it is ever visible: the want is dropped
   * as we give up, so nothing afterwards can be asked who was asked. DESIGN 7.5
   * wants the board to name "who to ask", and these client ids are the only
   * thing on this side that knows.
   */
  onUnavailable?: (sha256: string, tried: readonly number[]) => void;
}

/** One attached provider: whether its handshake is through, and how to let go. */
interface Attached {
  open: boolean;
  unlisten: (() => void)[];
}

export class AssetExchange {
  private readonly holders = new Map<string, Set<number>>();
  private readonly wanted = new Map<string, Wanted>();
  private readonly inFlight = new Map<string, InFlight>();
  private readonly attached = new Map<SyncProvider, Attached>();
  /**
   * The wire each peer was last heard on, which is the wire that reaches them.
   *
   * Latest sighting wins. A peer on two wires — its own dial of our relay and
   * our dial of its — is reachable down either, and whichever carried its most
   * recent frame is the one least likely to have quietly died since.
   */
  private readonly routes = new Map<number, SyncProvider>();
  private readonly awareness: SyncProvider["awareness"];
  private readonly onPeers: (change: { added: number[] }) => void;
  private destroyed = false;

  constructor(
    provider: SyncProvider,
    private readonly native: Platform,
    private readonly options: ExchangeOptions = {},
  ) {
    // One awareness for the whole exchange: `app/main.ts` hands every mesh
    // provider the primary's awareness, so this is everybody on the board
    // however they are connected — and one listener is enough.
    this.awareness = provider.awareness;
    // Tell a peer that has just arrived what we hold.
    //
    // `HAVE` is a broadcast with no history behind it, so everything announced
    // before somebody joined was announced to a room they were not in. Without
    // this, a window reloaded an hour into a session comes back to a board full
    // of photographs, wants every one of them, and waits forever — nobody is
    // going to mention them again. It cost a driven session to find, because
    // every test had both peers present before the first announcement.
    //
    // ARCHITECTURE section 5.2 says "periodic" and this is the same idea aimed:
    // the only thing a timer would add is a delay of up to its own period on
    // exactly this case, plus chatter forever on a board where nothing changes.
    // Everything that alters what we hold already announces on the spot.
    this.onPeers = ({ added }: { added: number[] }): void => {
      if (added.some((client) => client !== this.awareness.clientID)) void this.reannounce();
    };
    this.awareness.on("change", this.onPeers);

    this.attach(provider);
  }

  /**
   * One more wire this conversation runs over (T-388).
   *
   * Called with the primary provider by the constructor and with every mesh
   * provider by `app/main.ts`, because on a LAN those are the only connections
   * that cross the network at all — an exchange that does not hear them hears
   * nobody, and the board is a wall of blank film with a synced document behind
   * it. Idempotent per provider.
   */
  attach(provider: SyncProvider): void {
    if (this.destroyed || this.attached.has(provider)) return;
    const entry: Attached = { open: false, unlisten: [] };
    this.attached.set(provider, entry);
    entry.unlisten.push(
      provider.on("asset", ({ from, tail }) => this.receive(provider, from, tail)),
    );
    entry.unlisten.push(
      provider.on("status", (status) => {
        // `synced`, not `connected`. The relay stamps the sender's client id
        // into every asset frame from the awareness it has seen, and until the
        // handshake is through it has seen none — so a frame sent any earlier is
        // dropped by the relay with nothing said (D-28).
        if (status === "synced") void this.opened(provider);
        else this.closed(provider);
      }),
    );
    if (provider.synced) void this.opened(provider);
  }

  /**
   * Let a wire go for good — the mesh replacing a moved peer, or shutting down.
   *
   * Distinct from the wire merely closing: a drop keeps the subscription so the
   * reconnect is heard, where this stops listening entirely. Without it a mesh
   * that churned addresses for an afternoon would leave a listener per corpse.
   */
  detach(provider: SyncProvider): void {
    const entry = this.attached.get(provider);
    if (entry === undefined) return;
    this.closed(provider);
    for (const off of entry.unlisten) off();
    this.attached.delete(provider);
  }

  /** Whether anybody can hear us at all. */
  private get open(): boolean {
    for (const entry of this.attached.values()) if (entry.open) return true;
    return false;
  }

  private async reannounce(): Promise<void> {
    if (!this.open) return;
    const held = await this.native.peerHaveSummary();
    if (!this.destroyed) this.announce(held);
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
   * Tell the room what this machine holds — every room, down every open wire.
   *
   * Called on connect with everything, and with a single hash whenever one is
   * ingested — a photograph pasted here is one somebody else is about to want,
   * and waiting for a periodic sweep to mention it would leave their frame empty
   * for no reason.
   */
  announce(hashes: readonly string[]): void {
    if (hashes.length === 0) return;
    const frame = encodeAsset(0, encodeHave(hashes));
    for (const [provider, entry] of this.attached) {
      if (entry.open) provider.send(frame);
    }
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
    for (const provider of [...this.attached.keys()]) this.detach(provider);
    this.awareness.off("change", this.onPeers);
  }

  // --- the wire ------------------------------------------------------------

  /**
   * Put a frame on the wire that reaches this peer, if one does.
   *
   * The route is the connection the peer was last heard on. No route, or a
   * route that has since closed, is `false` — which every caller already treats
   * exactly like a send the provider refused.
   */
  private sendTo(peer: number, tail: Uint8Array): boolean {
    const via = this.routes.get(peer);
    if (via === undefined) return false;
    if (this.attached.get(via)?.open !== true) return false;
    return via.send(encodeAsset(peer, tail));
  }

  private async opened(provider: SyncProvider): Promise<void> {
    const entry = this.attached.get(provider);
    if (entry === undefined || entry.open) return;
    entry.open = true;
    // Everything we hold, so peers can ask us; then re-ask for everything we
    // still want, since a transfer that was in flight when the socket went is
    // not coming back on its own.
    //
    // Announced down this wire alone: the peers on the others heard it when
    // theirs opened, and a re-broadcast to them is chatter about nothing new.
    const held = await this.native.peerHaveSummary();
    if (this.destroyed || this.attached.get(provider)?.open !== true) return;
    if (held.length > 0) provider.send(encodeAsset(0, encodeHave(held)));
    for (const want of this.wanted.values()) want.tried.clear();
    this.pump();
  }

  private closed(provider: SyncProvider): void {
    const entry = this.attached.get(provider);
    if (entry !== undefined) entry.open = false;
    // Everything known through this connection went with it — and only that: a
    // client id is not stable across a connection, but the peers on the *other*
    // wires are on connections that are still up, and forgetting them too would
    // stall every transfer on the board because one link blinked.
    const gone = new Set<number>();
    for (const [client, via] of this.routes) {
      if (via === provider) gone.add(client);
    }
    if (gone.size === 0) return;
    for (const client of gone) this.routes.delete(client);
    for (const [prefix, peers] of this.holders) {
      for (const client of gone) peers.delete(client);
      if (peers.size === 0) this.holders.delete(prefix);
    }
    // The partials stay on the disk. This is the case T-265 is named for: a
    // connection that drops in the middle of a 400 MB interview is the flaky
    // LAN, not a peer saying no, and throwing the file away here is what made
    // the transfer unable to survive one.
    for (const [sha256, live] of this.inFlight) {
      if (!gone.has(live.peer)) continue;
      clearTimeout(live.silence);
      this.inFlight.delete(sha256);
    }
    this.pump();
  }

  private receive(provider: SyncProvider, from: number, tail: Uint8Array): void {
    const message = decodeAsset(tail);
    if (message === null) return;
    // However this frame got here, this wire reaches whoever sent it.
    this.routes.set(from, provider);

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
        void this.serve(from, message.sha256, message.from);
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

  /**
   * Somebody wants a hash. Send it from where they say they got to, or say we
   * do not have it.
   *
   * `from` is the asker's claim about its own disk and is never checked, because
   * there is nothing here that could check it: what the asker holds is on the
   * asker's machine. It cannot cost us anything either — the worst a lying peer
   * gets is *fewer* bytes than it asked for, and the hash it has to make at the
   * end is what decides whether any of this was any good.
   */
  private async serve(to: number, sha256: string, from = 0): Promise<void> {
    const size = await this.native.assetSize(sha256);
    if (this.destroyed) return;
    if (size <= 0) {
      this.sendTo(to, encodeNack(sha256));
      return;
    }

    const total = Math.max(1, Math.ceil(size / CHUNK_BYTES));
    // Clamped rather than refused, and to the last chunk rather than to none:
    // an asker that thinks it holds more of this than exists gets the final
    // chunk over again and then `DONE`, which is one chunk to put a confused
    // peer back on a path where its own hash check can speak.
    const start = Math.min(Math.max(0, Math.floor(from)), total - 1);
    for (let index = start; index < total; index += 1) {
      const bytes = await this.native.assetChunk(sha256, index);
      if (this.destroyed) return;
      // The socket went, or the asset was collected out from under us. Either
      // way there is no honest way to finish, and the other side's silence
      // timer is what recovers — sending a NACK now would be a lie about the
      // chunks already sent.
      if (bytes.length === 0) return;
      if (!this.sendTo(to, encodeData(sha256, index, total, bytes))) return;
    }
    this.sendTo(to, encodeDone(sha256));
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

  /**
   * That peer is not going to produce this asset. Try the next one, **keeping
   * what it did send** (T-265).
   *
   * The chunks on the disk are not that peer's property. They are bytes at
   * offsets in a file named for a hash, and the next holder's copy of the same
   * asset has the same bytes at the same offsets by definition — so the next
   * peer picks up where this one stopped instead of starting a 400 MB interview
   * again because one holder went quiet at 380 MB.
   *
   * If this peer was lying, or corrupt, the partial is wrong and nothing here
   * can tell. That is not a new risk and it has always had the same answer: the
   * hash at commit refuses the file, and `commit_received` deletes the partial
   * on its way out — so the retry after a failed commit starts at zero, which
   * is the one case where starting over is the correct thing to do.
   */
  private giveUpOn(sha256: string, peer: number): void {
    const live = this.inFlight.get(sha256);
    if (live !== undefined) {
      clearTimeout(live.silence);
      this.inFlight.delete(sha256);
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
          // Read before the delete, because the delete is what destroys it.
          this.wanted.delete(sha256);
          this.options.onUnavailable?.(sha256, [...want.tried]);
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
      // Reserved *before* the ask, because the ask is no longer synchronous —
      // it has to look at the disk first — and `ready` above filters on this
      // map. A pump landing in that window would otherwise start the same
      // transfer a second time, against the same peer, and the two would race
      // writing the same offsets.
      this.inFlight.set(sha256, live);
      void this.ask(sha256, live);
    }
  }

  /**
   * Ask one peer for what we have not got.
   *
   * The disk is consulted rather than remembered. A number kept here would be
   * lost on a reload and would have to be reconciled with the file anyway —
   * whereas the partial's own length is the answer, is durable for free, and is
   * already zero in every case that means "start at the beginning": never
   * asked, just committed, or swept by the store's hour-long tidy.
   *
   * That length is only a *chunk* count because of the promise this method
   * makes: it asks from a contiguous point, and a holder serves from there
   * upwards in order, so what lands on the disk has no holes in it. `serve` is
   * the other half of that and `AssetStore::partial_len` documents the same
   * bargain from the far side.
   */
  private async ask(sha256: string, live: InFlight): Promise<void> {
    const held = await this.native.assetPartial(sha256).catch(() => 0);
    // Displaced, committed or disconnected while we were asking the disk.
    if (this.destroyed || this.inFlight.get(sha256) !== live) return;

    const from = Math.floor(held / CHUNK_BYTES);
    // So the percentage is about the asset rather than about this attempt at
    // it: a transfer resumed at 90% must not report 0%.
    live.received = from;
    if (!this.sendTo(live.peer, encodeWant(sha256, live.priority, from))) {
      this.inFlight.delete(sha256);
      return;
    }
    this.armSilence(sha256, live);
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
   * Abandoning costs the *place in the queue* and not the chunks. They were
   * written at their own offsets in a file named for the hash, so re-asking
   * later carries on from where this stopped, and it is the hash at commit that
   * decides whether any of it was any good. This paragraph described what the
   * code did not do until T-265: the `abort` two lines below the loop threw the
   * file away, and a displaced transfer started again from nothing.
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
    // Still in `wanted` — nothing removes it there until it is committed — so
    // it comes back round on a later pump, and finds its own bytes waiting.
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
