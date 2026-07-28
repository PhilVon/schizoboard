/**
 * The y-websocket wire protocol, as encode and decode.
 *
 * > A transport-agnostic `SyncProvider` interface [...] **implementing the
 * > y-websocket wire protocol**, with the relay embedded in the application
 * > binary. — docs/ARCHITECTURE.md section 5.1
 *
 * We speak the established protocol rather than one of our own for a reason
 * that pays off long before the Rust relay exists (T-69): any `y-websocket`
 * server will serve this client today, so the frontend half of multiplayer can
 * be built and tested against a stock server, and the relay is then written
 * against a client already known to be correct rather than against itself.
 *
 * ## The frame
 *
 * ```
 * [ messageType : varUint ][ payload ]
 * ```
 *
 * `sync` carries a raw y-protocols sync message; the other three wrap their
 * payload in a length-prefixed byte array. There is no room name in the frame —
 * the upper layer (the URL path, for us) decides which board a socket is for.
 *
 * ## Why this file wraps y-protocols instead of using it directly
 *
 * `y-protocols` owns the *inner* messages — state vectors, updates, awareness
 * clocks. The outer frame above is `y-websocket`'s, and `y-websocket` only
 * ships it welded to a browser `WebSocket` and its own reconnect policy. This
 * is that frame on its own: pure functions over bytes, no socket, no timers, no
 * document ownership. Everything here is testable with two `Y.Doc`s and no
 * transport at all, which is most of why `provider.ts` stays small enough to
 * reason about.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type * as Y from "yjs";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  type Awareness,
} from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";

/**
 * The outer message type. Values are `y-websocket`'s and are not ours to
 * renumber — a peer running the stock server is on the other end.
 */
export const MessageType = {
  /** A y-protocols sync message: step 1, step 2, or an update. */
  SYNC: 0,
  /** A y-protocols awareness update. */
  AWARENESS: 1,
  /** The peer refusing us, with a reason. Server to client only. */
  AUTH: 2,
  /** "Tell me every awareness state you hold." Carries no payload. */
  QUERY_AWARENESS: 3,
  /**
   * Asset transfer, which is ours rather than `y-websocket`'s — four is the
   * first number it has not spent.
   *
   * ```
   * [ ASSET ][ from : varUint ][ to : varUint ][ opaque tail ]
   * ```
   *
   * The ids are Yjs client ids, because those are what a peer can name: every
   * peer sees every other's through awareness. `to = 0` is everybody else in
   * the room, which only `HAVE` uses; anything carrying bytes is addressed.
   *
   * The tail is `assets.ts`'s business and nothing else's. Rust routes on the
   * two ids and forwards the rest untouched, which is what keeps the surface
   * `wire.rs` and this file have to agree on by hand down to one constant
   * (D-28). A stock `y-websocket` server drops the type it does not know, so a
   * board hosted on one syncs and simply never trades bytes.
   */
  ASSET: 4,
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

/** The only `AUTH` sub-type either side sends. */
const PERMISSION_DENIED = 0;

/** Our state vector: "here is what I have, send me the rest." */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** Everything the peer's state vector says it is missing. */
export function encodeSyncStep2(doc: Y.Doc, remoteStateVector?: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.SYNC);
  syncProtocol.writeSyncStep2(encoder, doc, remoteStateVector);
  return encoding.toUint8Array(encoder);
}

/** One transaction's worth of change, forwarded as it happens. */
export function encodeUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/**
 * The awareness states of `clients`, as one frame.
 *
 * Takes the client ids rather than the whole map because that is what the
 * awareness `update` event hands us, and sending only what changed is the
 * difference between a constant trickle and re-broadcasting every peer's cursor
 * every time anyone moves.
 */
export function encodeAwareness(awareness: Awareness, clients: number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.AWARENESS);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
}

/** "Send me every awareness state you hold." One byte. */
export function encodeQueryAwareness(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.QUERY_AWARENESS);
  return encoding.toUint8Array(encoder);
}

/**
 * One asset sub-message, addressed to a peer — or to the room, with `to = 0`.
 *
 * `from` is written as zero and is not ours to fill in: the relay replaces it
 * with the client id it knows this connection by, so that a peer cannot send a
 * frame in somebody else's name (D-28). Anything written here is discarded.
 */
export function encodeAsset(to: number, tail: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.ASSET);
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, to);
  encoding.writeUint8Array(encoder, tail);
  return encoding.toUint8Array(encoder);
}

/** A refusal, with a reason a human can read. What a relay sends, not a client. */
export function encodePermissionDenied(reason: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.AUTH);
  encoding.writeVarUint(encoder, PERMISSION_DENIED);
  encoding.writeVarString(encoder, reason);
  return encoding.toUint8Array(encoder);
}

/** Everything `readMessage` needs, and nothing it should be allowed to own. */
export interface MessageSink {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /**
   * The transaction origin for every document write that arrives here.
   *
   * Must be something this client never uses as a local origin, which is why
   * the provider passes itself: `crdt/origins.ts` sorts local from remote by
   * asking whether the origin is a `schizo/` string, so an object fails that
   * test for free and remote edits stay out of the undo stack without anyone
   * having to remember to exclude them.
   */
  readonly origin: unknown;
  /** A sync step 2 landed: we now hold everything the peer had. */
  onSynced?(): void;
  /** The peer refused us. The connection is over; the reason is for the user. */
  onDenied?(reason: string): void;
  /** A frame did not decode, or an update did not apply. */
  onError?(error: unknown): void;
  /**
   * An asset sub-message from `from`, still encoded.
   *
   * Handed over rather than decoded here because this file is the frame and
   * `assets.ts` is the conversation inside it — and because the exchange is the
   * one part of sync that a board without a provider does not have at all.
   */
  onAsset?(from: number, tail: Uint8Array): void;
}

/**
 * Apply one inbound frame, and return the frame that answers it, if any.
 *
 * The reply is returned rather than sent so this stays a pure function of
 * (bytes, document state): the provider owns the socket, this owns the
 * protocol, and the seam between them is a `Uint8Array`.
 *
 * A frame we cannot parse is reported and dropped, never thrown. The payload of
 * an unknown message type is not length-prefixed in the `SYNC` case, so there
 * is no general way to skip one and keep reading — but every frame is its own
 * WebSocket message, so dropping this one costs nothing and the next arrives
 * intact. Throwing instead would take down a connection because a peer is one
 * version ahead of us.
 */
export function readMessage(bytes: Uint8Array, sink: MessageSink): Uint8Array | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    switch (decoding.readVarUint(decoder)) {
      case MessageType.SYNC:
        return readSync(decoder, sink);
      case MessageType.AWARENESS:
        applyAwarenessUpdate(sink.awareness, decoding.readVarUint8Array(decoder), sink.origin);
        return null;
      case MessageType.AUTH:
        readAuth(decoder, sink);
        return null;
      case MessageType.QUERY_AWARENESS:
        return encodeAwareness(sink.awareness, [...sink.awareness.getStates().keys()]);
      case MessageType.ASSET: {
        const from = decoding.readVarUint(decoder);
        // `to` is read and dropped. Routing already happened — the relay would
        // not have sent this frame here if it were for somebody else, and a
        // second opinion about that from the receiver is a way to disagree.
        decoding.readVarUint(decoder);
        sink.onAsset?.(from, decoding.readTailAsUint8Array(decoder));
        return null;
      }
      default:
        // A peer from the future. Say so once, at the call site's discretion,
        // and carry on.
        sink.onError?.(new Error("unknown sync message type"));
        return null;
    }
  } catch (error) {
    sink.onError?.(error);
    return null;
  }
}

function readSync(decoder: decoding.Decoder, sink: MessageSink): Uint8Array | null {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.SYNC);

  const kind = syncProtocol.readSyncMessage(decoder, encoder, sink.doc, sink.origin, (error) =>
    sink.onError?.(error),
  );

  // Step 2 is the peer answering our step 1, so receiving one means we now hold
  // everything they had when they read our state vector. Step 2 and a plain
  // update are the same bytes to Yjs, which is why this asks the reader which
  // it was rather than inspecting what it did.
  if (kind === syncProtocol.messageYjsSyncStep2) sink.onSynced?.();

  // One byte is the message type and nothing after it: `readSyncMessage` had
  // no reply to write. Only step 1 produces one.
  return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
}

function readAuth(decoder: decoding.Decoder, sink: MessageSink): void {
  // Inlined rather than taken from `y-protocols/auth`, which insists on a
  // `Y.Doc` it does not use and gives the reason to a handler it constructs
  // itself. Two reads is not worth the indirection.
  if (decoding.readVarUint(decoder) !== PERMISSION_DENIED) return;
  sink.onDenied?.(decoding.readVarString(decoder));
}
