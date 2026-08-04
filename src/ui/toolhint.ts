/**
 * What the info bar says, as a pure function of what is in your hand.
 *
 * The `boardmenu.ts` ↔ `menu.ts` split, applied again: this is the part with
 * opinions in it, and `ui/toolinfo.ts` is a box that shows lines. Everything
 * here is testable with no document, no renderer and no browser, which is the
 * whole reason it is a separate module — the copy is the part most likely to be
 * wrong, and it is the part a DOM test is worst at checking.
 *
 * ## Why the ambient rows are here rather than on a tool
 *
 * Three gestures belong to no tool and work in all of them:
 *
 * > `Alt`+drag from a pin, **in any tool** — DESIGN section 3.4
 * > `Ctrl`+`Alt`+click a string cuts it, in any tool — the scissors — section 3.9
 *
 * They are implemented once, in `state/tools/quickpull.ts` and
 * `state/tools/scissors.ts`, and every one of the eight tools delegates to both
 * before its own switch. So they are declared once, here, rather than copied
 * into eight `Tool.hint`s that would then drift apart. `hint.test.ts` asserts
 * no tool declares them.
 *
 * ## Why the board line is here at all
 *
 * The hint line this replaces taught the camera, the search and undo alongside
 * the tools, in one undifferentiated sentence. Those are not a tool's and never
 * change with one — but dropping them would lose the only place the application
 * says `Ctrl`+`0` fits the board. So they are a second, quieter line that is the
 * same on every frame: constant, and therefore free.
 */

import type { ToolHint, ToolHintRow } from "@/state/tools/tool";

/**
 * The three gestures every tool composes in.
 *
 * All three light, and the last one is the reason the lighting exists at all —
 * `app/main.ts` on the scissors: "`Ctrl`+`Alt` was chosen precisely because
 * nothing else can be pressed by accident, and the cost of that is that nothing
 * suggests it either."
 */
export const AMBIENT: readonly ToolHintRow[] = Object.freeze([
  { keys: "Alt+drag a pin", does: "pull a new string out", holds: ["Alt"] },
  { keys: "Alt+click a pin", does: "take it out; strings heal", holds: ["Alt"] },
  { keys: "Ctrl+Alt+click a string", does: "cut it; its pins stay", holds: ["Control", "Alt"] },
]);

/**
 * The standing line: the camera, the search, and undo.
 *
 * No `holds` on any of them, because none is a modifier a person holds and
 * waits with — they are things you press. A row that could never light is drawn
 * at the quiet weight, which is what this whole line is.
 */
export const BOARD: readonly ToolHintRow[] = Object.freeze([
  { keys: "space+drag", does: "pan" },
  { keys: "wheel", does: "zoom" },
  { keys: "Ctrl+0", does: "fit the board" },
  { keys: "F", does: "frame the selection" },
  { keys: "Ctrl+F", does: "find and fly there" },
  { keys: "Ctrl+Z", does: "undo" },
  { keys: "`", does: "the dev HUD" },
]);

/**
 * A tool's own rows, then the three that are everybody's.
 *
 * That order and not the reverse: the rows you are reading are about the thing
 * you just picked, and a readout that opened with three gestures true of every
 * tool would bury the answer to the question that made you look.
 */
export function rows(hint: ToolHint): readonly ToolHintRow[] {
  return [...hint.rows, ...AMBIENT];
}

/** The three, in the order a chip line names them. */
export const MODIFIERS = ["Shift", "Control", "Alt"] as const;
export type Modifier = (typeof MODIFIERS)[number];

/** How a modifier is written on a chip — `Control` is `Ctrl` everywhere else on
 *  this board, and the chip is the thing a reader matches against a key cap. */
export function modifierLabel(name: Modifier): string {
  return name === "Control" ? "Ctrl" : name;
}

/**
 * The rows a tool offers with nothing held.
 *
 * These are the whole of what the bar says at rest, and the reason it can be
 * short: two thirds of what a tool implements is behind a modifier, and a
 * gesture you are not holding the key for is a gesture you are not about to
 * make. Naming all of them at rest is what made this bar six lines tall — the
 * same shape of mistake as the line it replaced, which said everything always.
 *
 * Nothing is lost, because a row with no `holds` has no key to reveal it: these
 * are exactly the ones that could never appear any other way.
 */
export function restingRows(hint: ToolHint): readonly ToolHintRow[] {
  return rows(hint).filter((row) => (row.holds ?? []).length === 0);
}

/**
 * Which modifiers have something behind them, in [`MODIFIERS`] order.
 *
 * Each one separately, including the pair `Ctrl`+`Alt`+click needs: the chips
 * say which *keys* are worth holding, not which combinations exist. Holding one
 * of a pair then reveals nothing and the other chip is still lit beside it,
 * which is the only hint the cut needs — and is more than the board gave it
 * before, which was nothing at all.
 */
export function modifiers(hint: ToolHint): readonly Modifier[] {
  const seen = new Set<string>();
  for (const row of rows(hint)) for (const name of row.holds ?? []) seen.add(name);
  return MODIFIERS.filter((name) => seen.has(name));
}

/** Is this modifier down? The same two-codes-per-word mapping [`live`] uses. */
export function heldModifier(name: Modifier, held: ReadonlySet<string>): boolean {
  return held.has(`${name}Left`) || held.has(`${name}Right`);
}

/**
 * What holding these keys reveals — every row all of whose modifiers are down.
 *
 * Empty is the ordinary answer, and it has two quite different causes the caller
 * has to tell apart: nothing is held, or something is held that this tool has
 * nothing behind. Both fall back to the chip line — a bar that went blank
 * because you leaned on `Shift` in the pen tool would read as broken.
 */
export function revealed(hint: ToolHint, held: ReadonlySet<string>): readonly ToolHintRow[] {
  return rows(hint).filter((row) => live(row, held));
}

/**
 * Is every key this row needs down right now?
 *
 * `held` is `KeyboardEvent.code`s — `ToolMachine.held`, which is the set
 * `modifier()` answers from and the set a tool sees as `ctx.held`. The mapping
 * from the word a reader sees to the two codes a keyboard has is here because
 * it is the only place the two vocabularies meet.
 *
 * A row with no `holds` is **not** live. That is the point of the distinction
 * rather than an omission: live means *available this instant, because you are
 * holding the key*, and a gesture that is always available has nothing to
 * announce. Making those live too would leave the whole readout bright and the
 * one row that just lit indistinguishable from the rest.
 */
export function live(row: ToolHintRow, held: ReadonlySet<string>): boolean {
  const holds = row.holds;
  if (holds === undefined || holds.length === 0) return false;
  for (const name of holds) {
    if (!held.has(`${name}Left`) && !held.has(`${name}Right`)) return false;
  }
  return true;
}

/**
 * What a board that cannot be written to says instead.
 *
 * Both sentences move here from `app/main.ts` as data, because they are copy
 * and the rest of the copy is here. They behave differently and the difference
 * is not cosmetic — it is the reason they are two fields rather than one:
 *
 * `sealed` **replaces** the tool line. That board takes no gesture at all, and
 * a readout offering *drag to move · Delete removes* on one that does neither is
 * worse than no readout: the first thing anybody does is try one, and the board
 * says nothing back.
 *
 * `unsaved` **prefixes** it. That board still takes every gesture in the list
 * and merely fails to keep them, so the list is still true.
 */
export interface BoardStatus {
  /** Opened by a newer build — read-only, and the tool line is replaced. */
  readonly sealed?: { readonly boardVersion: number; readonly buildVersion: number };
  /** The document on disk could not be read and is being left alone. */
  readonly unsaved?: boolean;
  /**
   * Another window is writing this board's file, so this one has stopped
   * (T-368).
   *
   * Prefixes, like `unsaved` and for the same reason — every gesture in the list
   * still works and is still kept. What it says is narrower than `unsaved`, and
   * the difference is the whole point of it being a third field: the *document*
   * is still being saved here, and only the file has stopped being updated.
   */
  readonly taken?: boolean;
}

export function sealedLine(boardVersion: number, buildVersion: number): string {
  return (
    `THIS BOARD WAS MADE BY A NEWER VERSION — it is schema ${boardVersion} and this ` +
    `build reads ${buildVersion}, so it is open to look at and not to change. ` +
    `Nothing has been altered or thrown away.`
  );
}

export const UNSAVED_LINE =
  "THIS BOARD IS NOT BEING SAVED — the document on disk could not be read, " +
  "and is being left alone rather than written over. See the console.";

/**
 * T-368. Deliberately says what is *still* true before it says what stopped,
 * because the alarming reading of "this board's file is not being updated" is
 * the wrong one: the work is safe, it is on this disk, and what has stopped is
 * one of the two places it is kept.
 */
export const TAKEN_LINE =
  "THIS BOARD'S FILE IS NOT BEING UPDATED — your work is being saved here, but " +
  "another window has the file, so this one has stopped writing it rather than " +
  "write over what that window is doing. Close the other one and reopen this board.";

/** What the tool line reads, given the tool and the board's condition. */
export interface ToolLine {
  /** The lead: a warning, or the tool's name and plain verb. */
  readonly lead: string;
  /** A warning that has replaced the tool entirely, so the rows go too. */
  readonly warning: boolean;
  readonly rows: readonly ToolHintRow[];
}

export function toolLine(hint: ToolHint, status: BoardStatus = {}): ToolLine {
  if (status.sealed) {
    return {
      lead: sealedLine(status.sealed.boardVersion, status.sealed.buildVersion),
      warning: true,
      // Not even the ambient three. A sealed board takes no write, and
      // `Alt`+click a pin is a write.
      rows: [],
    };
  }
  const lead = `${hint.name} (${hint.key}) — ${hint.verb}`;
  // `unsaved` outranks `taken` when both are somehow true, because it is the
  // worse news by a long way: one says the file is stale and the other says the
  // work is not reaching this disk at all.
  const warn = status.unsaved ? UNSAVED_LINE : status.taken ? TAKEN_LINE : null;
  return {
    lead: warn === null ? lead : `${warn} · ${lead}`,
    warning: warn !== null,
    rows: rows(hint),
  };
}
