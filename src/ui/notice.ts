/**
 * The board-level notice for photographs nobody here has.
 *
 * > A photo that no connected peer holds gets a torn-photograph treatment and a
 * > retry, plus a board-level notice naming who to ask. — docs/DESIGN.md 7.5
 *
 * The tear is per photograph and says only that this one is not coming. This is
 * the board's half: how many there are, and whose laptop they are on. What it
 * says is `state/missing.ts`'s decision; this is where it goes and what it
 * looks like.
 *
 * ## It is not chrome you can click
 *
 * `pointer-events: none`, without exception. Two pieces of UI on this board have
 * eaten board presses — the dev HUD and the old hint line — and each cost a
 * session to find, because a press that lands in an overlay looks exactly like
 * an interaction the application ignored. Both are fixed (T-250); this comment
 * asserted the HUD was inert for nine phases before it was. There is nothing to click here: the
 * retry DESIGN asks for is automatic (every `synced` re-asks for everything
 * missing), so a button would only be a slower way to do what already happens.
 *
 * ## Silent by default
 *
 * The element is empty and hidden unless there is something to say, and the
 * text is only written when it *changes*. A board where every photograph is
 * present — which is nearly all of them, nearly all of the time — costs one
 * string comparison per update and touches no DOM at all.
 */

import type { MissingNotice } from "@/state/missing";
import { noticeText } from "@/state/missing";

export class Notice {
  private readonly el: HTMLDivElement;
  private readonly swatches: HTMLSpanElement;
  private readonly line: HTMLSpanElement;
  /** What is on screen, so an unchanged notice writes nothing. */
  private written: string | null = null;

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "notice";
    // Announced rather than merely drawn: a photograph quietly failing to
    // arrive is exactly the kind of thing a screen reader user would otherwise
    // have no signal for at all.
    this.el.setAttribute("role", "status");

    this.swatches = document.createElement("span");
    this.swatches.className = "notice-swatches";
    this.line = document.createElement("span");
    host.append(this.el);
    this.el.append(this.swatches, this.line);
  }

  /**
   * Show `notice`, or nothing at all when it is null.
   *
   * Keyed on the rendered sentence rather than on the object, because the
   * caller rebuilds the notice on every tick and two ticks that read the same
   * are the overwhelming majority.
   */
  update(notice: MissingNotice | null): void {
    const text = notice === null ? "" : noticeText(notice);
    if (text === this.written) return;
    this.written = text;

    this.el.classList.toggle("is-live", text.length > 0);
    this.line.textContent = text;

    // A dot per named peer, in the colour their cursor is drawn in — so the
    // name in the sentence and the cursor that was on the board a minute ago
    // are recognisably the same person.
    this.swatches.replaceChildren();
    for (const holder of notice?.holders ?? []) {
      const dot = document.createElement("span");
      dot.className = "notice-dot";
      dot.style.background = holder.color;
      dot.classList.toggle("is-gone", !holder.present);
      this.swatches.append(dot);
    }
  }

  destroy(): void {
    this.el.remove();
  }
}
