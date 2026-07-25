/**
 * Transaction origins.
 *
 * Every write to the document is tagged with one of these. Three separate
 * mechanisms read the tag, which is why the taxonomy is worth its own module:
 *
 *   - **Undo scoping.** `Y.UndoManager` tracks only the `null` origin by
 *     default. DATA-MODEL section 11 is blunt about the consequence:
 *     "every origin must be registered explicitly — forgetting this silently
 *     produces an undo stack that ignores most of the application."
 *   - **Echo suppression.** The binding needs to know whether an event came
 *     from this client, so a local drag is not fought by its own round trip.
 *   - **Maintenance invisibility.** Migration, the janitor and asset GC must
 *     never appear in a user's undo stack. Undoing someone else's compaction
 *     would be baffling.
 */

export const Origin = {
  /** Every direct user edit. */
  LOCAL_USER: "schizo/local-user",
  /**
   * Crash-safety writes during a drag (DESIGN section 7.3 — a throttled write
   * every half second). Tracked, and merged into the same undo entry as the
   * final release by `captureTimeout`.
   */
  DRAG_THROTTLE: "schizo/drag-throttle",
  /** One stroke, one entry. */
  INK_COMMIT: "schizo/ink-commit",

  /** Schema migration, run by the first client to open an older document. */
  MIGRATION: "schizo/migration",
  /**
   * Compacting dangling references a few seconds after they appear, by a
   * single elected client. Never repaired on read — that causes write storms
   * in a shared session (DATA-MODEL section 8.1).
   */
  JANITOR: "schizo/janitor",
  ASSET_GC: "schizo/asset-gc",
} as const;

export type OriginTag = (typeof Origin)[keyof typeof Origin];

/**
 * Passed to `Y.UndoManager`. Maintenance origins are deliberately absent, and
 * so is anything remote — a remote change has an origin this client never set,
 * so it fails the `has` check for free.
 *
 * Physics is absent because physics does not exist here. DESIGN section 5.1:
 * "Physics never writes to the document." Not particle positions, not swing
 * angles, not sleep flags. There is no origin to add.
 */
export const TRACKED_ORIGINS: ReadonlySet<string> = new Set<string>([
  Origin.LOCAL_USER,
  Origin.DRAG_THROTTLE,
  Origin.INK_COMMIT,
]);

export function isTracked(origin: unknown): boolean {
  return typeof origin === "string" && TRACKED_ORIGINS.has(origin);
}

/** Did this transaction come from this application, rather than the wire? */
export function isLocalOrigin(origin: unknown): origin is OriginTag {
  return typeof origin === "string" && origin.startsWith("schizo/");
}
