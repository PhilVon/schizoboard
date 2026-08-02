/**
 * @vitest-environment happy-dom
 *
 * The panel: that a slider reaches the value, that the readout says what the
 * simulation actually has rather than what the slider asked for, and that it
 * opens agreeing with a value somebody set from the console.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetTuning, setTuning, TUNABLES } from "@/sim/tuning";
import { TuningPanel } from "@/ui/tuning";

let host: HTMLElement;
let panel: TuningPanel;

function rowFor(key: string): { slider: HTMLInputElement; value: HTMLElement } {
  const index = TUNABLES.findIndex((k) => k.key === key);
  const rows = host.querySelectorAll(".tuning-row");
  const row = rows[index] as HTMLElement;
  return {
    slider: row.querySelector("input") as HTMLInputElement,
    value: row.querySelector(".tuning-value") as HTMLElement,
  };
}

/** What a hand on the slider does, which is an `input` and not a `change`. */
function slide(key: string, to: number): void {
  const { slider } = rowFor(key);
  slider.value = String(to);
  slider.dispatchEvent(new Event("input", { bubbles: true }));
}

function read(key: string): number {
  return TUNABLES.find((k) => k.key === key)!.read();
}

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  panel = new TuningPanel(host);
});

// The panel writes module state the whole worker shares — see `tuning.test.ts`.
afterEach(() => {
  panel.destroy();
  resetTuning();
});

describe("the physics panel", () => {
  it("has a row for every dial, and starts hidden", () => {
    expect(host.querySelectorAll(".tuning-row")).toHaveLength(TUNABLES.length);
    expect((host.querySelector(".tuning") as HTMLElement).hidden).toBe(true);
    expect(panel.open).toBe(false);
  });

  it("opens on Shift+backquote and closes on it", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote", shiftKey: true }));
    expect(panel.open).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote", shiftKey: true }));
    expect(panel.open).toBe(false);
  });

  /** The unshifted one is the HUD's, and taking it would open both at once. */
  it("leaves the bare backquote alone", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote" }));
    expect(panel.open).toBe(false);
  });

  /**
   * And leaves the character alone when somebody is typing one — T-325. Only a
   * tidy-up here, since this panel is dev-only, but the HUD beside it had the
   * same miss on a listener that ships, and one of the two guarding would be
   * the more confusing arrangement.
   */
  it("does not open while a caret has the keyboard", () => {
    const note = document.createElement("div");
    note.contentEditable = "true";
    document.body.append(note);

    const e = new KeyboardEvent("keydown", {
      code: "Backquote",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    note.dispatchEvent(e);

    expect(panel.open).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it("writes a dial while the thumb is still down", () => {
    slide("GRAVITY", 20000);
    expect(read("GRAVITY")).toBe(20000);
    expect(rowFor("GRAVITY").value.textContent).toBe("20000");
  });

  /**
   * The one bug a panel must not have. The slider asks for 16.4, the dial's
   * step is 1, and the readout must say what was *written* — a panel reporting
   * a number the simulation does not have sends somebody hunting a discrepancy
   * that is only on the screen.
   */
  it("reports what was written, not what was asked for", () => {
    // A dial whose step does not divide what the slider offers, so the two
    // numbers are genuinely different strings — with `ROPE_SUBSTEPS` at a step
    // of 1, "16.4 asked" and "16 written" both format to "16" and the test
    // would pass with the readout wired to the wrong one.
    slide("SIM_MARGIN", 0.33);
    expect(read("SIM_MARGIN")).toBe(0.35);
    expect(rowFor("SIM_MARGIN").value.textContent).toBe("0.35");

    slide("ROPE_SUBSTEPS", 16.4);
    expect(read("ROPE_SUBSTEPS")).toBe(16);
  });

  it("keeps the reset row out of the way until something has moved", () => {
    const reset = host.querySelector(".tuning-reset") as HTMLButtonElement;
    expect(reset.hidden).toBe(false); // never opened; sync has not run

    panel.toggle();
    expect(reset.hidden).toBe(true);

    slide("ROPE_DAMPING", 0.9);
    expect(reset.hidden).toBe(false);

    reset.click();
    expect(read("ROPE_DAMPING")).toBe(0.98);
    expect(reset.hidden).toBe(true);
    expect(rowFor("ROPE_DAMPING").slider.value).toBe("0.98");
  });

  /** A dial can be moved from the console as easily as from a slider. */
  it("opens agreeing with a value it did not write", () => {
    setTuning("MATERIAL_EASE", 4);
    panel.toggle();
    expect(rowFor("MATERIAL_EASE").slider.value).toBe("4");
    expect(rowFor("MATERIAL_EASE").value.textContent).toBe("4.0");
  });

  it("says what a dial will not do until something else happens", () => {
    const lags = [...host.querySelectorAll(".tuning-lag")].map((n) => n.textContent);
    expect(lags.some((t) => t?.includes("particle count it was seeded with"))).toBe(true);
  });
});
