/**
 * @vitest-environment happy-dom
 *
 * Which clipboard a keystroke means.
 *
 * `crdt/ops/clip.test.ts` covers what a copy carries. This covers the part that
 * cannot be reasoned about from the document at all: there are two clipboards
 * on this machine — the system's and this board's — and `Ctrl+V` is one key.
 * Every test here is about the token that decides between them.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BoardClipboard } from "@/app/clipboard";
import { initialiseBoard, openBoardDoc, sealBoard, type BoardDoc } from "@/crdt/doc";
import { createItems, createString } from "@/crdt/ops";
import { readItem } from "@/crdt/schema";
import { Camera } from "@/state/camera";
import { Scene } from "@/state/scene";
import { Selection } from "@/state/selection";
import type { BoardWriter } from "@/state/tools/tool";

const CLIP_MIME = "application/x-schizoboard-clip";

let board: BoardDoc;
let camera: Camera;
let scene: Scene;
let selection: Selection;
let clipboard: BoardClipboard;
let said: string[];
/** Every delete the cut asked for, the way `state/tools/select.test.ts` records
 *  them — the rule itself is `state/erase.ts`'s and is tested there. */
let deletes: { ids: string[]; keepPins: boolean }[];

/** A stand-in for the one surface a clipboard event exposes. */
class FakeTransfer {
  readonly data = new Map<string, string>();
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  getData(type: string): string {
    return this.data.get(type) ?? "";
  }
}

function fire(kind: "copy" | "cut", target?: EventTarget): FakeTransfer {
  const transfer = new FakeTransfer();
  const event = new Event(kind, { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: transfer });
  if (target) Object.defineProperty(event, "target", { value: target });
  window.dispatchEvent(event);
  lastEvent = event;
  return transfer;
}

let lastEvent: ClipboardEvent;

function note(x: number, y: number, text = ""): { itemId: string; pinId: string } {
  const [made] = createItems(board, [{ type: "note", x, y, w: 200, h: 160, text, rot: 0 }]);
  return { itemId: made!.itemId, pinId: made!.pinId! };
}

function itemsOnBoard(): { id: string; x: number; y: number; text: string }[] {
  return [...board.items].map(([id, map]) => ({
    id,
    x: readItem(id, map)!.x,
    y: readItem(id, map)!.y,
    text: String(map.get("text") ?? ""),
  }));
}

/** Whether something is over the board, for T-324's gate. False everywhere
 *  above the one describe that is about it. */
let covered = false;

beforeEach(() => {
  board = openBoardDoc();
  initialiseBoard(board);
  camera = new Camera();
  camera.resize(1000, 800);
  scene = new Scene();
  selection = new Selection();
  said = [];
  deletes = [];
  const write = {
    deleteItems: (ids: readonly string[], keepPins: boolean) => {
      deletes.push({ ids: [...ids], keepPins });
    },
    deleteStrings: () => {},
    deletePins: () => {},
  } as unknown as BoardWriter;

  covered = false;
  clipboard = new BoardClipboard({
    board,
    camera,
    selection,
    scene,
    write,
    cursor: () => null,
    covered: () => covered,
    onPasted: (pasted) => {
      selection.replaceThread(pasted.items, pasted.strings, pasted.freePins);
    },
    say: (message) => said.push(message),
  });
  clipboard.attach();
});

// The listeners are on `window`, which outlives the test — one that stayed
// attached would hear the next test's copy and answer it with the last test's
// board.
afterEach(() => clipboard.destroy());

describe("copying", () => {
  it("announces a token and the words, and puts no paper on the system clipboard", () => {
    const { itemId } = note(0, 0, "the sentence");
    selection.replace([itemId]);

    const transfer = fire("copy");

    expect(transfer.getData(CLIP_MIME)).not.toBe("");
    expect(transfer.getData("text/plain")).toBe("the sentence");
    // Nothing else: the paper is in memory, and a serialisation of it on the
    // system clipboard is the thing Q-162 decided against.
    expect([...transfer.data.keys()].sort()).toEqual([CLIP_MIME, "text/plain"]);
    expect(lastEvent.defaultPrevented).toBe(true);
    // A copy changes nothing.
    expect(itemsOnBoard()).toHaveLength(1);
    expect(said).toEqual(["Copied 1 item"]);
  });

  it("leaves the clipboard alone when nothing is selected", () => {
    note(0, 0, "not selected");
    const transfer = fire("copy");

    // A copy that emptied what you already had would be worse than one that did
    // nothing, so the event is not ours and is not taken.
    expect([...transfer.data.keys()]).toEqual([]);
    expect(lastEvent.defaultPrevented).toBe(false);
    // And nothing to claim a paste with, which is the same statement made where
    // it can be observed.
    expect(clipboard.claim(transfer as unknown as DataTransfer, { x: 0, y: 0 })).toBe(false);
  });

  it("stands down inside a note's editor", () => {
    const { itemId } = note(0, 0, "the sentence");
    selection.replace([itemId]);

    const editor = document.createElement("textarea");
    const transfer = fire("copy", editor);

    expect([...transfer.data.keys()]).toEqual([]);
    expect(lastEvent.defaultPrevented).toBe(false);
  });

  it("says what it took, counting the strings and the free pins", () => {
    const a = note(0, 0);
    const b = note(400, 0);
    createString(board, { pins: [a.pinId, b.pinId] });
    selection.replace([a.itemId, b.itemId]);

    fire("copy");
    expect(said).toEqual(["Copied 2 items and 1 string"]);
  });
});

describe("pasting", () => {
  it("puts the paper down when the token comes back", () => {
    const { itemId } = note(0, 0, "evidence");
    selection.replace([itemId]);
    const transfer = fire("copy");

    expect(clipboard.claim(transfer as unknown as DataTransfer, { x: 700, y: 300 })).toBe(true);

    const items = itemsOnBoard();
    expect(items).toHaveLength(2);
    const copy = items.find((item) => item.id !== itemId)!;
    expect([copy.x, copy.y, copy.text]).toEqual([700, 300, "evidence"]);
    // Held, so that putting it down and moving it is one gesture in two halves.
    expect(selection.toArray()).toEqual([copy.id]);
  });

  it("declines a clipboard that has been overwritten since", () => {
    const { itemId } = note(0, 0, "evidence");
    selection.replace([itemId]);
    fire("copy");

    // Somebody copied something else, anywhere on the machine: the token went
    // with the rest of the clipboard, and what is on it now is more recent than
    // what this board is holding.
    const elsewhere = new FakeTransfer();
    elsewhere.setData("text/plain", "a sentence from a browser");

    expect(clipboard.claim(elsewhere as unknown as DataTransfer, { x: 700, y: 300 })).toBe(false);
    expect(itemsOnBoard()).toHaveLength(1);
  });

  it("declines when nothing has been copied at all", () => {
    const empty = new FakeTransfer();
    empty.setData(CLIP_MIME, "a token this board never issued");
    expect(clipboard.claim(empty as unknown as DataTransfer, { x: 0, y: 0 })).toBe(false);
  });

  it("puts the same clip down twice, each time where it was asked for", () => {
    const { itemId } = note(0, 0, "evidence");
    selection.replace([itemId]);
    const transfer = fire("copy");

    clipboard.claim(transfer as unknown as DataTransfer, { x: 100, y: 0 });
    clipboard.claim(transfer as unknown as DataTransfer, { x: 200, y: 0 });

    expect(itemsOnBoard().map((item) => item.x).sort((a, b) => a - b)).toEqual([0, 100, 200]);
  });
});

describe("cutting", () => {
  it("takes the copy first and then deletes what it took", () => {
    const { itemId } = note(0, 0, "evidence");
    selection.replace([itemId]);

    const transfer = fire("cut");

    expect(transfer.getData(CLIP_MIME)).not.toBe("");
    expect(deletes).toEqual([{ ids: [itemId], keepPins: false }]);
    expect(said).toEqual(["Cut 1 item"]);
    // And the clip survives the thing it was taken from: the delete is queued
    // through the writer, but even once it lands the paste has its own copy.
    expect(clipboard.claim(transfer as unknown as DataTransfer, { x: 500, y: 0 })).toBe(true);
    expect(itemsOnBoard().some((item) => item.text === "evidence" && item.x === 500)).toBe(true);
  });

  it("deletes nothing when there was nothing to copy", () => {
    fire("cut");
    expect(deletes).toEqual([]);
  });
});

describe("duplicating", () => {
  it("lands beside the original rather than under the cursor", () => {
    const { itemId } = note(120, 40, "evidence");
    selection.replace([itemId]);

    clipboard.duplicate();

    const copy = itemsOnBoard().find((item) => item.id !== itemId)!;
    expect([copy.x - 120, copy.y - 40]).toEqual([28, 28]);
    expect(selection.toArray()).toEqual([copy.id]);
  });

  it("leaves the system clipboard exactly as it found it", () => {
    const { itemId } = note(0, 0, "evidence");
    selection.replace([itemId]);
    clipboard.duplicate();

    // Duplicating something is not a statement about what you want to paste
    // next, so nothing was announced and a paste still has nothing of ours to
    // find on the system clipboard.
    const anything = new FakeTransfer();
    anything.setData(CLIP_MIME, "whatever was there before");
    expect(clipboard.claim(anything as unknown as DataTransfer, { x: 0, y: 0 })).toBe(false);
    expect(said).toEqual([]);
  });

  it("does nothing with an empty selection", () => {
    note(0, 0);
    clipboard.duplicate();
    expect(itemsOnBoard()).toHaveLength(1);
  });

  it("duplicates the duplicate, so a row can be built one keystroke at a time", () => {
    const { itemId } = note(0, 0);
    selection.replace([itemId]);
    clipboard.duplicate();
    clipboard.duplicate();

    expect(itemsOnBoard().map((item) => item.x).sort((a, b) => a - b)).toEqual([0, 28, 56]);
  });
});

/**
 * A board written by a newer build — T-224, Q-170.
 *
 * The clipboard is the one surface where read-only is not simply "no": a copy
 * is a read, and taking a piece of a board you cannot edit somewhere you can is
 * most of what looking at one is for. So the two halves of `Ctrl+X` come apart
 * here and nowhere else.
 */
describe("on a sealed board", () => {
  /** The paper is put down first: a sealed board is one nothing can add to. */
  function held(): void {
    const { itemId } = note(0, 0, "the sentence");
    selection.replace([itemId]);
    sealBoard(board);
  }

  it("still copies", () => {
    held();

    const transfer = fire("copy");

    expect(transfer.getData(CLIP_MIME)).not.toBe("");
    expect(transfer.getData("text/plain")).toBe("the sentence");
    expect(said).toEqual(["Copied 1 item"]);
  });

  /**
   * And a cut is a copy. The flash says *Copied*, not *Cut*: naming the half
   * that did not happen is worse than naming the half that did.
   */
  it("turns a cut into a copy, and says so", () => {
    held();

    const transfer = fire("cut");

    expect(transfer.getData(CLIP_MIME)).not.toBe("");
    expect(deletes).toEqual([]);
    expect(said).toEqual(["Copied 1 item"]);
  });

  /** The other direction is refused outright, by both routes into it. */
  it("takes no paste and no duplicate", () => {
    held();
    const transfer = fire("copy");

    expect(clipboard.claim(transfer as unknown as DataTransfer, { x: 500, y: 500 })).toBe(true);
    expect(itemsOnBoard()).toHaveLength(1);

    clipboard.duplicate();
    expect(itemsOnBoard()).toHaveLength(1);
  });
});

/**
 * T-324: the clipboard does not reach a board somebody cannot see.
 *
 * The bug this is about was not in this file. `ui/crt.ts` implements the set as
 * a capture-phase **keydown** listener, and a `cut` is a different event from
 * the `Ctrl`+`X` that caused it - so `stopPropagation` on the key never touched
 * it, and these two listeners answered a board behind a film covering the
 * screen. Driven before the fix: two selected notes deleted, on a board nobody
 * could look at.
 *
 * Asserted here rather than at the set because the set cannot answer for it: a
 * file dragged in from the OS is not a keydown either (`app/paste.test.ts` has
 * that half).
 */
describe("while something is covering the board", () => {
  function held(): void {
    const { itemId } = note(0, 0, "the sentence");
    selection.replace([itemId]);
    covered = true;
  }

  it("takes no cut, so nothing is deleted behind a film", () => {
    held();

    const transfer = fire("cut");

    expect(deletes).toEqual([]);
    // And nothing was announced to the system clipboard either, so a paste a
    // keystroke later cannot put back what was never taken.
    expect(transfer.getData(CLIP_MIME)).toBe("");
    expect(said).toEqual([]);
    expect(itemsOnBoard()).toHaveLength(1);
  });

  /**
   * The copy goes with the cut, which is the one of the two worth arguing.
   * Copying changes no document and could have been allowed - but a copy taken
   * from a selection nobody can see is a paste you did not mean, one keystroke
   * later, and the whole point of the set is that the board is not there.
   */
  it("takes no copy either", () => {
    held();

    const transfer = fire("copy");

    expect(transfer.getData(CLIP_MIME)).toBe("");
    expect(transfer.getData("text/plain")).toBe("");
    expect(said).toEqual([]);
  });

  it("lets go again when the set does", () => {
    held();
    fire("cut");
    expect(deletes).toEqual([]);

    // The film comes off. Nothing about the refusal is latched.
    covered = false;
    fire("cut");
    expect(deletes).toHaveLength(1);
  });
});
