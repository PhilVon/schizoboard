/**
 * The invite link — how a second person ever gets the secret.
 *
 * > `deep-link` (for `schizo://` invites) — docs/ARCHITECTURE.md section 5.1
 *
 * T-70 built the secret and the check at the door. Nothing delivered one: the
 * only way to hand a board's secret to somebody else was `?secret=` on the URL,
 * which in a packaged application is a place nobody can type. So LAN discovery
 * worked and was, for a real user, unreachable. This is the delivery.
 *
 * ## What a link carries, and what it deliberately does not
 *
 * ```
 * schizo://join?board=demo&secret=8f14e45fceea167a5a36dedd4bea2543
 * ```
 *
 * A board name and a secret, and no address at all. That is not an omission —
 * it is the whole reason a link works. The two peers find each other over mDNS,
 * and `sync/discovery.rs`'s `is_joinable` matches on exactly these two things:
 * the board name, and a fingerprint of the secret. Neither is a location. So an
 * invite survives the host moving off the dock and onto wifi, restarting on a
 * different port, or rebooting — none of which an address in the link would have
 * survived, and every one of which is an ordinary afternoon.
 *
 * It also means an invite is not a capability to reach *this machine*. It is a
 * capability to join a board, wherever that board turns out to be, which is the
 * honest description of what the secret already was.
 *
 * `relay=` is accepted when it is there, for the case mDNS cannot serve — two
 * people not on one network, which is section 5.1's relay mode. Nothing produces
 * such a link yet, because nothing yet runs a relay for anybody to point at.
 *
 * ## Why this is barely any code
 *
 * Because an invite carries the same three parameters `planSync` already reads
 * off the address bar, and means the same thing by all three. So a link is
 * parsed by handing its query string to the function that has read `?board=`,
 * `?secret=` and `?relay=` since T-69 — which is not a shortcut but the actual
 * claim being made: **an invite link is the address bar, for a shell that has no
 * address bar.** Every rule about what a board may be called and what a secret
 * must look like is inherited rather than restated, and the failure modes are
 * the ones `sync.test.ts` already covers.
 */

import { isBoardName, isSecret, planSync, type SyncPlan } from "@/app/sync";

/** The scheme registered with the operating system (`src-tauri/src/lib.rs`). */
export const INVITE_SCHEME = "schizo:";

/**
 * The verb, and the reason there is one at all.
 *
 * A link is `schizo://join?…` rather than `schizo://?…` so that a later verb —
 * `schizo://open`, say — is an addition rather than a breaking change to the
 * shape everybody's chat history is already full of. Costs four characters now
 * and buys the option later.
 */
const JOIN = "join";

export interface Invite {
  boardId: string;
  secret: string;
  /** Where to dial, for a board mDNS cannot find. Usually absent — see above. */
  relay?: string;
}

/**
 * A link somebody can paste into a message, or `null` if there is nothing
 * honest to make one from.
 *
 * Null rather than a link with a hole in it, because the two ways this fails are
 * both cases where a link would be worse than no link: a board with no secret is
 * not one anybody can join, and a name or secret that fails the rules here would
 * be refused by the receiving end anyway — after the recipient had clicked it,
 * which is the worst possible moment to find out.
 */
export function formatInvite(invite: Invite): string | null {
  if (!isBoardName(invite.boardId) || !isSecret(invite.secret)) return null;

  const params = new URLSearchParams({ board: invite.boardId, secret: invite.secret });
  if (invite.relay !== undefined) params.set("relay", invite.relay);
  return `${INVITE_SCHEME}//${JOIN}?${params.toString()}`;
}

/**
 * Read a link, or `null` when it is not one of ours at all.
 *
 * The two answers are different questions, and keeping them apart is what makes
 * this usable at the point a link arrives:
 *
 * - **`null`** — not an invite. Some other scheme, or not a URL. The caller
 *   should do nothing at all; there is nothing to tell the user, because the
 *   user did not ask for anything.
 * - **a plan with a `complaint`** — an invite, and something in it is wrong. The
 *   board still opens, locally, and the complaint says why nobody joined it.
 *   That is `planSync`'s rule and it is the right one here too: a mistyped
 *   secret should not be the difference between a board and a blank window.
 *
 * A link with no secret in it parses fine and joins nothing, which is correct
 * rather than lenient — `planSync` treats an absent secret as "this peer is
 * opening the board", so `schizo://join?board=demo` opens a board called `demo`
 * with a secret of its own. That is what the words say, and it is not a way to
 * get into somebody else's board of the same name: their advertisement carries a
 * fingerprint of *their* secret, and `is_joinable` will not match it.
 */
export function parseInvite(link: string): SyncPlan | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== INVITE_SCHEME) return null;

  // Both spellings, because both get written. `schizo://join?x` puts the verb in
  // the host and `schizo:join?x` puts it in the path — the difference is whether
  // whoever typed it thought of the scheme as having an authority, and no user
  // should ever have to know. An empty verb is allowed for the same reason:
  // `schizo://?board=…` is plainly an invite, and refusing it would be pedantry
  // charged to somebody who did nothing wrong.
  const verb = url.host !== "" ? url.host : url.pathname.replace(/^\/+/, "");
  if (verb !== JOIN && verb !== "") return null;

  return planSync(url.search);
}
