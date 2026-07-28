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

import { formatInvite, INVITE_SCHEME, parseInvite } from "@/app/invite";

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
