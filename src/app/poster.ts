/**
 * The still that stands for a film — grabbing one, and only ever once.
 *
 * > A poster frame paperclipped to the tape — one still from the video printed
 * > small and clipped to the case, because a wall of unlabelled black
 * > rectangles is unreadable and a wall of stills is not. (I-14)
 *
 * ## It is not a performance measure, and that is worth stating first
 *
 * A thumbnail usually exists because the real thing is too expensive to show.
 * Not here. D-48 section 4 measured three times the source resolution for
 * *nothing* — the decode runs on the GPU's fixed-function block and a 1080p
 * frame costs it no more than a 360p one — and sixteen times the drawn area for
 * 1.7 points of one core. There is no cheaper-stream argument for a still, and
 * D-48 says so outright: what a poster frame is for is what a **stopped tape
 * looks like**. A tape on a shelf is not playing. It is a black plastic
 * rectangle with somebody's handwriting on it, and the still is what tells you
 * which one it is without taking it down.
 *
 * ## Where the frame comes from
 *
 * A `<video>` seeked a few percent in and drawn to a canvas (I-64) — the first
 * frame is black on almost everything, so frame zero would give a board of
 * tapes each showing a slightly different black. The result is ingested as its
 * own asset (I-70), which is what buys the whole of the rest: it dedupes by
 * hash, it transfers on the exchange every photograph already uses, it is
 * served by `asset://` and drawn by an `<img>`, and two people who paste the
 * same interview grab the same frame to the same bytes to the same hash.
 *
 * ## Detached, and one at a time
 *
 * The element is never appended to the document, for two reasons out of D-48:
 * the culler calls `view.el.remove()` on an off-screen item and *removing a
 * media element pauses it*, and a second decoding video takes the board from
 * 144 Hz to 72. The first would make a grab depend on the camera not moving.
 * The second is why [`PosterGrabber`] runs a queue of one rather than firing a
 * grab per tape the moment a board of them mounts.
 */

import { isHash } from "@/crdt/sync/assets";
import type { AssetMeta } from "@/platform/types";

/**
 * How far in the frame is taken, as a fraction of the running time.
 *
 * Far enough past a fade from black or a title card to be a picture of
 * something, near enough the front that it is the *opening* of the recording —
 * which is what somebody looking for a tape is remembering.
 */
export const POSTER_FRACTION = 0.08;

/**
 * Never sooner than this, however short the film. A 5-second clip's 8% is 0.4 s
 * and that is often still the fade.
 */
export const POSTER_MIN_S = 1;

/**
 * And never later than this, however long it is.
 *
 * 8% of a two-hour interview is nine and a half minutes in, which is a seek
 * that has to fetch from the middle of a 4 GB file to arrive at a frame with no
 * more claim to being the tape than the one at fifteen seconds. The fraction is
 * for short things; this is what stops it being silly on long ones.
 */
export const POSTER_MAX_S = 15;

/** And never past halfway, which is what makes the two above safe on a stub. */
export const POSTER_LATEST = 0.5;

/**
 * The long edge of the still, in pixels.
 *
 * A thumbnail, and deliberately: a VHS is about a third of a sheet of paper on
 * this board and the still is a print clipped to it, so even at 300% zoom it is
 * a few hundred pixels across. Storing the frame at source resolution would put
 * a 1920-wide picture on the disk and over the wire per tape to draw it at 400.
 */
export const POSTER_EDGE = 640;

/** WebP at this quality is around 30 KB for a 640-wide frame. */
export const POSTER_QUALITY = 0.82;

export const POSTER_MIME = "image/webp";

/**
 * How long one grab may take before it is abandoned.
 *
 * Generous, because the bytes come through `asset://` range requests off a file
 * that may be gigabytes, and a seek is a fetch. It exists so a container the
 * webview will not decode fails as *nothing happened* rather than as a promise
 * that never settles and a decoder held open for the session.
 */
export const POSTER_TIMEOUT_MS = 20_000;

/** What a grab produced: the encoded still, ready to be ingested. */
export interface Poster {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/**
 * Decode one frame. Injected so the queue can be tested without a decoder —
 * there is no video in happy-dom, and a stub returning bytes exercises every
 * decision in [`PosterGrabber`] except the drawing.
 */
export type Decoder = (url: string) => Promise<Poster | null>;

export interface PosterOptions {
  /** Where the film's bytes are — an `asset://` URL for the original variant. */
  readonly url: (sha256: string) => string;
  /** The bytes are on this disk, so there is something to seek. */
  readonly isReady: (sha256: string) => boolean;
  /** Put the still in the store. Rejects the way every other ingest does. */
  readonly ingest: (bytes: Uint8Array, mime: string) => Promise<AssetMeta>;
  /** Write it down: the still's own record, and the film pointing at it. */
  readonly record: (film: string, poster: AssetMeta) => void;
  readonly decode?: Decoder;
}

/**
 * Which films have been grabbed off, and which are not worth asking about again.
 *
 * The whole of the policy is "once", and the two failure modes it has to cover
 * pull in opposite directions. A film whose decode fails must not be retried on
 * every bind, which is sixty attempts a second at a container the webview does
 * not support. A film whose *record* already names a still it turns out nobody
 * holds the bytes of must be retried — otherwise a tape that arrived by clip
 * from another board, or from a peer whose poster never transferred, shows a
 * missing still for ever. So the grab is keyed on **what is on this disk**
 * rather than on whether the field is set, and this set is what keeps that from
 * being a loop: within a session, one attempt per film.
 */
export class PosterGrabber {
  private readonly tried = new Set<string>();
  private readonly decode: Decoder;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PosterOptions) {
    this.decode = options.decode ?? decodeFrame;
  }

  /**
   * Grab a still for this film if one is wanted and none is here.
   *
   * Called from the same place the title probe is — the renderer asking what a
   * record says, which is the layer that already decides what is on screen
   * (ARCHITECTURE section 5.2). Returns immediately; the work is queued.
   *
   * `poster` is what the record currently says, which may be a hash whose bytes
   * this machine does not have. That is not "done" — see [`tried`].
   */
  wants(film: string, poster: string | null): void {
    if (!isHash(film) || this.tried.has(film)) return;
    // The bytes are the whole of what this needs and the only thing it cannot
    // work around. Not marked tried: a transfer that has not committed yet is
    // the commonest state a tape is in, and it becomes ready later.
    if (!this.options.isReady(film)) return;
    if (poster !== null && this.options.isReady(poster)) return;
    this.tried.add(film);
    this.queue = this.queue.then(() => this.grab(film)).catch(() => undefined);
  }

  /** For a test, and for the shutdown that waits on nothing else. */
  async idle(): Promise<void> {
    await this.queue;
  }

  private async grab(film: string): Promise<void> {
    let poster: Poster | null;
    try {
      poster = await withTimeout(this.decode(this.options.url(film)), POSTER_TIMEOUT_MS);
    } catch (error) {
      // A container this webview will not decode, a file that went away
      // mid-seek, a codec behind a licence. All of them are one outcome — a
      // tape with no still on it, which is a state the object already draws.
      console.warn("[poster] no frame could be taken", film, error);
      return;
    }
    if (poster === null) return;
    let meta: AssetMeta;
    try {
      meta = await this.options.ingest(poster.bytes, poster.mime);
    } catch (error) {
      console.warn("[poster] the still could not be stored", film, error);
      return;
    }
    // Between the seek and here is a decode, an encode and a disk write, and
    // the item may have been deleted across all three. `recordPoster` is silent
    // on a record that is gone, which is what makes that safe rather than a
    // resurrection of an asset the sweep is on its way to collect.
    this.options.record(film, meta);
  }
}

/**
 * One frame, off a real decoder.
 *
 * Everything in here is ordered by what releases the decoder. A `<video>` with
 * a source is a hardware decode session; leaving one open per tape on a board
 * of tapes is the failure this function's `finally` exists for, and it is why
 * the element is created here and never handed out.
 */
async function decodeFrame(url: string): Promise<Poster | null> {
  const video = document.createElement("video");
  // Never appended. See the module comment — an in-document media element is
  // the culler's to pause, and this one's life is measured in one seek.
  video.preload = "auto";
  video.muted = true;
  // The bytes are ours and same-origin through `asset://`, and the canvas is
  // tainted without this on some paths — a tainted canvas throws on `toBlob`,
  // which would be every still failing for a reason that reads as a codec.
  video.crossOrigin = "anonymous";
  try {
    video.src = url;
    const duration = await once(video, "loadedmetadata", () => video.duration);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    // A seek that lands where the playhead already is fires no `seeked` event
    // on some builds, so the wait is armed before the write and the write is
    // never zero.
    const at = posterTime(duration);
    const seeked = once(video, "seeked", () => undefined);
    video.currentTime = at;
    await seeked;
    return draw(video);
  } finally {
    // Both, and in this order. Clearing `src` alone leaves the element holding
    // the last loaded resource until it is collected; `load()` on an empty
    // source is what tears the media element's state down now.
    video.src = "";
    video.load();
  }
}

/** Where in the recording the still is taken from. See the constants. */
export function posterTime(duration: number): number {
  const wanted = Math.min(Math.max(duration * POSTER_FRACTION, POSTER_MIN_S), POSTER_MAX_S);
  return Math.min(wanted, duration * POSTER_LATEST);
}

/** The drawn size of a frame that is `w` by `h`, long edge capped. */
export function posterBox(w: number, h: number): readonly [number, number] {
  const scale = Math.min(1, POSTER_EDGE / Math.max(w, h));
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

async function draw(video: HTMLVideoElement): Promise<Poster | null> {
  const [w, h] = posterBox(video.videoWidth, video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.drawImage(video, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, POSTER_MIME, POSTER_QUALITY);
  });
  if (blob === null) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // The encoder's answer, not the one asked for. A build without WebP hands
  // back a PNG under the same call and says so on the blob; storing it as the
  // type we requested would put a mime in the record the bytes disagree with,
  // and `assets.rs` sniffs the magic numbers anyway — so the record would
  // disagree with the store rather than with itself, which is worse.
  return { bytes, mime: blob.type || POSTER_MIME };
}

/**
 * The first of an event or an error, whichever comes.
 *
 * A media element reports failure on `error` and never settles otherwise, so a
 * promise waiting only for the happy event is a promise that never resolves on
 * every unsupported file.
 */
function once<T>(video: HTMLVideoElement, event: string, read: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const done = (): void => {
      video.removeEventListener(event, ok);
      video.removeEventListener("error", bad);
    };
    const ok = (): void => {
      done();
      resolve(read());
    };
    const bad = (): void => {
      done();
      reject(new Error(`the media element reported an error waiting for ${event}`));
    };
    video.addEventListener(event, ok, { once: true });
    video.addEventListener("error", bad, { once: true });
  });
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`gave up after ${ms} ms`));
    }, ms);
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}
