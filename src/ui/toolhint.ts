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
  { keys: "Alt+drag a pin", does: "pull a new string out of it", holds: ["Alt"] },
  { keys: "Alt+click a pin", does: "take it out; the strings through it heal", holds: ["Alt"] },
  { keys: "Ctrl+Alt+click a string", does: "cut it — its pins stay", holds: ["Control", "Alt"] },
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
  { keys: "F", does: "frame what is selected" },
  { keys: "Ctrl+F", does: "find, and fly you there" },
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
  return {
    lead: status.unsaved ? `${UNSAVED_LINE} · ${lead}` : lead,
    warning: status.unsaved === true,
    rows: rows(hint),
  };
}
