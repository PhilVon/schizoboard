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
 * if it stayed. They also cannot share an element, because a board can perfectly
 * well be missing three photographs at the moment you copy an invite, and the
 * more important of those two sentences is the one that is still true.
 *
 * ## It cannot be clicked, for the usual reason
 *
 * `pointer-events: none`, like the notice, and load-bearing for the same
 * reason: the dev HUD and the hint line have each swallowed board presses, and
 * each cost a session to find, because a press that lands in an overlay looks
 * exactly like the application ignoring you. This one is worse than most if it
 * got that wrong — it appears under the cursor's general area moments after a
 * click, which is precisely when the next click is coming.
 *
 * Bottom right, the one corner nothing else uses: the notice is top left, the
 * dev HUD top right, the hint line bottom left.
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
    if (this.clearing !== null) clearTimeout(this.clearing);
    this.el.textContent = message;
    this.el.classList.add("is-live");
    this.clearing = setTimeout(() => {
      this.el.classList.remove("is-live");
      this.clearing = null;
    }, HOLD_MS);
  }

  destroy(): void {
    if (this.clearing !== null) clearTimeout(this.clearing);
    this.el.remove();
  }
}
