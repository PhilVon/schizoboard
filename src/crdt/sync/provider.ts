/**
 * The provider: one document, one connection, and the policy between them.
 *
 * > A transport-agnostic `SyncProvider` interface — `connect`, `disconnect`,
 * > `on(update)`, `awareness`, `status`. — docs/ARCHITECTURE.md section 5.1
 *
 * `protocol.ts` knows the frames and `transport.ts` knows the socket. What is
 * left — and it is the part with all the failure modes — is *when* to say
 * things: what to send on open, what to do when the line goes quiet, how long
 * to wait before trying again, and what to tell the rest of the application
 * while none of that is working.
 *
 * ## What this deliberately does not do
 *
 * **There is no outbound queue.** An edit made while disconnected is not held
 * for later; it is simply in the document, and the state-vector handshake on
 * the next connection carries it along with everything else that was missed.
 * That is the whole point of a CRDT and it is worth stating, because a queue is
 * the first thing anyone reaches for here and it would be both redundant and a
 * source of duplicate sends.
 *
 * **Awareness is not queued either**, for the opposite reason: it is ephemeral
 * by design (DATA-MODEL section 9.4) and a cursor position from before a
 * thirty-second outage is worse than nothing.
 *
 * ## Several providers, one document
 *
 * > Yjs supports multiple simultaneous providers, so a client attaches disk
 * > persistence, LAN and relay at once, and deduplication is free.
 * > — ARCHITECTURE section 5.1
 *
 * Each provider forwards any update that did not arrive on *its own*
 * connection, so a client attached to both a LAN peer and a hosted relay
 * bridges the two without anything being told to. Passing one shared
 * `Awareness` to both does the same for presence.
 */

import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import type * as Y from "yjs";

import {
  encodeAwareness,
  encodeQueryAwareness,
  encodeSyncStep1,
  encodeUpdate,
  readMessage,
} from "@/crdt/sync/protocol";
import {
  webSocketTransport,
  type SyncTransport,
  type TransportFactory,
} from "@/crdt/sync/transport";
import type { Unlisten } from "@/platform/types";

/**
 * `connected` and `synced` are worth distinguishing: between them sits the
 * handshake, and a board that is connected but not yet synced is a board whose
 * content is still arriving. The UI should say so rather than claim either.
 */
export type ConnectionState = "offline" | "connecting" | "connected" | "synced";

export interface SyncEvents {
  status: ConnectionState;
  /** A remote update, after it has been applied. The bytes, not the meaning. */
  update: Uint8Array;
  /** A frame that would not decode, or a socket that failed. Never fatal. */
  error: unknown;
  /** The peer refused us, with its reason. No further attempt is made. */
  denied: string;
  /** An asset sub-message, and the client id the relay says it came from. */
  asset: { from: number; tail: Uint8Array };
}

export interface SyncProvider {
  readonly awareness: Awareness;
  readonly status: ConnectionState;
  readonly synced: boolean;
  connect(): void;
  disconnect(): void;
  destroy(): void;
  /**
   * Put a frame on the wire, if there is one.
   *
   * Returns whether it went. There is deliberately no outbound queue in this
   * provider, and this is the one caller that has to care: a `WANT` dropped
   * because the socket was reconnecting is a photograph that never arrives, so
   * `exchange.ts` re-asks rather than assuming.
   */
  send(frame: Uint8Array): boolean;
  on<K extends keyof SyncEvents>(event: K, listener: (value: SyncEvents[K]) => void): Unlisten;
}

export interface WireProviderOptions {
  /** Injected by tests and by the native WebSocket plugin, when it lands. */
  transport?: TransportFactory;
  /** Share one across providers to give a client a single presence. */
  awareness?: Awareness;
  /** Open the connection on construction. */
  connect?: boolean;
  /** First reconnect delay; doubles per failed attempt up to `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** How often to re-send a state vector while connected. */
  resyncMs?: number;
  /** Close a connection that has said nothing for this long. */
  healthMs?: number;
}

const DEFAULTS = {
  baseDelayMs: 500,
  /**
   * Half a minute is long enough that a relay rebooting is not hammered, short
   * enough that someone who closed their laptop lid is back before they have
   * finished sitting down.
   */
  maxDelayMs: 30_000,
  /**
   * A state vector is cheap and settles any divergence a dropped frame could
   * have caused. It doubles as the keepalive that stops the peer's own health
   * timer firing, which is why it must stay comfortably under `healthMs`.
   */
  resyncMs: 20_000,
  /**
   * Two missed resyncs. A half-open TCP connection — the laptop that changed
   * network without telling anyone — looks exactly like a working one from this
   * side, and only silence gives it away.
   */
  healthMs: 45_000,
} as const;

export class WireProvider implements SyncProvider {
  readonly awareness: Awareness;

  private readonly doc: Y.Doc;
  private readonly url: string;
  private readonly makeTransport: TransportFactory;
  private readonly ownsAwareness: boolean;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly resyncMs: number;
  private readonly healthMs: number;

  private transport: SyncTransport | null = null;
  /** Identifies the current attempt; null once it has been given up on. */
  private token: object | null = null;
  private open = false;
  private state: ConnectionState = "offline";

  /** Set by `connect`, cleared by `disconnect` and by a refusal. */
  private wanted = false;
  /** Consecutive failures since the last successful sync. Drives the backoff. */
  private attempts = 0;
  private destroyed = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly listeners = new Map<keyof SyncEvents, Set<(value: never) => void>>();

  constructor(doc: Y.Doc, url: string, options: WireProviderOptions = {}) {
    this.doc = doc;
    this.url = url;
    this.makeTransport = options.transport ?? webSocketTransport;
    this.ownsAwareness = options.awareness === undefined;
    this.awareness = options.awareness ?? new Awareness(doc);
    this.baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
    this.resyncMs = options.resyncMs ?? DEFAULTS.resyncMs;
    this.healthMs = options.healthMs ?? DEFAULTS.healthMs;

    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);

    if (options.connect !== false) this.connect();
  }

  get status(): ConnectionState {
    return this.state;
  }

  get synced(): boolean {
    return this.state === "synced";
  }

  connect(): void {
    if (this.destroyed) return;
    this.wanted = true;
    if (this.transport !== null) return;
    this.dial();
  }

  /**
   * Stop, and stay stopped. Deliberately not the same as a dropped connection:
   * this cancels the retry, where a drop schedules one.
   */
  disconnect(): void {
    this.wanted = false;
    this.clearTimer("reconnectTimer");
    this.abandon();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // Say goodbye while there is still a socket to say it on: a peer that
    // vanishes without this leaves its cursor on everyone else's board until
    // the awareness timeout expires, half a minute later.
    removeAwarenessStates(this.awareness, [this.doc.clientID], "schizo/sync-destroy");

    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.disconnect();
    if (this.ownsAwareness) this.awareness.destroy();
    this.listeners.clear();
  }

  on<K extends keyof SyncEvents>(event: K, listener: (value: SyncEvents[K]) => void): Unlisten {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (value: never) => void);
    return () => {
      set.delete(listener as (value: never) => void);
    };
  }

  // --- the connection ------------------------------------------------------

  private dial(): void {
    // One token per attempt, so a transport we have already given up on cannot
    // report an open or a close over the top of its successor.
    const token = {};
    this.token = token;
    this.setStatus("connecting");

    // Armed here rather than on open, because a dial that hangs — a host that
    // accepts the packet and says nothing — otherwise has no deadline at all.
    this.armHealth();

    try {
      this.transport = this.makeTransport(this.url, {
        onOpen: () => {
          if (this.token === token) this.onOpen();
        },
        onMessage: (bytes) => {
          if (this.token === token) this.onMessage(bytes);
        },
        onError: (error) => {
          if (this.token === token) this.emit("error", error);
        },
        onClose: () => {
          if (this.token === token) this.dropped();
        },
      });
    } catch (error) {
      // A malformed URL throws out of the constructor rather than closing.
      this.emit("error", error);
      this.dropped();
    }
  }

  private readonly onOpen = (): void => {
    this.open = true;
    this.setStatus("connected");
    this.armHealth();

    // "Here is what I have" — the peer replies with everything we are missing,
    // and (in the client/server shape this protocol documents) its own step 1.
    this.write(encodeSyncStep1(this.doc));

    // A stock y-websocket server pushes its awareness states on connection and
    // this is redundant against one. It is one byte, and it means a relay that
    // only answers what it is asked still gives us the peers already in the
    // room rather than nothing until somebody moves.
    this.write(encodeQueryAwareness());

    // Say who we are, under a *fresh* clock.
    //
    // Re-sending the state as it stands is not enough, and this is the sharp
    // edge of the awareness protocol: a peer that dropped us when the socket
    // went kept the clock it last saw, and an announcement carrying that same
    // clock is discarded as stale. `setLocalState` increments it, and the
    // awareness handler below turns that into the frame — which is why nothing
    // is written here.
    const local = this.awareness.getLocalState();
    if (local !== null) this.awareness.setLocalState(local);

    this.clearTimer("resyncTimer");
    this.resyncTimer = setInterval(this.resync, this.resyncMs);
  };

  private readonly onMessage = (bytes: Uint8Array): void => {
    // Any frame at all proves the line is alive, including one we discard.
    this.armHealth();

    const reply = readMessage(bytes, {
      doc: this.doc,
      awareness: this.awareness,
      origin: this,
      onSynced: () => {
        this.attempts = 0;
        this.setStatus("synced");
      },
      onDenied: (reason) => {
        // Retrying a refusal is a loop with a log line in it. Stopping comes
        // before the announcement, so that a listener which throws — or which
        // decides to reconnect with credentials — cannot leave us dialling a
        // peer that has already said no.
        this.disconnect();
        this.emit("denied", reason);
      },
      onError: (error) => this.emit("error", error),
      onAsset: (from, tail) => this.emit("asset", { from, tail }),
    });

    if (reply !== null) this.write(reply);
  };

  /**
   * The connection is over. Idempotent, and it never waits to be told twice.
   *
   * Called by the transport's close, by the silence timer, and by
   * `disconnect` — because the one thing a provider must not do is sit in
   * `connecting` forever waiting for a callback that is not coming. A socket
   * that reports an error and then never closes is not hypothetical; it is
   * what a refused connection did against a real server.
   */
  private dropped(): void {
    const wasLive = this.token !== null;
    this.token = null;
    this.transport = null;
    this.open = false;
    this.clearTimer("resyncTimer");
    this.clearTimer("healthTimer");

    // Every peer we knew about was known through this connection. Their state
    // is ephemeral and it is now stale; dropping it is what makes cursors
    // disappear when someone's network does. Attributed to us so the removal
    // is not broadcast down a socket that has already gone.
    if (wasLive) {
      const strangers = [...this.awareness.getStates().keys()].filter(
        (client) => client !== this.doc.clientID,
      );
      if (strangers.length > 0) removeAwarenessStates(this.awareness, strangers, this);
    }

    this.setStatus("offline");
    // A no-op unless a connection is still wanted — which is what makes it
    // safe to call this from `disconnect`.
    this.retry();
  }

  /** Give up on the current attempt, whether or not the socket agrees. */
  private abandon(): void {
    const transport = this.transport;
    this.dropped();
    transport?.close();
  }

  private retry(): void {
    if (this.destroyed || !this.wanted || this.reconnectTimer !== null) return;

    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.attempts);
    this.attempts += 1;
    // Jitter, so a relay coming back up does not meet every client it dropped
    // in the same millisecond.
    const jittered = delay * (0.75 + Math.random() * 0.5);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted && this.transport === null) this.dial();
    }, jittered);
  }

  private readonly resync = (): void => {
    this.write(encodeSyncStep1(this.doc));
  };

  /**
   * Restart the silence timer. A connection that has said nothing for
   * `healthMs` is given up rather than trusted — which routes it into the
   * normal reconnect path instead of leaving the board quietly stale.
   */
  private armHealth(): void {
    this.clearTimer("healthTimer");
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      this.abandon();
    }, this.healthMs);
  }

  // --- the document --------------------------------------------------------

  /**
   * Forward every local transaction — and every transaction that arrived on a
   * *different* provider, which is how one client bridges LAN and relay. Only
   * what came in on this connection is held back, because the peer that sent it
   * is the peer that fans it out.
   */
  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) {
      // Announced here rather than in `onMessage` because this is where a
      // remote change has actually landed in the document — and because a sync
      // step 2 is one frame carrying any number of transactions, which this
      // reports individually and that could not.
      this.emit("update", update);
      return;
    }
    this.write(encodeUpdate(update));
  };

  private readonly onAwarenessUpdate = (
    changed: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return;
    const clients = [...changed.added, ...changed.updated, ...changed.removed];
    if (clients.length === 0) return;
    this.write(encodeAwareness(this.awareness, clients));
  };

  // --- plumbing ------------------------------------------------------------

  /** See `SyncProvider.send`. The boolean is the whole reason it is public. */
  send(frame: Uint8Array): boolean {
    if (!this.open || this.transport === null) return false;
    this.transport.send(frame);
    return true;
  }

  private write(bytes: Uint8Array): void {
    if (!this.open || this.transport === null) return;
    this.transport.send(bytes);
  }

  private setStatus(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit("status", next);
  }

  private emit<K extends keyof SyncEvents>(event: K, value: SyncEvents[K]): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;
    // Copied, because a listener is allowed to unsubscribe itself.
    for (const listener of [...set]) (listener as (value: SyncEvents[K]) => void)(value);
  }

  private clearTimer(which: "reconnectTimer" | "resyncTimer" | "healthTimer"): void {
    const handle = this[which];
    if (handle === null) return;
    if (which === "resyncTimer") clearInterval(handle as ReturnType<typeof setInterval>);
    else clearTimeout(handle);
    this[which] = null;
  }
}
