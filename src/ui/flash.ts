/**
 * A line that says something happened, and then stops saying it.
 *
 * Built for the invite link (T-164), which is the first verb on this board with
 * no visible result. Everything else you can do to a corkboard shows on the
 * corkboard: a pin appears, a string moves, a photograph lands. Copying a link
 * puts something on the clipboard, which is not a place you can look at — so
 * without a word somewhere, picking *Copy invite link* and picking a row that
 * silently failed are the same experience.
 *
 * ## Not the notice, and not the hint
 *
 * `ui/notice.ts` is a standing statement — these photographs are missing, and
 * they will still be missing in a minute. This is the opposite: a thing that
 * just happened, which stops being true almost immediately and would be a lie
 * if it stayed. [`hold`] is the one exception and it proves the rule — it is
 * for something that is *still happening*, and it ends by being replaced with
 * the sentence saying it finished. They also cannot share an element, because a board can perfectly
 * well be missing three photographs at the moment you copy an invite, and the
 * more important of those two sentences is the one that is still true.
 *
 * ## It cannot be clicked, for the usual reason
 *
 * `pointer-events: none`, like the notice, and load-bearing for the same
 * reason: the dev HUD and the old hint line each swallowed board presses, and
 * each cost a session to find, because a press that lands in an overlay looks
 * exactly like the application ignoring you. Both are fixed — the hint line is
 * gone and the HUD was finally made inert in T-250, having been described as
 * inert here since before it was. This one is worse than most if it
 * got that wrong — it appears under the cursor's general area moments after a
 * click, which is precisely when the next click is coming.
 *
 * Bottom right, the one corner nothing else uses: the notice is top left, the
 * dev HUD top right, the tool info bar bottom left.
 */

/** How long a message stands before it fades. */
const HOLD_MS = 2400;

export class Flash {
  private readonly el: HTMLDivElement;
  /** The timer that will clear the current message, if one is up. */
  private clearing: ReturnType<typeof setTimeout> | null = null;

  constructor(host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "flash";
    // Announced rather than only drawn. A confirmation nobody can see is
    // exactly the case a screen reader user is in for every message here.
    this.el.setAttribute("role", "status");
    host.append(this.el);
  }

  /**
   * Say `message`, replacing whatever was up.
   *
   * Replacing rather than queueing: two messages in a row means the second is
   * the news, and a queue would make the board narrate its own recent history
   * at somebody who has moved on.
   */
  say(message: string): void {
    this.write(message);
    this.clearing = setTimeout(() => {
      this.el.classList.remove("is-live");
      this.clearing = null;
    }, HOLD_MS);
  }

  /**
   * Say `message` and keep saying it, until a [`say`] or a [`clear`].
   *
   * The one thing on this board that takes long enough to need it: an image
   * export of a large board is ninety seconds of a window that has zoomed
   * itself out to the whole board and gone quiet, and without a word somewhere
   * that is indistinguishable from having hung. Ordinary messages here are
   * things that *happened* and stop being true; this is a thing that is
   * happening and stays true until it stops.
   *
   * Same element, and deliberately: the sentence that follows a progress line
   * is the result of the same action, and a person who has been watching one
   * corner should not have to find another. It also means this inherits
   * `@media print`'s `display: none` — a progress line about making a file must
   * not appear *in* the file, and the PDF route prints the live document.
   */
  hold(message: string): void {
    this.write(message);
  }

  /** Take down a held message without putting anything in its place. */
  clear(): void {
    if (this.clearing !== null) clearTimeout(this.clearing);
    this.clearing = null;
    this.el.classList.remove("is-live");
    this.el.textContent = "";
  }

  private write(message: string): void {
    if (this.clearing !== null) clearTimeout(this.clearing);
    this.clearing = null;
    this.el.textContent = message;
    this.el.classList.add("is-live");
  }

  destroy(): void {
    if (this.clearing !== null) clearTimeout(this.clearing);
    this.el.remove();
  }
}
