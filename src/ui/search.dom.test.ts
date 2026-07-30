/**
 * @vitest-environment happy-dom
 *
 * The search field — T-85, DESIGN section 3.7.
 *
 * The behaviour worth pinning down is not that it holds text. It is that this
 * is the first surface on this board that takes the keyboard, and two of its
 * properties are load-bearing for things a long way from here:
 *
 * - it is an `<input>`, which is what `state/input.ts`'s `isTextTarget` reads,
 *   and which is therefore the whole of how `Delete` stops clearing the board
 *   while you type a query into it; and
 * - it gives the keyboard *back* when it closes, because a hidden field that
 *   still holds focus leaves every shortcut on the board disarmed with nothing
 *   on screen to say why.
 *
 * `Escape` and `Enter` are stopped rather than let through, because both mean
 * something else to the board underneath.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isTextTarget } from "@/state/input";
import { SearchField, type SearchHandlers } from "@/ui/search";

let host: HTMLElement;

const panel = (): HTMLElement => host.querySelector(".search") as HTMLElement;
const input = (): HTMLInputElement => host.querySelector(".search-input") as HTMLInputElement;
const count = (): HTMLElement => host.querySelector(".search-count") as HTMLElement;

function handlers(): SearchHandlers & {
  queries: string[];
  steps: number[];
  closes: number;
} {
  const seen = {
    queries: [] as string[],
    steps: [] as number[],
    closes: 0,
    typed: (q: string) => void seen.queries.push(q),
    stepped: (d: number) => void seen.steps.push(d),
    closed: () => void (seen.closes += 1),
  };
  return seen;
}

/** A key, dispatched at the input the way a person's would arrive. */
function key(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  input().dispatchEvent(e);
  return e;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

describe("the search field", () => {
  it("is not on the board until it is asked for", () => {
    new SearchField(host, handlers());
    expect(panel().classList.contains("is-live")).toBe(false);
    expect(document.activeElement).not.toBe(input());
  });

  it("takes the keyboard when it opens and gives it back when it closes", () => {
    const field = new SearchField(host, handlers());
    field.open();
    expect(panel().classList.contains("is-live")).toBe(true);
    expect(document.activeElement).toBe(input());

    field.close();
    expect(panel().classList.contains("is-live")).toBe(false);
    // The one that matters: a hidden field still holding focus would leave
    // Delete, V, E and the tool letters disarmed for the rest of the session.
    expect(document.activeElement).not.toBe(input());
  });

  it("is a text target, which is the whole of how the board disarms itself", () => {
    const field = new SearchField(host, handlers());
    field.open();
    // Not an assertion about this module so much as about the one rule it is
    // relying on. If `isTextTarget` ever stops recognising an input, Delete
    // starts clearing the board while somebody types a query.
    expect(isTextTarget(input())).toBe(true);
  });

  it("reports every keystroke, including the one back to empty", () => {
    const seen = handlers();
    const field = new SearchField(host, seen);
    field.open();
    input().value = "har";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    input().value = "";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(seen.queries).toEqual(["har", ""]);
  });

  it("steps forward on Enter and back on Shift+Enter", () => {
    const seen = handlers();
    const field = new SearchField(host, seen);
    field.open();
    key({ key: "Enter" });
    key({ key: "Enter", shiftKey: true });
    expect(seen.steps).toEqual([1, -1]);
  });

  it("keeps Enter and Escape away from the board, which means other things by them", () => {
    const field = new SearchField(host, handlers());
    field.open();
    // Enter ends a string run and Escape clears a selection. Neither may happen
    // because somebody stepped a search.
    expect(key({ key: "Enter" }).defaultPrevented).toBe(true);
    expect(key({ key: "Escape" }).defaultPrevented).toBe(true);
  });

  it("closes on Escape and says so once", () => {
    const seen = handlers();
    const field = new SearchField(host, seen);
    field.open();
    key({ key: "Escape" });
    expect(panel().classList.contains("is-live")).toBe(false);
    expect(seen.closes).toBe(1);
    // And closing an already-closed field is not a second event to react to.
    field.close();
    expect(seen.closes).toBe(1);
  });

  it("selects what is in it when reopened, so the last query is there to reuse or replace", () => {
    const field = new SearchField(host, handlers());
    field.open();
    input().value = "harbour";
    field.close();

    const select = vi.spyOn(input(), "select");
    field.open();
    expect(field.value).toBe("harbour");
    expect(select).toHaveBeenCalled();
  });

  // --- the readout ------------------------------------------------------------

  it("says nothing at all for a query nobody has typed yet", () => {
    const field = new SearchField(host, handlers());
    field.open();
    field.report(0, 0);
    // Not "0 of 0": a field you have just opened has not failed to find
    // anything, it has not been asked.
    expect(count().textContent).toBe("");
  });

  it("counts from one, and says so plainly", () => {
    const field = new SearchField(host, handlers());
    field.open();
    input().value = "hit";
    field.report(3, 7);
    expect(count().textContent).toBe("3 of 7");
    expect(count().classList.contains("is-none")).toBe(false);
  });

  it("says none rather than zero, and marks it as quiet rather than as an error", () => {
    const field = new SearchField(host, handlers());
    field.open();
    input().value = "nothing on this board";
    field.report(0, 0);
    expect(count().textContent).toBe("none");
    expect(count().classList.contains("is-none")).toBe(true);
  });

  it("writes no DOM for an unchanged readout", () => {
    const field = new SearchField(host, handlers());
    field.open();
    input().value = "hit";
    field.report(2, 5);
    const span = count();
    const spy = vi.spyOn(span, "textContent", "set");
    field.report(2, 5);
    expect(spy).not.toHaveBeenCalled();
  });

  it("takes itself off the board on destroy", () => {
    const field = new SearchField(host, handlers());
    field.destroy();
    expect(host.querySelector(".search")).toBe(null);
  });
});
