/**
 * The wire format, with no wire.
 *
 * Two documents and a function that turns bytes into a reply — which is the
 * whole reason `protocol.ts` owns no socket. Everything here is the handshake
 * as it actually runs, minus the timers and the reconnects that make
 * `provider.test.ts` the slower file.
 */

import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  MessageType,
  encodeAwareness,
  encodePermissionDenied,
  encodeQueryAwareness,
  encodeSyncStep1,
  encodeUpdate,
  readMessage,
  type MessageSink,
} from "@/crdt/sync/protocol";

/** One end of a conversation: a document, a presence, and what it was told. */
class Peer {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly errors: unknown[] = [];
  readonly denials: string[] = [];
  syncs = 0;

  readonly sink: MessageSink = {
    doc: this.doc,
    awareness: this.awareness,
    origin: this,
    onSynced: () => {
      this.syncs += 1;
    },
    onDenied: (reason) => {
      this.denials.push(reason);
    },
    onError: (error) => {
      this.errors.push(error);
    },
  };

  /** Hand `bytes` to this peer and return what it wants to say back. */
  receive(bytes: Uint8Array): Uint8Array | null {
    return readMessage(bytes, this.sink);
  }

  notes(): string[] {
    return [...this.doc.getMap<string>("notes").values()];
  }

  write(key: string, value: string): void {
    this.doc.getMap<string>("notes").set(key, value);
  }
}

/** Pass frames back and forth until neither side has anything left to say. */
function converse(from: Peer, to: Peer, first: Uint8Array): void {
  let frame: Uint8Array | null = first;
  let speaker = to;
  let listener = from;
  for (let hop = 0; frame !== null && hop < 8; hop += 1) {
    const reply: Uint8Array | null = speaker.receive(frame);
    frame = reply;
    [speaker, listener] = [listener, speaker];
  }
  expect(frame).toBeNull();
}

describe("the sync handshake", () => {
  it("carries a document the other side has never seen", () => {
    const a = new Peer();
    const b = new Peer();
    a.write("n1", "a pinned receipt");

    converse(b, a, encodeSyncStep1(b.doc));

    expect(b.notes()).toEqual(["a pinned receipt"]);
    expect(b.syncs).toBe(1);
  });

  it("merges two documents that both changed apart", () => {
    const a = new Peer();
    const b = new Peer();
    a.write("n1", "from a");
    b.write("n2", "from b");

    // Step 1 in one direction only sends what the *asker* is missing, which is
    // why the protocol has both sides ask.
    converse(b, a, encodeSyncStep1(b.doc));
    converse(a, b, encodeSyncStep1(a.doc));

    expect(a.notes().sort()).toEqual(["from a", "from b"]);
    expect(b.notes().sort()).toEqual(["from a", "from b"]);
  });

  it("applies a forwarded update under the receiver's origin", () => {
    const a = new Peer();
    const b = new Peer();

    let seen: unknown = "never ran";
    b.doc.on("update", (_update, origin) => {
      seen = origin;
    });

    a.doc.on("update", (update) => {
      expect(b.receive(encodeUpdate(update))).toBeNull();
    });
    a.write("n1", "typed on a");

    expect(b.notes()).toEqual(["typed on a"]);
    // The sink's origin, not the sender's — which is what keeps a remote edit
    // out of this client's undo stack (crdt/origins.ts).
    expect(seen).toBe(b.sink.origin);
  });

  it("answers step 1 and stays quiet for step 2", () => {
    const a = new Peer();
    const b = new Peer();
    a.write("n1", "something to send");

    const step2 = a.receive(encodeSyncStep1(b.doc));
    expect(step2).not.toBeNull();
    // The reply to a step 2 is silence. A protocol that answered every frame
    // with a frame would never stop.
    expect(b.receive(step2!)).toBeNull();
  });

  it("counts a step 2 as synced even when there was nothing to send", () => {
    const a = new Peer();
    const b = new Peer();

    converse(b, a, encodeSyncStep1(b.doc));

    expect(b.syncs).toBe(1);
    expect(b.notes()).toEqual([]);
  });
});

describe("awareness on the wire", () => {
  it("carries one client's state to another", () => {
    const a = new Peer();
    const b = new Peer();
    a.awareness.setLocalState({ user: { name: "Phil" } });

    b.receive(encodeAwareness(a.awareness, [a.doc.clientID]));

    expect(b.awareness.getStates().get(a.doc.clientID)).toEqual({ user: { name: "Phil" } });
  });

  it("answers a query with every state it holds, its own included", () => {
    const relay = new Peer();
    const a = new Peer();
    const b = new Peer();
    a.awareness.setLocalState({ cursor: { x: 1, y: 2 } });
    b.awareness.setLocalState({ cursor: { x: 3, y: 4 } });
    relay.receive(encodeAwareness(a.awareness, [a.doc.clientID]));
    relay.receive(encodeAwareness(b.awareness, [b.doc.clientID]));

    const answer = relay.receive(encodeQueryAwareness());

    expect(answer).not.toBeNull();
    const asker = new Peer();
    asker.receive(answer!);
    expect(asker.awareness.getStates().get(a.doc.clientID)).toEqual({ cursor: { x: 1, y: 2 } });
    expect(asker.awareness.getStates().get(b.doc.clientID)).toEqual({ cursor: { x: 3, y: 4 } });
  });
});

describe("frames that should not take a connection down", () => {
  it("reports a refusal and its reason", () => {
    const a = new Peer();

    expect(a.receive(encodePermissionDenied("this board is not shared with you"))).toBeNull();

    expect(a.denials).toEqual(["this board is not shared with you"]);
  });

  it("drops an unparseable frame and says so", () => {
    const a = new Peer();

    expect(a.receive(new Uint8Array([MessageType.SYNC, 0xff, 0xff, 0xff]))).toBeNull();
    expect(a.receive(new Uint8Array())).toBeNull();

    expect(a.errors).toHaveLength(2);
  });

  it("drops a message type it has never heard of", () => {
    const a = new Peer();
    a.write("n1", "still here afterwards");

    expect(a.receive(new Uint8Array([99]))).toBeNull();

    expect(a.errors).toHaveLength(1);
    expect(a.notes()).toEqual(["still here afterwards"]);
  });
});
