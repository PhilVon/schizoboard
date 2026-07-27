/**
 * Two questions every input listener on the board has to ask first.
 *
 * Shared rather than duplicated because getting either one wrong is a bug that
 * only appears once some other feature lands — `Delete` wiping the board while
 * someone is editing a note, or a marquee starting underneath a toolbar the
 * user was aiming at. Both are the sort of thing that is obvious in hindsight
 * and invisible until the day it isn't.
 */

/**
 * What counts as a double-click, in one place.
 *
 * Two things ask, and they ask it of different edges of the same gesture: the
 * string tool ends a run on a second *click* in the same spot (DESIGN section
 * 3.4's "Finish: Enter, Esc, or double-click"), and `state/tools/machine.ts`
 * flags a second *press* so the select tool can toggle a segment taut. Neither
 * can use the DOM's own `dblclick`, because the machine calls `preventDefault`
 * on `pointerdown` to keep the webview's text selection out of a board drag, and
 * that suppresses the compatibility mouse events `dblclick` is one of.
 *
 * So the window and the slop are ours, and they are here rather than in either
 * caller because two different answers to "was that a double-click" on one
 * surface is a board where the same two presses mean different things depending
 * on which tool is holding it. 400 ms is inside the Windows default of 500 and
 * comfortably outside a deliberate pair of clicks.
 */
export const DOUBLE_CLICK_MS = 400;
/** Screen pixels, and larger than the drag threshold on purpose: a second
 *  press that has drifted 5 px is still someone clicking twice at one spot. */
export const DOUBLE_CLICK_SLOP = 6;

/** Is this event going to a text field? Then it is text, not board input. */
export function isTextTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

/** Is it going to the UI layer — the HUD, a toolbar, a panel — rather than to
 *  the board itself? Those take their own clicks. */
export function isChromeTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return Boolean(el && typeof el.closest === "function" && el.closest(".layer-ui"));
}
