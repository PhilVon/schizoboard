/**
 * The composite: what gets drawn, in what order, and what happens to the board
 * while it is happening.
 *
 * Nothing here draws anything — the painters are recorders. What is worth
 * checking is the arrangement around them, and it is worth checking because
 * every way it can go wrong is a picture that still looks like a board. A layer
 * left out is a board with no strings on it. A layer out of order is a string
 * in front of a photograph it passes behind. A pose that is not put back is a
 * board that has apparently teleported, minutes after the export that did it.
 */

import { describe, expect, it, vi } from "vitest";

import type { Bounds } from "@/state/scene";

import type { ImageFormat } from "@/platform/types";

import {
  exportImage,
  MAX_WEBP_PIXELS,
  MAX_WEBP_SIDE,
  phraseFor,
  type ExportPhase,
  type BoardPainter,
  type ImageStage,
  type ImageWriter,
} from "@/app/exportImage";

const board = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

interface Recorder {
  stage: ImageStage;
  /** Every canvas the composite asked for, by size. */
  readonly canvases: Array<[number, number]>;
  /** Painter names, in the order they were actually called. */
  readonly drawn: string[];
  readonly settled: number[];
  redraws: number;
  holds: number;
  releases: number;
  encoded: number;
  /** Which format each encode was asked for. */
  readonly encodedAs: ImageFormat[];
  /** The canvas the encoder was handed. */
  encodedSize: [number, number];
  /** What `measure` should claim came out, when a test wants them to differ. */
  measured?: { width: number; height: number };
  clock: number;
}

/** A painter that records and, optionally, takes a turn of the loop to do it —
 *  the composite has to hold its order across an await, not just across a call. */
function painter(name: string, drawn: string[], slow = false): BoardPainter {
  return {
    name,
    paint: async () => {
      if (slow) await Promise.resolve();
      drawn.push(name);
    },
  };
}

/**
 * A stage that records rather than draws, starting from an ordinary window: a
 * 1440 × 900 viewport looking at the board from (100, 50) at 1:1.
 */
function recorder(
  names: readonly string[] = ["cork", "ink", "ropes-under", "items", "ropes-over"],
  custom?: (drawn: string[]) => BoardPainter[],
): Recorder {
  const canvases: Array<[number, number]> = [];
  const drawn: string[] = [];
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
      frames: async () => {},
      // A clock that ticks a known amount per call, so the timings are a fact
      // rather than a number that changes every run.
      now: () => (out.clock += 10),
      canvas: (width: number, height: number) => {
        canvases.push([width, height]);
        return { width, height, getContext: () => ({}) } as unknown as HTMLCanvasElement;
      },
      // Every other painter is slow, so they all are: this is the arrangement
      // where an ordering bug would show.
      painters: custom ? custom(drawn) : names.map((name, i) => painter(name, drawn, i % 2 === 0)),
      encode: async (canvas, format) => {
        out.encoded += 1;
        out.encodedAs.push(format);
        out.encodedSize = [canvas.width, canvas.height];
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      },
      // An honest encoder by default: it gives back what it was given. The
      // truncating one is built per-test.
      measure: async () =>
        out.measured ?? { width: out.encodedSize[0], height: out.encodedSize[1] },
    },
    canvases,
    drawn,
    settled,
    redraws: 0,
    holds: 0,
    releases: 0,
    encoded: 0,
    encodedAs: [],
    encodedSize: [0, 0],
    clock: 0,
  };
  return out;
}

const writer = (
  write: ImageWriter["write"] = async () => "C:/somewhere/Board.png",
  format: ImageFormat = "png",
): ImageWriter => ({
  choose: async () => format,
  write,
});

const pose = (stage: ImageStage): Record<string, number> => ({ ...stage.camera });

describe("a board with nothing on it", () => {
  it("is not an export, and nobody is asked where to put it", async () => {
    const r = recorder();
    const choose = vi.fn(async (): Promise<ImageFormat | null> => "png");
    const write = vi.fn(async () => "C:/somewhere/Board.png");

    expect(await exportImage(r.stage, null, "Board", { choose, write })).toEqual({ done: "empty" });
    expect(choose).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(r.holds).toBe(0);
    expect(r.drawn).toEqual([]);
  });
});

describe("the dialog comes before the board moves", () => {
  /**
   * A cancelled export has to cost nothing and show nothing. Posing first would
   * mean the board zooms out to its own bounds while somebody is still typing a
   * filename, and then zooms back when they think better of it.
   */
  it("leaves the board exactly where it was when the dialog is closed", async () => {
    const r = recorder();
    const before = pose(r.stage);

    const outcome = await exportImage(r.stage, board(0, 0, 400, 300), "Board", {
      choose: async () => null,
      write: async () => "never",
    });

    expect(outcome).toEqual({ done: "cancelled" });
    expect(pose(r.stage)).toEqual(before);
    expect(r.holds).toBe(0);
    expect(r.canvases).toEqual([]);
    expect(r.drawn).toEqual([]);
    expect(r.encoded).toBe(0);
  });
});

describe("the composite", () => {
  it("draws every painter it was given, in the order it was given them", async () => {
    const r = recorder();
    await exportImage(r.stage, board(0, 0, 400, 300), "Board", writer());
    expect(r.drawn).toEqual(["cork", "ink", "ropes-under", "items", "ropes-over"]);
  });

  /**
   * The one readout that can tell a layer that drew nothing from a layer that
   * was never wired in. A missing painter leaves no trace in the file — the
   * board simply has no strings on it, and looks like a board with no strings.
   */
  it("says which painters reached the file", async () => {
    const r = recorder(["cork", "items"]);
    const outcome = await exportImage(r.stage, board(0, 0, 400, 300), "Board", writer());
    expect(outcome).toMatchObject({
      done: "saved",
      painted: [
        { name: "cork", ms: 10 },
        { name: "items", ms: 10 },
      ],
    });
  });

  /**
   * An export of a large board takes minutes rather than seconds, and every
   * painter is somebody else's module behind one `await` — so without this
   * there is no answer at all to "which part of it".
   */
  it("says what the encode cost and how big the file came out", async () => {
    const r = recorder(["cork"]);
    const outcome = await exportImage(r.stage, board(0, 0, 400, 300), "Board", writer());
    expect(outcome).toMatchObject({ done: "saved", encodeMs: 10, bytes: 4 });
  });

  it("draws into a canvas the size of the export view, and hands over what it encoded", async () => {
    const r = recorder();
    const write = vi.fn(async () => "C:/somewhere/Board.png");

    const outcome = await exportImage(r.stage, board(0, 0, 400, 300), "Board", writer(write), {
      scale: 2,
    });

    if (outcome.done !== "saved") throw new Error("expected a saved export");
    // 400 × 300 plus the margin on each side, at 2 pixels a unit.
    expect(r.canvases).toContainEqual([outcome.view.width, outcome.view.height]);
    expect(r.encoded).toBe(1);
    expect(write).toHaveBeenCalledWith(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(outcome.path).toBe("C:/somewhere/Board.png");
  });

  /**
   * The painters run at the export camera, not at the window's. Reading it
   * inside a painter is the only way to see that — by the time the export
   * returns the board is back where it started, which is the whole point.
   */
  it("has the board posed at the export view while the painters run", async () => {
    const seen: Array<Record<string, number>> = [];
    const r = recorder([], () => [
      { name: "spy", paint: async () => void seen.push(pose(r.stage)) },
    ]);

    const outcome = await exportImage(r.stage, board(0, 0, 400, 300), "Board", writer());
    if (outcome.done !== "saved") throw new Error("expected a saved export");

    expect(seen[0]).toMatchObject({
      x: outcome.view.x,
      y: outcome.view.y,
      zoom: outcome.view.zoom,
      width: outcome.view.width,
      height: outcome.view.height,
    });
    // And back where it started by the time anybody could look.
    expect(pose(r.stage)).toMatchObject({ x: 100, y: 50, zoom: 1, width: 1440, height: 900 });
  });

  /**
   * A `hold` never released is T-90's performance work silently undone, and a
   * camera left at the export view is a board that has apparently teleported.
   * Neither looks like an export failing.
   */
  it("puts the board back and lets the tier go even when a painter throws", async () => {
    const r = recorder([], () => [
      {
        name: "broken",
        paint: async () => {
          throw new Error("no");
        },
      },
    ]);
    const before = pose(r.stage);

    await expect(
      exportImage(r.stage, board(0, 0, 400, 300), "Board", writer()),
    ).rejects.toThrow("no");

    expect(r.releases).toBe(1);
    expect(pose(r.stage)).toEqual({ ...before, version: before.version! + 2 });
    expect(r.settled.at(-1)).toBe(1);
  });
});

/**
 * The dialog chooses the format, and the format changes what may be asked for.
 *
 * PNG's ceiling is the canvas's — 268 megapixels, measured. WebP's is its own
 * and lower, and it is *not* a limit on the dimensions, which was the obvious
 * guess: a flat 16384 × 16384 encodes fine. What Chromium gives up on is
 * photographic content at scale, and it gives up by handing back `null` — a
 * blank where the board should be, from a call that did not fail.
 */
describe("which file it turns out to be", () => {
  it("encodes as whatever the dialog settled on", async () => {
    const r = recorder(["cork"]);
    const outcome = await exportImage(
      r.stage,
      board(0, 0, 400, 300),
      "Board",
      writer(async () => "C:/somewhere/Board.webp", "webp"),
    );
    expect(r.encodedAs).toEqual(["webp"]);
    expect(outcome).toMatchObject({ done: "saved", format: "webp" });
  });

  it("holds a WebP export below the size its encoder gives up at", async () => {
    const r = recorder(["cork"]);
    // A board far too big for either ceiling, so the scale is what gives.
    const huge = board(0, 0, 40_000, 30_000);

    const asPng = await exportImage(r.stage, huge, "Board", writer());
    const asWebp = await exportImage(
      r.stage,
      huge,
      "Board",
      writer(async () => "C:/somewhere/Board.webp", "webp"),
    );
    if (asPng.done !== "saved" || asWebp.done !== "saved") throw new Error("expected saves");

    const pixels = (o: typeof asPng): number => o.view.width * o.view.height;
    expect(pixels(asWebp)).toBeLessThanOrEqual(MAX_WEBP_PIXELS);
    // And the PNG is allowed the room WebP is not.
    expect(pixels(asPng)).toBeGreaterThan(pixels(asWebp));
    // Neither crops: the whole board is in both, at different resolutions.
    expect(asWebp.view.bounds).toEqual(asPng.view.bounds);
    expect(asWebp.view.reduced).toBe(true);
  });

  /**
   * A caller that asks for a size explicitly gets it. The ceiling is a default,
   * not a policy — and a test rig that could not turn it off would have to
   * allocate 200 megapixels to check anything about WebP.
   */
  it("lets an explicit limit override the format's own", async () => {
    const r = recorder(["cork"]);
    const outcome = await exportImage(
      r.stage,
      board(0, 0, 40_000, 30_000),
      "Board",
      writer(async () => "C:/somewhere/Board.webp", "webp"),
      { maxPixels: 1_000_000 },
    );
    if (outcome.done !== "saved") throw new Error("expected a save");
    expect(outcome.view.width * outcome.view.height).toBeLessThanOrEqual(1_000_000);
  });
});

/**
 * The failure that would have shipped.
 *
 * Chromium's WebP encoder does not refuse a canvas wider than 16383 — it
 * truncates it. A 19092 × 10412 board came back as a valid 21 MB file that was
 * 16383 × 10412, with the right-hand seventh of the board absent, and every
 * other signal said the export had worked: `toBlob` resolved, the file opened,
 * the flash reported the size that had been *asked* for.
 */
describe("an encoder that disagrees with what it was handed", () => {
  it("keeps a WebP inside the longest side the format has", async () => {
    const r = recorder(["cork"]);
    // Wide and shallow: inside every pixel ceiling, over the side limit.
    const outcome = await exportImage(
      r.stage,
      board(0, 0, 40_000, 2_000),
      "Board",
      writer(async () => "C:/somewhere/Board.webp", "webp"),
    );
    if (outcome.done !== "saved") throw new Error("expected a save");
    expect(outcome.view.width).toBeLessThanOrEqual(MAX_WEBP_SIDE);
    expect(outcome.view.height).toBeLessThanOrEqual(MAX_WEBP_SIDE);
    // The whole board is still in it — the scale gave, not the framing.
    expect(outcome.view.bounds.maxX - outcome.view.bounds.minX).toBeGreaterThan(40_000);
  });

  it("refuses to hand over a file the encoder quietly cropped", async () => {
    const r = recorder(["cork"]);
    r.measured = { width: MAX_WEBP_SIDE, height: 100 };
    const write = vi.fn(async () => "C:/somewhere/Board.webp");

    await expect(
      exportImage(r.stage, board(0, 0, 4_000, 30), "Board", writer(write, "webp")),
    ).rejects.toThrow(/part of it would have been missing/);

    // And nothing reached the disk.
    expect(write).not.toHaveBeenCalled();
  });

  /**
   * Both axes, and separately: WebP's limit is on a *side*, so a tall board is
   * cropped at the bottom exactly as a wide one is cropped at the right, and a
   * guard that only compared widths would pass every test above while letting
   * the tall case through.
   */
  it("catches a crop on either axis", async () => {
    for (const wrong of ["width", "height"] as const) {
      const r = recorder(["cork"]);
      const write = vi.fn(async () => "C:/somewhere/Board.webp");
      // Encode first to learn the size, then claim one axis came back short.
      await exportImage(r.stage, board(0, 0, 400, 300), "Board", writer(write));
      const [w, h] = r.encodedSize;
      r.measured = wrong === "width" ? { width: w - 1, height: h } : { width: w, height: h - 1 };
      write.mockClear();

      await expect(
        exportImage(r.stage, board(0, 0, 400, 300), "Board", writer(write, "webp")),
      ).rejects.toThrow(/part of it would have been missing/);
      expect(write, `a short ${wrong} reached the disk`).not.toHaveBeenCalled();
    }
  });

  it("puts the board back when the encoder is caught out", async () => {
    const r = recorder(["cork"]);
    r.measured = { width: 1, height: 1 };
    const before = { ...r.stage.camera };

    await expect(
      exportImage(r.stage, board(0, 0, 400, 300), "Board", writer(undefined, "webp")),
    ).rejects.toThrow();

    expect(r.releases).toBe(1);
    expect(pose(r.stage)).toMatchObject({ x: before.x, y: before.y, zoom: before.zoom });
  });

  it("says nothing when the encoder gave back what it was asked for", async () => {
    const r = recorder(["cork"]);
    const outcome = await exportImage(r.stage, board(0, 0, 400, 300), "Board", writer());
    expect(outcome.done).toBe("saved");
  });
});

/**
 * The progress line.
 *
 * An image export of a large board is a minute and a half in which the window
 * has zoomed itself out to the whole board and stopped answering — which is
 * indistinguishable from having hung. These are the only sentences in the
 * application somebody reads while *waiting*, which is when a vague one costs
 * the most.
 */
describe("saying how far along it is", () => {
  const phasesOf = async (
    r: Recorder,
    writerFor: ImageWriter = writer(),
    bounds = board(0, 0, 400, 300),
  ): Promise<ExportPhase[]> => {
    const seen: ExportPhase[] = [];
    await exportImage(r.stage, bounds, "Board", writerFor, {}, (p) => seen.push(p));
    return seen;
  };

  it("reports every stage, in the order they happen", async () => {
    const seen = await phasesOf(recorder(["cork"]));
    expect(seen.map((p) => p.at)).toEqual([
      "framing",
      "drawing",
      "encoding",
      "checking",
      "writing",
    ]);
  });

  /**
   * The framing is the part where the board visibly rearranges itself, so it is
   * the part most in need of a word — and it has to be said *before* the camera
   * moves rather than after, or the sentence arrives explaining something the
   * person has already watched happen.
   */
  it("says it is framing before the board has moved", async () => {
    const r = recorder(["cork"]);
    const seen: Array<[string, number]> = [];
    await exportImage(r.stage, board(0, 0, 400, 300), "Board", writer(), {}, (p) =>
      seen.push([p.at, r.stage.camera.zoom]),
    );
    // The window's own zoom, not the export's: nothing has been posed yet.
    expect(seen[0]).toEqual(["framing", 1]);
  });

  /** A cancelled export never moved the board, so it has nothing to report. */
  it("says nothing at all when the dialog is closed", async () => {
    const r = recorder(["cork"]);
    const seen = await phasesOf(r, { choose: async () => null, write: async () => "never" });
    expect(seen).toEqual([]);
  });

  /**
   * Said *before* the write, not after. A progress line that appears once the
   * thing it describes has finished is not progress, it is a caption — and the
   * write is a shell round-trip with a multi-hundred-megabyte payload, so it is
   * long enough to be worth covering.
   */
  it("says it is saving while the saving is happening", async () => {
    const r = recorder(["cork"]);
    const seen: ExportPhase[] = [];
    const duringWrite: string[] = [];
    await exportImage(
      r.stage,
      board(0, 0, 400, 300),
      "Board",
      {
        choose: async () => "png",
        write: async () => {
          duringWrite.push(...seen.map((p) => p.at));
          return "C:/somewhere/Board.png";
        },
      },
      {},
      (p) => seen.push(p),
    );
    expect(duringWrite).toContain("writing");
  });

  it("names the format it is encoding as, because that is the slow part", async () => {
    const seen = await phasesOf(
      recorder(["cork"]),
      writer(async () => "C:/somewhere/Board.webp", "webp"),
    );
    expect(seen.find((p) => p.at === "encoding")).toEqual({ at: "encoding", format: "webp" });
  });

  it("reports up to the point it fails, and not past it", async () => {
    const r = recorder(["cork"]);
    r.measured = { width: 1, height: 1 };
    const seen: ExportPhase[] = [];
    await expect(
      exportImage(r.stage, board(0, 0, 400, 300), "Board", writer(), {}, (p) => seen.push(p)),
    ).rejects.toThrow();
    // Checking is where it died, so "Saving" must never have been said.
    expect(seen.map((p) => p.at)).toEqual(["framing", "drawing", "encoding", "checking"]);
  });

  it("has a sentence for every phase, and none of them is empty", () => {
    const all: ExportPhase[] = [
      { at: "framing" },
      { at: "drawing" },
      { at: "encoding", format: "png" },
      { at: "encoding", format: "webp" },
      { at: "checking" },
      { at: "writing" },
    ];
    for (const phase of all) {
      expect(phraseFor(phase).length, phase.at).toBeGreaterThan(0);
    }
    expect(phraseFor({ at: "encoding", format: "webp" })).toContain("WebP");
    expect(phraseFor({ at: "encoding", format: "png" })).toContain("PNG");
    // The encode gets a running count of seconds appended, so it must not
    // already end in an ellipsis.
    expect(phraseFor({ at: "encoding", format: "png" })).not.toContain("…");
    expect(phraseFor({ at: "drawing" })).toContain("…");
  });
});
