/**
 * @vitest-environment happy-dom
 *
 * The one preference in this file whose default is *on the other side*.
 *
 * `app/prefs.ts` has been untested since it was written, and deliberately so:
 * ageing and the tool drawer both store their default as absence, so there is
 * nothing to get wrong that reading the four lines does not show you. The timer
 * flight (T-399) is the first one that inverts — off by default, so the stored
 * value means *on* — and the inversion is exactly the kind of thing a later edit
 * "tidies" back into the `!== "off"` shape the two above it use.
 *
 * What that would cost is the whole of AC-1121: a machine that has never asked
 * for it, or one with site data switched off, would start flying somebody's
 * camera across the board every time a colleague's kitchen timer ran out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chime, setChime, setTimerFlight, timerFlight } from "@/app/prefs";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("flying to a timer that goes off", () => {
  it("is off until somebody asks for it", () => {
    expect(timerFlight()).toBe(false);
  });

  it("remembers being asked, and remembers being told to stop", () => {
    setTimerFlight(true);
    expect(timerFlight()).toBe(true);
    setTimerFlight(false);
    expect(timerFlight()).toBe(false);
    // Off is stored as *absence*, which is what makes the unreadable case below
    // land on the same answer as the ordinary one.
    expect(localStorage.getItem("schizo.timerflight")).toBeNull();
  });

  it("stays off for a value no build of this wrote", () => {
    // A key some other version left, or a hand-edited store. Anything that is
    // not the one string meaning yes is a camera that stays where it is.
    localStorage.setItem("schizo.timerflight", "yes");
    expect(timerFlight()).toBe(false);
  });

  it("stays off when the store cannot be read at all", () => {
    // A webview with site data disabled: `localStorage` throws rather than
    // answering. Every failure here leans the same way — see the file header.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("site data disabled");
    });
    expect(timerFlight()).toBe(false);
  });

  it("says nothing when the store cannot be written", () => {
    // The switch has already been thrown for this session by the time this is
    // called; all that is lost is remembering it, and a board that refused to
    // open over a checkbox would be an absurd way to lose.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("site data disabled");
    });
    expect(() => setTimerFlight(true)).not.toThrow();
  });
});

/**
 * The bell — T-406.
 *
 * Its own block rather than more of the flight's, because the interesting thing
 * about it is the one way it differs: it stores its default as **absence** and
 * the flight stores its default as **presence**, so every failure here leans
 * toward the board making a noise where every failure there leans toward the
 * camera staying put. Two switches side by side in one menu, deliberately on
 * opposite sides of that line, and `app/prefs.ts` says why.
 */
describe("ringing a timer that goes off", () => {
  it("rings until somebody says not to", () => {
    expect(chime()).toBe(true);
  });

  it("remembers being silenced, and being let ring again", () => {
    setChime(false);
    expect(chime()).toBe(false);
    setChime(true);
    expect(chime()).toBe(true);
    // On is stored as absence, which is what makes every failure below land on
    // the board still ringing.
    expect(localStorage.getItem("schizo.chime")).toBeNull();
  });

  it("rings for a value no build of this wrote", () => {
    localStorage.setItem("schizo.chime", "no");
    expect(chime()).toBe(true);
  });

  it("rings when the store cannot be read at all", () => {
    // A webview with site data disabled. The flight's equivalent test expects
    // the opposite answer, and that is the whole point of having both: a board
    // that quietly stopped flying is a preference that did not stick, and a
    // board that quietly stopped ringing is a timer that does not work.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("site data disabled");
    });
    expect(chime()).toBe(true);
  });

  it("says nothing when the store cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => setChime(false)).not.toThrow();
  });
});
