/**
 * The invite link.
 *
 * Every case here is a link that somebody was sent and clicked, which is the
 * reason the failure modes matter more than the happy path: the person holding a
 * broken invite did not make it, cannot see what is wrong with it, and has no
 * address bar to work around it with. So the rule throughout is `planSync`'s —
 * a board always opens, and anything wrong arrives as words rather than as
 * silence.
 */

import { describe, expect, it } from "vitest";

import { formatInvite, INVITE_SCHEME, inviteSearch, openingPlan, parseInvite } from "@/app/invite";
import { planSync } from "@/app/sync";

const SECRET = "8f14e45fceea167a5a36dedd4bea2543";

describe("making an invite", () => {
  it("carries the board and the secret, and no address", () => {
    // No address on purpose: mDNS matches on the board name and a fingerprint of
    // the secret, so a link survives the host changing port or network.
    expect(formatInvite({ boardId: "demo", secret: SECRET })).toBe(
      `schizo://join?board=demo&secret=${SECRET}`,
    );
  });

  it("carries a relay when there is one, for a board mDNS cannot reach", () => {
    const link = formatInvite({ boardId: "demo", secret: SECRET, relay: "wss://relay.example" });
    expect(link).toContain("relay=wss%3A%2F%2Frelay.example");
  });

  it("makes no link at all rather than one with a hole in it", () => {
    // Both of these would be refused at the far end — after the recipient had
    // clicked, which is the worst moment to find out.
    expect(formatInvite({ boardId: "demo", secret: "nope" })).toBeNull();
    expect(formatInvite({ boardId: "not a board", secret: SECRET })).toBeNull();
    expect(formatInvite({ boardId: "", secret: SECRET })).toBeNull();
  });
});

describe("reading an invite", () => {
  it("comes back as the plan it went out as", () => {
    const link = formatInvite({ boardId: "demo", secret: SECRET });
    expect(parseInvite(link!)).toEqual({
      config: { mode: "lan", boardId: "demo", secret: SECRET },
      complaint: null,
    });
  });

  it("asks to host rather than to dial, because there is nobody to dial", () => {
    // The invited peer hosts its own relay and advertises a fingerprint of the
    // secret; the two find each other. `relay` mode would need an address, and
    // the whole point is that the link does not carry one.
    expect(parseInvite(`${INVITE_SCHEME}//join?board=demo&secret=${SECRET}`)?.config.mode).toBe(
      "lan",
    );
  });

  it("dials when the link says where, for two people not on one network", () => {
    const plan = parseInvite(`schizo://join?board=demo&secret=${SECRET}&relay=wss://relay.example`);
    expect(plan?.config).toEqual({
      mode: "relay",
      url: `wss://relay.example/demo?token=${SECRET}`,
      boardId: "demo",
      secret: SECRET,
    });
  });

  it("takes the scheme spelled with an authority or without one", () => {
    // Nobody should have to know whether `schizo:` has a host. Both get typed.
    const withHost = parseInvite(`schizo://join?board=demo&secret=${SECRET}`);
    const without = parseInvite(`schizo:join?board=demo&secret=${SECRET}`);
    const bare = parseInvite(`schizo://?board=demo&secret=${SECRET}`);
    expect(without).toEqual(withHost);
    expect(bare).toEqual(withHost);
  });

  it("survives the whitespace a chat client wraps a link in", () => {
    expect(parseInvite(`  schizo://join?board=demo&secret=${SECRET}\n`)).toEqual(
      parseInvite(`schizo://join?board=demo&secret=${SECRET}`),
    );
  });

  it("is not ours, and says nothing, when the scheme is somebody else's", () => {
    // Null rather than a complaint: the user did not ask for anything, so there
    // is nothing to tell them.
    expect(parseInvite("https://example.com/?board=demo")).toBeNull();
    expect(parseInvite("mailto:someone@example.com")).toBeNull();
    expect(parseInvite("not a url at all")).toBeNull();
    expect(parseInvite("")).toBeNull();
  });

  it("is not ours when the verb is one we do not have", () => {
    // So that adding `schizo://open` later is an addition rather than a change
    // to what every existing link already means.
    expect(parseInvite(`schizo://wipe?board=demo&secret=${SECRET}`)).toBeNull();
  });

  it("opens the board anyway when the secret is mistyped, and says why", () => {
    // The person holding this cannot see what is wrong with it and has no
    // address bar to work around it with, so a blank window would be the end of
    // the road. A board that opens with a complaint in the console is not.
    const plan = parseInvite("schizo://join?board=demo&secret=NOTHEX");
    expect(plan?.config.mode).toBe("lan");
    expect(plan?.config.secret).toBeUndefined();
    expect(plan?.complaint).toMatch(/secret/);
  });

  it("opens a board of its own when the link names one and gives no secret", () => {
    // Not a way into somebody else's board of the same name: their
    // advertisement carries a fingerprint of *their* secret, and `is_joinable`
    // will not match a fingerprint of the one this peer invents.
    const plan = parseInvite("schizo://join?board=demo");
    expect(plan?.config).toEqual({ mode: "lan", boardId: "demo", secret: undefined });
    expect(plan?.complaint).toBeNull();
  });

  it("refuses a board name that could be a path, before it can become one", () => {
    // `sync/secret.rs` writes a file named after the board, and this name came
    // off a link a stranger sent. Two rules stand between them; this is the
    // first, and it runs before the name reaches Rust at all.
    for (const name of ["../../boom", "a/b", "..", "x".repeat(65)]) {
      const plan = parseInvite(`schizo://join?board=${encodeURIComponent(name)}&secret=${SECRET}`);
      expect(plan?.config.boardId, name).toBe("board");
      expect(plan?.complaint, name).toMatch(/board name/);
    }
  });
});

describe("the plan a window opens with", () => {
  const none = async (): Promise<string | null> => null;
  /** A shell that has never been moved off the board it started on. */
  const first = async (): Promise<string | null> => null;

  it("takes the query string when no link launched us, which is nearly every launch", async () => {
    expect(await openingPlan(none, first, "?board=mine")).toEqual(planSync("?board=mine"));
  });

  it("is the invite when one launched us, and the address bar is not consulted", async () => {
    // The cold arrival costs no reload: this runs before there is a provider, a
    // mesh or a relay, so the link simply is the plan.
    const link = async (): Promise<string> => `schizo://join?board=theirs&secret=${SECRET}`;
    expect((await openingPlan(link, first, "?board=mine")).config).toEqual({
      mode: "lan",
      boardId: "theirs",
      secret: SECRET,
    });
  });

  it("falls back to the query string when what launched us was not an invite", async () => {
    const other = async (): Promise<string> => "https://example.com/";
    expect(await openingPlan(other, first, "?board=mine")).toEqual(planSync("?board=mine"));
  });

  it("opens the board anyway when the shell cannot answer at all", async () => {
    // An older shell, or a platform with no such command. A board that refuses
    // to open because nobody could be asked about invites would be absurd.
    const broken = async (): Promise<string | null> => {
      throw new Error("no such command");
    };
    expect(await openingPlan(broken, first, "?board=mine")).toEqual(planSync("?board=mine"));
    expect(await openingPlan(none, broken, "?board=mine")).toEqual(planSync("?board=mine"));
  });

  it("is the board this installation was moved onto, when nothing else says", async () => {
    // A bundle was opened here once (T-195), and there is no address bar in a
    // packaged application to say so on. Every launch from now on is this board.
    const moved = async (): Promise<string> => "board-abc123";
    expect((await openingPlan(none, moved, "")).config.boardId).toBe("board-abc123");
  });

  it("lets a link take you off it, because that is somebody asking now", async () => {
    const moved = async (): Promise<string> => "board-abc123";
    const link = async (): Promise<string> => `schizo://join?board=theirs&secret=${SECRET}`;
    expect((await openingPlan(link, moved, "")).config.boardId).toBe("theirs");
    expect((await openingPlan(none, moved, "?board=theirs")).config.boardId).toBe("theirs");
  });
});

describe("the query an invite is the same thing as", () => {
  it("is what the address bar would have said, character for character", () => {
    // The whole "an invite link is the address bar" idea, made checkable: a
    // window told to join somewhere else reloads with exactly this, and there is
    // no conversion step that could drift.
    const search = inviteSearch(`schizo://join?board=demo&secret=${SECRET}`);
    expect(search).toBe(`?board=demo&secret=${SECRET}`);
    expect(planSync(search!)).toEqual(parseInvite(`schizo://join?board=demo&secret=${SECRET}`));
  });

  it("is null for a link that is not ours, so nothing reloads for it", () => {
    expect(inviteSearch("https://example.com/?board=demo")).toBeNull();
    expect(inviteSearch("schizo://wipe?board=demo")).toBeNull();
  });
});
