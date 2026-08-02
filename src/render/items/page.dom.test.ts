/**
 * @vitest-environment happy-dom
 *
 * What is on an open page — T-320.
 *
 * Five arms, and what is asserted is the *distinctions between them* rather than
 * that each of them draws something. `empty` and a `plain` page holding `""`
 * would put the same blank sheet on the wall and only one of them is allowed to;
 * a scan with no bytes yet and a scan with bytes are the same page in two
 * states; and a page this build cannot read has to name what stopped it. AC-681
 * and AC-682 are both entirely about telling these apart.
 *
 * Its own file rather than more of `dom.test.ts`, which is already the largest
 * test in the directory and is about the item layer rather than about what a
 * document says.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { PageView } from "@/app/pages";
import type { PageContent, PageFigure } from "@/platform/types";
import { DomItemLayer, NO_FACTS, type AssetView } from "@/render/items/dom";
import { cloneForExport, inlineAssets } from "@/render/items/raster";
import { DirtySets } from "@/state/dirty";
import { Scene, type ItemCold } from "@/state/scene";

const HASH = "7c1d55ab".padEnd(64, "0");
const FOLDER = { w: 481, h: 344 };

let host: HTMLDivElement;
let scene: Scene;
let dirty: DirtySets;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  scene = new Scene();
  dirty = new DirtySets();
});

const asset = (sha: string): AssetView => ({
  url: `asset://sha256/${sha}`,
  phase: "ready",
  fraction: 0,
});

function layerFor(pageOf: () => PageView | null): DomItemLayer {
  return new DomItemLayer(
    host,
    asset,
    () => ({ ...NO_FACTS, kind: "document", pages: 4, name: "R v Hartley.txt" }),
    undefined,
    pageOf,
  );
}

function put(cold: Partial<ItemCold> = {}): void {
  scene.putItem(
    {
      id: "a",
      type: "polaroid",
      z: "a0",
      seed: 1,
      assetId: HASH,
      createdBy: 1,
      createdAt: 0,
      text: "",
      ...cold,
    },
    { x: 0, y: 0, rot: 0, ...FOLDER },
  );
  dirty.item("a");
}

/** Mount one folder, open it, and hand back its leaf. */
function leafOf(view: PageView | null, cold: Partial<ItemCold> = {}): HTMLElement {
  const layer = layerFor(() => view);
  put(cold);
  scene.setOpen("a", 1);
  layer.sync(scene, dirty, null);
  return host.querySelector(".folder-leaf") as HTMLElement;
}

const arrived = (
  content: PageContent,
  imageUrl: string | null = null,
  index = 1,
  figureUrls: readonly (string | null)[] = [],
): PageView => ({
  phase: "ready",
  page: { index, width: 595, height: 842, content },
  reason: null,
  imageUrl,
  figureUrls,
});

const bodyOf = (leaf: HTMLElement) => leaf.querySelector(".leaf-body")!.textContent;
const noteOf = (leaf: HTMLElement) => leaf.querySelector(".leaf-note")!.textContent;

describe("a page of a text file", () => {
  it("is set in the hand, plainly", () => {
    const leaf = leafOf(arrived({ kind: "plain", text: "the fourth witness" }));
    expect(leaf.dataset["page"]).toBe("plain");
    expect(bodyOf(leaf)).toBe("the fourth witness");
    // Q-269, and the whole of what that answer bought: one of these per
    // character is the 16.3 ms a page the measurement refused.
    expect(leaf.querySelectorAll(".hand-word > span")).toHaveLength(0);
  });
});

describe("a typed page", () => {
  it("has its runs re-set rather than its boxes reproduced", () => {
    const leaf = leafOf(
      arrived({
        kind: "text",
        runs: [
          { text: "IN THE MATTER OF", x: 72, y: 96, width: 180, height: 12, size: 11 },
          { text: "HARTLEY", x: 260, y: 96, width: 60, height: 12, size: 11 },
          { text: "and in the matter of", x: 72, y: 120, width: 190, height: 12, size: 11 },
        ],
        figures: [],
      }),
    );
    expect(leaf.dataset["page"]).toBe("text");
    // Two runs on one baseline join; the third moved down a line and breaks.
    // A PDF splits a line at every font and kerning change, so joining them
    // bare would run the words together.
    expect(bodyOf(leaf)).toBe("IN THE MATTER OF HARTLEY\nand in the matter of");
    // And nothing carries a position: a facsimile is the fork Q-198 did not
    // take, so the boxes are used to find the breaks and then thrown away.
    expect(leaf.querySelector(".leaf-body")!.innerHTML).not.toContain("left:");
  });

  it("does not break a line for a superscript or a mid-line font change", () => {
    // Half the run's own height, and this is why: a footnote mark and a change
    // of face both shift `y` a little and neither is a line break.
    const leaf = leafOf(
      arrived({
        kind: "text",
        runs: [
          { text: "as pleaded", x: 72, y: 96, width: 80, height: 12, size: 11 },
          { text: "3", x: 154, y: 92, width: 4, height: 7, size: 7 },
          { text: "in the reply", x: 160, y: 96, width: 80, height: 12, size: 11 },
        ],
        figures: [],
      }),
    );
    expect(bodyOf(leaf)).toBe("as pleaded 3 in the reply");
  });
});

describe("a scanned page", () => {
  it("is laid on the sheet, with no text beside it", () => {
    const leaf = leafOf(
      arrived(
        { kind: "image", image: { mime: "image/jpeg", width: 1600, height: 1200, bytes: 406744 } },
        "blob:x",
      ),
    );
    expect(leaf.dataset["page"]).toBe("image");
    expect(leaf.querySelector<HTMLImageElement>(".leaf-scan")!.getAttribute("src")).toBe("blob:x");
    expect(bodyOf(leaf)).toBe("");
    expect(noteOf(leaf)).toBe("");
  });

  it("draws the paper while its bytes are still coming", () => {
    // The same shape a photograph already has: the sheet is there and the image
    // lands on it, rather than the page waiting for the bytes to exist.
    const leaf = leafOf(
      arrived({
        kind: "image",
        image: { mime: "image/jpeg", width: 1600, height: 1200, bytes: 406744 },
      }),
    );
    expect(leaf.dataset["page"]).toBe("image");
    expect(leaf.querySelector<HTMLImageElement>(".leaf-scan")!.getAttribute("src")).toBeNull();
  });
});

/**
 * A picture on a typed page — T-329, and Q-289 is the whole of where it goes.
 *
 * Rust has lifted these since Q-203 and nothing drew them, so a report's chart
 * arrived as the caption and a blank space — which is the exact failure Q-203's
 * answer was bought to stop, reached by a different road.
 *
 * What is asserted here is the *order*, because in-flow was chosen over the
 * figure's own page box: the lines have been re-set, so a figure holding its
 * original geometry would sit on text that has moved out from under it. So a
 * figure goes after the last line above it and before the first line below it,
 * and a caption stays with its picture.
 */
describe("a picture on a typed page", () => {
  const CHART = {
    x: 72,
    y: 200,
    width: 400,
    height: 300,
    content: {
      kind: "image" as const,
      image: { mime: "image/png", width: 800, height: 600, bytes: 51_200 },
    },
  };
  const typed = (figures: PageFigure[]) =>
    ({
      kind: "text" as const,
      runs: [
        { text: "Figure 1 follows", x: 72, y: 96, width: 180, height: 12, size: 11 },
        { text: "as the chart shows", x: 72, y: 560, width: 190, height: 12, size: 11 },
      ],
      figures,
    }) satisfies PageContent;

  /** The body's children in order, as "text" / "figure" — the reading order. */
  const shapeOf = (leaf: HTMLElement): string[] =>
    [...leaf.querySelector(".leaf-body")!.children].map((el) =>
      el.classList.contains("leaf-figure") ? "figure" : "text",
    );

  it("is drawn at all, which is the bug", () => {
    const leaf = leafOf(arrived(typed([CHART]), null, 1, ["blob:chart"]));
    const image = leaf.querySelector<HTMLImageElement>(".leaf-figure-image");
    expect(image?.getAttribute("src")).toBe("blob:chart");
  });

  it("sits between the line above it and the line below it", () => {
    const leaf = leafOf(arrived(typed([CHART]), null, 1, ["blob:chart"]));
    expect(shapeOf(leaf)).toEqual(["text", "figure", "text"]);
    // And the text is all still there, in its own order, with nothing under the
    // picture: in-flow is chosen precisely so that nothing is ever hidden.
    expect(bodyOf(leaf)).toBe("Figure 1 followsas the chart shows");
  });

  it("goes first when it was above every line", () => {
    const leaf = leafOf(
      arrived(typed([{ ...CHART, y: 40 }]), null, 1, ["blob:chart"]),
    );
    expect(shapeOf(leaf)).toEqual(["figure", "text"]);
  });

  it("goes last when it was below every line", () => {
    const leaf = leafOf(
      arrived(typed([{ ...CHART, y: 700 }]), null, 1, ["blob:chart"]),
    );
    expect(shapeOf(leaf)).toEqual(["text", "figure"]);
  });

  it("is ordered down the page rather than by the order it was drawn in", () => {
    // Content-stream order is not top-to-bottom order — a figure written last
    // can sit at the head of the page — and reading order is what this builds.
    const leaf = leafOf(
      arrived(typed([{ ...CHART, y: 700 }, { ...CHART, y: 40 }]), null, 1, [
        "blob:low",
        "blob:high",
      ]),
    );
    expect(shapeOf(leaf)).toEqual(["figure", "text", "figure"]);
    const images = [...leaf.querySelectorAll<HTMLImageElement>(".leaf-figure-image")];
    // And each one still has *its own* bytes: `figureUrls` is index for index
    // with `figures`, and sorting for the reading must not disturb that pairing.
    expect(images.map((one) => one.getAttribute("src"))).toEqual(["blob:high", "blob:low"]);
  });

  it("is as wide a share of the measure as it was on the page it came off", () => {
    // The measure and not the page width: the runs above span 72..262, so a
    // 400pt figure is wider than the type area and clamps to it. Mapping
    // through the page's 595pt instead would draw a full-measure chart at
    // three quarters of the text it sits between.
    const leaf = leafOf(arrived(typed([{ ...CHART, width: 95 }]), null, 1, ["blob:chart"]));
    const box = leaf.querySelector<HTMLElement>(".leaf-figure")!;
    expect(box.style.width).toBe("50.00%");
    expect(box.style.aspectRatio).toBe("95 / 300");
  });

  it("holds its place and says why when the shell could not lift it", () => {
    // `document.rs` reports a figure it could not lift with its box and the
    // reason rather than dropping it. Dropping it here instead would be that
    // same silence one module further along — and a blank space where an
    // exhibit was is what the whole five-armed union exists to stop.
    const leaf = leafOf(
      arrived(
        typed([
          { ...CHART, content: { kind: "unsupported", reason: "the figure is a JPX image" } },
        ]),
        null,
        1,
        [null],
      ),
    );
    const box = leaf.querySelector<HTMLElement>(".leaf-figure")!;
    expect(box.dataset["figure"]).toBe("unsupported");
    expect(box.querySelector(".leaf-figure-note")!.textContent).toBe("the figure is a JPX image");
  });

  it("says so when a figure it could read brought back no bytes", () => {
    const leaf = leafOf(arrived(typed([CHART]), null, 1, [null]));
    const box = leaf.querySelector<HTMLElement>(".leaf-figure")!;
    expect(box.dataset["figure"]).toBe("unreadable");
    expect(box.querySelector(".leaf-figure-note")!.textContent).toMatch(/could not be read/);
    expect(box.querySelector("img")).toBeNull();
  });

  /**
   * And it is in the export, which is not a separate feature — an open folder
   * exports with its page drawn (T-278), and this board has already shipped a
   * composite that dropped everything with no painter behind it.
   *
   * Nothing was written for this: a figure is an `<img>` in the leaf's subtree,
   * so it goes down the road the photographs and the lifted scan already take.
   * The test is here because "it comes for free" is a claim about somebody
   * else's code, and this is the assertion that says it is still true.
   */
  it("is carried into an export like every other picture on the board", async () => {
    const layer = layerFor(() => arrived(typed([CHART]), null, 1, ["blob:chart"]));
    put();
    scene.setOpen("a", 1);
    layer.sync(scene, dirty, null);

    const clone = cloneForExport(host.querySelector(".item")!);
    const cost = await inlineAssets(clone, async (url) => {
      expect(url).toBe("blob:chart");
      return { bytes: new Uint8Array([0x89, 0x50]), mime: "image/png" };
    });

    expect(cost.inlined).toBe(1);
    expect(clone.querySelector(".leaf-figure-image")!.getAttribute("src")).toBe(
      `data:image/png;base64,${btoa("\x89\x50")}`,
    );
  });

  it("leaves a page with no figures on it exactly as it was", () => {
    // The common page in every filing. It is written straight onto the body
    // with no wrapper at all, which is what keeps `writeHand`'s guard in front
    // of it — and what stops every page in a two-hundred-page scan carrying an
    // element it has no use for.
    const leaf = leafOf(arrived(typed([])));
    expect(leaf.querySelector(".leaf-body")!.children).toHaveLength(0);
    expect(bodyOf(leaf)).toBe("Figure 1 follows\nas the chart shows");
  });
});

describe("a page with nothing readable on it", () => {
  it("says a blank page is blank rather than drawing a blank page", () => {
    const leaf = leafOf(arrived({ kind: "empty" }));
    expect(leaf.dataset["page"]).toBe("empty");
    expect(noteOf(leaf)).toMatch(/blank/);
    expect(bodyOf(leaf)).toBe("");
  });

  it("names what stopped it rather than passing it off as empty", () => {
    const leaf = leafOf(arrived({ kind: "unsupported", reason: "the page is a JPEG 2000 image" }));
    expect(leaf.dataset["page"]).toBe("unsupported");
    expect(noteOf(leaf)).toBe("the page is a JPEG 2000 image");
  });

  it("carries the shell's own sentence when the document will not open", () => {
    const leaf = leafOf({
      phase: "unreadable",
      page: null,
      reason: "the document is password protected",
      imageUrl: null,
      figureUrls: [],
    });
    expect(leaf.dataset["page"]).toBe("unreadable");
    expect(noteOf(leaf)).toBe("the document is password protected");
  });

  it("says nothing at all while the page is still coming", () => {
    // Deliberately not a message. A page arrives in a handful of milliseconds
    // off a document the shell already has open, and a word that appears and
    // vanishes at that rate is a flicker rather than information.
    const leaf = leafOf({ phase: "reading", page: null, reason: null, imageUrl: null, figureUrls: [] });
    expect(leaf.dataset["page"]).toBe("reading");
    expect(noteOf(leaf)).toBe("");
    expect(bodyOf(leaf)).toBe("");
  });
});

describe("when a page is asked for at all", () => {
  it("is never asked for while the folder is shut", () => {
    // Asking is what fetches, so a lookup on a folder nobody is reading is not
    // a wasted call — it is a document held open in the shell.
    let asked = 0;
    const layer = layerFor(() => {
      asked++;
      return null;
    });
    put();
    layer.sync(scene, dirty, null);
    expect(asked).toBe(0);

    scene.setOpen("a", 1);
    dirty.item("a");
    layer.sync(scene, dirty, null);
    expect(asked).toBeGreaterThan(0);
  });

  it("is put away when the folder is shut, so the next one does not inherit it", () => {
    let open = true;
    const view = arrived({ kind: "plain", text: "the fourth witness" });
    const layer = layerFor(() => (open ? view : null));
    put();
    scene.setOpen("a", 1);
    layer.sync(scene, dirty, null);
    expect(host.querySelector(".leaf-body")!.textContent).toBe("the fourth witness");

    open = false;
    scene.setOpen(null, 0);
    dirty.item("a");
    layer.sync(scene, dirty, null);
    expect(host.querySelector(".leaf-body")!.textContent).toBe("");
  });
});

describe("the face a page is set in", () => {
  it("is the board's hand unless the document asks otherwise", () => {
    expect(leafOf(arrived({ kind: "plain", text: "x" })).dataset["face"]).toBe("hand");
  });

  it("is the clean face when it does — AC-678", () => {
    // `style.fontFamily`, which is the field DESIGN section 3.6 already has and
    // T-225 already gave a home, rather than a second per-document preference
    // that would have to be kept in step with it.
    const leaf = leafOf(arrived({ kind: "plain", text: "x" }), {
      style: { fontFamily: "clean" },
    });
    expect(leaf.dataset["face"]).toBe("clean");
  });
});

describe("the header, while a page is open", () => {
  it("says which page you are on, out of how many — T-321", () => {
    // "3 of 51" and not "3": a page reference means nothing without the
    // document's length beside it, and the two together are what a citation
    // carries (D-60 — the reference is `(sha256, page)`).
    const layer = layerFor(() => arrived({ kind: "plain", text: "x" }, null, 3));
    put();
    scene.setOpen("a", 1);
    layer.sync(scene, dirty, null);
    expect(host.querySelector(".leaf-meta")!.textContent).toBe("3 of 4");
  });

  it("gives the slot back to the page count when the folder is shut", () => {
    let open = true;
    const layer = layerFor(() => (open ? arrived({ kind: "plain", text: "x" }, null, 2) : null));
    put();
    scene.setOpen("a", 1);
    layer.sync(scene, dirty, null);
    expect(host.querySelector(".leaf-meta")!.textContent).toBe("2 of 4");

    open = false;
    scene.setOpen(null, 0);
    dirty.item("a");
    layer.sync(scene, dirty, null);
    // A shut folder says how thick it is, which is the fact its tab carries.
    expect(host.querySelector(".leaf-meta")!.textContent).toBe("4 pp.");
  });

  it("never claims fewer pages than the one being read", () => {
    // A document counted by a machine that could not count it reads `null`, and
    // "3 of 1" would be a worse answer than "3 of 3".
    const layer = new DomItemLayer(
      host,
      asset,
      () => ({ ...NO_FACTS, kind: "document", pages: null }),
      undefined,
      () => arrived({ kind: "plain", text: "x" }, null, 3),
    );
    put();
    scene.setOpen("a", 1);
    layer.sync(scene, dirty, null);
    expect(host.querySelector(".leaf-meta")!.textContent).toBe("3 of 3");
  });
});
