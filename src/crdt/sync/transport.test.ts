/**
 * The `WebSocket` adapter, against a socket that does as it is told.
 *
 * Small surface, but every line of it is there because a real socket did
 * something inconvenient: delivered a `Blob`, threw on a send, or reported a
 * failure and then went quiet without ever closing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLOSE_ABNORMAL, CLOSE_NORMAL, webSocketTransport } from "@/crdt/sync/transport";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | null = null;

  readyState: number = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  readonly sent: Uint8Array[] = [];
  closedWith: number | null = null;

  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.last = this;
  }

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  close(code?: number): void {
    this.closedWith = code ?? CLOSE_NORMAL;
    this.readyState = FakeWebSocket.CLOSING;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

const realWebSocket = globalThis.WebSocket;

function handlers() {
  return {
    opens: 0,
    messages: [] as Uint8Array[],
    errors: [] as unknown[],
    closes: [] as { code: number; clean: boolean }[],
  };
}

function connect() {
  const seen = handlers();
  const transport = webSocketTransport("ws://peer/board-1", {
    onOpen: () => {
      seen.opens += 1;
    },
    onMessage: (bytes) => seen.messages.push(bytes),
    onError: (error) => seen.errors.push(error),
    onClose: (info) => seen.closes.push({ code: info.code, clean: info.clean }),
  });
  return { seen, transport, socket: FakeWebSocket.last! };
}

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = realWebSocket;
  vi.useRealTimers();
});

describe("the WebSocket adapter", () => {
  it("asks for array buffers before anything can arrive", () => {
    const { socket } = connect();

    // The default is `Blob`, whose `arrayBuffer()` is async — and a protocol
    // whose frames arrive out of order because two of them awaited is a bug
    // that only shows up under load.
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("passes binary frames through and drops text", () => {
    const { seen, socket } = connect();

    socket.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
    socket.onmessage?.({ data: "hello" });

    expect(seen.messages).toHaveLength(1);
    expect([...seen.messages[0]!]).toEqual([1, 2, 3]);
  });

  it("does not send before the socket is open", () => {
    const { transport, socket } = connect();

    // `send` on a CONNECTING socket throws by specification.
    transport.send(new Uint8Array([9]));
    expect(socket.sent).toHaveLength(0);

    socket.open();
    transport.send(new Uint8Array([9]));
    expect(socket.sent).toHaveLength(1);
  });

  it("closes with a normal code", () => {
    const { transport, socket } = connect();

    transport.close();

    expect(socket.closedWith).toBe(CLOSE_NORMAL);
  });

  it("reports a close once, even when an error came first", async () => {
    const { seen, socket } = connect();

    socket.onerror?.(new Error("refused"));
    socket.readyState = FakeWebSocket.CLOSED;
    socket.onclose?.({ code: 1006, reason: "", wasClean: false });
    await vi.advanceTimersByTimeAsync(10);

    expect(seen.errors).toHaveLength(1);
    expect(seen.closes).toEqual([{ code: 1006, clean: false }]);
  });

  it("stands in for a close that never comes", async () => {
    const { seen, socket } = connect();

    // Exactly what Node's WebSocket does when the dial is refused: the error,
    // then `CONNECTING` for the rest of the process. Without this the provider
    // waits out its whole silence timer before retrying a connection that
    // failed instantly.
    socket.onerror?.(new Error("refused"));
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING);
    expect(seen.closes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10);

    expect(seen.closes).toEqual([{ code: CLOSE_ABNORMAL, clean: false }]);
    // And the half-built socket is not left for the runtime to hold.
    expect(socket.closedWith).not.toBeNull();
  });

  it("leaves a socket that will close itself alone", async () => {
    for (const readyState of [FakeWebSocket.OPEN, FakeWebSocket.CLOSING]) {
      const { seen, socket } = connect();
      socket.readyState = readyState;

      socket.onerror?.(new Error("mid-flight"));
      await vi.advanceTimersByTimeAsync(10);

      // Open, or on its way down: its own close event is still coming.
      expect(seen.closes).toHaveLength(0);
    }
  });
});
