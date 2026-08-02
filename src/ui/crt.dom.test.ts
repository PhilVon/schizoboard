/** @vitest-environment happy-dom */

/**
 * The set (T-276), and the two things about it that are not cosmetic.
 *
 * **It is modal**, which on this board means one capture-phase listener on
 * `window` that stops a keydown before any of the six that already exist can see
 * it. That is asserted here by registering an ordinary listener — exactly the
 * shape every one in `app/main.ts` has — and proving it hears nothing while a
 * tape is on and hears everything the moment one is not. A test that only
 * checked `Escape` would pass just as well against a modal that let `Delete`
 * through to the board behind it, which is the failure worth catching.
 *
 * **Leaving it stops the tape** (AC-674). `pause` alone does not do that: a
 * `<video>` holding a `src` holds a decode session open, and `app/poster.ts`
 * already learned that giving one back means clearing the source and calling
 * `load()`. So the assertion is on all three and not on `paused`.
 *
 * happy-dom has no layout and no media pipeline: `duration` is `NaN`,
 * `readyState` never leaves `HAVE_NOTHING`, and `getBoundingClientRect` is all
 * zeroes. Nothing here measures a box, and the two tests that need a running
 * time define one on the element — which is what makes the *clamps* testable at
 * all, since a real duration only arrives asynchronously.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Crt, SEEK_S, SEEK_LONG_S, type CrtFilm } from "@/ui/crt";

let host: HTMLElement;
let crt: Crt;

const el = () => host.querySelector<HTMLElement>(".crt");
const video = () => host.querySelector<HTMLVideoElement>(".crt-tube");
const word = () => host.querySelector<HTMLElement>(".crt-word");
const plate = () => host.querySelector<HTMLElement>(".crt-name");
const time = () => host.querySelector<HTMLElement>(".crt-time");

/** A tape that is here, with a name on it. */
function film(over: Partial<CrtFilm> = {}): CrtFilm {
  return {
    id: "aa11",
    url: "asset://sha256/aa11?v=original",
    poster: "",
    title: "Interview, second sitting",
    number: "CASE-004",
    w: 1920,
    h: 1080,
    fraction: 0,
    lost: false,
    ...over,
  };
}

/** Press a key at the document, the way the board's own listeners hear one. */
function key(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  return e;
}

/** A running time, which happy-dom's element will never grow on its own. */
function runs(seconds: number): void {
  const v = video();
  if (v === null) throw new Error("no tube");
  Object.defineProperty(v, "duration", { value: seconds, configurable: true });
}

beforeEach(() => {
  host = document.createElement("div");
  host.className = "layer layer-ui";
  document.body.append(host);
  crt = new Crt(host);
  // happy-dom's `play()` resolves against no pipeline at all; stubbed so the
  // element's own state is what the assertions read rather than a no-op.
  const v = video();
  if (v !== null) {
    vi.spyOn(v, "play").mockImplementation(() => {
      Object.defineProperty(v, "paused", { value: false, configurable: true });
      return Promise.resolve();
    });
    vi.spyOn(v, "pause").mockImplementation(() => {
      Object.defineProperty(v, "paused", { value: true, configurable: true });
    });
  }
});

afterEach(() => {
  crt.destroy();
  host.remove();
  vi.restoreAllMocks();
});

describe("a board with no tape on", () => {
  it("has a set built and out of the way, so opening one is not a DOM build", () => {
    expect(el()).not.toBeNull();
    expect(el()?.classList.contains("is-live")).toBe(false);
    expect(crt.isOpen).toBe(false);
    expect(crt.showing).toBe("");
  });

  it("lets every key through, because there is nothing here to be modal about", () => {
    const heard: string[] = [];
    window.addEventListener("keydown", (e) => heard.push(e.code));
    key("Escape");
    key("Delete");
    key("KeyE");
    expect(heard).toEqual(["Escape", "Delete", "KeyE"]);
  });

  it("has nothing to shut, and says so rather than swallowing the press", () => {
    expect(crt.close()).toBe(false);
  });
});

describe("a tape on the set", () => {
  beforeEach(() => crt.open(film()));

  it("is up, and knows which tape it is showing", () => {
    expect(el()?.classList.contains("is-live")).toBe(true);
    expect(crt.isOpen).toBe(true);
    expect(crt.showing).toBe("aa11");
  });

  it("points the tube at the original bytes and starts it", () => {
    expect(video()?.getAttribute("src")).toBe("asset://sha256/aa11?v=original");
    expect(video()?.play).toHaveBeenCalled();
  });

  it("names the tape on its plate, in the words the spine uses", () => {
    expect(plate()?.textContent).toBe("Interview, second sitting");
  });

  it("falls back to the case number for a tape nobody named", () => {
    crt.close();
    crt.open(film({ id: "bb22", title: "" }));
    expect(plate()?.textContent).toBe("CASE-004");
  });

  it("cuts the set to the frame's shape when the record carries one", () => {
    expect(el()?.style.getPropertyValue("--crt-aspect")).toBe("1920 / 1080");
  });

  it("falls back to 16:9 for a record that would not say — which today is all of them", () => {
    // Not a rare branch: `assets.rs` derives w and h from an image decode and
    // writes (0, 0) for everything else, so no tape on this board has a shape.
    crt.close();
    crt.open(film({ id: "bb22", w: 0, h: 0 }));
    expect(el()?.style.getPropertyValue("--crt-aspect")).toBe("16 / 9");
  });

  it("re-cuts itself to what the element says, which is where the shape really comes from", () => {
    crt.close();
    crt.open(film({ id: "bb22", w: 0, h: 0 }));
    const v = video() as HTMLVideoElement;
    Object.defineProperty(v, "videoWidth", { value: 1080, configurable: true });
    Object.defineProperty(v, "videoHeight", { value: 1920, configurable: true });
    v.dispatchEvent(new Event("loadedmetadata"));
    expect(el()?.style.getPropertyValue("--crt-aspect")).toBe("1080 / 1920");
  });
});

describe("modal, which is the whole of what makes this different", () => {
  let heard: string[];
  let board: (e: KeyboardEvent) => void;

  beforeEach(() => {
    heard = [];
    // The shape every keydown listener in `app/main.ts` has: on `window`, in the
    // bubble phase, arriving after the board has had its say about the target.
    // Removed again after each, because `window` outlives a test here and a
    // listener left on it would be a second board listening to the next one.
    board = (e: KeyboardEvent) => heard.push(e.code);
    window.addEventListener("keydown", board);
    crt.open(film());
  });

  afterEach(() => window.removeEventListener("keydown", board));

  it("takes every key off the board, not only the ones it acts on", () => {
    // Deliberately not `Escape` — that one shuts the set, and a run that opened
    // with it would be testing the keys against a board with nothing on.
    key("Delete");
    key("KeyE");
    key("KeyZ", { ctrlKey: true });
    key("F");
    expect(heard).toEqual([]);
  });

  it("gives them all back the moment the set is off", () => {
    key("Escape");
    key("Delete");
    expect(heard).toEqual(["Delete"]);
  });

  it("leaves the shell's own keys their default, having only stopped the board hearing", () => {
    // `stopPropagation` without `preventDefault`: F12 still opens the devtools
    // the webview owns, which is not ours to take away.
    expect(key("F12").defaultPrevented).toBe(false);
    expect(key("Escape").defaultPrevented).toBe(true);
  });
});

describe("leaving the set", () => {
  beforeEach(() => crt.open(film()));

  it("stops the tape on Escape", () => {
    key("Escape");
    expect(crt.isOpen).toBe(false);
    expect(video()?.pause).toHaveBeenCalled();
  });

  it("stops it on Enter too, the way Enter shuts a case file", () => {
    key("Enter");
    expect(crt.isOpen).toBe(false);
  });

  it("gives the decoder back, which pausing on its own does not", () => {
    const v = video();
    const load = vi.spyOn(v as HTMLVideoElement, "load");
    crt.close();
    expect(v?.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalled();
  });

  it("does not shut on a press outside the picture — a stray click is not an exit", () => {
    el()?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(crt.isOpen).toBe(true);
  });

  it("says on the set itself how to get out of it", () => {
    expect(host.querySelector(".crt-out")?.textContent).toContain("Esc");
  });
});

describe("the transport", () => {
  beforeEach(() => {
    crt.open(film());
    runs(600);
  });

  it("plays and pauses on Space", () => {
    key("Space");
    expect(video()?.paused).toBe(true);
    key("Space");
    expect(video()?.paused).toBe(false);
  });

  it("steps by five seconds on an arrow, and by thirty with Shift", () => {
    key("ArrowRight");
    expect(video()?.currentTime).toBe(SEEK_S);
    key("ArrowRight", { shiftKey: true });
    expect(video()?.currentTime).toBe(SEEK_S + SEEK_LONG_S);
  });

  it("does not walk off either end of the tape", () => {
    key("ArrowLeft");
    expect(video()?.currentTime).toBe(0);
    key("Home");
    expect(video()?.currentTime).toBe(0);
    for (let i = 0; i < 200; i += 1) key("ArrowRight", { shiftKey: true });
    // Short of the end rather than on it: seeking exactly to `duration` fires
    // `ended`, which is not what pressing the forward key asked for.
    expect(video()?.currentTime).toBeLessThan(600);
    expect(video()?.currentTime).toBeGreaterThan(599);
  });

  it("writes the playhead against the running time", () => {
    key("ArrowRight");
    video()?.dispatchEvent(new Event("timeupdate"));
    expect(time()?.textContent).toBe("0:05 / 10:00");
  });

  it("refuses to seek a tape whose length nobody knows yet", () => {
    crt.close();
    crt.open(film({ id: "cc33" }));
    // What a `<video>` handed a fresh source actually reports, until
    // `durationchange` — the state `nudge` has to survive rather than divide by.
    runs(NaN);
    key("ArrowRight");
    expect(video()?.currentTime).toBe(0);
  });
});

describe("a tape that is still coming", () => {
  const coming = film({ url: "", fraction: 0.42 });

  beforeEach(() => crt.open(coming));

  it("comes on anyway, because a photograph is usable before it arrives and so is this", () => {
    expect(crt.isOpen).toBe(true);
    expect(video()?.hasAttribute("src")).toBe(false);
  });

  it("says on the glass how far through it is, rather than sitting dark", () => {
    expect(word()?.textContent).toContain("42%");
    expect(word()?.classList.contains("is-there")).toBe(true);
  });

  it("shows the still a peer already grabbed, if one has landed", () => {
    crt.update(film({ url: "", fraction: 0.5, poster: "asset://sha256/dd44?v=display" }));
    const still = host.querySelector<HTMLImageElement>(".crt-still");
    expect(still?.classList.contains("is-there")).toBe(true);
    expect(still?.getAttribute("src")).toBe("asset://sha256/dd44?v=display");
  });

  it("starts on its own the moment the bytes are here, and clears the line", () => {
    crt.update(film());
    expect(video()?.getAttribute("src")).toBe("asset://sha256/aa11?v=original");
    expect(video()?.play).toHaveBeenCalled();
    expect(word()?.classList.contains("is-there")).toBe(false);
  });

  it("does not restart the film every time the transfer ticks", () => {
    crt.update(film());
    const before = video()?.play as unknown as ReturnType<typeof vi.fn>;
    const calls = before.mock.calls.length;
    crt.update(film());
    crt.update(film());
    expect(before.mock.calls.length).toBe(calls);
  });

  it("names a recording nobody can produce, rather than waiting on it forever", () => {
    crt.update(film({ url: "", lost: true }));
    expect(word()?.textContent).toContain("nobody");
  });

  it("says when this machine has no decoder for it, so a black screen is not the answer", () => {
    crt.update(film());
    video()?.dispatchEvent(new Event("error"));
    expect(word()?.textContent).toContain("decoder");
  });
});

describe("a transfer finishing somewhere else on the board", () => {
  beforeEach(() => crt.open(film()));

  it("does not seize the set", () => {
    crt.update(film({ id: "zz99", url: "asset://sha256/zz99?v=original", title: "Something else" }));
    expect(crt.showing).toBe("aa11");
    expect(video()?.getAttribute("src")).toBe("asset://sha256/aa11?v=original");
    expect(plate()?.textContent).toBe("Interview, second sitting");
  });

  it("does not put a tape on a set nobody has turned on", () => {
    crt.close();
    crt.update(film());
    expect(crt.isOpen).toBe(false);
  });
});

describe("opening the tape that is already on", () => {
  beforeEach(() => crt.open(film()));

  it("does not start it again from the beginning", () => {
    const v = video() as HTMLVideoElement;
    v.currentTime = 90;
    crt.open(film());
    expect(v.currentTime).toBe(90);
    expect((v.play as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
