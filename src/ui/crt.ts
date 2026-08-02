/**
 * The television, and the one thing on this board that takes the screen.
 *
 * > Watching a tape is linear, full-attention and done once — you are not
 * > thinking *with* the board while you do it, so taking the screen costs
 * > nothing and a CRT is the picture that says what is happening.
 * > — D-46 section 4, Q-197
 *
 * Every other surface in `ui/` is a corner-anchored strip that takes no press it
 * did not ask for. This one covers everything, eats every key while it is on,
 * and is the first modal this application has ever had. That is worth being
 * uncomfortable about, so the argument is written down rather than assumed: a
 * document is read *against* the wall — you pull quotes out onto the board and
 * look back at the page, so covering the board would break the loop the feature
 * exists for. A film is not read against anything. There is nothing to look back
 * at, and the board being visible behind it would be a board you were not using.
 *
 * ## What modal is made of here
 *
 * Two mechanisms, and neither is a framework.
 *
 * **Keys**: one listener on `window` in the *capture* phase, which runs before
 * every other keydown on this board and stops the event dead. `app/main.ts` has
 * five separate keydown listeners and `state/tools/machine.ts` forwards a sixth;
 * teaching each of them about the set would mean the seventh, written next year,
 * quietly undoing this. One swallow at the top is what "modal" means, and it is
 * the only implementation of it that a later listener cannot break.
 *
 * `stopPropagation` always, `preventDefault` only for the keys acted on — so the
 * shell's own bindings (`F12`, the reload) still work, and nothing on the board
 * behind moves. There is nothing to type into here, so swallowing everything
 * costs a person nothing.
 *
 * **Presses**: the element is a full-screen child of `.layer-ui`, which is
 * `pointer-events: none` with `> * { pointer-events: auto }`. So while it is up
 * it is the only thing under the cursor, and the board's own hit tests never
 * run. That is the same rule that already stops a click on the tool drawer
 * starting a marquee.
 *
 * ## Clicking away does not shut it
 *
 * The same answer T-273 gave for the folder, for a different reason. There, a
 * click elsewhere is *work* and must not close the thing you are quoting from.
 * Here there is no work elsewhere — but a film has a position, that position is
 * local and is not written down anywhere (D-46 section 4), and a stray click
 * that dismissed the set would lose your place in a two-hour interview with no
 * undo to get it back. So it is `Escape`, or `Enter` again, exactly as the case
 * file is — and the set says so on its own plate, which is the fix T-273 landed
 * when an open folder turned out to be a state with no visible way out.
 *
 * ## What it never does
 *
 * It does not touch the camera, the LOD tier, the culler or the dirty flags.
 * Nothing about the board changes on the way in or on the way out — AC-676 —
 * and the frame loop behind carries on exactly as it was. A film costs about
 * eight per cent of one core with the DOM phase at 0.00 ms (D-48), so there is
 * nothing to buy by pausing the board, and pausing it would be a change.
 *
 * It writes nothing to the document. Which tape is on and where its playhead is
 * are facts about this window, not about the board — the same call the camera
 * came off awareness on (T-226), stated for media in D-46 section 4.
 */

/** How far an arrow key moves the playhead, in seconds. */
export const SEEK_S = 5;
/** With `Shift` held. A scene rather than a sentence. */
export const SEEK_LONG_S = 30;

/**
 * A tape, as the set needs it.
 *
 * `id` is opaque here on purpose — this module knows nothing about hashes, the
 * store or the exchange. It exists so {@link Crt.update} can tell "the bytes for
 * the film that is already on have arrived" from "a different tape entirely".
 */
export interface CrtFilm {
  /** Whatever the caller uses to identify a film. Compared, never parsed. */
  id: string;
  /** Where the bytes are, or `""` while they are still coming. */
  url: string;
  /** The still to show until they get here, or `""` for a tape with no poster. */
  poster: string;
  /** The two lines the spine carries: what it is called, and its case number. */
  title: string;
  number: string;
  /** The frame's own shape, off the asset record. The set is cut to it, so that
   *  a phone video stands up and a widescreen one lies down — and so that
   *  nothing here has to measure an element to lay one out. */
  w: number;
  h: number;
  /** How far through the transfer, `0`…`1`, when `url` is `""`. */
  fraction: number;
  /** Nobody has these bytes and nobody is going to. */
  lost: boolean;
}

/** Seconds as a playhead reads them: `4:07`, or `1:02:59` for a long one. */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export class Crt {
  private readonly el: HTMLDivElement;
  private readonly video: HTMLVideoElement;
  private readonly still: HTMLImageElement;
  private readonly word: HTMLDivElement;
  private readonly name: HTMLSpanElement;
  private readonly time: HTMLSpanElement;
  private readonly rail: HTMLDivElement;
  private readonly fill: HTMLDivElement;

  /** The film currently on, or `null`. The whole of "is it open". */
  private film: CrtFilm | null = null;
  /** What the plate last read, so an unchanged one writes no DOM. */
  private written = "";
  /** Set while a pointer is dragging the rail, so `timeupdate` stops fighting it. */
  private scrubbing = false;

  /**
   * Nothing is reported upward, and that is not an omission.
   *
   * Which tape is on is this object's own state and nobody else's: it writes
   * nothing to the document, moves no camera and dirties nothing. A caller that
   * wants to know asks {@link showing}, and the one caller that does — the
   * board menu's *Open* row — asks it at the moment it is drawing the row.
   */
  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "crt";

    const set = document.createElement("div");
    set.className = "crt-set";

    const screen = document.createElement("div");
    screen.className = "crt-screen";

    this.video = document.createElement("video");
    this.video.className = "crt-tube";
    // No `controls`: Chromium's player is somebody else's chrome, it is styled
    // for a web page rather than for a dark room, and D-46 section 6 spends a
    // row of its refusals table on not being anybody else's player. Ours is the
    // rail below, which is four elements and takes the board's own idiom.
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.video.disablePictureInPicture = true;

    this.still = document.createElement("img");
    this.still.className = "crt-still";
    // Decorative: the plate below already says what tape this is, in words.
    this.still.alt = "";
    // The poster is one of ours, over `asset://`, which is CORS-open.
    this.still.crossOrigin = "anonymous";

    // Everything the glass has to say when it cannot show a picture: the tape is
    // still arriving, nobody has it, or this machine has no decoder for it.
    // Written on the screen rather than in a notice at the edge, because the
    // screen is the thing the person is looking at and a dark rectangle with an
    // explanation somewhere else is the failure D-46 section 6 names.
    this.word = document.createElement("div");
    this.word.className = "crt-word";
    this.word.setAttribute("role", "status");

    const glow = document.createElement("div");
    glow.className = "crt-glow";
    const scan = document.createElement("div");
    scan.className = "crt-scan";

    screen.append(this.video, this.still, this.word, glow, scan);
    set.append(screen);

    this.rail = document.createElement("div");
    this.rail.className = "crt-rail";
    this.fill = document.createElement("div");
    this.fill.className = "crt-fill";
    this.rail.append(this.fill);

    const plate = document.createElement("div");
    plate.className = "crt-plate";
    this.name = document.createElement("span");
    this.name.className = "crt-name";
    this.time = document.createElement("span");
    this.time.className = "crt-time";
    const out = document.createElement("span");
    out.className = "crt-out";
    // The one line T-273 had to add to the folder after the fact: a state with
    // no visible way out is the same bug whatever shape it takes.
    out.textContent = "Space plays · Esc shuts";
    plate.append(this.name, this.time, out);

    this.el.append(set, this.rail, plate);
    host.append(this.el);

    this.video.addEventListener("timeupdate", () => this.report());
    this.video.addEventListener("durationchange", () => this.report());
    this.video.addEventListener("play", () => this.report());
    this.video.addEventListener("pause", () => this.report());
    this.video.addEventListener("ended", () => this.report());
    this.video.addEventListener("error", () => {
      // A codec this build of Chromium has no block for. Named plainly: the
      // alternative is a black rectangle that looks like a bug in the board.
      this.say("this machine has no decoder for this recording");
    });

    // Chromium's own menu on a media element offers Save video as, Loop, Picture
    // in picture and Show controls — four pieces of another application's UI, one
    // of which turns on the chrome the paragraph above refuses.
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());

    // The picture is the play button, which is what a screen has always been.
    // The surround is not: see the header — a stray press must not lose your
    // place in a two-hour tape.
    screen.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.toggle();
    });

    this.rail.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.scrubbing = true;
      this.seekTo(e.clientX);
    });
    // On `window` rather than captured on the rail: happy-dom has no pointer
    // capture (`state/navigation.dom.test.ts` says so), and while the set is up
    // it is the only thing taking presses anyway, so there is nothing on the
    // board for a stray move to reach.
    window.addEventListener("pointermove", (e) => {
      if (this.scrubbing) this.seekTo(e.clientX);
    });
    window.addEventListener("pointerup", () => {
      this.scrubbing = false;
    });

    window.addEventListener("keydown", this.onKey, true);
  }

  get isOpen(): boolean {
    return this.film !== null;
  }

  /** Which film is on, or `""`. The caller's own id, handed back. */
  get showing(): string {
    return this.film?.id ?? "";
  }

  /**
   * Put a tape on and start it.
   *
   * Opening the tape that is already on is not a re-open — it is
   * {@link update}, so pressing `Open` twice from the menu does not restart a
   * film half way through.
   */
  open(film: CrtFilm): void {
    if (this.film?.id !== film.id) {
      this.el.classList.add("is-live");
      this.film = null;
    }
    this.apply(film);
  }

  /**
   * Re-read the tape, and start it if it has just become playable.
   *
   * The one path for both the first mount and the bytes landing later, so a
   * half-transferred film is not a second code path with its own bugs.
   * `openable` deliberately does not wait for bytes — DESIGN section 1.3 says a
   * photograph is usable before it has arrived, and a tape is no different — so
   * this is where that promise is actually kept: the set comes on showing the
   * poster and how far through the transfer is, and the film starts on its own
   * when there is a film to start.
   *
   * Silent unless this is the tape that is on. A transfer finishing across the
   * board must not seize the screen — and one finishing after the set has been
   * turned off must not turn it back on, which is the same guard read the other
   * way round and the reason this is not simply "no film yet, so take this one".
   */
  update(film: CrtFilm): void {
    if (this.film === null || this.film.id !== film.id) return;
    this.apply(film);
  }

  /** Write a tape onto the set. The only writer; {@link open} and
   *  {@link update} are the two answers to *may it*. */
  private apply(film: CrtFilm): void {
    const was = this.film;
    this.film = film;

    if (film.w !== was?.w || film.h !== was?.h) {
      // A record that came from an older build, or a container that would not
      // say: fall back rather than divide by zero, and 16:9 is what all but a
      // handful of films are.
      const shape = film.w > 0 && film.h > 0 ? `${film.w} / ${film.h}` : "16 / 9";
      this.el.style.setProperty("--crt-aspect", shape);
    }

    if (film.poster !== (was?.poster ?? "")) {
      this.still.src = film.poster;
      this.still.classList.toggle("is-there", film.poster !== "");
    }

    // The one moment worth getting right: the source is written once, when the
    // bytes are first known to be here. Writing it again on every progress tick
    // would restart the film every few hundred milliseconds.
    if (film.url !== "" && film.url !== (was?.url ?? "")) {
      this.video.src = film.url;
      this.say("");
      void this.video.play().catch(() => {
        // Refused, which on a user gesture is unusual but not impossible. The
        // set stays up with the first frame on it and the plate already says
        // which key starts it.
        this.report();
      });
    } else if (film.url === "") {
      this.say(
        film.lost
          ? "nobody on this board has this recording"
          : `the tape is still coming — ${Math.round(film.fraction * 100)}%`,
      );
    }

    this.report();
  }

  /**
   * Turn the set off, and stop the tape.
   *
   * > Leaving the overlay stops playback — a tape that is not being watched is
   * > not decoding. — AC-674
   *
   * `pause` is not enough on its own and neither is hiding the element: a
   * `<video>` with a `src` holds a decode session open, and `app/poster.ts`
   * already learned that the way to give one back is to clear the source and
   * `load()`. Same three lines, same reason.
   *
   * Answers whether there was anything to turn off, so a caller can let
   * `Escape` fall through to whatever it means on a board with no tape on —
   * the shape `closeOpen` already uses for the folder.
   */
  close(): boolean {
    if (this.film === null) return false;
    this.film = null;
    this.el.classList.remove("is-live");
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.still.removeAttribute("src");
    this.still.classList.remove("is-there");
    this.scrubbing = false;
    this.written = "";
    return true;
  }

  destroy(): void {
    this.close();
    window.removeEventListener("keydown", this.onKey, true);
    this.el.remove();
  }

  /**
   * Every key, while the set is on.
   *
   * Capture phase on `window`, which is the first listener to see a keydown and
   * the only place a modal can be implemented once rather than in every listener
   * that already exists and every listener that does not exist yet.
   */
  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.film === null) return;
    // Nothing on the board hears anything while the set is on. That is the whole
    // definition; the branch below is only about what the *set* does with it.
    e.stopPropagation();

    if (e.code === "Escape" || e.code === "Enter" || e.code === "NumpadEnter") {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      this.toggle();
      return;
    }
    const by =
      e.code === "ArrowRight"
        ? e.shiftKey
          ? SEEK_LONG_S
          : SEEK_S
        : e.code === "ArrowLeft"
          ? e.shiftKey
            ? -SEEK_LONG_S
            : -SEEK_S
          : 0;
    if (by !== 0) {
      e.preventDefault();
      this.nudge(by);
      return;
    }
    if (e.code === "Home") {
      e.preventDefault();
      this.nudge(-Infinity);
    }
    // Everything else is swallowed and not acted on. `preventDefault` is
    // deliberately not called, so the shell's own keys still reach the shell.
  };

  private toggle(): void {
    // Gated on there being a tape rather than on `readyState`: a film whose
    // bytes are still coming has nothing to start, but one that has only just
    // been handed a source is legitimately at `HAVE_NOTHING` and pressing play
    // on it is how it gets loaded.
    if (this.film === null || this.film.url === "") return;
    if (this.video.paused) void this.video.play().catch(() => this.report());
    else this.video.pause();
  }

  /** Move the playhead by `by` seconds, clamped inside the tape. */
  private nudge(by: number): void {
    const end = this.video.duration;
    if (!Number.isFinite(end) || end <= 0) return;
    // Clamped a hair short of the end rather than to it: seeking exactly to
    // `duration` fires `ended` and puts the last frame up, which is not what
    // somebody pressing the forward key was asking for.
    this.video.currentTime = Math.max(0, Math.min(end - 0.01, this.video.currentTime + by));
    this.report();
  }

  /** Where a press at `clientX` lands on the rail, as a time. */
  private seekTo(clientX: number): void {
    const end = this.video.duration;
    if (!Number.isFinite(end) || end <= 0) return;
    const box = this.rail.getBoundingClientRect();
    if (box.width <= 0) return;
    const at = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
    this.video.currentTime = Math.min(end - 0.01, at * end);
    this.report();
  }

  /** Write a line on the glass, or clear it. */
  private say(text: string): void {
    if (this.word.textContent === text) return;
    this.word.textContent = text;
    this.word.classList.toggle("is-there", text !== "");
  }

  /**
   * The plate and the rail.
   *
   * Driven by the element's own events — `timeupdate` fires about four times a
   * second — and never by the frame loop. Nothing about a film playing is the
   * board's motion, and putting a readout in phase 5 would make the loop's cost
   * depend on whether a tape happened to be on.
   */
  private report(): void {
    const film = this.film;
    if (film === null) return;
    const end = Number.isFinite(this.video.duration) ? this.video.duration : 0;
    const at = Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0;

    const label = film.title.trim() !== "" ? film.title : film.number;
    const stamp = end > 0 ? `${clock(at)} / ${clock(end)}` : "";
    const digest = `${label} ${stamp}`;
    if (digest !== this.written) {
      this.written = digest;
      this.name.textContent = label;
      this.time.textContent = stamp;
    }

    const through = end > 0 ? Math.max(0, Math.min(1, at / end)) : 0;
    this.fill.style.width = `${(through * 100).toFixed(2)}%`;
    this.el.classList.toggle("is-playing", !this.video.paused);
  }
}
