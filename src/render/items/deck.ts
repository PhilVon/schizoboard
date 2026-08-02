/**
 * Playing a cassette where it hangs — T-277, D-46 section 4.
 *
 * > Press play on the cassette where it hangs, the spools turn, and you carry
 * > on working.
 *
 * Which is a design sentence with one hard consequence in it: **the element
 * that makes the sound lives inside the item**. It has to, because the readout
 * is the object — the tape wound between its two reels is the position (T-268)
 * — and an app-owned player drawing spools on somebody else's cassette was the
 * shape D-50 looked at and rejected.
 *
 * ## One element, parked, exactly like the caret
 *
 * `TextEditor` (`editor.ts`) had this problem first and solved it: view nodes
 * are **pooled and recycled between items**, so anything living inside one that
 * belongs to a particular *item* has to be re-parked every DOM phase or it is
 * inherited by whatever mounts next out of the pool. A `<textarea>` left to
 * fend for itself becomes another note's caret; an `<audio>` left to fend for
 * itself becomes another cassette playing somebody else's recording.
 *
 * So there is one element, it belongs to this object, and `DomItemLayer` parks
 * it on the view the playing item currently has. That also answers what would
 * otherwise be the hardest question here — where the *position* lives while the
 * cassette is off screen. It lives on the element, because the element is not
 * the view's and does not go into the pool with it.
 *
 * ## Removing it from the document pauses it, and that is not ours to change
 *
 * D-48 measured it: the culler calls `el.remove()`, and a media element removed
 * from a document is paused by the user agent (HTML 4.8.11.15). There is no
 * flag. Panning away from a playing cassette stopped the sound, and panning
 * back did not start it again — the element came back paused and nothing knew
 * to press play.
 *
 * D-50 settled the answer: the culler exempts an item that is playing, the way
 * it already exempts the note being written on, and for a reason of the same
 * kind — unmounting the one ends the sentence, unmounting the other ends the
 * recording. [`playing`] is the getter that exemption asks, which is why it
 * reports the item only while the sound is actually coming out: a cassette
 * paused half way through is an ordinary item that may be culled, and its
 * position survives because it is on this element.
 */

/** What the layer is told. Neither call may read the scene. */
export interface DeckHooks {
  /**
   * How far the tape has wound onto the take-up reel, 0 to 1.
   *
   * From the element's own clock rather than from a frame counter (AC-704):
   * this is what the object is *actually* doing, and a spool driven by a timer
   * beside it would drift from the sound the moment either one stalled.
   */
  onMoved(itemId: string, reeled: number): void;
  /**
   * The recording has been let go — the element's source dropped.
   *
   * **Not** a pause. A cassette paused half way through is a cassette half way
   * through, and its spools stay where the sound stopped; this is the tape
   * coming out of the machine, and the object it came from reads rewound again
   * because that is what it now is.
   */
  onLetGo(itemId: string): void;
}

export class Deck {
  readonly element: HTMLAudioElement;
  /** The item whose recording is loaded, playing or paused. */
  private itemId: string | null = null;
  /** What `src` currently holds, so re-pressing play does not reload the file
   *  and lose the position. */
  private source = "";
  private sounding = false;
  /** What the spools were last told, so a view coming back out of the pool can
   *  be told the same thing without waiting for the element to tick. */
  private wound = 0;

  constructor(private readonly hooks: DeckHooks) {
    const audio = document.createElement("audio");
    // Nothing is drawn: the cassette *is* the transport (T-268), so a browser's
    // own bar sitting on top of it would be a second, uglier answer to the
    // question this object already answers.
    audio.className = "item-deck";
    audio.hidden = true;
    audio.preload = "metadata";
    audio.controls = false;

    // Every one of these is the element telling us what it is doing, rather
    // than us telling the element and hoping — the arrangement `ui/crt.ts`
    // takes for the same reason.
    audio.addEventListener("timeupdate", () => this.moved());
    audio.addEventListener("durationchange", () => this.moved());
    audio.addEventListener("seeked", () => this.moved());
    audio.addEventListener("play", () => {
      this.sounding = true;
    });
    for (const quiet of ["pause", "ended", "error"]) {
      audio.addEventListener(quiet, () => this.hushed());
    }

    this.element = audio;
  }

  /** The item that is *making a sound*, or null — see the class comment on why
   *  a paused cassette is not it. */
  get playing(): string | null {
    return this.sounding ? this.itemId : null;
  }

  /** The item whose recording is loaded, playing or not: who the element must
   *  be parked on. */
  get loaded(): string | null {
    return this.itemId;
  }

  /** How far the tape has wound, 0 to 1 — the last thing the spools were told. */
  get reeled(): number {
    return this.wound;
  }

  /**
   * Press play on this item, or press it again to stop — and answer whether it
   * is now making a sound.
   *
   * One recording at a time (DESIGN section 3.7's "one thing plays at a time"),
   * which costs nothing to enforce because there is one element: pressing play
   * on a second cassette loads it over the first, and the first stops by
   * arithmetic rather than by a rule anybody has to remember.
   *
   * A `url` of `""` is a recording whose bytes are not here yet. It is not an
   * error and not a refusal — the want has been raised by the caller, and the
   * honest thing is to do nothing audible rather than to load an empty source
   * and let the element report a failure the person cannot act on.
   */
  press(itemId: string, url: string): boolean {
    if (url === "") return false;
    if (this.itemId === itemId && this.source === url) {
      if (this.sounding) {
        this.element.pause();
        return false;
      }
      this.start();
      return true;
    }
    // A different recording, or the same one whose URL has changed underneath
    // it. Stopping the old one first is what makes the take-up reel of the
    // cassette being left behind stop where the sound stopped.
    this.stop();
    this.itemId = itemId;
    this.source = url;
    this.element.src = url;
    this.start();
    return true;
  }

  /**
   * Ask the element to play, and count it as playing from **now** rather than
   * from the `play` event.
   *
   * `play()` is a promise, and what fills the gap before it settles is exactly
   * the frame in which the culler decides what to unmount. A deck that only
   * became "playing" on the event would have the item unexempted for that
   * frame, the view removed, and the element paused by the user agent before
   * the sound it was about to make ever came out — the D-48 failure, arriving
   * through a race instead of through a pan. So the claim goes up first and is
   * taken back if the element refuses.
   */
  private start(): void {
    this.sounding = true;
    void this.element.play().catch(() => this.hushed());
  }

  /**
   * Stop, and let the recording go.
   *
   * `pause` rather than a bare flag, and then the source is dropped: an audio
   * element holding an `asset://` source holds a decode session and whatever
   * the shell has buffered for it, and this board has one player for a reason.
   * The position goes with it, which is right — the tape a person put down is
   * not the tape they are on.
   */
  stop(): void {
    const was = this.itemId;
    this.itemId = null;
    this.source = "";
    this.sounding = false;
    this.wound = 0;
    if (was === null) return;
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
    this.hooks.onLetGo(was);
  }

  destroy(): void {
    this.stop();
    this.element.remove();
  }

  /**
   * Paused, played out, or refused — all three are "no sound is coming out",
   * and the spools stop where they are for all three.
   *
   * No hook. What this changes is [`playing`], which the culler asks every
   * frame; the drawing does not move, because the tape has not.
   */
  private hushed(): void {
    this.sounding = false;
  }

  private moved(): void {
    const id = this.itemId;
    if (id === null) return;
    const end = this.element.duration;
    // A recording whose metadata has not arrived has no length to be a fraction
    // of, and a live stream's is infinite. Both are a tape that reads rewound,
    // which is what an unplayed one already reads as (`items.css`).
    const reeled = Number.isFinite(end) && end > 0 ? this.element.currentTime / end : 0;
    this.wound = Math.min(1, Math.max(0, reeled));
    this.hooks.onMoved(id, this.wound);
  }
}
