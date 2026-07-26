/**
 * Two questions every input listener on the board has to ask first.
 *
 * Shared rather than duplicated because getting either one wrong is a bug that
 * only appears once some other feature lands — `Delete` wiping the board while
 * someone is editing a note, or a marquee starting underneath a toolbar the
 * user was aiming at. Both are the sort of thing that is obvious in hindsight
 * and invisible until the day it isn't.
 */

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
