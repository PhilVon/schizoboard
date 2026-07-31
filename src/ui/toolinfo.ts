/**
 * The tool info bar — what is in your hand, and what is under the key you are
 * holding.
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
 * ## What it draws, and why it is short
 *
 * The first version of this said every gesture in full, always, and came out six
 * lines tall — which is the mistake it was built to fix, made again with better
 * copy in it. Q-194 settled the shape: **the bar names the modifiers at rest and
 * holding one is what asks the question.**
 *
 * So there are four bands, and only the third of them ever changes:
 *
 *   1. the **lead** — the tool, its key, and its plain verb;
 *   2. the rows that need **nothing held**, which are true whatever you are
 *      doing and are the only ones no key could ever reveal;
 *   3. either the **chips** — `hold Shift · Ctrl · Alt`, each lit while its key
 *      is down — or, when a held key has something behind it on this tool, the
 *      **rows it reveals**, with their phrases;
 *   4. the standing **board line**: the camera, the search and undo. Built once
 *      in the constructor, because it is the same on every frame of every
 *      session.
 *
 * Two thirds of what a tool implements sits behind a modifier, so hiding those
 * until they are asked for is most of the height — and nothing is lost, because
 * a gesture you are not holding the key for is one you are not about to make.
 *
 * ## What it costs per frame
 *
 * Called once a frame from the OVERLAY phase, where the rest of the chrome
 * repaints, and it writes DOM on two events: the lead changing, which happens
 * when the tool does, and band 3 changing, which happens when a modifier goes
 * down or up. Everything else is two string compares against what is on screen.
 *
 * The policy — which rows rest, which a held set reveals, which modifiers are
 * worth naming — is `ui/toolhint.ts`, tested with no DOM at all. This is the box
 * that shows them.
 */

import type { ToolHint, ToolHintRow } from "@/state/tools/tool";
import {
  BOARD,
  heldModifier,
  modifierLabel,
  modifiers,
  restingRows,
  revealed,
  toolLine,
  type BoardStatus,
} from "@/ui/toolhint";

export class ToolInfo {
  private readonly el: HTMLDivElement;
  private readonly toolEl: HTMLDivElement;
  private readonly leadEl: HTMLSpanElement;
  /** Band 3 — the chips, or what a held key revealed. */
  private readonly heldEl: HTMLDivElement;
  /** The lead as written. Null until the first sync — which is not the same as
   *  an empty lead, and the difference is the first frame. */
  private writtenLead: string | null = null;
  /** A signature of band 3 as written, so an unchanged frame writes nothing. */
  private writtenHeld: string | null = null;

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

    this.heldEl = document.createElement("div");
    this.heldEl.className = "toolinfo-held";

    const board = document.createElement("div");
    board.className = "toolinfo-board";
    // Once. These seven are the same on every frame of every session, so there
    // is nothing here for `sync` to reconsider.
    for (const row of BOARD) board.append(this.row(row));

    this.el.append(this.toolEl, this.heldEl, board);
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
      // The lead stays; everything after it is this tool's plain gestures.
      this.toolEl.replaceChildren(
        this.leadEl,
        ...(line.warning && line.rows.length === 0 ? [] : restingRows(hint).map((r) => this.row(r))),
      );
    }

    // A sealed board offers nothing at all — not the chips either, since every
    // gesture behind them is a write.
    const shown = line.rows.length === 0 ? [] : revealed(hint, held);
    const chips = line.rows.length === 0 ? [] : modifiers(hint);
    const lit = chips.filter((name) => heldModifier(name, held));

    /**
     * What band 3 is showing, as a string.
     *
     * The revealed rows are keyed by their own `keys`, which are unique within a
     * tool; the chip line is keyed by which chips exist *and* which are lit,
     * because a modifier this tool has nothing behind still lights its chip and
     * that is a DOM write.
     */
    const signature =
      shown.length > 0
        ? `r:${shown.map((r) => r.keys).join("|")}`
        : `c:${chips.join(",")}/${lit.join(",")}`;
    if (signature === this.writtenHeld) return;
    this.writtenHeld = signature;

    if (shown.length > 0) {
      const rows = shown.map((row) => {
        const el = this.row(row);
        el.classList.add("is-live");
        return el;
      });
      this.heldEl.replaceChildren(...rows);
      return;
    }
    if (chips.length === 0) {
      this.heldEl.replaceChildren();
      return;
    }
    const hold = document.createElement("span");
    hold.className = "toolinfo-hold";
    hold.textContent = "hold";
    this.heldEl.replaceChildren(
      hold,
      ...chips.map((name) => {
        const chip = document.createElement("b");
        chip.className = "toolinfo-chip";
        chip.textContent = modifierLabel(name);
        // Lit with nothing revealed is the honest answer to leaning on `Shift`
        // in the pen tool: the key is down, and there is nothing behind it here.
        chip.classList.toggle("is-on", heldModifier(name, held));
        return chip;
      }),
    );
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
