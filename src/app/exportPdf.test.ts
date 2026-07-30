/**
 * The moment a print happens in.
 *
 * Every failure this guards against is invisible in the application and only
 * shows up in a file somebody was handed, or in the board *afterwards*:
 *
 *   - a print taken before the pose reached the screen, which is the board as
 *     it was and not as the page needs it;
 *   - a camera left at the export view, which reads as the board teleporting;
 *   - a detail tier held at `full` for ever, which is T-90's whole performance
 *     argument silently undone.
 *
 * So the interesting assertions are not about the return value. They are about
 * what the stage looked like *at the instant `write` was called* — recorded
 * from inside the write — and about what it looks like after every way this can
 * end, including the two that are not success.
 */

import { describe, expect, it, vi } from "vitest";

import { phaseTicks, phraseFor, type ExportPhase } from "@/app/export";
import { exportPdf, type PdfWriter, type Stage } from "@/app/exportPdf";
import type { PdfPage } from "@/platform/types";
import type { Bounds } from "@/state/scene";

const board = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

interface Recorder {
  stage: Stage;
  /** Canvas sizes, in the order they were asked for. */
  readonly canvases: Array<[number, number]>;
  readonly settled: number[];
  redraws: number;
  framesAwaited: number;
  holds: number;
  releases: number;
}

/**
 * A stage that records rather than draws, starting from an ordinary window: a
 * 1440 x 900 viewport looking at the board from (100, 50) at 1:1.
 */
function recorder(): Recorder {
  const canvases: Array<[number, number]> = [];
  const settled: number[] = [];
  const out: Recorder = {
    stage: {
      camera: { x: 100, y: 50, zoom: 1, width: 1440, height: 900, version: 7 },
      resizeCanvases: (width: number, height: number) => void canvases.push([width, height]),
      hold: () => {
        out.holds += 1;
        return () => void (out.releases += 1);
      },
      settle: (zoom: number) => void settled.push(zoom),
      redraw: () => void (out.redraws += 1),
      frames: async (count: number) => void (out.framesAwaited += count),
    },
    canvases,
    settled,
    redraws: 0,
    framesAwaited: 0,
    holds: 0,
    releases: 0,
  };
  return out;
}

/** A shell that agrees to the dialog and writes wherever it is told. */
function writer(write: PdfWriter["write"] = async () => "C:/somewhere/Board.pdf"): PdfWriter {
  return { choose: async () => true, write };
}

/** The camera as it stands, for comparing against where it started. */
const pose = (stage: Stage): Record<string, number> => ({ ...stage.camera });

/** Untouched: the stage as `recorder` built it, nothing called on it. */
const untouched = (r: Recorder): void => {
  expect(pose(r.stage)).toEqual({ x: 100, y: 50, zoom: 1, width: 1440, height: 900, version: 7 });
  expect(r.holds).toBe(0);
  expect(r.canvases).toEqual([]);
  expect(r.settled).toEqual([]);
  expect(r.redraws).toBe(0);
};

describe("a board with nothing on it", () => {
  it("is not an export, and nobody is asked where to put it", async () => {
    const r = recorder();
    const choose = vi.fn(async () => true);
    const write = vi.fn(async () => "C:/somewhere/Board.pdf");

    const outcome = await exportPdf(r.stage, null, "Board", { choose, write });

    expect(outcome).toEqual({ done: "empty" });
    expect(choose).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    untouched(r);
  });
});

describe("what the board looks like at the moment it is printed", () => {
  /**
   * The one that matters. A print lays out at the paper width and fires no
   * resize, so if the pose is not already in place when `write` is called the
   * file is the board as it was — which is exactly how the first PDF came out
   * (D-36).
   */
  it("is posed for the page, not for the window", async () => {
    const r = recorder();
    let atPrint: Record<string, number> | null = null;
    let heldAtPrint = 0;
    let canvasesAtPrint: Array<[number, number]> = [];

    await exportPdf(
      r.stage,
      board(0, 0, 2000, 1000),
      "Board",
      writer(async (page): Promise<string> => {
        atPrint = pose(r.stage);
        heldAtPrint = r.holds - r.releases;
        canvasesAtPrint = [...r.canvases];
        expect(page.width).toBeCloseTo((2000 + 2 * 48) / 96, 5);
        return "C:/somewhere/Board.pdf";
      }),
    );

    // 2000 x 1000 of board plus a 48-unit margin either side, at the scale of 1
    // `exportPage` uses — the page is the board and the camera is derived from
    // the page (T-205).
    expect(atPrint).toEqual({ x: -48, y: -48, zoom: 1, width: 2096, height: 1096, version: 8 });
    expect(heldAtPrint).toBe(1);
    expect(canvasesAtPrint).toEqual([[2096, 1096]]);
  });

  it("has had frames to settle in, and has been told to draw them", async () => {
    const r = recorder();
    let framesAtPrint = 0;
    let redrawsAtPrint = 0;

    await exportPdf(
      r.stage,
      board(0, 0, 800, 600),
      "Board",
      writer(async () => {
        framesAtPrint = r.framesAwaited;
        redrawsAtPrint = r.redraws;
        return "C:/somewhere/Board.pdf";
      }),
    );

    expect(framesAtPrint).toBeGreaterThanOrEqual(3);
    expect(redrawsAtPrint).toBe(1);
  });

  /**
   * The camera fields are written past the setter that would have bumped
   * `version`, and `version` is what the render loop compares against to decide
   * a frame is worth drawing. Without the bump the pose never reaches the
   * screen and the print is of the board exactly as it was — the same file the
   * broken case above produces, from a different cause.
   */
  it("has told the render loop the camera moved", async () => {
    const r = recorder();
    let versionAtPrint = 0;

    await exportPdf(
      r.stage,
      board(0, 0, 800, 600),
      "Board",
      writer(async () => {
        versionAtPrint = r.stage.camera.version;
        return "C:/somewhere/Board.pdf";
      }),
    );

    expect(versionAtPrint).toBe(8);
  });

  it("has re-rastered the ink for the scale it is about to be printed at", async () => {
    const r = recorder();
    let settledAtPrint: number[] = [];

    await exportPdf(
      r.stage,
      board(0, 0, 4000, 4000),
      "Board",
      writer(async () => {
        settledAtPrint = [...r.settled];
        return "C:/somewhere/Board.pdf";
      }),
    );

    expect(settledAtPrint).toEqual([r.stage.camera.zoom]);
  });
});

describe("what crosses to the shell", () => {
  it("is a name first, and then a page in inches — never a path", async () => {
    const r = recorder();
    const seen: PdfPage[] = [];
    const asked: string[] = [];

    await exportPdf(r.stage, board(0, 0, 1920, 960), "Holiday plans", {
      choose: async (title) => {
        asked.push(title);
        return true;
      },
      write: async (page) => {
        seen.push(page);
        return "C:/somewhere/Holiday plans.pdf";
      },
    });

    expect(asked).toEqual(["Holiday plans"]);
    expect(seen).toHaveLength(1);
    // 1920 + 96 of margin at 96 CSS pixels to the inch.
    expect(seen[0].width).toBeCloseTo(21, 5);
    expect(seen[0].height).toBeCloseTo(11, 5);
    // The page and nothing else. A path in either direction is the one thing
    // ARCHITECTURE section 4.4 does not allow across this boundary.
    expect(Object.keys(seen[0]).sort()).toEqual(["height", "width"]);
  });

  it("reports where it went, and how big the page was", async () => {
    const r = recorder();

    const outcome = await exportPdf(r.stage, board(0, 0, 1920, 960), "Board", writer());

    expect(outcome.done).toBe("saved");
    if (outcome.done !== "saved") return;
    expect(outcome.path).toBe("C:/somewhere/Board.pdf");
    expect(outcome.view.inches.width).toBeCloseTo(21, 5);
    expect(outcome.view.reduced).toBe(false);
  });

  /**
   * A board wider than 200 inches — the PDF format's own limit — comes out at a
   * lower scale rather than cropped, and says so. The caller is what turns that
   * into words for the person about to hand the file over.
   */
  it("says when a ceiling brought the scale down", async () => {
    const r = recorder();

    const outcome = await exportPdf(r.stage, board(0, 0, 40_000, 20_000), "Board", writer());

    if (outcome.done !== "saved") throw new Error(`expected a saved file, got ${outcome.done}`);
    expect(outcome.view.reduced).toBe(true);
    expect(outcome.view.inches.width).toBeLessThanOrEqual(200);
  });
});

describe("a cancelled dialog", () => {
  /**
   * Q-132's answer, and the reason the shell's side is two commands. Asking
   * first means cancelling is free: no pose, no re-pose, and no window zooming
   * out to its own bounds while somebody is typing a filename.
   */
  it("never moves the board at all", async () => {
    const r = recorder();
    const write = vi.fn(async () => "C:/somewhere/Board.pdf");

    const outcome = await exportPdf(r.stage, board(0, 0, 2000, 1000), "Board", {
      choose: async () => false,
      write,
    });

    expect(outcome).toEqual({ done: "cancelled" });
    expect(write).not.toHaveBeenCalled();
    untouched(r);
  });

  it("is not confused with a shell that could not open a dialog", async () => {
    const r = recorder();

    await expect(
      exportPdf(r.stage, board(0, 0, 2000, 1000), "Board", {
        choose: async () => {
          throw new Error("Exporting a board as a PDF needs the native shell");
        },
        write: async () => "C:/somewhere/Board.pdf",
      }),
    ).rejects.toThrow("needs the native shell");

    untouched(r);
  });
});

describe("the board afterwards", () => {
  it("is exactly where it was, after a file was written", async () => {
    const r = recorder();
    const before = pose(r.stage);

    await exportPdf(r.stage, board(0, 0, 2000, 1000), "Board", writer());

    expect(pose(r.stage)).toEqual({ ...before, version: 9 });
    expect(r.canvases.at(-1)).toEqual([1440, 900]);
    expect(r.settled.at(-1)).toBe(1);
    expect(r.holds).toBe(1);
    expect(r.releases).toBe(1);
  });

  /**
   * The expensive one. A print that throws — an old WebView2 runtime, a folder
   * that refuses the write — leaves a board zoomed out to its own bounds and a
   * tier held at `full`, and nothing on screen says why. The `finally` is the
   * whole reason this is not a sequence of statements.
   */
  it("is exactly where it was, after the print threw", async () => {
    const r = recorder();
    const before = pose(r.stage);

    await expect(
      exportPdf(
        r.stage,
        board(0, 0, 2000, 1000),
        "Board",
        writer(async () => {
          throw new Error("this WebView2 runtime cannot print to PDF");
        }),
      ),
    ).rejects.toThrow("cannot print to PDF");

    expect(pose(r.stage)).toEqual({ ...before, version: 9 });
    expect(r.canvases.at(-1)).toEqual([1440, 900]);
    expect(r.releases).toBe(1);
  });
});

/**
 * The progress line, on the route where this side can say least about it.
 *
 * Everything slow about a print happens on the far side of one command: the
 * board is posed here, and then Chromium lays the document out and writes the
 * file with nothing coming back until it is done. So the only honest thing to
 * say is that it has started — which is exactly why it has to be said *before*
 * the command goes out rather than after.
 */
describe("saying how far along a print is", () => {
  it("reports the framing and then the printing, in that order", async () => {
    const r = recorder();
    const seen: ExportPhase[] = [];

    await exportPdf(r.stage, board(0, 0, 400, 300), "Board", writer(), {}, (p) => seen.push(p));

    expect(seen.map((p) => p.at)).toEqual(["framing", "printing"]);
  });

  it("says it is framing before the board has moved", async () => {
    const r = recorder();
    const seen: Array<[string, number]> = [];

    await exportPdf(r.stage, board(0, 0, 400, 300), "Board", writer(), {}, (p) =>
      seen.push([p.at, r.stage.camera.zoom]),
    );

    // The window's own zoom, not the page's: nothing has been posed yet.
    expect(seen[0]).toEqual(["framing", 1]);
  });

  /**
   * A print that appeared to start only once it had finished would be a
   * caption. This is the whole point of the phase on this route — there is no
   * second thing to report.
   */
  it("says it is printing while the print is happening", async () => {
    const r = recorder();
    const seen: ExportPhase[] = [];
    const duringWrite: string[] = [];

    await exportPdf(
      r.stage,
      board(0, 0, 400, 300),
      "Board",
      {
        choose: async () => true,
        write: async () => {
          duringWrite.push(...seen.map((p) => p.at));
          return "C:/somewhere/Board.pdf";
        },
      },
      {},
      (p) => seen.push(p),
    );

    expect(duringWrite).toEqual(["framing", "printing"]);
  });

  it("says nothing at all when the dialog is closed", async () => {
    const r = recorder();
    const seen: ExportPhase[] = [];

    await exportPdf(
      r.stage,
      board(0, 0, 400, 300),
      "Board",
      { choose: async () => false, write: async () => "never" },
      {},
      (p) => seen.push(p),
    );

    expect(seen).toEqual([]);
  });

  it("reports the framing even when the print then fails", async () => {
    const r = recorder();
    const seen: ExportPhase[] = [];

    await expect(
      exportPdf(
        r.stage,
        board(0, 0, 400, 300),
        "Board",
        writer(async () => {
          throw new Error("the webview could not write Board.pdf");
        }),
        {},
        (p) => seen.push(p),
      ),
    ).rejects.toThrow(/could not write/);

    expect(seen.map((p) => p.at)).toEqual(["framing", "printing"]);
    // And the board is back, which is the thing a failed print must not cost.
    expect(r.releases).toBe(1);
  });

  /**
   * The print is opaque and slow, so it earns a clock for the same reason the
   * image route's encode does. The framing does not: it is three frames.
   */
  it("is one of the two phases long enough to need a clock", () => {
    expect(phaseTicks({ at: "printing" })).toBe(true);
    expect(phaseTicks({ at: "framing" })).toBe(false);
    // And it carries no ellipsis, because a count of seconds is appended to it.
    expect(phraseFor({ at: "printing" })).not.toContain("…");
    expect(phraseFor({ at: "printing" })).toMatch(/print/i);
  });
});
