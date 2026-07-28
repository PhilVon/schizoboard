/**
 * The peers this client found for itself, and the connections to them.
 *
 * > **LAN mode** — any peer hosts, advertised over mDNS; peers discover and
 * > connect directly. — docs/ARCHITECTURE.md section 5.1
 *
 * The shell finds them (`src-tauri/src/sync/discovery.rs`) and announces each
 * as a `sync:peer-found`. This is what that announcement turns into: one more
 * provider on the same document, sharing the same awareness.
 *
 * ## Nobody is elected
 *
 * Every peer keeps hosting its own relay and dials everybody else's. There is
 * no host, no election, and no failover — which sounds wasteful and is the
 * cheapest thing available:
 *
 * > Yjs supports multiple simultaneous providers, so a client attaches disk
 * > persistence, LAN and relay at once, and deduplication is free.
 * > — ARCHITECTURE section 5.1
 *
 * An election would need agreement about who won, a rule for what happens when
 * the winner closes their laptop, and a way to tell "the host left" from "the
 * network went away" — three hard problems bought in exchange for one fewer
 * socket per peer.
 *
 * ## Why this needs no `AssetExchange` of its own
 *
 * Because discovery is symmetric. If this client can see a peer, that peer can
 * see this client, so it dials *our* relay as we dial theirs — which puts it in
 * the room our existing exchange is already talking to. The photographs travel
 * over the link the other machine opened, not the one this file opens.
 *
 * That is a real dependency and not a happy accident: if discovery ever becomes
 * one-way — a seed that advertises but does not browse, say — assets stop
 * flowing to it while the document keeps syncing, and the symptom will be a
 * fully synced board of blank film.
 */

import type { SyncProvider } from "@/crdt/sync/provider";
import type { PlatformEvents } from "@/platform/types";

/**
 * How many found peers to hold connections to at once.
 *
 * DESIGN section 5.1's LAN case is "two people at a table", so this is not a
 * capacity target — it is a bound on what a misconfigured or hostile network
 * can talk this client into opening. Something advertising a thousand boards
 * gets eight sockets and a line in the console, rather than a thousand sockets.
 */
const MAX_PEERS = 8;

export interface MeshOptions {
  /**
   * How to open a connection. Injected because the alternative is a test that
   * needs a network, and every rule worth having here is about *which* URLs get
   * dialled and how often — none of which involves a socket.
   */
  connect(url: string): SyncProvider;
  max?: number;
  /** Told what was dropped, and why. Defaults to `console.warn`. */
  onDropped?(reason: string): void;
}

/** One found peer's connection. */
interface Link {
  url: string;
  provider: SyncProvider;
}

export class Mesh {
  private readonly links = new Map<string, Link>();
  private readonly connect: (url: string) => SyncProvider;
  private readonly max: number;
  private readonly onDropped: (reason: string) => void;
  private destroyed = false;

  constructor(options: MeshOptions) {
    this.connect = options.connect;
    this.max = options.max ?? MAX_PEERS;
    this.onDropped = options.onDropped ?? ((reason) => console.warn(`[mesh] ${reason}`));
  }

  /** How many peers are connected. */
  get size(): number {
    return this.links.size;
  }

  /** The URLs currently dialled, for the dev HUD and for tests. */
  urls(): string[] {
    return [...this.links.values()].map((link) => link.url);
  }

  /**
   * A peer the shell found. Idempotent per instance, which is the whole point:
   * mDNS re-announces on a timer and once per interface, so a peer on a laptop
   * with wifi and a dock arrives twice immediately and again every minute after
   * that. Dialling on each would be a new socket a minute, for ever.
   */
  found(peer: PlatformEvents["sync:peer-found"]): void {
    if (this.destroyed) return;

    const existing = this.links.get(peer.instance);
    if (existing !== undefined) {
      // Same peer, same address: an ordinary re-announcement, and there is
      // nothing to do.
      if (existing.url === peer.url) return;
      // Same peer, different address. It moved — off the dock and onto wifi, or
      // its relay restarted on a new port — and the connection we hold is to
      // somewhere it no longer is.
      existing.provider.destroy();
      this.links.delete(peer.instance);
    }

    if (this.links.size >= this.max) {
      this.onDropped(`already holding ${this.max} peers; ignoring ${peer.url}`);
      return;
    }

    this.links.set(peer.instance, { url: peer.url, provider: this.connect(peer.url) });
  }

  /**
   * Drop every connection. Idempotent, and `found` does nothing afterwards —
   * an announcement can arrive between teardown starting and the listener being
   * unhooked, and a mesh that quietly reconnected during shutdown would be a
   * socket nobody owns.
   */
  destroy(): void {
    this.destroyed = true;
    for (const link of this.links.values()) link.provider.destroy();
    this.links.clear();
  }
}
