/**
 * The tool info bar — what is in your hand and what you can do with it.
 *
 * Bottom left, where the hint line it replaces was. Three things about that
 * line are being fixed rather than restyled:
 *
 *   - it was **one sentence for every tool**, about forty gestures long and
 *     identical whichever tool you were holding, so it answered no question
 *     anybody actually had;
 *   - it had **no `max-width`**, so it wrapped into a block across most of the
 *     bottom of the viewport;
 *   - it had **no `pointer-events: none`**, so every press that landed in that
 *     block was swallowed. Three separate source comments assert the hint line
 *     is inert. None of them was true.
 *
 * That last one is why this class is a readout and nothing else. Two overlays on
 * this board have eaten board presses and each cost a session to find, because a
 * press that lands in chrome looks exactly like the application ignoring an
 * interaction.
 *
 * ## What it draws
 *
 * Two lines. The **tool line** is the name, the plain verb, and the tool's own
 * rows followed by the three that belong to every tool. The **board line** is
 * the camera, the search and undo — constant, quieter, and built once in the
 * constructor because it never changes.
 *
 * A row whose modifiers are all down is drawn live. Holding `Ctrl`+`Alt` and
 * watching the cut row brighten is the gesture teaching itself, which is D-44's
 * sixth decision and the reason the readout is worth more than a list.
 *
 * ## What it costs per frame
 *
 * Called once a frame from the OVERLAY phase, where the rest of the chrome
 * repaints, and it writes DOM on two events only: the lead changing, which
 * happens when the tool does, and the set of live rows changing, which happens
 * when a modifier goes down or up. Everything else is a string compare and an
 * integer compare against what is on screen.
 *
 * The policy — what the rows say, and which of them are live — is
 * `ui/toolhint.ts`, tested with no DOM at all. This is the box that shows them.
 */

import type { ToolHint, ToolHintRow } from "@/state/tools/tool";
import { BOARD, live, toolLine, type BoardStatus } from "@/ui/toolhint";

export class ToolInfo {
  private readonly el: HTMLDivElement;
  private readonly toolEl: HTMLDivElement;
  private readonly leadEl: HTMLSpanElement;
  /** One element per row of the tool line, in order, so a modifier going down
   *  is a class toggle rather than a rebuild. */
  private rowEls: HTMLElement[] = [];
  private rowData: readonly ToolHintRow[] = [];
  /** The lead as written. Null until the first sync — which is not the same as
   *  an empty lead, and the difference is the first frame. */
  private writtenLead: string | null = null;
  /** Which rows are live, one bit each, as written. -1 until the first sync. */
  private writtenLive = -1;

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "toolinfo";
    // Announced, like the notice: which tool is in hand is exactly the kind of
    // state a screen reader user would otherwise have no signal for — and until
    // this existed, neither did anybody else.
    this.el.setAttribute("role", "status");

    this.toolEl = document.createElement("div");
    this.toolEl.className = "toolinfo-tool";
    this.leadEl = document.createElement("span");
    this.leadEl.className = "toolinfo-lead";
    this.toolEl.append(this.leadEl);

    const board = document.createElement("div");
    board.className = "toolinfo-board";
    // Once. These seven are the same on every frame of every session, so there
    // is nothing here for `sync` to reconsider.
    for (const row of BOARD) board.append(this.row(row));

    this.el.append(this.toolEl, board);
    host.append(this.el);
  }

  /**
   * What is in your hand, and what is held.
   *
   * `held` is `ToolMachine.held` — the same set `applyCursor` reads through
   * `modifier()` for the scissors cursor, so the pointer and this line cannot
   * disagree about whether `Ctrl`+`Alt` is down.
   */
  sync(hint: ToolHint, held: ReadonlySet<string>, status: BoardStatus = {}): void {
    const line = toolLine(hint, status);

    if (line.lead !== this.writtenLead) {
      this.writtenLead = line.lead;
      this.leadEl.textContent = line.lead;
      this.leadEl.classList.toggle("is-warning", line.warning);
      this.rowData = line.rows;
      this.rowEls = line.rows.map((row) => this.row(row));
      // The lead stays; everything after it is this tool's.
      this.toolEl.replaceChildren(this.leadEl, ...this.rowEls);
      // The rows are new, so nothing on screen is known live yet.
      this.writtenLive = -1;
    }

    let mask = 0;
    for (let i = 0; i < this.rowData.length; i++) {
      if (live(this.rowData[i]!, held)) mask |= 1 << i;
    }
    if (mask === this.writtenLive) return;
    this.writtenLive = mask;
    for (let i = 0; i < this.rowEls.length; i++) {
      this.rowEls[i]!.classList.toggle("is-live", (mask & (1 << i)) !== 0);
    }
  }

  /**
   * One row: the keys, then what they do.
   *
   * Built as elements with `textContent` rather than as a string of markup.
   * Nothing here comes from a person — every row is a module constant — but the
   * rows are the one thing on this board authored as prose in eight different
   * files, and an apostrophe in one of them should not be able to matter.
   */
  private row(row: ToolHintRow): HTMLElement {
    const el = document.createElement("span");
    el.className = "toolinfo-row";
    const keys = document.createElement("b");
    keys.className = "toolinfo-keys";
    keys.textContent = row.keys;
    const does = document.createElement("span");
    does.textContent = row.does;
    el.append(keys, does);
    return el;
  }

  destroy(): void {
    this.el.remove();
  }
}
