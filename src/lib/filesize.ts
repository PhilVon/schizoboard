/**
 * A number of bytes, as a person about to hand a file to somebody reads it —
 * T-291.
 *
 * ## Why this is not `ui/hud.ts`'s formatter
 *
 * That one stops at megabytes, and it is right to: it prints a document's size
 * and a board's ink, and a board whose document reaches a gigabyte is a bug
 * rather than a reading. This one prints the weight of a `.schizo`, and a board
 * with three interviews on it really is six gigabytes — "6100 MB" is a number
 * somebody has to convert before it means anything, at the exact moment they
 * are deciding whether to send it.
 *
 * **Rounded coarsely on purpose.** One decimal at gigabytes and none at
 * megabytes: the figure is an estimate before the file exists (`bundleWeigh`
 * says what it leaves out) and precision it has not got would be a claim it
 * cannot keep. The floor at 1 MB is for the same reason in the other direction
 * — a board of notes and no photographs is a file of some kilobytes, and
 * "0 MB" reads as nothing having been written.
 */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "an unknown size";
  const mb = bytes / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(mb))} MB`;
}
