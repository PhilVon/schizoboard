/**
 * Local preferences — the things that are true of this *machine* rather than of
 * the board.
 *
 * The first of them is the reason the file exists:
 *
 * > Ageing can be turned off entirely for anyone who finds it precious.
 * > — DESIGN section 4.7
 *
 * "Anyone", singular, is the whole of the argument for this not being a document
 * field. Two people on one board can disagree about whether they want to watch
 * their paper go brown, and neither of them is wrong; a `meta` flag would let one
 * of them decide for the other, and would put a taste in the CRDT where every
 * other thing is a fact about what is on the cork. DATA-MODEL section 10 already
 * draws that line for asset transfer state, and this is on the same side of it.
 *
 * `localStorage` and not the Tauri store, because a preference that failed to
 * load must not hold up the board — and because this has to work in a plain
 * browser, which is where most of this application is developed. Everything here
 * is wrapped: storage throws in a webview with site data disabled, and a board
 * that refused to open because it could not read a checkbox would be an absurd
 * way to lose.
 */

const AGEING = "schizo.ageing";
const TOOLBAR = "schizo.toolbar";
const TIMER_FLIGHT = "schizo.timerflight";
const CHIME = "schizo.chime";

/**
 * Whether items age (DESIGN section 4.7).
 *
 * Defaults to on, and to on again if the value is unreadable or is anything
 * other than the one string that means off. Ageing is the intended look of the
 * application, so every failure here leans toward showing it — the alternative
 * is a board that quietly stops ageing on a machine with strict storage
 * settings, which is a bug nobody would ever think to report.
 */
export function ageing(): boolean {
  try {
    return localStorage.getItem(AGEING) !== "off";
  } catch {
    return true;
  }
}

export function setAgeing(on: boolean): void {
  try {
    if (on) localStorage.removeItem(AGEING);
    else localStorage.setItem(AGEING, "off");
  } catch {
    // Nothing to do and nothing to say. The setting holds for this session
    // either way — the caller has already switched the clock over — and all that
    // is lost is remembering it next time.
  }
}

/**
 * Whether the tool drawer is open (`ui/toolbar.ts`).
 *
 * The same shape as [`ageing`] and for the same reason, which is the whole of
 * why this file has a convention rather than two functions: the default is
 * stored as **absence**, so an unreadable store — or a first run, or a machine
 * with site data switched off — gives you the tools rather than hiding them.
 * D-44 chose open-by-default because discovery is the entire point of the rail;
 * a drawer that came back shut on a storage error would leave the seven tools
 * on the keyboard exactly as they were before it existed, and nobody would
 * think to report it.
 */
export function toolbar(): boolean {
  try {
    return localStorage.getItem(TOOLBAR) !== "closed";
  } catch {
    return true;
  }
}

export function setToolbar(open: boolean): void {
  try {
    if (open) localStorage.removeItem(TOOLBAR);
    else localStorage.setItem(TOOLBAR, "closed");
  } catch {
    // As above. The drawer is already shut on screen; what is lost is it being
    // shut next time.
  }
}

/**
 * Whether a countdown going off carries *your* camera to it (T-399).
 *
 * Local for the reason at the top of this file, and the timer is the sharpest
 * case of it yet: what a timer lights is written down and both people see it,
 * because that is a fact about the board, while being taken there is a thing
 * done to one person's screen. Somebody watching a countdown wants the trip;
 * somebody working at the other end of the board while a colleague's kitchen
 * timer runs out very much does not, and neither of them is wrong.
 *
 * ## It is the one preference here stored as *presence*, and deliberately
 *
 * Ageing and the drawer both store their default as **absence**, so a machine
 * with site data switched off gets the intended look. This one defaults to
 * **off**, so the same reasoning inverts: the failure to read a preference must
 * not move somebody's camera. A board that quietly stopped ageing is a bug
 * nobody reports; a board that quietly flies away from what you are doing is one
 * you would report immediately, and it would be this line that did it.
 *
 * So the comparison is `=== "on"` rather than `!== "off"`, and every way of
 * failing — unreadable store, first run, a value some other build wrote — lands
 * on the camera staying where the hand left it.
 */
export function timerFlight(): boolean {
  try {
    return localStorage.getItem(TIMER_FLIGHT) === "on";
  } catch {
    return false;
  }
}

export function setTimerFlight(on: boolean): void {
  try {
    if (on) localStorage.setItem(TIMER_FLIGHT, "on");
    else localStorage.removeItem(TIMER_FLIGHT);
  } catch {
    // As above, and with less to lose than either: the switch holds for this
    // session, and a timer going off is the kind of thing you are present for.
  }
}

/**
 * Whether a timer that goes off makes a sound (`ui/chime.ts`, T-406).
 *
 * ## Stored as absence, on the *opposite* side of the line to `timerFlight`
 *
 * Those two sit next to each other in the menu and store their default in
 * opposite ways, so the reason is worth writing down rather than leaving as an
 * inconsistency for somebody to tidy into a bug.
 *
 * A flight **moves your camera**, which is an intrusion into what you were
 * doing, so it defaults off and every failure to read a preference leaves the
 * camera alone. A chime interrupts nothing: it announces, exactly as the flash
 * line does, and the flash line is not a preference at all. What it is for is
 * the case where nobody is looking at the screen — which is most of why anybody
 * sets a kitchen timer — so a machine with site data switched off should still
 * ring. This is `ageing`'s rule, and for `ageing`'s reason: the failure leans
 * toward the application behaving as intended.
 *
 * The cost of being wrong is also asymmetric, and points the same way. A board
 * that quietly stopped flying is a preference that did not stick; a board that
 * quietly stopped ringing is a timer that does not work, and the person finds
 * out by missing something.
 */
export function chime(): boolean {
  try {
    return localStorage.getItem(CHIME) !== "off";
  } catch {
    return true;
  }
}

export function setChime(on: boolean): void {
  try {
    if (on) localStorage.removeItem(CHIME);
    else localStorage.setItem(CHIME, "off");
  } catch {
    // Nothing to do and nothing to say — `setAgeing`'s note, and the switch
    // holds for this session either way.
  }
}
