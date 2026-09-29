import { atVariant, cloneForExport, exportStylesheet, fetchBytes, inlineAssets, inertDocument, ITEM_BLEED, serialise, svgDataUri, svgFor } from "@/render/items/raster";

interface Photo { el: HTMLElement; w: number; h: number }
export interface SnapshotRequest {
  photo: Photo;
  scale: number;
  width: number;
  height: number;
}
interface Pending extends SnapshotRequest { resolve: (image: HTMLCanvasElement | null) => void }
type Render = (batch: readonly SnapshotRequest[]) => Promise<(HTMLCanvasElement | null)[]>;
const GROUP_SIZE = 8;
const GROUP_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 8192;

/** Shares SVG/font preparation while returning independently disposable photo images. */
export class PhotoSnapshots {
  private readonly queue: Pending[] = [];
  private active = 0;
  private scheduled = false;
  private destroyed = false;
  private css: Promise<string> | null = null;
  private readonly assets = new Map<string, ReturnType<typeof fetchBytes>>();

  constructor(private readonly renderGroup: Render = batch => this.render(batch)) {}

  capture(photo: Photo, scale: number): Promise<HTMLCanvasElement | null> {
    const width = Math.ceil((photo.w + 2 * ITEM_BLEED) * scale);
    const height = Math.ceil((photo.h + 2 * ITEM_BLEED) * scale);
    if (this.destroyed || !(width > 0 && height > 0) || !Number.isFinite(width + height) ||
        width > MAX_EDGE || height > MAX_EDGE || width * height * 4 > GROUP_BYTES) return Promise.resolve(null);
    // Freeze the item before yielding; a pooled view may already show another photo next frame.
    const el = photo.el.cloneNode(true) as HTMLElement;
    el.classList.remove("is-card-cached");
    el.classList.add("is-coarse");
    return new Promise(resolve => {
      this.queue.push({ photo: { ...photo, el }, scale, width, height, resolve });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.scheduled || this.destroyed || this.active >= 2 || this.queue.length === 0) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain(); });
  }

  private drain(): void {
    while (!this.destroyed && this.active < 2 && this.queue.length) {
      const batch: Pending[] = [];
      let width = 0, height = 0;
      while (batch.length < GROUP_SIZE && this.queue.length) {
        const next = this.queue[0]!;
        const w = Math.max(width, next.width), h = height + next.height;
        if (h > MAX_EDGE || w * h * 4 > GROUP_BYTES) break;
        batch.push(this.queue.shift()!);
        width = w; height = h;
      }
      this.active++;
      void this.renderGroup(batch).then(images => {
        batch.forEach((job, i) => {
          const image = images[i] ?? null;
          if (this.destroyed && image) { image.width = 0; image.height = 0; }
          job.resolve(this.destroyed ? null : image);
        });
      }).catch(() => batch.forEach(job => job.resolve(null))).finally(() => {
        this.active--;
        this.schedule();
      });
    }
  }

  private readonly read = (url: string): ReturnType<typeof fetchBytes> => {
    const key = atVariant(url, "thumb");
    let bytes = this.assets.get(key);
    if (!bytes) {
      bytes = fetchBytes(key);
      this.assets.set(key, bytes);
      if (this.assets.size > 512) this.assets.delete(this.assets.keys().next().value!);
    }
    return bytes;
  };

  private async render(batch: readonly SnapshotRequest[]): Promise<(HTMLCanvasElement | null)[]> {
    this.css ??= exportStylesheet();
    const css = await this.css;
    if (this.destroyed) return [];
    const inert = inertDocument(), framed = inert.createElement("div");
    const width = Math.max(...batch.map(job => job.width));
    const height = batch.reduce((sum, job) => sum + job.height, 0);
    framed.style.cssText = `position:relative;width:${width}px;height:${height}px`;
    let y = 0;
    for (const job of batch) {
      // Pack in output pixels, so unequal heights and fractional DPR never bleed into a neighbour.
      const slot = inert.createElement("div");
      slot.style.cssText = `position:absolute;left:0;top:${y}px;width:${job.photo.w + 2 * ITEM_BLEED}px;height:${job.photo.h + 2 * ITEM_BLEED}px;transform:scale(${job.scale});transform-origin:0 0`;
      const clone = cloneForExport(job.photo.el, inert);
      clone.style.position = "absolute";
      clone.style.left = `${ITEM_BLEED}px`;
      clone.style.top = `${ITEM_BLEED}px`;
      slot.append(clone); framed.append(slot); y += job.height;
    }
    const cost = await inlineAssets(framed, this.read, new Map());
    if (this.destroyed || cost.unreadable) return [];
    const image = await decode(svgDataUri(svgFor(serialise(framed), css, width, height)));
    if (!image) return [];
    const atlas = document.createElement("canvas");
    try {
      if (this.destroyed) return [];
      atlas.width = width; atlas.height = height;
      const ctx = atlas.getContext("2d");
      if (!ctx) return [];
      // One SVG paint, rather than repainting the SVG for each cropped item.
      ctx.drawImage(image, 0, 0);
      y = 0;
      return batch.map(job => {
        const canvas = document.createElement("canvas");
        canvas.width = job.width; canvas.height = job.height;
        const target = canvas.getContext("2d");
        if (target) target.drawImage(atlas, 0, y, job.width, job.height, 0, 0, job.width, job.height);
        y += job.height;
        if (!target) { canvas.width = 0; canvas.height = 0; return null; }
        return canvas;
      });
    } finally {
      image.removeAttribute("src");
      atlas.width = 0; atlas.height = 0;
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const job of this.queue.splice(0)) job.resolve(null);
    this.assets.clear();
    this.css = null;
  }
}

function decode(uri: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    const finish = (result: HTMLImageElement | null): void => {
      image.onload = null; image.onerror = null; resolve(result);
    };
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = uri;
  });
}

/** Reuse the snapshot key while all pixel-affecting inputs are unchanged. */
export class PhotoSnapshotStamp {
  private previous: { w: number; h: number; rot: number; wear: number; filter: string; key: string } | null = null;

  get(w: number, h: number, rot: number, wear: number, filter: string): string {
    const last = this.previous;
    if (last && last.w === w && last.h === h && last.rot === rot && last.wear === wear && last.filter === filter) return last.key;
    const key = `${w}:${h}:${rot}:${wear}|${filter}`;
    this.previous = { w, h, rot, wear, filter, key };
    return key;
  }
}
