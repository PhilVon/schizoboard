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
