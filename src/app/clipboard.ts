/**
 * The board's own clipboard — `Ctrl+C`, `Ctrl+X` and `Ctrl+D` (DESIGN section
 * 3.9, Q-162).
 *
 * ## Why the payload never leaves the process
 *
 * > B — an internal board clipboard. — Q-162
 *
 * A note is a piece of paper with a seed, a style map, pins pushed through it,
 * ink drawn on it and possibly a string tying it to the note beside it. There is
 * no clipboard format that carries that, so putting it on the *system*
 * clipboard would mean inventing a serialisation, versioning it, and then
 * defending the board against whatever a hostile page could put in one. The
 * clip stays in memory, as the plain data `crdt/ops/clip.ts` already lifts out.
 *
 * ## But the system clipboard still decides *when*
 *
 * Which leaves the question the shape decision does not answer: `Ctrl+V` is not
 * a keybinding on this board at all. Paste is the DOM `paste` event, and it
 * means *read the system clipboard* — so on a board that has copied something,
 * a paste has two possible answers and no way to tell which the person meant.
 *
 * Recency is what they mean, and recency is exactly what the system clipboard
 * knows. So a copy here writes **a token and no payload**: a fresh id under a
 * MIME type of ours, which the paste event hands back only if nothing else has
 * been copied anywhere on the machine since. Copy two notes, go to a browser,
 * copy a photograph, come back and paste — the token is gone with the rest of
 * the clipboard, and the photograph wins, because it is what you copied last.
 * No permissions, no async read, nothing to keep in sync.
 *
 * Measured in WebView2 before it was designed on: the `copy` event fires with no
 * DOM selection at all, and a custom MIME type set on it comes back intact
 * through the system clipboard on the next `paste`.
 *
 * The text goes on beside the token, because a copy that made the clipboard
 * useless everywhere else would be a strange thing to do to somebody's machine
 * — so copying three notes and pasting into an editor gives you the three
 * sentences. It is also what a *second window* of this application gets, which
 * is honest: the paper is not on the clipboard, only what it said.
 */

import { pasteClip, copySubgraph, type BoardClip, type PastedClip } from "@/crdt/ops";
import { boardSealed, type BoardDoc } from "@/crdt/doc";
import { newId } from "@/lib/ids";
import type { Camera } from "@/state/camera";
import { eraseSelection } from "@/state/erase";
import { isTextTarget } from "@/state/input";
import type { Scene } from "@/state/scene";
import type { Selection } from "@/state/selection";
import type { BoardWriter } from "@/state/tools/tool";

/**
 * Ours, on the system clipboard. A custom type rather than a marker inside the
 * text: the text is for other applications and must not have our bookkeeping in
 * it, and a person who copies the same sentence out of a text editor must not
 * have it mistaken for this board's paper.
 */
const CLIP_MIME = "application/x-schizoboard-clip";

/**
 * How far a duplicate lands from the thing it duplicates, in board units.
 *
 * Down and to the right, the direction the light does not come from (DESIGN
 * section 4.1) — so the copy's shadow falls across the original rather than the
 * other way round, and the pile reads as a copy on top rather than as one sheet
 * drawn twice. Small enough that the two are obviously the same thing and large
 * enough that the edge, the pin and the shadow are all visible.
 */
const DUPLICATE_OFFSET = 28;

export interface BoardClipboardOptions {
  board: BoardDoc;
  camera: Camera;
  selection: Selection;
  scene: Scene;
  write: BoardWriter;
  /** Last known cursor in screen space, or null when the pointer is not over
   *  the board — the same source `Paste` uses, for the same reason. */
  cursor: () => { x: number; y: number } | null;
  /** Everything a paste or a duplicate created. */
  onPasted?: (pasted: PastedClip) => void;
  /** Where a verb with no visible result says it happened (T-164). */
  say?: (message: string) => void;
}

export class BoardClipboard {
  private readonly options: BoardClipboardOptions;
  private readonly disposers: (() => void)[] = [];
  private clip: BoardClip | null = null;
  /** The id this clip was announced to the system clipboard under. */
  private token: string | null = null;

  constructor(options: BoardClipboardOptions) {
    this.options = options;
  }

  attach(): void {
    const onCopy = (e: ClipboardEvent): void => this.onCopy(e, false);
    const onCut = (e: ClipboardEvent): void => this.onCopy(e, true);
    // Capture, like the paste listener, so a clipboard event on any part of the
    // page is this board's unless a text field claimed it first.
    window.addEventListener("copy", onCopy, true);
    window.addEventListener("cut", onCut, true);
    this.disposers.push(() => window.removeEventListener("copy", onCopy, true));
    this.disposers.push(() => window.removeEventListener("cut", onCut, true));
  }

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  /**
   * Does this paste belong to the board clipboard?
   *
   * Asked by `Paste` before it looks at the clipboard's contents, and true means
   * it has already been dealt with. An explicit question rather than a second
   * `paste` listener racing the first: two listeners on one event deciding the
   * same thing independently is a truce that holds only as long as nobody
   * changes the order they were registered in.
   */
  claim(data: DataTransfer | null, at: { x: number; y: number }): boolean {
    if (this.clip === null || this.token === null) return false;
    if (data?.getData(CLIP_MIME) !== this.token) return false;
    this.put(this.clip, at);
    return true;
  }

  /**
   * `Ctrl+D` — a copy and a paste with no clipboard in between, so the system
   * clipboard is left exactly as it was found. Duplicating something is not a
   * statement about what you want to paste next.
   */
  duplicate(): void {
    const clip = copySubgraph(this.options.board, this.options.selection.snapshot());
    if (clip === null) return;
    this.put(clip, {
      x: clip.anchor.x + DUPLICATE_OFFSET,
      y: clip.anchor.y + DUPLICATE_OFFSET,
    });
  }

  private onCopy(event: ClipboardEvent, cut: boolean): void {
    // Inside a note's editor the clipboard belongs to the text, exactly as it
    // does for `Ctrl+Z` (`app/main.ts`).
    if (isTextTarget(event.target)) return;
    const clip = copySubgraph(this.options.board, this.options.selection.snapshot());
    // Nothing selected. Not our event — leave the clipboard alone rather than
    // emptying it, because a copy that clears what you had is worse than one
    // that does nothing.
    if (clip === null) return;

    const data = event.clipboardData;
    if (data === null) return;
    this.clip = clip;
    this.token = newId();
    data.setData(CLIP_MIME, this.token);
    data.setData("text/plain", plainText(clip));
    // Ours now: without this the webview writes its own idea of the copy over
    // the top, which for a page with no selection is nothing at all.
    event.preventDefault();

    /**
     * On a board this build may not write to (T-224), a cut is a copy.
     *
     * The copy half is a read and stays: taking a piece of a board you cannot
     * edit and putting it somewhere you can is the one thing read-only is for.
     * Only the delete is refused, and the flash says *Copied* rather than
     * *Cut*, because a message naming the half that did not happen is worse
     * than the one that did.
     */
    const taken = cut && !boardSealed(this.options.board);
    if (taken) eraseSelection({ ...this.options });
    this.options.say?.(said(clip, taken ? "Cut" : "Copied"));
  }

  private put(clip: BoardClip, at: { x: number; y: number }): void {
    // `claim` and `duplicate` are the two ways in, and a sealed board refuses
    // both — this is the join rather than each of them.
    if (boardSealed(this.options.board)) return;
    const pasted = pasteClip(this.options.board, clip, at);
    this.options.onPasted?.(pasted);
  }
}

/**
 * What the rest of the machine gets. Blank lines between, because two notes are
 * two things and a reader outside this application has nothing else to tell them
 * apart by.
 *
 * Empty when nothing copied had any words in it — a photograph has no text, and
 * inventing "3 items" would put a sentence nobody wrote onto the clipboard.
 */
function plainText(clip: BoardClip): string {
  return clip.items
    .map((item) => item.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** "Copied 3 notes and a string." — the flash, since copying is the second verb
 *  on this board that changes nothing you can see. */
function said(clip: BoardClip, verb: string): string {
  const parts: string[] = [];
  if (clip.items.length > 0) parts.push(count(clip.items.length, "item"));
  const free = clip.pins.filter((pin) => pin.parent === null).length;
  if (free > 0) parts.push(count(free, "pin"));
  if (clip.strings.length > 0) parts.push(count(clip.strings.length, "string"));
  return `${verb} ${join(parts)}`;
}

function count(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? "" : "s"}`;
}

function join(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "nothing";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
