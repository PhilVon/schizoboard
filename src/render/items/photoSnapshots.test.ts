/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from "vitest";
import { PhotoSnapshots, PhotoSnapshotStamp, type SnapshotRequest } from "@/render/items/photoSnapshots";

const photo = (text = "original", w = 300, h = 300) => {
  const el = document.createElement("div"); el.textContent = text;
  return { el, w, h };
};
const images = (n: number) => Array.from({ length: n }, () => document.createElement("canvas"));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("shared photo snapshot preparation", () => {
  it("freezes each photo and runs at most two eight-photo groups", async () => {
    const finish: Array<(value: HTMLCanvasElement[]) => void> = [];
    const render = vi.fn((_batch: readonly SnapshotRequest[]) => new Promise<HTMLCanvasElement[]>(r => finish.push(r)));
    const snapshots = new PhotoSnapshots(render), original = photo();
    const pending = Array.from({ length: 24 }, () => snapshots.capture(original, 0.5));
    original.el.textContent = "edited";
    await flush();
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls.map(([batch]) => batch.length)).toEqual([8, 8]);
    expect(render.mock.calls[0]![0][0]!.photo.el.textContent).toBe("original");
    expect(render.mock.calls[0]![0][0]!.photo.el).not.toBe(original.el);
    finish[0]!(images(8)); await flush();
    expect(render).toHaveBeenCalledTimes(3);
    finish[1]!(images(8)); finish[2]!(images(8));
    expect((await Promise.all(pending)).every(Boolean)).toBe(true);
    snapshots.destroy();
  });

  it("bounds the entire atlas rectangle for differently shaped photos", async () => {
    const render = vi.fn(async (batch: readonly SnapshotRequest[]) => {
      const width = Math.max(...batch.map(job => job.width));
      const height = batch.reduce((sum, job) => sum + job.height, 0);
      expect(width * height * 4).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(width).toBeLessThanOrEqual(8192); expect(height).toBeLessThanOrEqual(8192);
      return images(batch.length);
    });
    const snapshots = new PhotoSnapshots(render);
    const result = await Promise.all(Array.from({ length: 12 }, (_, i) => snapshots.capture(photo("", i % 2 ? 1000 : 1400, i % 2 ? 1400 : 1000), 1)));
    expect(result.every(Boolean)).toBe(true);
    expect(render.mock.calls.length).toBeGreaterThan(2);
    expect(await snapshots.capture(photo("", 100000, 10), 1)).toBeNull();
    snapshots.destroy();
  });

  it("cancels queued work and releases images finishing after destruction", async () => {
    const finish: Array<(value: HTMLCanvasElement[]) => void> = [];
    const snapshots = new PhotoSnapshots(() => new Promise<HTMLCanvasElement[]>(r => finish.push(r)));
    const pending = Array.from({ length: 24 }, () => snapshots.capture(photo(), 0.5));
    await flush(); snapshots.destroy();
    const late = images(16);
    finish[0]!(late.slice(0, 8)); finish[1]!(late.slice(8));
    expect(await Promise.all(pending)).toEqual(Array(24).fill(null));
    expect(late.every(image => image.width === 0 && image.height === 0)).toBe(true);
    expect(await snapshots.capture(photo(), 0.5)).toBeNull();
  });

  it("keeps fallback possible after failure and processes later work", async () => {
    const render = vi.fn(async (batch: readonly SnapshotRequest[]) => images(batch.length));
    render.mockRejectedValueOnce(new Error("decode failed"));
    const snapshots = new PhotoSnapshots(render);
    expect(await snapshots.capture(photo(), 0.5)).toBeNull();
    expect(await snapshots.capture(photo(), 0.5)).not.toBeNull();
    snapshots.destroy();
  });
});


describe("photo snapshot stamps", () => {
  it("preserves the previous key format and invalidates every appearance input", () => {
    const stamp = new PhotoSnapshotStamp();
    const inputs: [number, number, number, number, string][] = [
      [300, 200, 0.15, 12, "sepia(0.2)"],
      [301, 200, 0.15, 12, "sepia(0.2)"],
      [301, 201, 0.15, 12, "sepia(0.2)"],
      [301, 201, 0.16, 12, "sepia(0.2)"],
      [301, 201, 0.16, 13, "sepia(0.2)"],
      [301, 201, 0.16, 13, "sepia(0.3)"],
    ];
    let previous = "";
    for (const [w, h, rot, wear, filter] of inputs) {
      const key = stamp.get(w, h, rot, wear, filter);
      expect(key).toBe([w, h, rot, [wear, filter].join("|")].join(":"));
      expect(key).not.toBe(previous);
      expect(stamp.get(w, h, rot, wear, filter)).toBe(key);
      previous = key;
    }
  });
});
