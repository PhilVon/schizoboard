/**
 * The derived local index — T-280.
 *
 * The double is the *platform*, which is the boundary this module is written
 * against. What only this side decides is asked here: what is asked for and how
 * often, what is kept, and what a needle is tested against once it is.
 */

import { describe, expect, it, vi } from "vitest";

import { TextIndex } from "@/app/textindex";
// Moved to `lib/` when `Search` became its second caller (T-286) — the tests
// stay here, where the rule's consequences are visible.
import { normalise } from "@/lib/textnorm";
import type { PageText, Platform } from "@/platform/types";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

function shell(pages: Record<string, readonly PageText[] | Error>) {
  const asked: string[] = [];
  const readAs: boolean[] = [];
  const native = {
    documentText: async (sha256: string, markdown?: boolean) => {
      asked.push(sha256);
      readAs.push(markdown ?? false);
      const answer = pages[sha256];
      if (answer === undefined || answer instanceof Error) {
        throw answer ?? new Error("no such document");
      }
      return answer;
    },
  } as unknown as Platform;
  return { native, asked, readAs };
}

function text(...lines: string[]): PageText[] {
  return lines.map((line) => ({ kind: "text", text: line }) as const);
}

describe("TextIndex", () => {
  it("reads a document once however many times it is wanted", async () => {
    const { native, asked } = shell({ [HASH]: text("Witness statement") });
    const index = new TextIndex(native);
    for (let i = 0; i < 60; i++) index.wants(HASH);
    await index.idle();
    // The mark goes down before the await, which is what makes a folder bound
    // on every frame cost one read rather than one a frame.
    expect(asked).toEqual([HASH]);
  });

  it("says nothing has been asked before anything is", () => {
    const { native } = shell({});
    const index = new TextIndex(native);
    expect(index.of(HASH).phase).toBe("unasked");
    expect(index.find(HASH, "witness")).toBeNull();
  });

  it("refuses a string that is not a hash", async () => {
    const { native, asked } = shell({ [HASH]: text("anything") });
    const index = new TextIndex(native);
    index.wants("not-a-hash");
    index.wants("");
    await index.idle();
    expect(asked).toEqual([]);
  });

  it("finds a phrase and answers with the number printed on the page", async () => {
    const { native } = shell({
      [HASH]: text("the first page", "the second page", "the witness statement"),
    });
    const index = new TextIndex(native);
    index.wants(HASH);
    await index.idle();
    // One-based: page three, not element two. A search hands this straight to
    // the reading surface, which turns to the page with that number on it.
    expect(index.find(HASH, "witness")).toBe(3);
    expect(index.find(HASH, "first")).toBe(1);
    expect(index.find(HASH, "nothing of the kind")).toBeNull();
  });

  it("matches through case and through whatever whitespace the file used", async () => {
    // The gap rule and `linesOfRuns` disagree about which whitespace sits
    // between two runs and agree about the characters, so a needle that
    // survives normalisation is a needle that survives the disagreement.
    const { native } = shell({ [HASH]: text("WITNESS\n\n   STATEMENT  of\ttruth") });
    const index = new TextIndex(native);
    index.wants(HASH);
    await index.idle();
    expect(index.find(HASH, "witness statement")).toBe(1);
    expect(index.find(HASH, "  Witness   Statement ")).toBe(1);
    expect(index.find(HASH, "statement of truth")).toBe(1);
  });

  it("never answers an empty needle", async () => {
    const { native } = shell({ [HASH]: text("anything at all") });
    const index = new TextIndex(native);
    index.wants(HASH);
    await index.idle();
    // Otherwise every document on the board matches every keystroke of nothing,
    // which is the state a search field is in the instant it opens.
    expect(index.find(HASH, "")).toBeNull();
    expect(index.find(HASH, "   ")).toBeNull();
  });

  it("counts what each silent page was silent about", async () => {
    const { native } = shell({
      [HASH]: [
        { kind: "text", text: "the typed page" },
        { kind: "none", why: "scan" },
        { kind: "none", why: "scan" },
        { kind: "none", why: "empty" },
        { kind: "none", why: "unreadable" },
      ],
    });
    const index = new TextIndex(native);
    index.wants(HASH);
    await index.idle();
    const held = index.of(HASH);
    expect(held.phase).toBe("read");
    // Three different sentences for a search field to say, and the empty string
    // a silent page contributes cannot tell them apart on its own.
    expect(held.silence).toEqual({ scan: 2, empty: 1, unreadable: 1 });
    expect(held.pages).toEqual(["the typed page", "", "", "", ""]);
    // A scan has no text and there is no OCR, so it is findable by nothing.
    expect(index.find(HASH, "scan")).toBeNull();
  });

  it("keeps a file the shell could not read apart from one that said nothing", async () => {
    const { native } = shell({
      [HASH]: new Error("the document is password-protected"),
      [OTHER]: [{ kind: "none", why: "empty" }],
    });
    const index = new TextIndex(native);
    index.wants(HASH);
    index.wants(OTHER);
    await index.idle();
    // About 6% of real files (D-47), and a board must not report those as a
    // document that turned out to be blank.
    expect(index.of(HASH).phase).toBe("unreadable");
    expect(index.of(OTHER).phase).toBe("read");
  });

  it("does not let one unreadable document stop the next one", async () => {
    const { native, asked } = shell({
      [HASH]: new Error("nope"),
      [OTHER]: text("the second document"),
    });
    const index = new TextIndex(native);
    index.wants(HASH);
    index.wants(OTHER);
    await index.idle();
    expect(asked).toEqual([HASH, OTHER]);
    expect(index.find(OTHER, "second")).toBe(1);
  });

  it("reads one document at a time", async () => {
    let open = 0;
    let most = 0;
    const native = {
      documentText: async () => {
        open += 1;
        most = Math.max(most, open);
        await Promise.resolve();
        open -= 1;
        return text("a page");
      },
    } as unknown as Platform;
    const index = new TextIndex(native);
    for (let i = 0; i < 8; i++) index.wants(String(i).padStart(64, "c"));
    await index.idle();
    // A board of forty case files mounting at once must not put forty
    // documents' structure in memory and forty file reads on the blocking pool.
    expect(most).toBe(1);
  });
});

describe("normalise", () => {
  it("lowercases, collapses every run of whitespace and trims the ends", () => {
    expect(normalise("  WITNESS\n\n\tSTATEMENT  ")).toBe("witness statement");
    expect(normalise("")).toBe("");
    expect(normalise("   \n  ")).toBe("");
  });
});

/**
 * The arrival hook — T-286.
 *
 * There was none until a search field needed one: a query typed while twenty
 * filings are still being read keeps the answer it had, and nothing would ever
 * correct it. Both landings count, because "still reading" and "there is
 * nothing in here to find" are different sentences.
 */
describe("saying when a document has landed", () => {
  it("calls back once per document, after its pages are readable", async () => {
    const { native } = shell({ [HASH]: text("Witness statement") });
    const seen: string[] = [];
    const index = new TextIndex(native, (sha256) => {
      // Called *after* the entry is in place — a caller that re-walks on this
      // and found the old answer would be worse than no callback at all.
      seen.push(sha256);
      expect(index.find(sha256, "witness")).toBe(1);
    });
    for (let i = 0; i < 5; i++) index.wants(HASH);
    await index.idle();
    expect(seen).toEqual([HASH]);
  });

  it("calls back for a file the shell would not read at all", async () => {
    const { native } = shell({ [HASH]: new Error("the document is password protected") });
    const arrived = vi.fn();
    const index = new TextIndex(native, arrived);
    index.wants(HASH);
    await index.idle();
    expect(arrived).toHaveBeenCalledWith(HASH);
    expect(index.of(HASH).phase).toBe("unreadable");
  });
});

/**
 * The index reads the same words the sheet shows — T-347.
 *
 * Without this the search and the page are reading two different documents: a
 * search for a pair of asterisks would match every bold word in the file, and a
 * heading's hashes would count as part of the words it holds.
 */
describe("how a document is read for the index", () => {
  it("asks for the reading it was told about", async () => {
    const { native, readAs } = shell({ [HASH]: text("a heading") });
    const index = new TextIndex(native);
    index.wants(HASH, true);
    await index.idle();
    expect(readAs).toEqual([true]);
  });

  it("reads an ordinary text file as itself", async () => {
    const { native, readAs } = shell({ [HASH]: text("a line") });
    const index = new TextIndex(native);
    index.wants(HASH);
    await index.idle();
    expect(readAs).toEqual([false]);
  });
});
