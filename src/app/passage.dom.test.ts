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

import { passageBetween, passageBoxes, passageParts, passageSpan } from "@/app/clipping";

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

/**
 * The words marked under the rectangle while it is still being dragged — T-283,
 * Q-294.
 *
 * The claim the marking makes is that what is under the highlight is what will
 * be on the card. So every test here asks the same question of `passageParts`
 * that the block above asks of `passageBetween`, and the two must give the same
 * answer about the same span — a highlight over words the quotation is going to
 * drop would be the board offering to quote itself.
 *
 * Layout is the one thing this file cannot have: happy-dom answers zeroes for
 * every rect. That is why the measuring is injected — what is decided in
 * `clipping.ts` is *which stretches of which nodes* get measured, and that is
 * exactly what is checked here.
 */
describe("the words the rectangle has hold of", () => {
  const REASON = "the figure is a JPEG 2000 image, which this build cannot decode";

  /** What the marking would be drawn over, as text — one string per box, in the
   *  order the boxes come out. */
  const marked = (from: Range, to: Range): string[] => {
    const span = passageSpan(from, to);
    return span === null ? [] : passageParts(span, document).map((part) => part.toString());
  };

  it("marks exactly the words the card will hold, on an ordinary page", () => {
    const node = plainPage("The witness observed the vehicle parked outside.");
    const from = caretAt(node, 15);
    const to = caretAt(node, 30);
    expect(marked(from, to)).toEqual(["observed the vehicle"]);
    // The same span, read the two ways — this is the agreement, written down.
    expect(marked(from, to).join("\n")).toBe(passageBetween(from, to));
  });

  it("marks from the whole word, not from where the rectangle's edge fell", () => {
    // The widening is the reason the two ends are not the carets. A mark that
    // started mid-word would be showing a fragment and delivering a quotation.
    const node = plainPage("The witness observed the vehicle parked outside.");
    expect(marked(caretAt(node, 15), caretAt(node, 30))[0]!.startsWith("observed")).toBe(true);
  });

  it("leaves the board's own sentence unmarked, as the quotation leaves it out", () => {
    figurePage("The premises as they stood.", REASON, "Figure 1 - the frontage.");
    const from = caretAt(textIn(".leaf-lines"), 6);
    const to = caretAt(textIn(".leaf-lines", 1), 3);
    const parts = marked(from, to);
    expect(parts).toEqual(["premises as they stood.", "Figure"]);
    expect(parts.join(" ")).not.toContain("JPEG 2000");
    expect(parts.join("\n")).toBe(passageBetween(from, to));
  });

  it("marks nothing when the rectangle was drawn on that sentence alone", () => {
    figurePage("The premises as they stood.", REASON, "Figure 1 - the frontage.");
    const note = textIn(".leaf-figure-note");
    expect(marked(caretAt(note, 4), caretAt(note, 20))).toEqual([]);
  });

  it("drops a box with no width, which is a caret rather than a word", () => {
    // Every rect the measuring hands back is drawn, so an empty one is a stray
    // tick on the paper at the end of the selection.
    const node = plainPage("The witness observed the vehicle parked outside.");
    const span = passageSpan(caretAt(node, 15), caretAt(node, 30))!;
    const boxes = passageBoxes(span, () => [
      { left: 10, top: 10, right: 40, bottom: 22 },
      { left: 40, top: 10, right: 40, bottom: 22 },
      { left: 40, top: 10, right: 60, bottom: 10 },
    ]);
    expect(boxes).toEqual([{ left: 10, top: 10, right: 40, bottom: 22 }]);
  });

  it("measures every part, so a quotation across a figure is marked on both sides", () => {
    figurePage("The premises as they stood.", REASON, "Figure 1 - the frontage.");
    const span = passageSpan(
      caretAt(textIn(".leaf-lines"), 6),
      caretAt(textIn(".leaf-lines", 1), 3),
    )!;
    const seen: string[] = [];
    passageBoxes(span, (part) => {
      seen.push(part.toString());
      return [{ left: 0, top: 0, right: 1, bottom: 1 }];
    });
    expect(seen).toEqual(["premises as they stood.", "Figure"]);
  });
});

/**
 * A page of markdown — T-348, AC-951.
 *
 * The blocks a markdown page is built out of are ordinary children of
 * `.leaf-body`, exactly as `.leaf-lines` is, so the quote gesture needs no rule
 * about them. What these assert is that it *stayed* that way: the one thing
 * `quotationIn` drops is the board's own voice, and a heading is not that — it
 * is the document speaking, and it belongs on the card.
 */
describe("a rectangle over a page of markdown", () => {
  /** A markdown page as `writeMarkdown` builds it. */
  function markdownPage(): void {
    document.body.innerHTML =
      `<div class="leaf-body">` +
      `<div class="leaf-heading" data-level="2">The statement</div>` +
      `<div class="leaf-item" data-level="0">He came on the Tuesday train</div>` +
      `<div class="leaf-figure-note">this figure could not be lifted</div>` +
      `<div class="leaf-quote">and said so plainly</div>` +
      `</div>`;
  }

  it("carries a heading onto the card as words the document said", () => {
    markdownPage();
    const heading = document.querySelector(".leaf-heading")!.firstChild!;
    const item = document.querySelector(".leaf-item")!.firstChild!;
    const quoted = passageBetween(caretAt(heading, 0), caretAt(item, 28));
    expect(quoted).toContain("The statement");
    expect(quoted).toContain("He came on the Tuesday train");
  });

  it("still drops the board's own sentence from between them", () => {
    // The defect T-332 was written for, in the one page shape that did not
    // exist when it was fixed. A sentence this board wrote about a figure it
    // could not lift must never go on a card as something the document said.
    markdownPage();
    const heading = document.querySelector(".leaf-heading")!.firstChild!;
    const quote = document.querySelector(".leaf-quote")!.firstChild!;
    const quoted = passageBetween(caretAt(heading, 0), caretAt(quote, 19));
    expect(quoted).not.toContain("could not be lifted");
    expect(quoted).toContain("and said so plainly");
  });

  it("keeps the blocks apart rather than running them together", () => {
    markdownPage();
    const heading = document.querySelector(".leaf-heading")!.firstChild!;
    const item = document.querySelector(".leaf-item")!.firstChild!;
    // A newline between them, the way the document had it — "statementHe" is
    // the failure this rule was written against.
    expect(passageBetween(caretAt(heading, 0), caretAt(item, 28))).not.toContain("statementHe");
  });
});
