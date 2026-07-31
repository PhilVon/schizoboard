/**
 * The note tool — `N`, and the second tool this board has ever had.
 *
 * > Tools   V select · P pin · S string · N note · M marker · H highlighter · E eraser
 * > — DESIGN section 3.9
 *
 * Press it, click the cork, and a blank sheet is there. That is the whole tool.
 * Until now the only way to put anything on the board at all was to paste it,
 * which meant a blank piece of paper — the thing DESIGN section 2.1 calls a
 * scrap — was the one item the model could hold and nobody could make.
 *
 * ## It hands the board back
 *
 * One placement and the board returns to `select`, rather than staying armed.
 *
 * That is not the usual choice. It was made because nothing on screen said which
 * tool was active: no toolbar, no cursor change, no indicator of any kind. A
 * sticky tool with no way to see that it is active is a trap — you press `N`,
 * get distracted, come back, and every click on the cork drops another sheet
 * where you meant to deselect. A one-shot tool cannot do that, and it costs one
 * keystroke per sheet.
 *
 * **Something says so now** (DESIGN section 3.10): the drawer lights the tool in
 * your hand and the info bar names it. This paragraph used to end "and there
 * should not be one, on a board whose whole argument is that it has no UI
 * furniture on it", which was a fair reading while the board was being built by
 * the person who wrote the key map and stopped being one the moment anybody else
 * had to find their way in.
 *
 * The one-shot behaviour stays, and the indicator is not the reason it should.
 * Advertising an armed tool tells you *why* the next click made a sheet; it does
 * not stop the click. The failure is a hand that has moved on while the board
 * has not, and reading the corner of the screen is exactly what somebody who has
 * been distracted has not done. What the drawer changes is the cost of the
 * alternative — a sticky tool would now be visible, so this is a choice about
 * the gesture rather than a workaround for having no UI. Placing one sheet and
 * handing the board back is still the right shape for a verb you do once.
 *
 * It also puts the new sheet in the selection, for the same reason paste does:
 * "putting something down and then wanting to move it is one gesture in two
 * halves, so the second half starts with it already held" (`app/main.ts`).
 *
 * ## Where the sheet lands
 *
 * At the point the press went down, not where the release came up. Those are
 * usually the same pixel; when they are not, the press is the one that was
 * aimed, and a sheet that lands where the hand finished drifting reads as the
 * board being imprecise.
 */

import { QuickPull } from "@/state/tools/quickpull";
import { Scissors } from "@/state/tools/scissors";
import type { Vec2 } from "@/state/camera";
import type {
  PointerSample,
  Tool,
  ToolContext,
  ToolHint,
  ToolInput,
} from "@/state/tools/tool";

export interface NoteToolOptions {
  /**
   * The tool is finished with the board — a sheet was placed, or `Escape`
   * abandoned it. The caller hands control back to `select`; the tool cannot do
   * that itself, because a tool has no idea what other tools exist.
   */
  onDone?: () => void;
}

export class NoteTool implements Tool {
  readonly id = "note";

  /** See [`ToolHint`]. One row, for the reason `PinTool`'s says: this tool does
   *  one thing and then stops being the tool. */
  readonly hint: ToolHint = {
    name: "Note",
    key: "N",
    verb: "click for a blank sheet — it comes up selected",
    rows: [{ keys: "Esc", does: "make nothing, give the board back" }],
  };

  private readonly options: NoteToolOptions;
  /** Where the press landed, board space, or null when nothing is pressed. */
  private downAt: Vec2 | null = null;

  constructor(options: NoteToolOptions = {}) {
    this.options = options;
  }

  /** `Alt` on a pin: the quick pull that belongs to no tool (DESIGN 3.4). */
  private readonly pull = new QuickPull();
  /** `Ctrl`+`Alt` on a string: the cut that belongs to no tool either (Q-186). */
  private readonly scissors = new Scissors();

  pullPreview(cursor: { x: number; y: number } | null): readonly { x: number; y: number }[] | null {
    return this.pull.preview(cursor);
  }

  handle(input: ToolInput, ctx: ToolContext): void {
    // The scissors first. Both of these belong to no tool (DESIGN section 3.4);
    // this one is offered ahead of the pull because it is the more specific
    // press — `Ctrl`+`Alt` rather than `Alt` — and a pin sitting over the string
    // being aimed at must not turn a cut into a pin removal.
    if (this.scissors.handle(input, ctx)) return;

    // `Alt` on a pin is nobody's tool — DESIGN section 3.4's quick pull works
    // "in any tool", and this is what that sentence costs each of them
    // (`state/tools/quickpull.ts`, T-229).
    if (this.pull.handle(input, ctx)) return;
    switch (input.kind) {
      case "down":
        this.onDown(input.at, ctx);
        return;
      case "up":
        this.onUp(ctx);
        return;
      case "cancel":
        this.cancel(ctx);
        return;
      case "key":
        // Escape puts the board back in the select tool without leaving
        // anything behind — the same thing it means in every other tool.
        if (input.code === "Escape") {
          this.downAt = null;
          this.options.onDone?.();
        }
        return;
      default:
        return;
    }
  }

  private onDown(at: PointerSample, ctx: ToolContext): void {
    const board = ctx.camera.screenToBoard(at.x, at.y);
    this.downAt = board;
  }

  private onUp(ctx: ToolContext): void {
    const at = this.downAt;
    this.downAt = null;
    if (!at) return;
    ctx.write.createNote(at.x, at.y);
    this.options.onDone?.();
  }

  /** Nothing eases and nothing is held, so there is nothing to step. */
  tick(): void {}

  /**
   * A lost pointer or a lost window. Nothing has been written yet — the sheet
   * only exists at pointer-up — so abandoning is forgetting where the press was.
   *
   * `onDone` deliberately does *not* fire here. A window that lost focus
   * mid-click has not finished with the tool, and coming back to find the board
   * silently in a different one is worse than coming back to the tool you chose.
   */
  cancel(_ctx: ToolContext): void {
    // A pull in flight belongs to this instance, and a tool switch would
    // otherwise leave it holding a gesture whose release goes somewhere else.
    this.pull.cancel();
    this.scissors.cancel();
    this.downAt = null;
  }
}
