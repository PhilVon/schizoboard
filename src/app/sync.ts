/**
 * What this client connects to, and who it says it is.
 *
 * `crdt/sync/` knows how to speak to a relay and `src-tauri/src/sync/` knows how
 * to be one. What was missing is the decision between them: which address, which
 * board, and whether to host or to dial. That decision is small, it has three
 * awkward cases, and none of them belong buried in `app/main.ts` — which is
 * wiring, and which nothing tests.
 *
 * ## The three cases
 *
 * **Hosting (`lan`).** The shell starts the embedded relay on loopback and port
 * zero, and reports back the address the operating system gave it (T-69). This
 * client then dials its own relay, which sounds redundant and is not: it is the
 * one configuration where the whole path — provider, socket, relay, room, and
 * back — is exercised by a single window.
 *
 * **Dialling (`relay`).** Somebody else is hosting. The address comes from
 * outside: from `?relay=` today, and from an invite link once T-70 lands (Q-59 —
 * a secret in the link, checked at connect).
 *
 * **Neither.** A plain browser, where `platform/mock.ts` refuses `syncStart`
 * outright. That is not a failure to report to the user; it is the fast dev loop
 * working as designed (`platform/tauri.ts`), and the board is simply local.
 *
 * ## Why `?relay=` and not a setting
 *
 * Because two windows on one board is the only way to see any of Phase 7 work,
 * and the browser is where two windows are cheap. `npm run dev`, a standalone
 * relay (`PORT=1234 cargo run --bin relay` in `src-tauri/`), and two tabs on
 * `?relay=ws://127.0.0.1:1234&board=demo` is a real two-peer board in about
 * fifteen seconds. A settings panel would be a nicer answer to a question nobody
 * has asked yet.
 */

import { STRING_COLORS } from "@/lib/palette";
import type { Platform, SyncConfig } from "@/platform/types";

/**
 * What a board may be called.
 *
 * The same rule the relay enforces on its side (`src-tauri/src/sync/mod.rs`,
 * `room_name`), and for the same reason: the name keys a map that lives as long
 * as the relay process, and it arrives from outside. Checking it here as well is
 * not redundant — it turns "the socket closed and nobody said why" into a
 * message at the point the name was chosen.
 */
const BOARD_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** What a board is called when nobody said. Matches the relay's own default. */
const DEFAULT_BOARD = "board";

export interface SyncPlan {
  config: SyncConfig;
  /** Anything wrong with what was asked for, in words. Null when it was fine. */
  complaint: string | null;
}

/**
 * Read the plan out of a query string.
 *
 * Never throws and never returns nothing: a query nobody wrote is the ordinary
 * case (host on loopback, board `board`), and a query somebody got wrong falls
 * back to the same thing with a complaint attached, because a typo in an address
 * should not be the difference between a board that opens and one that does not.
 */
export function planSync(search: string): SyncPlan {
  const params = new URLSearchParams(search);
  const complaints: string[] = [];

  const asked = params.get("board");
  let boardId = DEFAULT_BOARD;
  if (asked !== null) {
    if (BOARD_NAME.test(asked)) boardId = asked;
    else complaints.push(`board name ${JSON.stringify(asked)} is not [A-Za-z0-9_-]{1,64}`);
  }

  const relay = params.get("relay");
  if (relay === null) {
    return { config: { mode: "lan", boardId }, complaint: complaints[0] ?? null };
  }

  const url = relayUrl(relay, boardId);
  if (url === null) {
    complaints.push(`${JSON.stringify(relay)} is not a ws:// or wss:// address`);
    return { config: { mode: "lan", boardId }, complaint: complaints.join("; ") };
  }
  // The board is on the end of the address in relay mode, because `sync_status`
  // hands back this exact string as the one to dial and "nothing else has to know
  // how a relay URL is spelled".
  return { config: { mode: "relay", url, boardId }, complaint: complaints[0] ?? null };
}

/**
 * `ws://host:port` plus the board, from whatever shorthand was given.
 *
 * A bare port is allowed because typing one into two address bars is the whole
 * point of the parameter. Anything that is not a WebSocket scheme is refused
 * rather than coerced: `http://` would connect to something, and what it
 * connected to would not be a relay.
 */
function relayUrl(asked: string, boardId: string): string | null {
  const bare = /^[0-9]{1,5}$/.test(asked) ? `ws://127.0.0.1:${asked}` : asked;
  let parsed: URL;
  try {
    parsed = new URL(bare);
  } catch {
    return null;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  // A path already on the address is somebody naming the room themselves, and
  // that beats a default appended behind their back.
  return path === "" ? `${parsed.origin}/${boardId}` : `${parsed.origin}${path}`;
}

/**
 * The address to dial, telling the shell what it needs to know on the way.
 *
 * The two modes need opposite things from the platform, and that asymmetry is
 * the whole function:
 *
 * **Hosting.** Only the shell knows the address, because the relay binds port
 * zero and is told what it got (T-69). So `syncStatus` is the answer, and a
 * platform that cannot host has no answer — which under `platform/mock.ts` is
 * every plain browser, and is a local board rather than a broken one.
 *
 * **Dialling.** The address came from outside and is already in hand. The
 * platform is being *informed*, not asked: it keeps the mode and the board for
 * its own peer bookkeeping and for `sync:peer-joined`. So a platform that refuses
 * is not an obstacle — the browser is exactly where two windows on one relay is
 * cheap, and refusing to connect there would make `?relay=` useless in the one
 * place it is for.
 */
export async function dialAddress(native: Platform, config: SyncConfig): Promise<string | null> {
  try {
    await native.syncStart(config);
  } catch (error) {
    // Under the shell this is the relay failing to bind; under the mock it is
    // `Sync is not available`. Only the first matters, and only in `lan` mode,
    // where it is the difference between an address and none.
    if (config.mode === "lan") {
      console.warn("[sync] could not host", error);
      return null;
    }
  }
  if (config.mode === "relay") return config.url ?? null;
  return (await native.syncStatus()).url;
}

/**
 * Who this client is, to everybody else.
 *
 * Derived from the Yjs client id rather than asked for, because there is nowhere
 * to ask: no name is stored, no settings panel exists, and a modal on first
 * launch is a product decision nobody has made. What matters for now is that two
 * windows are visibly two people — a different colour each and a name that is
 * not the other one's — and a client id is already unique and already agreed.
 *
 * The colour comes from the string palette (`lib/palette.ts`) because those six
 * were chosen to be told apart on cork, which is exactly the requirement, and
 * white is skipped: a white cursor on a pale note is not a cursor.
 */
export function identityFor(clientId: number): { id: string; name: string; color: string } {
  const usable = STRING_COLORS.filter((entry) => entry.label !== "White");
  const index = Math.abs(clientId) % usable.length;
  return {
    id: String(clientId),
    name: `${usable[index]!.label} peer`,
    color: usable[index]!.hex,
  };
}
