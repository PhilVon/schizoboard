/**
 * @vitest-environment happy-dom
 *
 * What a rectangle over a page comes back with — T-282's quotation, T-332's
 * repair.
 *
 * The two carets are `app/main.ts`'s, off `caretRangeFromPoint`, and are the
 * one part of this that needs a real webview. Everything downstream of them is
 * `passageBetween`, and it moved into `clipping.ts` so that this file could
 * exist: the wiring module has no tests, so a decision left in it is a decision
 * nothing checks.
 *
 * The page shapes here are the two the reading surface actually builds. A page
 * with no figure is one text node written straight onto `.leaf-body` (T-320); a
 * page carrying one is `.leaf-lines` blocks with the figure between them
 * (T-329). The whole of this file is that second shape not being allowed to
 * quietly change what a quotation is.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { passageBetween } from "@/app/clipping";

/** A collapsed range at an offset in a text node — what a caret hit test hands
 *  back, and the only thing `passageBetween` is ever given. */
function caretAt(node: Node, offset: number): Range {
  const caret = document.createRange();
  caret.setStart(node, offset);
  caret.setEnd(node, offset);
  return caret;
}

const textIn = (selector: string, at = 0): Node =>
  document.querySelectorAll(selector)[at]!.firstChild!;

beforeEach(() => {
  document.body.innerHTML = "";
});

/** The page every filing is mostly made of: no figure, one text node. */
function plainPage(text: string): Node {
  const body = document.createElement("div");
  body.className = "leaf-body";
  body.textContent = text;
  document.body.append(body);
  return body.firstChild!;
}

/**
 * A typed page carrying a figure — two blocks of text with the figure and its
 * sentence between them, exactly as `writePage` builds it.
 */
function figurePage(above: string, reason: string, below: string): void {
  document.body.innerHTML =
    `<div class="leaf-body">` +
    `<div class="leaf-lines">${above}</div>` +
    `<div class="leaf-figure" data-figure="unsupported"></div>` +
    `<div class="leaf-figure-note">${reason}</div>` +
    `<div class="leaf-lines">${below}</div>` +
    `</div>`;
}

describe("a rectangle inside one block of text", () => {
  it("comes back as whole words at both ends", () => {
    // The fragment this exists to stop, driven off the real app and read off
    // the card: "ed the vehicle parked outside the premises".
    const node = plainPage("The witness observed the vehicle parked outside.");
    expect(passageBetween(caretAt(node, 15), caretAt(node, 30))).toBe(
      "observed the vehicle",
    );
  });

  it("widens outwards rather than collapsing when it was dragged backwards", () => {
    const node = plainPage("The witness observed the vehicle parked outside.");
    expect(passageBetween(caretAt(node, 30), caretAt(node, 15))).toBe(
      "observed the vehicle",
    );
  });

  it("is unchanged on a page with a figure, as long as it stays in one block", () => {
    figurePage("The premises as they stood.", "no", "Figure 1 - the frontage.");
    // Both offsets land inside "premises", which runs 4..12, so the whole word
    // is what a rectangle across the middle of it caught.
    const node = textIn(".leaf-lines");
    expect(passageBetween(caretAt(node, 5), caretAt(node, 10))).toBe("premises");
  });
});

describe("a rectangle that spans a figure", () => {
  const REASON = "the figure is a JPEG 2000 image, which this build cannot decode";

  beforeEach(() => {
    figurePage("The premises as they stood.", REASON, "Figure 1 - the frontage.");
  });

  it("never carries the board's own sentence into the quotation", () => {
    // The worst of the three, by a distance. A figure this build could not lift
    // says so where the figure was, and that is the *board* speaking about the
    // document — a card carrying it is a quotation of something nobody wrote,
    // going on a wall as evidence.
    const said = passageBetween(
      caretAt(textIn(".leaf-lines"), 6),
      caretAt(textIn(".leaf-lines", 1), 3),
    );
    expect(said).not.toContain("JPEG 2000");
    expect(said).not.toContain("this build");
  });

  it("keeps whole words at both ends, in two different nodes", () => {
    // The repair used to be guarded on both carets landing in one node, which
    // was true until a page could have a figure in the middle of it.
    //
    // Both carets are deliberately INSIDE a word — 6 is the middle of
    // "premises", 3 the middle of "Figure". Offsets on a word boundary were the
    // first version of this test and they proved nothing: the widening had
    // nothing to do, so taking it out altogether left the test green.
    expect(
      passageBetween(caretAt(textIn(".leaf-lines"), 6), caretAt(textIn(".leaf-lines", 1), 3)),
    ).toBe("premises as they stood.\nFigure");
  });

  it("keeps the break the page had between the blocks", () => {
    // One text node had the document's own newline in it. Three elements do
    // not, and running them together makes "…stood.Figure 1…" — two sentences
    // presented as one, which is a claim the document does not make.
    const said = passageBetween(
      caretAt(textIn(".leaf-lines"), 0),
      caretAt(textIn(".leaf-lines", 1), 24),
    );
    expect(said.split("\n")).toHaveLength(2);
  });

  it("says nothing at all for a rectangle drawn on the sentence itself", () => {
    // Both ends in the board's voice: nothing of the document was under it, so
    // the caller says "There is nothing written there" — which is true.
    const note = textIn(".leaf-figure-note");
    expect(passageBetween(caretAt(note, 4), caretAt(note, 20))).toBe("");
  });
});
