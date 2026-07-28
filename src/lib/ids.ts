/**
 * Document ids.
 *
 * Every id is a map key in a CRDT, so it is stored once per entry and shipped
 * on the wire with every reference to it. A UUID is 36 characters for 122 bits;
 * twelve base-62 characters is 71 bits, which over a board of "hundreds to a
 * few thousand items" (DESIGN section 1.4) makes a collision comprehensively
 * less likely than the disk failing.
 *
 * Ids are opaque. Nothing sorts by them except the tie-break in
 * `compareOrder`, and nothing parses them.
 *
 * ## Why this is in `lib/` and not in `crdt/`
 *
 * It lived next to the document until T-167, and moved when a *tool* needed to
 * mint one: a stroke's id is now decided at pen-down rather than at commit, so
 * that a peer can match the wet ink it is drawing against the record that
 * eventually arrives (DATA-MODEL section 9.2). Nothing in `state/` imports
 * `crdt/` — the binding is the only bridge between the document and the mirror —
 * and an id generator is not worth being the first exception to that. It is a
 * dependency-free primitive, which is exactly what `lib/` is for.
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LENGTH = 12;

export function newId(): string {
  const bytes = new Uint8Array(LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}
