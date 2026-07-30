/**
 * @vitest-environment happy-dom
 *
 * The line in the bottom-right corner, and the one thing it does that is not
 * "say something and stop".
 *
 * An image export of a large board takes a minute and a half, and for all of it
 * the window has zoomed itself out and gone quiet. A message that faded after
 * two and a half seconds would leave the remaining eighty-seven looking exactly
 * like a hang.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Flash } from "@/ui/flash";

let host: HTMLElement;
const line = (): HTMLElement => host.querySelector(".flash") as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  vi.useRealTimers();
  host.remove();
});

describe("a message that just happened", () => {
  it("is said, and then stops being said", () => {
    const flash = new Flash(host);
    flash.say("Board saved as PNG");
    expect(line().textContent).toBe("Board saved as PNG");
    expect(line().classList.contains("is-live")).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(line().classList.contains("is-live")).toBe(false);
  });
});

describe("a message about something still happening", () => {
  it("stays up however long it takes", () => {
    const flash = new Flash(host);
    flash.hold("Encoding as WebP — 4s");

    vi.advanceTimersByTime(120_000);
    expect(line().textContent).toBe("Encoding as WebP — 4s");
    expect(line().classList.contains("is-live")).toBe(true);
  });

  /**
   * The sentence after a progress line is the result of the same action, so it
   * lands in the same corner — and it has to behave like an ordinary message
   * once it does, rather than inheriting the hold and staying up for ever.
   */
  it("is replaced by the result, which then fades normally", () => {
    const flash = new Flash(host);
    flash.hold("Encoding as WebP");
    flash.say("Board saved as WebP (16285 × 8881, 20 MB)");

    expect(line().textContent).toBe("Board saved as WebP (16285 × 8881, 20 MB)");
    vi.advanceTimersByTime(5000);
    expect(line().classList.contains("is-live")).toBe(false);
  });

  /**
   * The other way round is the one that would go wrong quietly: a `say` whose
   * fade is still pending, then a `hold`, and the fade lands on top of the
   * progress line a second later and takes it down mid-export.
   */
  it("is not taken down by a fade left over from the message before it", () => {
    const flash = new Flash(host);
    flash.say("Copied the invite link");
    vi.advanceTimersByTime(1000);
    flash.hold("Framing the board…");

    vi.advanceTimersByTime(10_000);
    expect(line().textContent).toBe("Framing the board…");
    expect(line().classList.contains("is-live")).toBe(true);
  });

  it("can be taken down with nothing in its place", () => {
    const flash = new Flash(host);
    flash.hold("Drawing the board…");
    flash.clear();
    expect(line().classList.contains("is-live")).toBe(false);
    expect(line().textContent).toBe("");
  });
});
