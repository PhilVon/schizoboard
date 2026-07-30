/**
 * Turning the items into pixels — the one part of an image export that has to be
 * invented (D-34).
 *
 * Everything else on this board already draws itself into a canvas at an
 * arbitrary camera: cork, the board-ink tiles, both rope layers and the overlay
 * are all painters that take a camera and draw per-point, which is what keeps a
 * line crisp at every zoom and what means an *export* camera costs them nothing
 * new. Only the items are DOM, so "how does a board become an image" is one
 * question rather than five, and this file is that question.
 *
 * The route, measured before it was chosen: clone the item subtree into an
 * `<svg><foreignObject>`, serialise it, load it as a `data:` URL and draw it to
 * the export canvas. It works — but a foreignObject subtree is styled by what is
 * *inside* the SVG and by nothing else, and it can reach nothing outside the
 * data URL it arrived in. So two things have to be carried in with it, and
 * neither of them announces itself when it is missing:
 *
 * 1. **The stylesheet.** Without it the clone comes back as unstyled text.
 * 2. **The font, as bytes.** `items.css` names the woff2 by a *relative* URL,
 *    which inside a `data:` SVG resolves against the data URI and is not found.
 *    Nothing throws; the writing silently comes out in whatever cursive the
 *    machine has. Measured ink extent for the same words at 19px: Patrick Hand
 *    138.1px, Segoe Script 214.7px — so it is not a subtle difference, it is
 *    every note in the wrong hand *wrapping differently* (D-34 §4).
 *
 * Photographs are the same hazard one step further out and are handled the same
 * way; see [`inlineAssets`].
 */

/** The face the board writes in, and the one thing an export must not lose. */
export const BOARD_FONT_URL = "/fonts/patrick-hand.woff2";

/**
 * Every stylesheet this document has, as one string.
 *
 * Same-origin only, and quietly skipping the rest: a sheet from another origin
 * throws `SecurityError` on `cssRules`, and there is nothing to be done about it
 * from here. A board's own CSS is always same-origin — it is bundled — so what
 * this can lose is a stylesheet somebody else injected, which is not part of the
 * board.
 */
export function collectStyles(sheets: Iterable<CSSStyleSheet>): string {
  const out: string[] = [];
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) out.push(rule.cssText);
  }
  return out.join("\n");
}

/**
 * Put the font's bytes where the SVG can reach them.
 *
 * A string replacement rather than a second `@font-face`, so the rule that is
 * already there — with its `font-display: block` and its weight — is the one
 * that ends up in the export. Both quoting styles and the bare form, because
 * this reads back CSS that has been through the browser's own serialiser and
 * that is not necessarily the text that was written.
 *
 * Returns the CSS unchanged when the URL is not in it, which is the honest
 * outcome for a stylesheet that has already been inlined once — and is why
 * [`fontWasInlined`] exists rather than a boolean return: a caller that wants to
 * know should *ask*, because "unchanged" happens for two opposite reasons.
 */
export function inlineFont(css: string, dataUri: string, url = BOARD_FONT_URL): string {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.replace(new RegExp(`url\\((['"]?)${escaped}\\1\\)`, "g"), `url("${dataUri}")`);
}

/** Whether a stylesheet still names the font by a URL an export cannot reach. */
export function fontWasInlined(css: string, url = BOARD_FONT_URL): boolean {
  return !css.includes(url);
}

/**
 * The bytes of a fetched font, as a `data:` URI.
 *
 * `font/woff2` rather than `application/octet-stream`: Chromium will load either,
 * and the honest type is what makes the export readable by anything else that
 * ever opens it.
 */
export function fontDataUri(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  // In chunks, because `String.fromCharCode(...bytes)` on a 24 kB font is a
  // 24,000-argument call and browsers have a limit on that which is nowhere near
  // as large as people assume.
  const CHUNK = 8192;
  for (let at = 0; at < view.length; at += CHUNK) {
    binary += String.fromCharCode(...view.subarray(at, at + CHUNK));
  }
  return `data:font/woff2;base64,${btoa(binary)}`;
}
