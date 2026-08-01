/**
 * The five asset messages, round-tripped and then abused.
 *
 * Everything decoded here came off another machine, so the interesting half of
 * this file is not that a `WANT` reads back as a `WANT` — it is that a frame
 * which is nearly one does not.
 */

import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";

import {
  decodeAsset,
  encodeData,
  encodeDone,
  encodeHave,
  encodeNack,
  encodeWant,
  isHash,
  prefixOf,
  PREFIX_BYTES,
} from "./assets";

const A = "a".repeat(64);
const B = `0123456789abcdef${"b".repeat(48)}`;

describe("the asset sub-protocol", () => {
  it("round-trips a want", () => {
    expect(decodeAsset(encodeWant(A, 1))).toEqual({ kind: "want", sha256: A, priority: 1, from: 0 });
    expect(decodeAsset(encodeWant(A, 1, 42))).toEqual({
      kind: "want",
      sha256: A,
      priority: 1,
      from: 42,
    });
  });

  it("reads a want from a peer that predates resuming", () => {
    // T-265 appended `from` rather than inserting it, so the two sides degrade
    // separately. This is the half that would otherwise be silent and total: a
    // `WANT` with nothing after the priority must decode as "start at zero" and
    // not throw, because `decodeAsset` turns a throw into `null` and the
    // exchange drops a `null` without a word — so an older peer would look like
    // one that never asks for anything rather than one that cannot resume.
    const older = encoding.createEncoder();
    encoding.writeVarUint(older, 1);
    encoding.writeVarString(older, A);
    encoding.writeVarUint(older, 1);

    expect(decodeAsset(encoding.toUint8Array(older))).toEqual({
      kind: "want",
      sha256: A,
      priority: 1,
      from: 0,
    });
  });

  it("round-trips a done and a nack", () => {
    expect(decodeAsset(encodeDone(A))).toEqual({ kind: "done", sha256: A });
    expect(decodeAsset(encodeNack(B))).toEqual({ kind: "nack", sha256: B });
  });

  it("round-trips a chunk without touching it", () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 0, 26]);
    const decoded = decodeAsset(encodeData(A, 3, 9, bytes));

    expect(decoded).toEqual({ kind: "data", sha256: A, index: 3, total: 9, bytes });
  });

  it("carries an empty final chunk, because an original may divide exactly", () => {
    const decoded = decodeAsset(encodeData(A, 1, 2, new Uint8Array(0)));

    expect(decoded).toMatchObject({ kind: "data", index: 1, total: 2 });
  });

  it("announces hashes as their first eight hex characters", () => {
    const decoded = decodeAsset(encodeHave([A, B]));

    expect(decoded).toEqual({ kind: "have", prefixes: [prefixOf(A), prefixOf(B)] });
    expect(prefixOf(B)).toBe("01234567");
    expect(prefixOf(B)).toHaveLength(PREFIX_BYTES * 2);
  });

  it("announces nothing without saying something else", () => {
    expect(decodeAsset(encodeHave([]))).toEqual({ kind: "have", prefixes: [] });
  });

  it("refuses a hash that is not a hash", () => {
    // The two things a sha256 off the wire is about to be used for are a path
    // in the content store and a key in a map that lives as long as the board.
    for (const bad of ["", "../../etc/passwd", "A".repeat(64), "abc", "a".repeat(63)]) {
      expect(isHash(bad)).toBe(false);
      expect(decodeAsset(encodeWant(bad, 0))).toBeNull();
      expect(decodeAsset(encodeDone(bad))).toBeNull();
      expect(decodeAsset(encodeData(bad, 0, 1, new Uint8Array(1)))).toBeNull();
    }
  });

  it("refuses a chunk index outside the total it claims", () => {
    // Otherwise this is an offset a peer chooses, and the offset is where the
    // receiving store seeks to.
    expect(decodeAsset(encodeData(A, 5, 2, new Uint8Array(1)))).toBeNull();
    expect(decodeAsset(encodeData(A, 0, 0, new Uint8Array(1)))).toBeNull();
  });

  it("survives a frame that stops in the middle of a value", () => {
    const whole = encodeData(A, 1, 4, new Uint8Array([7, 7, 7]));
    for (let cut = 1; cut < whole.length; cut += 1) {
      expect(() => decodeAsset(whole.subarray(0, cut))).not.toThrow();
    }
  });

  it("says nothing about a message type it does not know", () => {
    // A peer one version ahead. Dropping the frame is the whole policy; the
    // connection is not a casualty of it.
    expect(decodeAsset(new Uint8Array([9, 1, 2, 3]))).toBeNull();
    expect(decodeAsset(new Uint8Array(0))).toBeNull();
  });
});
