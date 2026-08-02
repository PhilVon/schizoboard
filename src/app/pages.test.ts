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

/** Let the fetch settle — one page is one `await` on this side. */
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
  it("asks for the page being read, without being told which", async () => {
    const { native, asked } = shell();
    const reader = new PageReader(native, () => {});
    reader.open(HASH, 4);
    reader.page(HASH);
    reader.turn(2);
    reader.page(HASH);
    await settle();
    expect(asked).toEqual([
      { sha256: HASH, index: 1 },
      { sha256: HASH, index: 3 },
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
    // Asking is what fetches, and the layer asks on every frame the folder is
    // open — so a second ask that reached the shell would be an IPC round trip
    // per frame.
    expect(asked).toHaveLength(1);
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
    // Asked again, because the pages went with the close. The shell keeps its
    // own cache, so this costs a memory copy rather than a re-read.
    expect(asked).toHaveLength(2);
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
