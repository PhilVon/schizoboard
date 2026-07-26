/**
 * Every document mutation in the application.
 *
 * > **1 · Every document mutation goes through `crdt/ops/`.**
 * > Nothing anywhere else touches Yjs directly. Every op wraps a transaction
 * > with an explicit origin. This is what makes undo scoping, echo suppression
 * > and write batching possible at all — and it's enforceable with a lint
 * > rule, so enforce it. — docs/ARCHITECTURE.md section 1
 *
 * The lint rule is T-87. Until it lands, this barrel is the honour system:
 * import from `@/crdt/ops`, never from `yjs`.
 */

export * from "@/crdt/ops/items";
export * from "@/crdt/ops/load";
export * from "@/crdt/ops/pins";
export * from "@/crdt/ops/z";
export { localToBoard, boardToLocal } from "@/crdt/ops/cascade";
