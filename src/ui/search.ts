/**
 * The one box on this board you can type into that is not a note.
 *
 * > Search · `Ctrl+F` — flies the camera to a match. **Never filters or hides.**
 * > — DESIGN section 3.7
 *
 * Top centre, which is the last free corner-ish position in the UI layer: the
 * missing-photo notice has top left, the dev HUD top right, the tool info bar
 * bottom left and the transient confirmation bottom right (`ui/notice.ts`,
 * `ui/hud.ts`, `ui/toolinfo.ts`, `ui/flash.ts`). The tool drawer has the left
 * edge between the first and the third. Centre because a search is a thing you asked
 * for and is looking back at you, unlike all four of those, which are the board
 * telling you something while you get on with something else.
 *
 * ## It is the first surface here that wants the keyboard, and that is free
 *
 * Every other panel is `pointer-events: none` on purpose, because two pieces of
 * chrome on this board have already eaten board presses and each cost a session
 * to find. This one has to take clicks and keys, and the interesting part is
 * what that gets right *by accident of an existing rule*: `isTextTarget`
 * (`state/input.ts`) is what makes a note's editor swallow board input, and it
 * is true of any `<input>`. So while this field has focus, `Delete` does not
 * clear the board, `E` does not arm the eraser, `V` does not switch tool and
 * `Ctrl+Z` undoes your typing rather than your last pin. Nothing had to be
 * disarmed; the rule that already existed covers it.
 *
 * The two exceptions are deliberate and both are elsewhere. `Navigation`
 * (`state/navigation.ts`) lets the zoom shortcuts through while you type,
 * because nobody types `Ctrl+0` into a sentence. And `Ctrl+F` itself is handled
 * *before* the text-target bail in `app/main.ts`, or it could never be pressed
 * from inside its own box.
 *
 * ## What it does not do
 *
 * It does not filter, sort, hide, dim, or list. The count is a readout and not
 * a set of results you can click: a list of matches is a view of the board that
 * is not the board, which is the thing DESIGN section 2.5 rules out. What it
 * says is "3 of 7", and the answer to "which 7" is: fly through them.
 */

/**
 * How much of what matched cannot be searched — T-286, Q-273, D-46 section 5.
 *
 * A scanned page is an image of paper. It has no text, there is no OCR, and
 * there will not be one, so it can never match anything — which makes a search
 * over a board of court filings quietly narrower than it looks. The counts are
 * **of the folders that did match**, not of the board: Q-273 chose to say this
 * only where it bears on the answer in front of you, rather than to carry a
 * standing warning about filings the query has nothing to do with.
 */
export interface Unsearched {
  /** Matched folders with nothing readable in them at all. */
  readonly whole: number;
  /** Matched folders with some pages readable and some not. */
  readonly part: number;
}

const NOTHING_UNSEARCHED: Unsearched = { whole: 0, part: 0 };

/** What the field reports upward. All three are plain intents; this module
 *  knows nothing about the scene, the camera or the flight. */
export interface SearchHandlers {
  /** The text changed. Fired on every keystroke, including back to empty. */
  typed: (query: string) => void;
  /** `Enter` / `Shift+Enter` — one match forward or back. */
  stepped: (delta: number) => void;
  /** `Escape`, or the field being closed any other way. */
  closed: () => void;
}

export class SearchField {
  private readonly el: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLSpanElement;
  /** What the count currently reads, so an unchanged one writes no DOM. */
  private written = "";

  constructor(host: HTMLElement, handlers: SearchHandlers) {
    this.el = document.createElement("div");
    this.el.className = "search";

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "search-input";
    this.input.placeholder = "find on the board";
    // Not the browser's idea of a search box: `type="search"` grows a clear
    // affordance whose size and behaviour are the platform's, and this one has
    // to sit in a paper-coloured strip the same height as everything else here.
    this.input.setAttribute("aria-label", "Find on the board");
    // Chromium will otherwise offer whatever else has been typed into a text
    // input on this origin, which on a board application is somebody's note.
    this.input.autocomplete = "off";
    this.input.spellcheck = false;

    this.count = document.createElement("span");
    this.count.className = "search-count";
    // Announced, because the whole answer to "did that find anything" is in
    // this one span — the rest of the feedback is the camera moving.
    this.count.setAttribute("role", "status");

    this.el.append(this.input, this.count);
    host.append(this.el);

    this.input.addEventListener("input", () => handlers.typed(this.input.value));

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        // Stopped here rather than let through: `Escape` also ends a string run
        // and clears a selection, and closing the field is the only thing it
        // should mean while the field is the thing you are looking at.
        e.preventDefault();
        e.stopPropagation();
        this.close();
        handlers.closed();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        handlers.stepped(e.shiftKey ? -1 : 1);
      }
    });
  }

  get isOpen(): boolean {
    return this.el.classList.contains("is-live");
  }

  get value(): string {
    return this.input.value;
  }

  /**
   * Show the field and take the keyboard.
   *
   * Already open, this **selects** what is in it rather than clearing it. That
   * is the find-in-page convention and it is the right one here for a reason
   * particular to this board: the query you last searched for is usually the
   * one you want again, and the camera is somewhere in the middle of its
   * matches. Typing replaces it; `Enter` steps on from where you are.
   */
  open(): void {
    this.el.classList.add("is-live");
    this.input.focus();
    this.input.select();
  }

  /** Hide it and give the keyboard back to the board. */
  close(): void {
    if (!this.isOpen) return;
    this.el.classList.remove("is-live");
    // Explicitly, rather than relying on the element going away: a hidden input
    // that still has focus leaves every board shortcut disarmed with nothing on
    // screen to explain why, which is the worst failure this feature has
    // available to it.
    this.input.blur();
  }

  /**
   * Write the readout: "3 of 7", or that there is nothing — and what of it
   * could not be looked inside.
   *
   * Blank rather than "0 of 0" for an empty query — a field you have just
   * opened has not failed to find anything, it has not been asked yet, and a
   * zero sitting there reads as the former.
   *
   * The second clause is the honesty D-46 section 5 asks for by name: "the
   * search field should say so rather than letting a silent miss read as a
   * failure to find". It is one short clause after a middle dot on the same
   * line, because a second line would move the count off the strip and this is
   * a footnote to the number rather than a message of its own.
   */
  report(ordinal: number, total: number, unsearched: Unsearched = NOTHING_UNSEARCHED): void {
    const found = total === 0 ? "none" : `${ordinal} of ${total}`;
    const text = this.input.value.trim() === "" ? "" : found + aside(unsearched);
    if (text === this.written) return;
    this.written = text;
    this.count.textContent = text;
    this.count.classList.toggle("is-none", total === 0 && text !== "");
  }

  destroy(): void {
    this.el.remove();
  }
}

/**
 * The clause about what could not be looked inside, or nothing at all.
 *
 * Three sentences rather than one with a number in it, because a folder of
 * photographs of paper and a typed filing with two exhibits behind it are
 * different facts and only one of them is *part*-anything. The mixed case says
 * the weaker thing about both, which is true of both: there are pages in there
 * nobody read.
 *
 * "Folder" rather than "document" or "case file": it is the word the object on
 * the cork is drawn as, and the only one somebody can point at.
 */
function aside({ whole, part }: Unsearched): string {
  if (whole === 0 && part === 0) return "";
  if (whole > 0 && part > 0) return ` · ${whole + part} folders with unread pages`;
  if (whole > 0) return ` · ${whole} ${folders(whole)} not searchable`;
  return ` · ${part} ${folders(part)} part-scanned`;
}

function folders(n: number): string {
  return n === 1 ? "folder" : "folders";
}
