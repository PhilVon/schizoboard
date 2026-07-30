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

import { exportImage, type BoardPainter, type ImageStage, type ImageWriter } from "@/app/exportImage";

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
      encode: async () => {
        out.encoded += 1;
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      },
    },
    canvases,
    drawn,
    settled,
    redraws: 0,
    holds: 0,
    releases: 0,
    encoded: 0,
    clock: 0,
  };
  return out;
}

const writer = (write: ImageWriter["write"] = async () => "C:/somewhere/Board.png"): ImageWriter => ({
  choose: async () => true,
  write,
});

const pose = (stage: ImageStage): Record<string, number> => ({ ...stage.camera });

describe("a board with nothing on it", () => {
  it("is not an export, and nobody is asked where to put it", async () => {
    const r = recorder();
    const choose = vi.fn(async () => true);
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
      choose: async () => false,
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
