/**
 * Grabbing the still that stands for a film — T-270.
 *
 * The decode itself is not testable here and is not tested here: there is no
 * video in happy-dom, and a fake that returned bytes on demand would be
 * asserting that a stub is a stub. What *is* here is the whole of the policy,
 * which is where every one of this thing's failure modes lives — when it asks,
 * when it does not, how often, and what it does when the answer is no.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  POSTER_MAX_S,
  POSTER_MIN_S,
  posterBox,
  PosterGrabber,
  posterTime,
  POSTER_EDGE,
  type Poster,
} from "@/app/poster";
import type { AssetMeta } from "@/platform/types";

const FILM = "a1b2c3d4".padEnd(64, "0");
const OTHER = "b2c3d4e5".padEnd(64, "0");
const STILL = "c3d4e5f6".padEnd(64, "0");

const FRAME: Poster = { bytes: new Uint8Array([1, 2, 3]), mime: "image/webp" };

function meta(sha256 = STILL): AssetMeta {
  return { sha256, w: 640, h: 360, mime: "image/webp", size: 3, duration: null, pages: null };
}

describe("where in a recording the still is taken from", () => {
  it("skips the front of a short film and does not go minutes into a long one", () => {
    // The first frame is black on almost everything (I-64), so frame zero would
    // give a wall of tapes each showing a slightly different black.
    expect(posterTime(60)).toBeCloseTo(60 * 0.08, 6);
    // A five second clip's 8% is 0.4s and is often still the fade.
    expect(posterTime(5)).toBe(POSTER_MIN_S);
    // And 8% of a two hour interview is nine and a half minutes in, which is a
    // seek into the middle of a 4 GB file for a frame with no more claim to
    // being the tape than the one at fifteen seconds.
    expect(posterTime(2 * 60 * 60)).toBe(POSTER_MAX_S);
  });

  it("never seeks past halfway, however short the film", () => {
    // What makes the floor safe on a stub. A one second clip asked for its
    // minimum would be seeking to the end of itself.
    expect(posterTime(1)).toBe(0.5);
    expect(posterTime(0.2)).toBeCloseTo(0.1, 6);
  });
});

describe("how big the still is stored", () => {
  it("caps the long edge and keeps the film's own shape", () => {
    // A thumbnail, deliberately: the print is a fifth of a VHS and the VHS is a
    // third of a sheet of paper. Storing the frame at source resolution would
    // put a 1920-wide picture on the disk and over the wire per tape.
    expect(posterBox(1920, 1080)).toEqual([POSTER_EDGE, 360]);
    expect(posterBox(1080, 1920)).toEqual([360, POSTER_EDGE]);
    // 4:3 keeps its shape — the print's height is a function of this, and
    // `tests/case-print-css.test.ts` is what holds the clearance for it.
    expect(posterBox(640, 480)).toEqual([640, 480]);
  });

  it("never upscales a frame smaller than the cap", () => {
    expect(posterBox(320, 180)).toEqual([320, 180]);
  });

  it("never rounds a sliver of a frame away to nothing", () => {
    const [w, h] = posterBox(4000, 1);
    expect(w).toBe(POSTER_EDGE);
    expect(h).toBeGreaterThanOrEqual(1);
  });
});

describe("when a grab is asked for", () => {
  let ready: Set<string>;
  let decode: ReturnType<typeof vi.fn>;
  let ingest: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;

  function grabber(): PosterGrabber {
    return new PosterGrabber({
      url: (sha) => `asset://sha256/${sha}`,
      isReady: (sha) => ready.has(sha),
      ingest: ingest as never,
      record: record as never,
      decode: decode as never,
    });
  }

  beforeEach(() => {
    ready = new Set([FILM]);
    decode = vi.fn(async () => FRAME);
    ingest = vi.fn(async () => meta());
    record = vi.fn();
  });

  it("grabs one frame off a film whose bytes are here, and writes it down", async () => {
    const posters = grabber();
    posters.wants(FILM, null);
    await posters.idle();

    expect(decode).toHaveBeenCalledWith(`asset://sha256/${FILM}`);
    expect(ingest).toHaveBeenCalledWith(FRAME.bytes, FRAME.mime);
    expect(record).toHaveBeenCalledWith(FILM, meta());
  });

  it("waits for the bytes rather than giving up on a film that is still transferring", async () => {
    // The commonest state a tape is in, and the one thing this cannot work
    // around. Not marked tried, because it becomes ready later — a 400 MB
    // interview that arrived after the object was mounted has to get its still.
    const posters = grabber();
    ready.delete(FILM);
    posters.wants(FILM, null);
    await posters.idle();
    expect(decode).not.toHaveBeenCalled();

    ready.add(FILM);
    posters.wants(FILM, null);
    await posters.idle();
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("asks once per film, and not once per bind", async () => {
    // The bind runs on every frame an object is dirty. A film whose container
    // this webview will not decode would otherwise be sixty attempts a second.
    const posters = grabber();
    decode.mockResolvedValue(null);
    for (let i = 0; i < 5; i++) posters.wants(FILM, null);
    await posters.idle();
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("leaves a film alone once its still is on this disk", async () => {
    const posters = grabber();
    ready.add(STILL);
    posters.wants(FILM, STILL);
    await posters.idle();
    expect(decode).not.toHaveBeenCalled();
  });

  it("grabs again when the record names a still whose bytes nobody here has", async () => {
    // The whole reason the key is "what is on this disk" rather than "is the
    // field set". A tape that arrived by clip from another board, or from a
    // peer whose poster never transferred, names a still this machine cannot
    // show — and the same frame off the same film hashes to the same bytes, so
    // asking again repairs it instead of showing a blank print for ever.
    const posters = grabber();
    posters.wants(FILM, STILL);
    await posters.idle();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(FILM, meta());
  });

  it("refuses a hash that did not come from a hash", async () => {
    const posters = grabber();
    ready.add("../../etc/passwd");
    posters.wants("../../etc/passwd", null);
    await posters.idle();
    expect(decode).not.toHaveBeenCalled();
  });

  it("decodes one film at a time", async () => {
    // D-48 section 8: the *second* decoding video takes this board from 144 Hz
    // to 72. A wall of tapes mounting at once would otherwise start one decode
    // each, on the frame the camera stopped.
    let live = 0;
    let peak = 0;
    decode.mockImplementation(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await Promise.resolve();
      live -= 1;
      return FRAME;
    });
    const posters = grabber();
    ready.add(OTHER);
    posters.wants(FILM, null);
    posters.wants(OTHER, null);
    await posters.idle();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });

  it("does not let one unreadable film stop the next one", async () => {
    // A queue of one is a queue that a rejection could wedge. Nothing else on
    // the board is waiting on this, so a container the webview will not open is
    // a line in the console rather than a board of tapes with no pictures.
    const posters = grabber();
    ready.add(OTHER);
    decode.mockRejectedValueOnce(new Error("no decoder"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    posters.wants(FILM, null);
    posters.wants(OTHER, null);
    await posters.idle();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(OTHER, meta());
  });

  it("writes nothing down when the still will not go into the store", async () => {
    // Half of a poster is worse than none: a record naming a hash whose bytes
    // are nowhere is a tape that shows a blank print and never asks again.
    const posters = grabber();
    ingest.mockRejectedValue(new Error("disk full"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    posters.wants(FILM, null);
    await posters.idle();
    expect(record).not.toHaveBeenCalled();
  });

  it("writes nothing down for a film it could take no frame off", async () => {
    const posters = grabber();
    decode.mockResolvedValue(null);
    posters.wants(FILM, null);
    await posters.idle();
    expect(ingest).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
