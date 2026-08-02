/**
 * Every document mutation in the application.
 *
 * > **1 · Every document mutation goes through `crdt/ops/`.**
 * > Nothing anywhere else touches Yjs directly. Every op wraps a transaction
 * > with an explicit origin. This is what makes undo scoping, echo suppression
 * > and write batching possible at all — and it's enforceable with a lint
 * > rule, so enforce it. — docs/ARCHITECTURE.md section 1
 *
 * The lint rule landed with T-87 (`eslint.config.js`), so this is no longer the
 * honour system: importing `yjs` outside `crdt/` fails the build. The barrel is
 * still the front door — import from `@/crdt/ops`.
 */

export * from "@/crdt/ops/clip";
export * from "@/crdt/ops/ink";
export * from "@/crdt/ops/items";
export * from "@/crdt/ops/load";
export * from "@/crdt/ops/pins";
export * from "@/crdt/ops/quote";
export * from "@/crdt/ops/strings";
export * from "@/crdt/ops/z";
export { localToBoard, boardToLocal } from "@/crdt/ops/cascade";
