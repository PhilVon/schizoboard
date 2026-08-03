/**
 * Reading a document, page by page — T-320's reader and T-321's position.
 *
 * The double here is the *platform*, which is the boundary this module is
 * written against, and not the module itself. What is asserted is the two things
 * only this side decides: which page is being read, and when the shell is told
 * to let a file go.
 */

import { describe, expect, it, vi } from "vitest";

import { PageReader } from "@/app/pages";
import type { DocumentPage, Platform } from "@/platform/types";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

function pageAt(index: number): DocumentPage {
  return {
    index,
    width: 595,
    height: 842,
    content: { kind: "plain", text: `page ${index}` },
    cues: [],
  };
}

function shell(over: Partial<Platform> = {}) {
  const closed: string[] = [];
  const asked: Array<{ sha256: string; index: number }> = [];
  const native = {
    documentPage: async (sha256: string, index: number) => {
      asked.push({ sha256, index });
      return pageAt(index);
    },
    documentPageImage: async () => new Uint8Array(),
    documentClose: async (sha256: string) => {
      closed.push(sha256);
    },
    ...over,
  } as unknown as Platform;
  return { native, closed, asked };
}

/** Let the fetch settle — one page is one `await` on this side, and a scan two. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("which page is being read", () => {
  it("starts at one, and a document with no count still has a page", () => {
    const { native } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, null);
    expect(reader.pageAt).toBe(1);
    // There is always a page. `pages: null` is a document nobody has counted,
    // not a document with none — and turning is what finds out there is no
    // second one.
    expect(reader.pageCount).toBe(1);
  });

  it("turns forward and back, and clamps rather than wrapping", () => {
    const { native } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 3);

    expect(reader.turn(-1)).toBe(false);
    expect(reader.pageAt).toBe(1);

    expect(reader.turn(1)).toBe(true);
    expect(reader.turn(1)).toBe(true);
    expect(reader.pageAt).toBe(3);
    // A document has a first page and a last one, and running off either end
    // into the other is a thing no physical file does.
    expect(reader.turn(1)).toBe(false);
    expect(reader.pageAt).toBe(3);
  });

  it("does nothing at all when no case file is open", () => {
    const { native } = shell();
    const reader = new PageReader(native, () => {});
    expect(reader.turn(1)).toBe(false);
  });

  it("marks the document dirty when the page moves, and only then", () => {
    const arrived = vi.fn();
    const { native } = shell();
    const reader = new PageReader(native, arrived);
    reader.open(HASH, 2);
    arrived.mockClear();

    reader.turn(1);
    expect(arrived).toHaveBeenCalledWith(HASH);
    arrived.mockClear();
    // At the last page nothing moved, so nothing is redrawn — a held arrow
    // would otherwise repaint the same page sixty times a second.
    reader.turn(1);
    expect(arrived).not.toHaveBeenCalled();
  });

  it("goes back to page one on a different document", async () => {
    const { native, closed } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 9);
    reader.turn(4);
    expect(reader.pageAt).toBe(5);

    reader.open(OTHER, 9);
    expect(reader.pageAt).toBe(1);
    // And the last one is let go of, so the shell holds one file rather than
    // two — on a 51 MB scan that is 51 MB of working set.
    await settle();
    expect(closed).toEqual([HASH]);
  });
});

describe("what is asked of the shell", () => {
  it("asks for the page being read and its neighbours, without being told which", async () => {
    const { native, asked } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 4);
    reader.page(HASH);
    reader.turn(2);
    reader.page(HASH);
    await settle();
    // Opening asks for 1 and the one after it; landing on 3 asks for 3 and 4,
    // and finds 2 already here (T-279, Q-276). Nobody said which page: the
    // layer asked for "the page", and the window either side of it is this
    // module's own doing.
    expect(asked).toEqual([
      { sha256: HASH, index: 1 },
      { sha256: HASH, index: 2 },
      { sha256: HASH, index: 3 },
      { sha256: HASH, index: 4 },
    ]);
  });

  it("asks once per page and answers from what it has after that", async () => {
    const { native, asked } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 4);
    reader.page(HASH);
    await settle();

    expect(reader.page(HASH).phase).toBe("ready");
    expect(reader.page(HASH).page?.index).toBe(1);
    // Two, and both from the open: page one and the neighbour held ahead of it.
    // Asking is what fetches, and the layer asks on every frame the folder is
    // open — so a further ask that reached the shell would be an IPC round trip
    // per frame.
    expect(asked).toHaveLength(2);
  });

  it("carries the shell's own sentence when a document will not open", async () => {
    const { native } = shell({
      documentPage: async () => {
        throw new Error("the document is password protected");
      },
    });
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 1);
    reader.page(HASH);
    await settle();

    const view = reader.page(HASH);
    expect(view.phase).toBe("unreadable");
    // Not replaced with a generic failure: `document.rs` writes these to be
    // read, and it is the one thing a person can act on.
    expect(view.reason).toBe("the document is password protected");
  });

  it("says there is no such page rather than that the page is empty", async () => {
    const { native } = shell({ documentPage: async () => null });
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 1);
    reader.page(HASH);
    await settle();

    const view = reader.page(HASH);
    expect(view.phase).toBe("unreadable");
    expect(view.page).toBeNull();
  });
});

describe("letting the file go", () => {
  it("tells the shell which folder was shut, not that one was", async () => {
    const { native, closed } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 2);
    reader.close(HASH);
    await settle();
    // Named rather than implied: two folders opened in quick succession would
    // otherwise have the loser's close land on the winner's file.
    expect(closed).toEqual([HASH]);
  });

  it("drops the pages it was holding for that document and no others", async () => {
    const { native, asked } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 2);
    reader.page(HASH);
    await settle();

    reader.close(HASH);
    reader.open(HASH, 2);
    reader.page(HASH);
    await settle();
    // Both pages asked for again, because they went with the close. The shell
    // keeps its own cache, so this costs a memory copy rather than a re-read.
    expect(asked).toHaveLength(4);
  });

  it("survives a shell that will not let go", async () => {
    const { native } = shell({
      documentClose: async () => {
        throw new Error("nope");
      },
    });
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 1);
    // A rejected close costs memory in the shell and nothing a reader can act
    // on, so it must not reach the frame as an unhandled rejection.
    expect(() => reader.close(HASH)).not.toThrow();
    await settle();
  });
});

/**
 * The window — T-279, Q-276.
 *
 * The rule is the culler's, one level down: hold the page being read and the
 * one either side, and let the rest go. What these assert is the bound itself
 * and the blob URLs that make it matter, because those are the two things a
 * screenshot of a single sheet can never show.
 */
describe("what a long read holds", () => {
  it("holds three pages however far through a document you get", async () => {
    const { native } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 1000);

    for (let n = 0; n < 200; n++) {
      reader.turn(1);
      reader.page(HASH);
      await settle();
    }

    expect(reader.pageAt).toBe(201);
    // Two hundred pages read, three held. Before this rule it was one entry per
    // page visited: 199 pages and 77 MiB of blob URLs to draw a 200-page scan.
    expect(reader.heldPages.pages).toBe(3);
  });

  it("holds two at either end rather than reaching past the covers", async () => {
    const { native } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 40);
    await settle();
    // Page 1 has one neighbour, not two — there is no page zero to ask for, and
    // asking would land as "there is no page here" on the sheet's own paper.
    expect(reader.heldPages.pages).toBe(2);

    reader.goto(40);
    await settle();
    expect(reader.heldPages.pages).toBe(2);
  });

  it("finds the page already here when you turn back", async () => {
    const { native, asked } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 40);
    reader.turn(1);
    await settle();
    const sofar = asked.length;

    // The gesture the window is for other than memory: turning back to re-read
    // the page you just left costs nothing, because it never went anywhere.
    expect(reader.turn(-1)).toBe(true);
    expect(reader.page(HASH).phase).toBe("ready");
    await settle();
    expect(asked).toHaveLength(sofar);
  });

  it("does not redraw the folder when a neighbour lands", async () => {
    const arrived = vi.fn();
    const { native } = shell();
    const reader = new PageReader(native, arrived);
    reader.open(HASH, 40);
    reader.page(HASH);
    await settle();
    arrived.mockClear();

    // Page 3 is fetched ahead by this turn; page 2 is what goes on the sheet
    // and is already here. So the only redraw is the turn's own — a neighbour
    // arriving changes nothing anybody is looking at, and `arrived` is a whole
    // item rebind.
    reader.turn(1);
    expect(arrived).toHaveBeenCalledTimes(1);
    await settle();
    expect(arrived).toHaveBeenCalledTimes(1);
  });

  it("revokes a scan's blob URL when its page leaves the window", async () => {
    const minted: string[] = [];
    const revoked: string[] = [];
    let next = 0;
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => {
        const url = `blob:page-${++next}`;
        minted.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    });

    const { native } = shell({
      documentPage: async (_sha: string, index: number) => ({
        index,
        width: 595,
        height: 842,
        content: {
          kind: "image" as const,
          image: { mime: "image/jpeg", bytes: 4, width: 1200, height: 1600 },
        },
      }),
      documentPageImage: async () => new Uint8Array([1, 2, 3, 4]),
    } as unknown as Partial<Platform>);

    const reader = new PageReader(native, () => {});
    reader.open(HASH, 100);
    for (let n = 0; n < 10; n++) {
      reader.turn(1);
      reader.page(HASH);
      await settle();
    }

    // Half a megabyte a page in the real thing, and the browser holds it until
    // the URL is revoked. Everything minted but the three in the window has to
    // have been let go of, or the window bounds the Map and nothing else.
    expect(minted.length).toBeGreaterThan(3);
    expect(revoked).toEqual(minted.slice(0, minted.length - 3));
    expect(reader.heldPages).toEqual({ pages: 3, urls: 3 });

    vi.unstubAllGlobals();
  });
});

/**
 * The pictures on a typed page — T-329.
 *
 * Rust has lifted these since Q-203 and this side asked for none of them, so a
 * report's chart arrived as its caption and a blank space. What is asserted is
 * this module's half: that each figure's bytes are asked for by the pair that
 * names them, that a figure with nothing to fetch is not fetched, and that the
 * URLs minted for them are let go of like every other one.
 */
describe("a page's figures", () => {
  const figure = (over: Record<string, unknown> = {}) => ({
    x: 72,
    y: 200,
    width: 400,
    height: 300,
    content: {
      kind: "image" as const,
      image: { mime: "image/png", bytes: 4, width: 800, height: 600 },
    },
    ...over,
  });

  /** A shell whose every page is typed and carries `figures`. */
  function withFigures(figures: unknown[], over: Partial<Platform> = {}) {
    const wanted: Array<number | undefined> = [];
    return {
      wanted,
      ...shell({
        documentPage: async (_sha: string, index: number) => ({
          index,
          width: 595,
          height: 842,
          content: {
            kind: "text" as const,
            runs: [{ text: "as the chart shows", x: 72, y: 96, width: 190, height: 12, size: 11 }],
            figures,
          },
        }),
        documentPageImage: async (_sha: string, _index: number, at?: number) => {
          wanted.push(at);
          return new Uint8Array([1, 2, 3, 4]);
        },
        ...over,
      } as unknown as Partial<Platform>),
    };
  }

  function stubUrls(): { minted: string[]; revoked: string[] } {
    const minted: string[] = [];
    const revoked: string[] = [];
    let next = 0;
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => {
        const url = `blob:fig-${++next}`;
        minted.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    });
    return { minted, revoked };
  }

  it("asks for each figure's bytes by its own index, and hands back a URL each", async () => {
    stubUrls();
    const { native, wanted } = withFigures([figure(), figure({ y: 400 })]);
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 1);
    await settle();

    // `documentPageImage` already took the `(page, figure)` pair — nothing in
    // the shell had to change for this.
    expect(wanted).toEqual([0, 1]);
    expect(reader.page(HASH, 1).figureUrls).toEqual(["blob:fig-1", "blob:fig-2"]);
    vi.unstubAllGlobals();
  });

  it("does not ask for a figure the shell already said it could not lift", async () => {
    stubUrls();
    const { native, wanted } = withFigures([
      figure({ content: { kind: "unsupported", reason: "the figure is a JPX image" } }),
      figure({ y: 400 }),
    ]);
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 1);
    await settle();

    // A round trip whose only possible answer is the empty one. The slot is
    // still there and still null, so the leaf can hold its place and say why.
    expect(wanted).toEqual([1]);
    expect(reader.page(HASH, 1).figureUrls).toEqual([null, "blob:fig-1"]);
    vi.unstubAllGlobals();
  });

  it("keeps the page when one figure will not read", async () => {
    stubUrls();
    const { native } = withFigures([figure(), figure({ y: 400 })], {
      documentPageImage: async (_sha: string, _index: number, at?: number) => {
        if (at === 0) throw new Error("the figure's stream is truncated");
        return new Uint8Array([1, 2, 3, 4]);
      },
    } as unknown as Partial<Platform>);
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 1);
    await settle();

    // A page whose words are here and whose chart would not read is still a
    // page somebody can read. Letting the throw reach the page-level arm would
    // throw away runs that arrived perfectly well.
    const view = reader.page(HASH, 1);
    expect(view.phase).toBe("ready");
    expect(view.page?.content.kind).toBe("text");
    expect(view.figureUrls).toEqual([null, "blob:fig-1"]);
    vi.unstubAllGlobals();
  });

  it("revokes every figure's URL when the page leaves the window", async () => {
    const { minted, revoked } = stubUrls();
    const { native } = withFigures([figure(), figure({ y: 400 }), figure({ y: 600 })]);
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 100);
    for (let n = 0; n < 6; n++) {
      reader.turn(1);
      reader.page(HASH);
      await settle();
    }

    // Three a page now rather than one, which is the whole reason a page holds
    // a list of them: a page let go of with two of its three revoked leaks the
    // third with nothing left pointing at it.
    expect(reader.heldPages).toEqual({ pages: 3, urls: 9 });
    expect(minted.length).toBeGreaterThan(9);
    expect(revoked).toEqual(minted.slice(0, minted.length - 9));
    vi.unstubAllGlobals();
  });

  it("mints nothing for a page shut while its figures were in flight", async () => {
    const { minted } = stubUrls();
    // Held open deliberately: the page itself has to have *landed* for this to
    // be the guard under test. A shut before that is caught one check earlier,
    // by the one the scan already had.
    let release = (): void => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { native } = withFigures([figure(), figure({ y: 400 })], {
      documentPageImage: async () => {
        await held;
        return new Uint8Array([1, 2, 3, 4]);
      },
    } as unknown as Partial<Platform>);

    const reader = new PageReader(native, () => {});
    reader.open(HASH, 1);
    await settle();
    reader.close(HASH);
    release();
    await settle();

    // The bytes are dropped on the floor, which the collector takes care of. A
    // blob URL minted before the check would not have been in `held.urls` for
    // `forget` to find, and `forget` is the one place a URL may be revoked.
    expect(minted).toEqual([]);
    vi.unstubAllGlobals();
  });
});

/**
 * Going straight to a page — T-286.
 *
 * The second way in, and the only one that is not a hand on the corner of a
 * sheet: a search match is a `(document, page)` pair and the flight lands on
 * the second half of it.
 */
describe("opening at a page", () => {
  it("goes to the page and says so", () => {
    const { native } = shell();
    const arrived = vi.fn();
    const reader = new PageReader(native, arrived);
    reader.open(HASH, 60);

    expect(reader.goto(41)).toBe(true);
    expect(reader.pageAt).toBe(41);
    expect(arrived).toHaveBeenCalledWith(HASH);
  });

  it("clamps to the document rather than trusting the number", () => {
    const { native } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 12);

    // A page number derived from an index built off the bytes, against a count
    // that came off the record — the two can disagree, and a reader must not
    // end up at page 400 of a twelve-page filing.
    reader.goto(400);
    expect(reader.pageAt).toBe(12);
    reader.goto(0);
    expect(reader.pageAt).toBe(1);
    reader.goto(-3);
    expect(reader.pageAt).toBe(1);
  });

  it("answers false when it is already there, and when nothing is open", () => {
    const { native } = shell();
    const arrived = vi.fn();
    const reader = new PageReader(native, arrived);

    // Nothing open: there is no page to be at.
    expect(reader.goto(3)).toBe(false);

    reader.open(HASH, 9);
    expect(reader.goto(1)).toBe(false);
    expect(arrived).not.toHaveBeenCalled();
  });

  it("keeps the page when the document it is already reading is opened again", () => {
    const { native } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 50);
    reader.goto(41);

    // What a search stepping onto a second match in the same filing does. If
    // `open` reset here, the second match would land on page one.
    reader.open(HASH, 50);
    expect(reader.pageAt).toBe(41);

    // A different one is a different reading, and starts at the front.
    reader.open(OTHER, 50);
    expect(reader.pageAt).toBe(1);
  });
});
