/**
 * The five asset messages, as encode and decode.
 *
 * > ```
 * > HAVE(hashPrefixes)                          // periodic, compact
 * > WANT(sha256, priority, from)                // `from` is the chunk to start at
 * > DATA(sha256, chunkIdx, totalChunks, bytes)  // 256 KB chunks
 * > DONE(sha256)                                // full hash verified before CAS commit
 * > NACK(sha256)                                // "I don't have it"
 * > ```
 * > — docs/ARCHITECTURE.md section 5.2
 *
 * These ride inside `protocol.ts`'s `ASSET` frame, which carries the two client
 * ids and nothing else. **Rust never parses any of this** (D-28): the relay
 * routes on the ids and forwards the tail untouched, so this file has no mirror
 * in `wire.rs` to drift from — which is the entire reason the split falls where
 * it does.
 *
 * Pure functions over bytes. No socket, no store, no promises: `exchange.ts` is
 * the part that decides what to say and this is the part that says it, which is
 * the same seam `protocol.ts` and `provider.ts` already have.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/**
 * How much of a hash a `HAVE` advertises: four bytes, eight hex characters.
 *
 * A prefix rather than the whole hash because a board with a thousand
 * photographs on it would otherwise announce 64 kB every time it reconnected.
 * Collisions are not a correctness problem — a peer asked for a hash it turns
 * out not to hold answers `NACK`, which is what that message is for.
 */
export const PREFIX_BYTES = 4;

const HAVE = 0;
const WANT = 1;
const DATA = 2;
const DONE = 3;
const NACK = 4;

export type AssetMessage =
  | { kind: "have"; prefixes: string[] }
  | { kind: "want"; sha256: string; priority: number; from: number }
  | { kind: "data"; sha256: string; index: number; total: number; bytes: Uint8Array }
  | { kind: "done"; sha256: string }
  | { kind: "nack"; sha256: string };

/** The eight hex characters a `HAVE` names an asset by. */
export function prefixOf(sha256: string): string {
  return sha256.slice(0, PREFIX_BYTES * 2);
}

/**
 * A hash we are willing to act on.
 *
 * Every sha256 in here arrived from another machine, and the two things it is
 * about to be used for — a path in the content store and a key in a map that
 * lives as long as the board — are both worth being unpleasant about. Rust
 * refuses a bad hash too; this is so nothing ever gets that far.
 */
export function isHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function encodeHave(hashes: readonly string[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, HAVE);
  const prefixes = new Uint8Array(hashes.length * PREFIX_BYTES);
  hashes.forEach((hash, i) => {
    for (let b = 0; b < PREFIX_BYTES; b += 1) {
      prefixes[i * PREFIX_BYTES + b] = Number.parseInt(hash.slice(b * 2, b * 2 + 2), 16);
    }
  });
  encoding.writeVarUint8Array(encoder, prefixes);
  return encoding.toUint8Array(encoder);
}

/**
 * `from` is the chunk to start at — what the asker already holds (T-265).
 *
 * Appended rather than inserted, and read back only if there are bytes left to
 * read it from, so the two directions degrade separately and neither is a flag
 * day. An older holder reads the sha and the priority, never looks further, and
 * sends from zero: a transfer that does not resume, which is exactly today. A
 * newer holder reading an older asker's `WANT` finds nothing after the priority
 * and defaults to zero, which is the same thing. Without the guard that second
 * case throws inside `decodeAsset`, and a dropped `WANT` is not a slower
 * transfer — it is a peer that never answers at all.
 */
export function encodeWant(sha256: string, priority: number, from = 0): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WANT);
  encoding.writeVarString(encoder, sha256);
  encoding.writeVarUint(encoder, priority);
  encoding.writeVarUint(encoder, from);
  return encoding.toUint8Array(encoder);
}

/**
 * `bytes` is a chunk of an original as it came out of the store, and passes
 * through here without being looked at — no hashing, no assembly, no decode.
 * Verification and the commit belong to Rust (ARCHITECTURE section 5.2), and
 * the frontend only orchestrates by hash.
 */
export function encodeData(
  sha256: string,
  index: number,
  total: number,
  bytes: Uint8Array,
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, DATA);
  encoding.writeVarString(encoder, sha256);
  encoding.writeVarUint(encoder, index);
  encoding.writeVarUint(encoder, total);
  encoding.writeVarUint8Array(encoder, bytes);
  return encoding.toUint8Array(encoder);
}

export function encodeDone(sha256: string): Uint8Array {
  return oneHash(DONE, sha256);
}

export function encodeNack(sha256: string): Uint8Array {
  return oneHash(NACK, sha256);
}

function oneHash(kind: number, sha256: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, kind);
  encoding.writeVarString(encoder, sha256);
  return encoding.toUint8Array(encoder);
}

/**
 * Decode one sub-message, or `null` if it is not one.
 *
 * Null covers three separate things on purpose — a type we do not know, a frame
 * that ran out mid-value, and a hash that is not a hash — because the caller's
 * answer to all three is the same: drop it, keep the connection. A peer one
 * version ahead of us is not a reason to disconnect somebody.
 */
export function decodeAsset(tail: Uint8Array): AssetMessage | null {
  try {
    const decoder = decoding.createDecoder(tail);
    switch (decoding.readVarUint(decoder)) {
      case HAVE: {
        const bytes = decoding.readVarUint8Array(decoder);
        const prefixes: string[] = [];
        for (let at = 0; at + PREFIX_BYTES <= bytes.length; at += PREFIX_BYTES) {
          let prefix = "";
          for (let b = 0; b < PREFIX_BYTES; b += 1) {
            prefix += bytes[at + b].toString(16).padStart(2, "0");
          }
          prefixes.push(prefix);
        }
        return { kind: "have", prefixes };
      }
      case WANT: {
        const sha256 = decoding.readVarString(decoder);
        const priority = decoding.readVarUint(decoder);
        // See `encodeWant`: absent means an asker that predates resuming, and
        // zero is what that asker meant.
        const from = decoding.hasContent(decoder) ? decoding.readVarUint(decoder) : 0;
        return isHash(sha256) ? { kind: "want", sha256, priority, from } : null;
      }
      case DATA: {
        const sha256 = decoding.readVarString(decoder);
        const index = decoding.readVarUint(decoder);
        const total = decoding.readVarUint(decoder);
        const bytes = decoding.readVarUint8Array(decoder);
        if (!isHash(sha256) || index >= total) return null;
        return { kind: "data", sha256, index, total, bytes };
      }
      case DONE: {
        const sha256 = decoding.readVarString(decoder);
        return isHash(sha256) ? { kind: "done", sha256 } : null;
      }
      case NACK: {
        const sha256 = decoding.readVarString(decoder);
        return isHash(sha256) ? { kind: "nack", sha256 } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
