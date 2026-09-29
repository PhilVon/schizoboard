/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ITEM_BLEED } from "@/render/items/raster";
import { CardBatches, type CardEntry } from "@/render/items/cardBatches";

const camera = { x: 0, y: 0, zoom: 0.25, width: 800, height: 600 };
const context = { setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), restore: vi.fn() };
let host: HTMLDivElement;
function entries(count: number): CardEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const el = document.createElement("div"); host.append(el);
    return { id: String(i), el, rank: i, x: i * 300, y: 0, rot: 0, w: 300, h: 300, identity: {}, stamp: "stable", eligible: true };
  });
}
async function flush(): Promise<void> { for (let i = 0; i < 6; i++) await Promise.resolve(); }
async function prepare(cache: CardBatches, items: CardEntry[]): Promise<void> {
  for (let i = 0; i < items.length + 2; i++) { cache.sync(items, camera, true, 1); await flush(); }
}
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
});
afterEach(() => { host.remove(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("distant photo batches", () => {
  it("starts eight images per frame with at most sixteen in flight and keeps originals until ready", async () => {
    const resolve: Array<(image: HTMLCanvasElement) => void> = [];
    const snapshot = vi.fn(() => new Promise<HTMLCanvasElement>(r => resolve.push(r)));
    const cache = new CardBatches(host, snapshot), items = entries(32);
    cache.sync(items, camera, true, 1);
    expect(snapshot).toHaveBeenCalledTimes(8);
    cache.sync(items, camera, true, 1); cache.sync(items, camera, true, 1);
    expect(snapshot).toHaveBeenCalledTimes(16);
    expect(host.querySelectorAll(".is-card-cached")).toHaveLength(0);
    resolve.forEach(r => r(document.createElement("canvas"))); await flush();
    cache.sync(items, camera, true, 1);
    expect(snapshot).toHaveBeenCalledTimes(24);
    cache.destroy();
  });

  it("splits at an intervening DOM object and restores all originals for detailed views", async () => {
    const cache = new CardBatches(host, async () => document.createElement("canvas"));
    const items = entries(33); items[16]!.eligible = false;
    await prepare(cache, items);
    expect(host.querySelectorAll(".is-card-cached")).toHaveLength(32);
    expect(items[16]!.el.classList.contains("is-card-cached")).toBe(false);
    const canvases = [...host.querySelectorAll<HTMLCanvasElement>(".item-card-batch")];
    expect(canvases.map(c => c.style.zIndex)).toEqual(["0", "17"]);
    expect(cache.pending).toBe(false);
    cache.sync(items, camera, false, 1);
    expect(host.querySelectorAll(".is-card-cached")).toHaveLength(0);
    expect(canvases.every(c => c.style.display === "none")).toBe(true);
    expect(canvases.every(c => c.width === 0 && c.height === 0)).toBe(true);
    cache.destroy();
  });

  it("does not accept an asynchronous snapshot after its item was edited", async () => {
    const resolve: Array<(image: HTMLCanvasElement) => void> = [];
    const cache = new CardBatches(host, () => new Promise(r => resolve.push(r)));
    const items = entries(16);
    cache.sync(items, camera, true, 1);
    items[0]!.identity = {};
    cache.sync(items, camera, true, 1);
    const obsolete = document.createElement("canvas"); obsolete.width = 200;
    resolve[0]!(obsolete); resolve[1]!(document.createElement("canvas")); await flush();
    expect(obsolete.width).toBe(0);
    expect(items[0]!.el.classList.contains("is-card-cached")).toBe(false);
    cache.destroy();
  });

  it("reveals an edited or moving item before preparing its replacement", async () => {
    const cache = new CardBatches(host, async () => document.createElement("canvas"));
    const items = entries(32); await prepare(cache, items);
    expect(items[0]!.el.classList.contains("is-card-cached")).toBe(true);
    items[0]!.stamp = "rotated"; items[1]!.eligible = false;
    cache.sync(items, camera, true, 1);
    expect(items[0]!.el.classList.contains("is-card-cached")).toBe(false);
    expect(items[1]!.el.classList.contains("is-card-cached")).toBe(false);
    cache.destroy();
  });

  it("leaves failed and oversized snapshots on the original renderer", async () => {
    const snapshot = vi.fn(async () => null);
    const cache = new CardBatches(host, snapshot), items = entries(16);
    items[0]!.w = 100000;
    await prepare(cache, items);
    expect(snapshot).toHaveBeenCalledTimes(15);
    expect(host.querySelectorAll(".is-card-cached")).toHaveLength(0);
    expect(cache.pending).toBe(false);
    cache.destroy();
  });

  it("cleans up pending snapshots after destruction", async () => {
    const resolve: Array<(image: HTMLCanvasElement) => void> = [];
    const cache = new CardBatches(host, () => new Promise(r => resolve.push(r)));
    cache.sync(entries(16), camera, true, 1); cache.destroy();
    const images = resolve.map(r => { const image = document.createElement("canvas"); r(image); return image; });
    await flush();
    expect(images.every(image => image.width === 0)).toBe(true);
    expect(host.querySelectorAll(".item-card-batch")).toHaveLength(0);
  });
  it("bounds handover even when every snapshot is already ready", async () => {
    const cache = new CardBatches(host, async () => document.createElement("canvas"));
    const items = entries(32); await prepare(cache, items); cache.reveal();
    cache.sync(items, camera, true, 1);
    expect(host.querySelectorAll(".is-card-cached")).toHaveLength(0);
    expect(cache.pending).toBe(true);
    cache.sync(items, camera, true, 1); cache.sync(items, camera, true, 1);
    expect(host.querySelectorAll(".is-card-cached")).toHaveLength(18);
    cache.destroy();
  });

  it("restores the cached marker after a pooled node resets its classes", async () => {
    const cache = new CardBatches(host, async () => document.createElement("canvas"));
    const items = entries(16); await prepare(cache, items);
    items[0]!.el.className = "item item-polaroid";
    cache.sync(items, camera, true, 1);
    expect(items[0]!.el.classList.contains("is-card-cached")).toBe(true);
    cache.destroy();
  });

  it("falls back before allocating oversized viewport surfaces", () => {
    const snapshot = vi.fn(async () => document.createElement("canvas"));
    const cache = new CardBatches(host, snapshot);
    cache.sync(entries(16), { ...camera, width: 10000, height: 10000 }, true, 2);
    expect(snapshot).not.toHaveBeenCalled();
    expect(host.querySelectorAll(".item-card-batch")).toHaveLength(0);
    cache.destroy();
  });

  it("wakes for late image loads and removes its listeners on destruction", () => {
    const cache = new CardBatches(host);
    const image = document.createElement("img"); host.append(image);
    image.dispatchEvent(new Event("load"));
    expect(cache.pending).toBe(true);
    cache.sync([], camera, false, 1);
    expect(cache.pending).toBe(false);
    cache.destroy(); image.dispatchEvent(new Event("load"));
    expect(cache.pending).toBe(false);
  });

  it("defers new preparation during zoom-in and resumes after the gesture", () => {
    const snapshot = vi.fn(async () => null);
    const cache = new CardBatches(host, snapshot), items = entries(16);
    cache.sync(items, { ...camera, zoom: 0.15 }, false, 1, true);
    cache.sync(items, camera, true, 1, true);
    expect(snapshot).not.toHaveBeenCalled();
    expect(cache.pending).toBe(true);
    cache.sync(items, camera, true, 1, false);
    expect(snapshot).toHaveBeenCalledTimes(8);
    cache.destroy();
  });

  it("stops reserving bitmaps at the budget and evicts offscreen images for new objects", async () => {
    const images: HTMLCanvasElement[] = [];
    const snapshot = vi.fn(async () => { const c = document.createElement("canvas"); images.push(c); return c; });
    const cache = new CardBatches(host, snapshot), items = entries(80);
    for (const item of items) { item.w = 2000; item.h = 2000; }
    await prepare(cache, items);
    const reserved = Math.ceil((2000 + 2 * ITEM_BLEED) * 0.5) ** 2 * 4;
    // Each snapshot reserves its padded physical size even while being prepared.
    expect(snapshot.mock.calls.length * reserved).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(snapshot.mock.calls.length).toBeGreaterThan(16);
    expect(snapshot.mock.calls.length).toBeLessThan(80);
    const count = snapshot.mock.calls.length;
    const other = entries(16).map((item, i) => ({ ...item, id: "new-" + i, w: 2000, h: 2000 }));
    await prepare(cache, other);
    expect(snapshot.mock.calls.length).toBe(count + 16);
    expect(images.some(image => image.width === 0)).toBe(true);
    cache.destroy();
  });

});
