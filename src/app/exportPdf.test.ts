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
 * what the stage looked like *at the instant `print` was called* — recorded
 * from inside the print — and about what it looks like after every way this can
 * end, including the two that are not success.
 */

import { describe, expect, it, vi } from "vitest";

import { exportPdf, type Stage } from "@/app/exportPdf";
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

/** The camera as it stands, for comparing against where it started. */
const pose = (stage: Stage): Record<string, number> => ({ ...stage.camera });

describe("a board with nothing on it", () => {
  it("is not an export, and nothing is touched", async () => {
    const r = recorder();
    const print = vi.fn();

    const outcome = await exportPdf(r.stage, null, "Board", print);

    expect(outcome).toEqual({ done: "empty" });
    expect(print).not.toHaveBeenCalled();
    expect(r.holds).toBe(0);
    expect(r.canvases).toEqual([]);
    expect(pose(r.stage)).toEqual({ x: 100, y: 50, zoom: 1, width: 1440, height: 900, version: 7 });
  });
});

describe("what the board looks like at the moment it is printed", () => {
  /**
   * The one that matters. A print lays out at the paper width and fires no
   * resize, so if the pose is not already in place when `print` is called the
   * file is the board as it was — which is exactly how the first PDF came out
   * (D-36).
   */
  it("is posed for the page, not for the window", async () => {
    const r = recorder();
    let atPrint: Record<string, number> | null = null;
    let heldAtPrint = 0;
    let canvasesAtPrint: Array<[number, number]> = [];

    await exportPdf(r.stage, board(0, 0, 2000, 1000), "Board", async (page): Promise<string> => {
      atPrint = pose(r.stage);
      heldAtPrint = r.holds - r.releases;
      canvasesAtPrint = [...r.canvases];
      expect(page.width).toBeCloseTo((2000 + 2 * 48) / 96, 5);
      return "C:/somewhere/Board.pdf";
    });

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

    await exportPdf(r.stage, board(0, 0, 800, 600), "Board", async () => {
      framesAtPrint = r.framesAwaited;
      redrawsAtPrint = r.redraws;
      return "C:/somewhere/Board.pdf";
    });

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

    await exportPdf(r.stage, board(0, 0, 800, 600), "Board", async () => {
      versionAtPrint = r.stage.camera.version;
      return "C:/somewhere/Board.pdf";
    });

    expect(versionAtPrint).toBe(8);
  });

  it("has re-rastered the ink for the scale it is about to be printed at", async () => {
    const r = recorder();
    let settledAtPrint: number[] = [];

    await exportPdf(r.stage, board(0, 0, 4000, 4000), "Board", async () => {
      settledAtPrint = [...r.settled];
      return "C:/somewhere/Board.pdf";
    });

    expect(settledAtPrint).toEqual([r.stage.camera.zoom]);
  });
});

describe("what crosses to the shell", () => {
  it("is a page in inches and a name, and never a path", async () => {
    const r = recorder();
    const seen: PdfPage[] = [];

    await exportPdf(r.stage, board(0, 0, 1920, 960), "Holiday plans", async (page) => {
      seen.push(page);
      return "C:/somewhere/Holiday plans.pdf";
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].title).toBe("Holiday plans");
    // 1920 + 96 of margin at 96 CSS pixels to the inch.
    expect(seen[0].width).toBeCloseTo(21, 5);
    expect(seen[0].height).toBeCloseTo(11, 5);
    expect(Object.keys(seen[0]).sort()).toEqual(["height", "title", "width"]);
  });

  it("reports where it went, and how big the page was", async () => {
    const r = recorder();

    const outcome = await exportPdf(
      r.stage,
      board(0, 0, 1920, 960),
      "Board",
      async () => "C:/somewhere/Board.pdf",
    );

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

    const outcome = await exportPdf(
      r.stage,
      board(0, 0, 40_000, 20_000),
      "Board",
      async () => "C:/somewhere/Board.pdf",
    );

    if (outcome.done !== "saved") throw new Error(`expected a saved file, got ${outcome.done}`);
    expect(outcome.view.reduced).toBe(true);
    expect(outcome.view.inches.width).toBeLessThanOrEqual(200);
  });
});

describe("the board afterwards", () => {
  it("is exactly where it was, after a file was written", async () => {
    const r = recorder();
    const before = pose(r.stage);

    await exportPdf(
      r.stage,
      board(0, 0, 2000, 1000),
      "Board",
      async () => "C:/somewhere/Board.pdf",
    );

    expect(pose(r.stage)).toEqual({ ...before, version: 9 });
    expect(r.canvases.at(-1)).toEqual([1440, 900]);
    expect(r.settled.at(-1)).toBe(1);
    expect(r.holds).toBe(1);
    expect(r.releases).toBe(1);
  });

  it("is exactly where it was, after the dialog was cancelled", async () => {
    const r = recorder();
    const before = pose(r.stage);

    const outcome = await exportPdf(r.stage, board(0, 0, 2000, 1000), "Board", async () => null);

    expect(outcome).toEqual({ done: "cancelled" });
    expect(pose(r.stage)).toEqual({ ...before, version: 9 });
    expect(r.canvases.at(-1)).toEqual([1440, 900]);
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
      exportPdf(r.stage, board(0, 0, 2000, 1000), "Board", async () => {
        throw new Error("this WebView2 runtime cannot print to PDF");
      }),
    ).rejects.toThrow("cannot print to PDF");

    expect(pose(r.stage)).toEqual({ ...before, version: 9 });
    expect(r.canvases.at(-1)).toEqual([1440, 900]);
    expect(r.releases).toBe(1);
  });
});
