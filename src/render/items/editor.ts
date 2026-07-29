/**
 * Writing on a note: the caret, and the field it lives in.
 *
 * > Click into a note or a polaroid's caption area to edit. Type. Click away.
 * > — DESIGN section 3.6
 *
 * ## Inside `render/items/`, deliberately
 *
 * `view.ts` says it plainly: nothing crosses that seam that a Pixi
 * implementation could not satisfy, and "if it ever leaks an `HTMLElement`, the
 * escalation stops being one directory". A text caret is exactly the kind of
 * thing that would have leaked one. So the DOM layer owns its own field and the
 * seam carries `edit(itemId, text)` and two callbacks — which a Pixi renderer
 * would satisfy by overlaying a field of its own, since WebGL has no caret
 * either.
 *
 * ## A textarea, and why
 *
 * Q-93 settled that the paper is a fixed size and the text scrolls inside it
 * while it is being written on. A `<textarea>` gives that for nothing, and
 * three other things this would otherwise have to build: a caret, IME
 * composition, and a plain-string `value` that diffs exactly against the
 * `Y.Text` behind it (T-180). `contentEditable` normalises its own DOM
 * underneath the caret and would need all four rebuilt.
 *
 * The fourth thing it gives is the one that matters most. `state/input.ts`'s
 * `isTextTarget` — which every keyboard listener on the board already consults
 * — returns true for a focused textarea, so `Delete`, `Space`, `N`, `Ctrl+Z`
 * and the `1`-`9` slack presets all disarm themselves the moment the caret is
 * in a note. That predicate exists for this and has been waiting for it.
 *
 * ## Where the field is parked
 *
 * Inside the item's own DOM, as a sibling of the static text it stands in for
 * and wearing the same class. So it inherits the paper's hand, its metrics and
 * its stock rules — an index card's 40px left margin reaches the editor without
 * being restated — and the item's transform carries it, so there is no second
 * pose to keep in step.
 *
 * That is only safe because `DomItemLayer` re-parks it on every DOM phase.
 * These view nodes are pooled and recycled between items, and `bind()` rewrites
 * the static text on every document change; a field left to fend for itself
 * would be inherited by whichever note got the node next.
 */

/** What the layer's owner is told. Neither call may write the DOM. */
export interface ItemEditorHooks {
  /** The field's whole value, on every input event. */
  onInput(itemId: string, text: string): void;
  /** The caret has left the paper — blur, `Escape`, or the item going away. */
  onClosed(itemId: string): void;
}

export class TextEditor {
  readonly field: HTMLTextAreaElement;
  private editing: string | null = null;
  /** Set on open, spent in the DOM phase once the field is in the document. */
  private pendingFocus = false;
  private readonly hooks: ItemEditorHooks;
  private readonly onPointerDown: (e: Event) => void;

  constructor(hooks: ItemEditorHooks) {
    this.hooks = hooks;

    const field = document.createElement("textarea");
    // `item-field` is what the stylesheet addresses it by; the second class is
    // added when it is parked, and names the text it stands in for.
    field.className = "item-field";
    field.spellcheck = false;
    // A note is prose, not a form control: no autocapitalise, no autocorrect,
    // and nothing offering to complete it.
    field.autocapitalize = "off";
    field.autocomplete = "off";
    field.setAttribute("autocorrect", "off");
    field.rows = 1;

    field.addEventListener("blur", () => this.close());

    /**
     * "Click away" — DESIGN section 3.6's third sentence, and the one that does
     * not come free.
     *
     * A press somewhere else would ordinarily blur the field, and on this board
     * it does not: `state/tools/machine.ts` calls `preventDefault` on every
     * board `pointerdown`, deliberately, to keep the webview's own text
     * selection out of a drag — and the implicit focus change is one of the
     * defaults that suppresses. So clicking onto the cork left the caret in the
     * paper and the note lying flat, with nothing on screen to say why.
     *
     * Capture, on the window, so it is decided before the machine sees the
     * press and whatever the press turns out to mean. Anything inside the field
     * is the caret being moved and is not a click away.
     */
    this.onPointerDown = (e: Event) => {
      if (this.editing === null) return;
      const target = e.target as Node | null;
      if (target && this.field.contains(target)) return;
      this.close();
    };
    window.addEventListener("pointerdown", this.onPointerDown, true);
    field.addEventListener("input", () => {
      if (this.editing !== null) this.hooks.onInput(this.editing, field.value);
    });
    field.addEventListener("keydown", (e) => {
      /**
       * `Escape` means "done", not "undo".
       *
       * A text field usually reverts on escape, and that is the wrong verb
       * here: the edits are already in the document, character by character,
       * merged into entries by typing pause (T-180). There is nothing local to
       * throw away, and `Ctrl+Z` is what takes an edit back. What escape is for
       * is getting the caret out of the paper without having to find somewhere
       * else to click.
       */
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });

    this.field = field;
  }

  /** The item being written on, or null. */
  get itemId(): string | null {
    return this.editing;
  }

  /**
   * Start writing on `itemId`, with `text` as what is already on the paper.
   *
   * The caret goes to the end rather than to the character that was
   * double-clicked. Placing it under the pointer means asking the engine to hit
   * test the laid-out text, and every route to that answer —
   * `caretRangeFromPoint`, `caretPositionFromPoint` — forces synchronous
   * layout, which the frame loop forbids outright (ARCHITECTURE section 3).
   * Clicking again once the field is open places the caret natively and
   * exactly, so the fine-grained path is one click away rather than gone.
   */
  open(itemId: string, text: string): void {
    if (this.editing === itemId) return;
    this.editing = itemId;
    this.field.value = text;
    this.pendingFocus = true;
  }

  /** Give the paper back. Safe to call when nothing is open. */
  close(): void {
    const was = this.editing;
    if (was === null) return;
    // Cleared first: `close` is itself the blur handler, so the re-entry the
    // line below provokes has to find nothing left to do.
    this.editing = null;
    this.pendingFocus = false;
    if (document.activeElement === this.field) this.field.blur();
    this.hooks.onClosed(was);
  }

  /**
   * DOM phase (5), **after** the field has been parked on a view.
   *
   * Focus is a DOM write and belongs in the write phase, and it cannot happen
   * any earlier: focusing a node that is not in the document does nothing at
   * all, and does it silently.
   */
  focusParked(): void {
    if (!this.pendingFocus) return;
    if (!this.field.isConnected) return;
    this.pendingFocus = false;
    this.field.focus({ preventScroll: true });
    const end = this.field.value.length;
    this.field.setSelectionRange(end, end);
  }

  /** The window listener is the only thing here that outlives the field. */
  destroy(): void {
    this.close();
    window.removeEventListener("pointerdown", this.onPointerDown, true);
    this.field.remove();
  }
}
