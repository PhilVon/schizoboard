/**
 * The socket, behind an interface.
 *
 * The provider is "transport-agnostic" (ARCHITECTURE section 5.1) for two
 * reasons that are both about to matter:
 *
 *   - **A native WebSocket is coming.** > "Budget for a native WebSocket
 *     plugin: the webview's own WebSocket will hit TLS problems against a
 *     self-signed LAN peer, and planning for it beats discovering it."
 *     — ARCHITECTURE section 4.6. When that day arrives the provider should not
 *     change at all; a second factory should appear next to this one.
 *   - **Tests need two peers and no network.** A loopback factory wires two
 *     providers to each other in-process, which is what makes convergence
 *     testable at unit-test speed and what the fuzz harness (T-76) will run on.
 */

/**
 * What a transport tells the provider. Exactly one terminal call: `onClose`.
 *
 * **No handler may be called synchronously from the factory.** The provider
 * only holds the transport once the factory has returned, so an `onOpen` that
 * fires before that would have its first frames — the state vector that starts
 * the whole handshake — silently dropped. A real `WebSocket` delivers its
 * events as tasks and satisfies this for free; an in-process transport has to
 * defer deliberately.
 */
export interface TransportHandlers {
  onOpen(): void;
  onMessage(bytes: Uint8Array): void;
  /** Reported, but never terminal — a socket that errors still closes after. */
  onError(error: unknown): void;
  onClose(info: CloseInfo): void;
}

export interface CloseInfo {
  code: number;
  reason: string;
  /** Did the peer close politely, or did the connection simply stop? */
  clean: boolean;
}

export interface SyncTransport {
  /** Never throws. A send on a socket that is gone is dropped, not an error. */
  send(bytes: Uint8Array): void;
  close(): void;
}

export type TransportFactory = (url: string, handlers: TransportHandlers) => SyncTransport;

/** Closed by us on purpose, rather than by the peer or the network. */
export const CLOSE_NORMAL = 1000;
/** The connection went without a closing handshake. Never sent on the wire. */
export const CLOSE_ABNORMAL = 1006;

/**
 * The webview's own `WebSocket`.
 *
 * `binaryType` is set before anything can arrive: the default is `Blob`, whose
 * `arrayBuffer()` is async, and a protocol whose frames arrive out of order
 * because two of them awaited is a bug that only shows up under load.
 */
export const webSocketTransport: TransportFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  let reported = false;
  const reportClosed = (info: CloseInfo): void => {
    if (reported) return;
    reported = true;
    handlers.onClose(info);
  };

  socket.onopen = () => handlers.onOpen();
  socket.onclose = (event) =>
    reportClosed({ code: event.code, reason: event.reason, clean: event.wasClean });

  socket.onerror = (event) => {
    handlers.onError(event);

    // A failed connection is supposed to close, and in a browser it does.
    // Node's `WebSocket`, dialling a port with nothing behind it, fires this
    // and then sits in `CONNECTING` for the rest of the process — no close
    // event, ever. Waiting for one wedges the provider until its silence timer
    // expires, which is most of a minute of showing "offline" for a peer that
    // refused us instantly.
    //
    // So: an error is terminal unless the socket is `OPEN` or already
    // `CLOSING`, both of which deliver their own close. Given a turn first, in
    // case this implementation is one of the well-behaved ones, and deduped by
    // `reportClosed` when it is.
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) return;
      // Tell the implementation too, so a half-built connection is not left
      // holding a socket nobody will ever read.
      socket.close();
      reportClosed({ code: CLOSE_ABNORMAL, reason: "", clean: false });
    }, 0);
  };

  socket.onmessage = (event) => {
    // A peer sending text on a binary protocol is a peer we cannot talk to;
    // the frame is dropped rather than fed to a decoder as garbage.
    if (event.data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(event.data));
  };

  return {
    send(bytes) {
      // `send` on a CONNECTING socket throws by specification, and on a closed
      // one silently discards. The provider only sends while open, but a close
      // that races a queued send should not surface as an unhandled throw.
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(bytes);
    },
    close() {
      socket.close(CLOSE_NORMAL);
    },
  };
};
