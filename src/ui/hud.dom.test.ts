/**
 * @vitest-environment happy-dom
 *
 * The HUD's one keystroke — T-325.
 *
 * The HUD is built outside `import.meta.env.DEV`, so its listener is on the
 * window of a shipped board: a backquote typed into a note reached it, toggled
 * the panel and was *eaten*, because the toggle calls `preventDefault` and
 * nothing had asked whether a caret was in the way. `state/input.ts`'s
 * `isTextTarget` is the bail every other keydown in the application makes, and
 * these tests are here because the shortcut and the character live in the same
 * key and only a text target tells them apart.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { FrameLoop } from "@/render/loop";
import { Hud, type HudStats } from "@/ui/hud";

let host: HTMLElement;
let hud: Hud;

const STATS: HudStats = {
  zoom: 1,
  lodTier: "full",
  cameraX: 0,
  cameraY: 0,
  awakeParticles: 0,
  docBytes: 0,
  items: 0,
  mounted: 0,
  inked: 0,
  inkPixels: 0,
  janitorPending: 0,
  janitorSwept: 0,
  assetsWanted: 0,
  assetsInFlight: 0,
  assetsPercent: 0,
  assetsUnavailable: 0,
};

/** A backquote as it arrives from a keyboard, at `target`. */
function backquote(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    code: "Backquote",
    key: "`",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  hud = new Hud(host, new FrameLoop(), () => STATS, "test");
});

afterEach(() => {
  hud.destroy();
});

describe("the HUD's backquote", () => {
  it("toggles the panel when the press is on the board", () => {
    const e = backquote(window);
    expect(hud.visible).toBe(true);
    // Eaten deliberately here: nothing on the board wants a backquote, and a
    // character typed into nothing is the alternative.
    expect(e.defaultPrevented).toBe(true);
    backquote(window);
    expect(hud.visible).toBe(false);
  });

  it("leaves the character alone when a note has the caret", () => {
    const note = document.createElement("div");
    note.contentEditable = "true";
    document.body.append(note);

    const e = backquote(note);

    expect(hud.visible).toBe(false);
    // The half that made this a bug rather than a nuisance: `preventDefault`
    // means the backquote is never typed, so the panel appearing and the
    // character vanishing are one press.
    expect(e.defaultPrevented).toBe(false);
  });

  it("leaves the character alone in a field — the search's own input", () => {
    const field = document.createElement("input");
    document.body.append(field);

    const e = backquote(field);

    expect(hud.visible).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it("still ignores the shifted press, which belongs to the physics panel", () => {
    const e = backquote(window, { shiftKey: true });
    expect(hud.visible).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});
