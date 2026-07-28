/**
 * Sync — the front door.
 *
 * `docs/ARCHITECTURE.md` section 5. The pieces underneath split three ways:
 * `protocol.ts` is bytes, `transport.ts` is the socket, `provider.ts` is the
 * policy that joins them. Import from here.
 */

export * from "@/crdt/sync/protocol";
export * from "@/crdt/sync/provider";
export * from "@/crdt/sync/transport";
export { Awareness } from "y-protocols/awareness";
